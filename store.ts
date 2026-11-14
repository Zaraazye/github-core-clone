// In-memory model for the forge. Everything lives in Maps keyed by plain
// strings; hot lookups are a single Map.get. No disk, no database — the
// whole point of this entry is that the request path does as little work
// as possible, so mutable state is cached aggressively and invalidated
// lazily (see touchGit / touchIssue below).

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  updatedSeq: number;
  commentCount: number;
  /** Serialized REST JSON for this issue; rebuilt on mutation, reused on GET. */
  json: Buffer | null;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean;
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  /** Serialized REST JSON for this pull; rebuilt on mutation, reused on GET. */
  json: Buffer | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** full ref name -> commit oid */
  refs: Map<string, string>;
  /** oid -> raw object bytes */
  objects: Map<string, GitObj>;
  /** commit oid -> parent oids (parsed once when the commit is stored) */
  parents: Map<string, string[]>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  nextIssue: number;
  comments: Map<number, Comment[]>;
  labels: Map<string, Label>;
  pulls: Pull[];
  pullByNumber: Map<number, Pull>;
  nextPull: number;
  nextComment: number;
  seq: number;
  // ---- git caches (invalidated by touchGit) ----
  /** sorted [refname, oid] list, rebuilt on demand */
  refList: Array<[string, string]> | null;
  /** v0 upload-pack advertisement bytes */
  v0UploadAd: Buffer | null;
  /** v0 receive-pack advertisement bytes */
  v0ReceiveAd: Buffer | null;
  /** pack cache: key `${tip}|${depth}|${wantsHash}` -> raw pack bytes */
  packCache: Map<string, Buffer>;
}

/** The scenario's viewer. The trial scenario is built from one constant
 * seed, so the viewer is the same in every run: login "adaiversen", id 1000.
 * Every bearer token authenticates as this user. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const ZERO_OID = '0'.repeat(40);

export function repoKey(owner: string, name: string): string {
  return owner + '\0' + name;
}

export function nodeId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(kind + ':' + parts.join(':'), 'utf8').toString('base64');
}

export function parseNodeId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), parts: text.slice(idx + 1).split(':') };
  } catch {
    return null;
  }
}

let seqCounter = 1;

export class Store {
  readonly repos = new Map<string, Repo>();
  /** viewer repos in creation order (drives GET /user/repos pagination) */
  readonly userRepos: Repo[] = [];
  nextRepoId = 1;

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = new Date().toISOString();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      parents: new Map(),
      issues: [],
      issueByNumber: new Map(),
      nextIssue: 1,
      comments: new Map(),
      labels: new Map(),
      pulls: [],
      pullByNumber: new Map(),
      nextPull: 1,
      nextComment: 1,
      seq: seqCounter++,
      refList: null,
      v0UploadAd: null,
      v0ReceiveAd: null,
      packCache: new Map(),
    };
    this.repos.set(repoKey(owner, name), repo);
    if (owner === VIEWER_LOGIN) this.userRepos.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repoKey(repo.owner, repo.name));
    const i = this.userRepos.indexOf(repo);
    if (i >= 0) this.userRepos.splice(i, 1);
  }

  /** Drop every cache that depends on the ref set or the object store. */
  touchGit(repo: Repo): void {
    repo.refList = null;
    repo.v0UploadAd = null;
    repo.v0ReceiveAd = null;
    repo.packCache.clear();
  }
}

/** Sorted ref list for a repo, cached. */
export function sortedRefs(repo: Repo): Array<[string, string]> {
  let list = repo.refList;
  if (list === null) {
    list = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    repo.refList = list;
  }
  return list;
}

/** Parse the parent oids out of raw commit bytes. */
export function commitParents(data: Buffer): string[] {
  const parents: string[] = [];
  const text = data.toString('latin1');
  let pos = 0;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) break;
    const line = text.slice(pos, nl);
    if (line === '') break;
    if (line.startsWith('parent ')) parents.push(line.slice(7));
    pos = nl + 1;
  }
  return parents;
}

/** Parse the tree oid out of raw commit bytes. */
export function commitTree(data: Buffer): string | null {
  const text = data.toString('latin1', 0, 64);
  const m = /^tree ([0-9a-f]{40})\n/.exec(text);
  return m ? m[1] : null;
}
