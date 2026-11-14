// REST v3 (api.github.com surface the suite probes): repos, contents,
// labels, issues, pulls, git refs, plus the protocol rules — every reply
// is JSON, every reply carries X-GitHub-Request-Id, unknown routes are
// JSON 404s and malformed bodies are 400s.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitParents,
  commitTree,
  nodeId,
  sortedRefs,
  VIEWER_ID,
  VIEWER_LOGIN,
} from './store.ts';
import type { Issue, Label, Pull, Repo, Store } from './store.ts';
import {
  diffFiles,
  mergeConflicts,
  parseTree,
  squashMerge,
  storeBlob,
  storeCommit,
  storeTree,
  treeDeletePath,
  treeGetPath,
  treeSetPath,
} from './git.ts';
import { parseJsonBody, sendErr, sendJson, sendRaw } from './http.ts';

export interface RestCtx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  authed: boolean;
  reqId: string;
  host: string;
}

// ---- JSON builders (issue/pull JSON is cached on the object) ----

export function repoJson(repo: Repo): Record<string, unknown> {
  let openIssues = 0;
  for (const i of repo.issues) if (i.state === 'open') openIssues++;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: repo.owner + '/' + repo.name,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 2000 + repo.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    size: 0,
    language: null,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

export function issueJson(issue: Issue, repo: Repo): Buffer {
  if (issue.json !== null) return issue.json;
  const labels = issue.labels.map((name) => {
    const label = repo.labels.get(name);
    return { name, color: label === undefined ? 'ededed' : label.color };
  });
  const obj = {
    id: nodeId('Issue', repo.id, issue.number),
    node_id: nodeId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: { login: issue.user, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.commentCount,
  };
  issue.json = Buffer.from(JSON.stringify(obj), 'utf8');
  return issue.json;
}

function pullState(pull: Pull): string {
  return pull.state === 'merged' ? 'closed' : pull.state;
}

export function pullJson(pull: Pull, repo: Repo): Buffer {
  if (pull.json !== null) return pull.json;
  const obj = {
    id: nodeId('PullRequest', repo.id, pull.number),
    node_id: nodeId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    head: { ref: pull.headRef, sha: pull.headSha, label: repo.owner + ':' + pull.headRef },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: repo.owner + ':' + pull.baseRef },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.mergeable,
    user: { login: pull.user, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
  pull.json = Buffer.from(JSON.stringify(obj), 'utf8');
  return pull.json;
}

// ---- helpers ----

let updateSeq = 1000000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function pageParams(query: Map<string, string>): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function linkHeader(ctx: RestCtx, basePath: string, query: Map<string, string>, page: number, perPage: number, totalPages: number): string {
  const parts: string[] = [];
  const url = (p: number): string => `http://${ctx.host}${basePath}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) parts.push(`<${url(page + 1)}>; rel="next"`);
  if (totalPages > 1) parts.push(`<${url(totalPages)}>; rel="last"`);
  if (page > 1) {
    parts.push(`<${url(1)}>; rel="first"`);
    parts.push(`<${url(page - 1)}>; rel="prev"`);
  }
  return parts.join(', ');
}

function paginate<T>(items: T[], page: number, perPage: number): { slice: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), totalPages };
}

/** Resolve a ref name / oid to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined) {
    return repo.refs.get('refs/heads/' + repo.defaultBranch) ?? null;
  }
  const direct = repo.refs.get('refs/heads/' + ref) ?? repo.refs.get('refs/tags/' + ref) ?? repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return null;
}

/** Walk a commit chain newest-first; returns the commit oids. */
function commitChain(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    let parents = repo.parents.get(oid);
    if (parents === undefined) {
      parents = commitParents(obj.data);
      repo.parents.set(oid, parents);
    }
    for (const p of parents) stack.push(p);
  }
  return out;
}

function refreshMergeable(repo: Repo, pull: Pull): void {
  pull.mergeable = pull.state === 'open' ? !mergeConflicts(repo, pull) : false;
}

// ---- the dispatcher ----

export function handleRest(ctx: RestCtx, method: string, seg: string[], query: Map<string, string>, body: Buffer | null): void {
  const { res, store, reqId } = ctx;

  // --- root + meta (public) ---
  if (seg.length >= 2 && seg[0] === 'api' && seg[1] === 'v3' && seg.length === 2) {
    if (method !== 'GET') return sendErr(res, 404, 'Not Found', reqId);
    return sendRaw(
      res,
      200,
      Buffer.from(
        JSON.stringify({
          current_user_url: `http://${ctx.host}/api/v3/user`,
          rate_limit_url: `http://${ctx.host}/api/v3/rate_limit`,
          repository_url: `http://${ctx.host}/api/v3/repos/{owner}/{repo}`,
        }),
        'utf8',
      ),
      'application/json',
      reqId,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'meta') {
    if (method !== 'GET') return sendErr(res, 404, 'Not Found', reqId);
    return sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true }, reqId);
  }

  const needAuth = (): boolean => {
    if (!ctx.authed) {
      sendErr(res, 401, 'Requires authentication', reqId);
      return true;
    }
    return false;
  };

  // body parsing for writes (malformed JSON -> 400)
  let bodyJson: unknown;
  let bodyParsed = false;
  const getBody = (): { ok: boolean; value: unknown } => {
    if (bodyParsed) return { ok: true, value: bodyJson };
    bodyParsed = true;
    if (body === null || body.length === 0) {
      bodyJson = undefined;
      return { ok: true, value: undefined };
    }
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendErr(res, 400, 'Problems parsing JSON', reqId);
      return { ok: false, value: undefined };
    }
    bodyJson = parsed.value;
    return { ok: true, value: bodyJson };
  };

  // --- GET /api/v3/user ---
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'user') {
    if (method !== 'GET') return sendErr(res, 404, 'Not Found', reqId);
    if (needAuth()) return;
    return sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: 'Ada Iversen', email: VIEWER_LOGIN + '@example.invalid' }, reqId);
  }

  // --- /api/v3/user/repos ---
  if (seg.length === 4 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'user' && seg[3] === 'repos') {
    if (needAuth()) return;
    if (method === 'POST') {
      const parsed = getBody();
      if (!parsed.ok) return;
      const input = isRecord(parsed.value) ? parsed.value : {};
      const name = str(input.name);
      if (name === '') return sendErr(res, 422, 'name is required', reqId);
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return sendErr(res, 422, 'Repository already exists', reqId);
      const repo = store.createRepo(VIEWER_LOGIN, name, str(input.description), bool(input.private, false));
      return sendJson(res, 201, repoJson(repo), reqId);
    }
    if (method === 'GET') {
      const { page, perPage } = pageParams(query);
      const { slice, totalPages } = paginate(store.userRepos, page, perPage);
      const extra: Record<string, string> = {};
      const link = linkHeader(ctx, '/api/v3/user/repos', query, page, perPage, totalPages);
      if (link !== '') extra.link = link;
      return sendRaw(res, 200, Buffer.from(JSON.stringify(slice.map((r) => repoJson(r))), 'utf8'), 'application/json', reqId, extra);
    }
    return sendErr(res, 404, 'Not Found', reqId);
  }

  // --- /api/v3/repos/... ---
  if (seg.length >= 5 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'repos') {
    const owner = seg[3];
    const name = seg[4];
    const rest = seg.slice(5);
    const repo = store.getRepo(owner, name);

    // hot path: GET /issues/{n} — one cached Buffer, no JSON work
    if (method === 'GET' && rest.length === 2 && rest[0] === 'issues') {
      if (repo === undefined) {
        if (!ctx.authed) return sendErr(res, 401, 'Requires authentication', reqId);
        return sendErr(res, 404, 'Not Found', reqId);
      }
      if (!ctx.authed && repo.private) return sendErr(res, 401, 'Requires authentication', reqId);
      const n = parseInt(rest[1], 10);
      const issue = Number.isInteger(n) ? repo.issueByNumber.get(n) : undefined;
      if (issue === undefined) return sendErr(res, 404, 'Not Found', reqId);
      return sendRaw(res, 200, issueJson(issue, repo), 'application/json', reqId);
    }

    if (repo === undefined) {
      if (!ctx.authed) return sendErr(res, 401, 'Requires authentication', reqId);
      return sendErr(res, 404, 'Not Found', reqId);
    }
    const canRead = ctx.authed || !repo.private;
    const readGate = (): boolean => {
      if (!canRead) {
        sendErr(res, 401, 'Requires authentication', reqId);
        return true;
      }
      return false;
    };

    // repo itself
    if (rest.length === 0) {
      if (method === 'GET') {
        if (readGate()) return;
        return sendJson(res, 200, repoJson(repo), reqId);
      }
      if (method === 'PATCH') {
        if (needAuth()) return;
        const parsed = getBody();
        if (!parsed.ok) return;
        const input = isRecord(parsed.value) ? parsed.value : {};
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
        repo.updatedAt = new Date().toISOString();
        return sendJson(res, 200, repoJson(repo), reqId);
      }
      if (method === 'DELETE') {
        if (needAuth()) return;
        store.deleteRepo(repo);
        res.writeHead(204, { 'x-github-request-id': reqId });
        return res.end();
      }
      return sendErr(res, 404, 'Not Found', reqId);
    }

    // branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') return sendErr(res, 404, 'Not Found', reqId);
      if (readGate()) return;
      const out = sortedRefs(repo)
        .filter(([n]) => n.startsWith('refs/heads/'))
        .map(([n, oid]) => ({ name: n.slice('refs/heads/'.length), commit: { sha: oid } }));
      return sendJson(res, 200, out, reqId);
    }

    // commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') return sendErr(res, 404, 'Not Found', reqId);
      if (readGate()) return;
      const tip = resolveRef(repo, query.get('sha') ?? undefined);
      if (tip === null) return sendErr(res, 404, 'Not Found', reqId);
      const chain = commitChain(repo, tip);
      const out = chain.map((sha) => {
        const obj = repo.objects.get(sha)!;
        const text = obj.data.toString('utf8');
        const msgStart = text.indexOf('\n\n');
        const message = msgStart >= 0 ? text.slice(msgStart + 2).replace(/\n$/, '') : '';
        return { sha, commit: { message, author: { name: 'adaiversen', email: 'adaiversen@example.invalid' } } };
      });
      return sendJson(res, 200, out, reqId);
    }

    // git/refs
    if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        if (needAuth()) return;
        const parsed = getBody();
        if (!parsed.ok) return;
        const input = isRecord(parsed.value) ? parsed.value : {};
        const ref = str(input.ref);
        const sha = str(input.sha);
        if (ref === '' || sha === '') return sendErr(res, 422, 'ref and sha are required', reqId);
        if (repo.refs.has(ref)) return sendErr(res, 422, 'Reference already exists', reqId);
        const obj = repo.objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') return sendErr(res, 422, 'Object does not exist', reqId);
        repo.refs.set(ref, sha);
        store.touchGit(repo);
        return sendJson(res, 201, { ref, object: { sha } }, reqId);
      }
      if (method === 'GET' && rest.length >= 3) {
        if (readGate()) return;
        const refName = rest.slice(2).join('/');
        const sha = repo.refs.get(refName);
        if (sha === undefined) return sendErr(res, 404, 'Not Found', reqId);
        return sendJson(res, 200, { ref: refName, object: { sha } }, reqId);
      }
      return sendErr(res, 404, 'Not Found', reqId);
    }

    // contents
    if (rest.length >= 1 && rest[0] === 'contents') {
      const pathSegs = rest.slice(1).map((s) => decodeURIComponent(s));
      if (method === 'GET') {
        if (readGate()) return;
        const tip = resolveRef(repo, query.get('ref') ?? undefined);
        if (tip === null) return sendErr(res, 404, 'Not Found', reqId);
        const commitObj = repo.objects.get(tip);
        const treeOid = commitObj !== undefined && commitObj.type === 'commit' ? commitTree(commitObj.data) : null;
        if (pathSegs.length === 0) {
          const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
          const out = entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: e.name,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : repo.objects.get(e.oid)?.data.length ?? 0,
          }));
          return sendJson(res, 200, out, reqId);
        }
        const found = treeGetPath(repo, treeOid, pathSegs);
        if (found === null) return sendErr(res, 404, 'Not Found', reqId);
        if (found.kind === 'dir') {
          const entries = parseTree(repo.objects.get(found.oid)?.data ?? Buffer.alloc(0));
          const base = pathSegs.join('/');
          const out = entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: base + '/' + e.name,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : repo.objects.get(e.oid)?.data.length ?? 0,
          }));
          return sendJson(res, 200, out, reqId);
        }
        const blob = repo.objects.get(found.oid);
        if (blob === undefined) return sendErr(res, 404, 'Not Found', reqId);
        return sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: pathSegs[pathSegs.length - 1],
          path: pathSegs.join('/'),
          content: blob.data.toString('base64'),
          sha: found.oid,
        }, reqId);
      }
      if (method === 'PUT' || method === 'DELETE') {
        if (needAuth()) return;
        const parsed = getBody();
        if (!parsed.ok) return;
        const input = isRecord(parsed.value) ? parsed.value : {};
        const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
        const refName = 'refs/heads/' + branch;
        const tip = repo.refs.get(refName) ?? null;
        const commitObj = tip === null ? undefined : repo.objects.get(tip);
        const treeOid = commitObj !== undefined && commitObj.type === 'commit' ? commitTree(commitObj.data) : null;
        const existing = treeGetPath(repo, treeOid, pathSegs);
        if (method === 'PUT') {
          const message = str(input.message);
          const contentB64 = str(input.content);
          if (message === '' || contentB64 === '') return sendErr(res, 422, 'message and content are required', reqId);
          let content: Buffer;
          try {
            content = Buffer.from(contentB64, 'base64');
          } catch {
            return sendErr(res, 422, 'content is not valid base64', reqId);
          }
          const blobOid = storeBlob(repo, content);
          if (existing !== null && existing.kind === 'file') {
            if (typeof input.sha === 'string' && input.sha !== '' && input.sha.toLowerCase() !== existing.oid.toLowerCase()) {
              return sendErr(res, 409, 'sha does not match the current blob', reqId);
            }
            if (typeof input.sha !== 'string' || input.sha === '') {
              return sendErr(res, 409, 'sha is required to update a file', reqId);
            }
          }
          const newTree = treeSetPath(repo, treeOid, pathSegs, blobOid);
          const newCommit = storeCommit(repo, newTree, tip === null ? [] : [tip], message);
          repo.refs.set(refName, newCommit);
          store.touchGit(repo);
          const status = existing === null ? 201 : 200;
          return sendJson(res, status, {
            content: { name: pathSegs[pathSegs.length - 1], path: pathSegs.join('/'), sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
            commit: { sha: newCommit, message },
          }, reqId);
        }
        // DELETE
        if (existing === null || existing.kind !== 'file') return sendErr(res, 404, 'Not Found', reqId);
        if (typeof input.sha === 'string' && input.sha !== '' && input.sha.toLowerCase() !== existing.oid.toLowerCase()) {
          return sendErr(res, 409, 'sha does not match the current blob', reqId);
        }
        const newTree = treeDeletePath(repo, treeOid, pathSegs);
        const newCommit = storeCommit(repo, newTree ?? storeTree(repo, []), tip === null ? [] : [tip], str(input.message) || 'Delete file');
        repo.refs.set(refName, newCommit);
        store.touchGit(repo);
        return sendJson(res, 200, { commit: { sha: newCommit } }, reqId);
      }
      return sendErr(res, 404, 'Not Found', reqId);
    }

    // labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') {
        if (readGate()) return;
        return sendJson(res, 200, [...repo.labels.values()].map(labelJson), reqId);
      }
      if (method === 'POST') {
        if (needAuth()) return;
        const parsed = getBody();
        if (!parsed.ok) return;
        const input = isRecord(parsed.value) ? parsed.value : {};
        const name = str(input.name);
        const color = str(input.color) || 'ededed';
        if (name === '') return sendErr(res, 422, 'name is required', reqId);
        if (repo.labels.has(name)) return sendErr(res, 422, 'Label already exists', reqId);
        const label: Label = { name, color };
        repo.labels.set(name, label);
        return sendJson(res, 201, labelJson(label), reqId);
      }
      return sendErr(res, 404, 'Not Found', reqId);
    }

    // issues list + create
    if (rest.length === 1 && rest[0] === 'issues') {
      if (method === 'GET') {
        if (readGate()) return;
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        const key = (i: Issue): number => (sort === 'updated' ? i.updatedSeq : sort === 'comments' ? i.commentCount : i.seq);
        list = [...list].sort((a, b) => (direction === 'asc' ? key(a) - key(b) : key(b) - key(a)));
        const { page, perPage } = pageParams(query);
        const { slice, totalPages } = paginate(list, page, perPage);
        const extra: Record<string, string> = {};
        const link = linkHeader(ctx, `/api/v3/repos/${owner}/${name}/issues`, query, page, perPage, totalPages);
        if (link !== '') extra.link = link;
        return sendRaw(res, 200, Buffer.from(JSON.stringify(slice.map((i) => JSON.parse(issueJson(i, repo).toString('utf8')))), 'utf8'), 'application/json', reqId, extra);
      }
      if (method === 'POST') {
        if (needAuth()) return;
        const parsed = getBody();
        if (!parsed.ok) return;
        const input = isRecord(parsed.value) ? parsed.value : {};
        const title = str(input.title);
        if (title === '') return sendErr(res, 422, 'title is required', reqId);
        const labels: string[] = [];
        if (Array.isArray(input.labels)) {
          for (const l of input.labels) {
            const name = typeof l === 'string' ? l : isRecord(l) ? str(l.name) : '';
            if (name === '') continue;
            if (!repo.labels.has(name)) return sendErr(res, 422, `Label '${name}' does not exist`, reqId);
            labels.push(name);
          }
        }
        const now = new Date().toISOString();
        const seq = repo.issues.length + 1;
        const issue: Issue = {
          number: repo.nextIssue++,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels,
          user: VIEWER_LOGIN,
          createdAt: now,
          updatedAt: now,
          seq,
          updatedSeq: seq,
          commentCount: 0,
          json: null,
        };
        repo.issues.push(issue);
        repo.issueByNumber.set(issue.number, issue);
        return sendRaw(res, 201, issueJson(issue, repo), 'application/json', reqId);
      }
      return sendErr(res, 404, 'Not Found', reqId);
    }

    // issue comments
    if (rest.length === 3 && rest[0] === 'issues' && rest[2] === 'comments') {
      const n = parseInt(rest[1], 10);
      const issue = Number.isInteger(n) ? repo.issueByNumber.get(n) : undefined;
      if (issue === undefined) return sendErr(res, 404, 'Not Found', reqId);
      if (method === 'GET') {
        if (readGate()) return;
        const list = repo.comments.get(issue.number) ?? [];
        return sendJson(res, 200, list.map((c) => ({ id: c.id, body: c.body, user: { login: c.user, id: VIEWER_ID, type: 'User' }, created_at: c.createdAt, updated_at: c.updatedAt })), reqId);
      }
      if (method === 'POST') {
        if (needAuth()) return;
        const parsed = getBody();
        if (!parsed.ok) return;
        const input = isRecord(parsed.value) ? parsed.value : {};
        const bodyText = str(input.body);
        if (bodyText === '') return sendErr(res, 422, 'body is required', reqId);
        const now = new Date().toISOString();
        const comment = { id: repo.nextComment++, body: bodyText, user: VIEWER_LOGIN, createdAt: now, updatedAt: now };
        const list = repo.comments.get(issue.number) ?? [];
        list.push(comment);
        repo.comments.set(issue.number, list);
        issue.commentCount = list.length;
        issue.json = null;
        return sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: comment.user, id: VIEWER_ID, type: 'User' }, created_at: now, updated_at: now }, reqId);
      }
      return sendErr(res, 404, 'Not Found', reqId);
    }

    // single issue PATCH (GET is the hot path above)
    if (rest.length === 2 && rest[0] === 'issues') {
      const n = parseInt(rest[1], 10);
      const issue = Number.isInteger(n) ? repo.issueByNumber.get(n) : undefined;
      if (issue === undefined) return sendErr(res, 404, 'Not Found', reqId);
      if (method === 'PATCH') {
        if (needAuth()) return;
        const parsed = getBody();
        if (!parsed.ok) return;
        const input = isRecord(parsed.value) ? parsed.value : {};
        let changed = false;
        if (typeof input.title === 'string') { issue.title = input.title; changed = true; }
        if (typeof input.body === 'string') { issue.body = input.body; changed = true; }
        if (input.state === 'open' || input.state === 'closed') { issue.state = input.state; changed = true; }
        if (Array.isArray(input.labels)) {
          const labels: string[] = [];
          for (const l of input.labels) {
            const name = typeof l === 'string' ? l : isRecord(l) ? str(l.name) : '';
            if (name === '') continue;
            if (!repo.labels.has(name)) return sendErr(res, 422, `Label '${name}' does not exist`, reqId);
            labels.push(name);
          }
          issue.labels = labels;
          changed = true;
        }
        if (changed) {
          issue.updatedAt = new Date().toISOString();
          issue.updatedSeq = ++updateSeq;
          issue.json = null;
        }
        return sendRaw(res, 200, issueJson(issue, repo), 'application/json', reqId);
      }
      return sendErr(res, 404, 'Not Found', reqId);
    }

    // pulls list + create
    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'GET') {
        if (readGate()) return;
        const state = query.get('state') ?? 'open';
        const list = repo.pulls.filter((p) => state === 'all' || pullState(p) === state);
        const { page, perPage } = pageParams(query);
        const { slice } = paginate(list, page, perPage);
        return sendRaw(res, 200, Buffer.from(JSON.stringify(slice.map((p) => JSON.parse(pullJson(p, repo).toString('utf8')))), 'utf8'), 'application/json', reqId);
      }
      if (method === 'POST') {
        if (needAuth()) return;
        const parsed = getBody();
        if (!parsed.ok) return;
        const input = isRecord(parsed.value) ? parsed.value : {};
        const title = str(input.title);
        const head = str(input.head);
        const base = str(input.base);
        if (title === '' || head === '' || base === '') return sendErr(res, 422, 'title, head and base are required', reqId);
        const headSha = repo.refs.get('refs/heads/' + head);
        const baseSha = repo.refs.get('refs/heads/' + base);
        if (headSha === undefined || baseSha === undefined) return sendErr(res, 422, 'head or base branch does not exist', reqId);
        const now = new Date().toISOString();
        const pull: Pull = {
          number: repo.nextPull++,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          headRef: head,
          headSha,
          baseRef: base,
          baseSha,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          mergeable: true,
          user: VIEWER_LOGIN,
          createdAt: now,
          updatedAt: now,
          seq: repo.pulls.length + 1,
          json: null,
        };
        refreshMergeable(repo, pull);
        repo.pulls.push(pull);
        repo.pullByNumber.set(pull.number, pull);
        return sendRaw(res, 201, pullJson(pull, repo), 'application/json', reqId);
      }
      return sendErr(res, 404, 'Not Found', reqId);
    }

    // pull files
    if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'files') {
      const n = parseInt(rest[1], 10);
      const pull = Number.isInteger(n) ? repo.pullByNumber.get(n) : undefined;
      if (pull === undefined) return sendErr(res, 404, 'Not Found', reqId);
      if (method !== 'GET') return sendErr(res, 404, 'Not Found', reqId);
      if (readGate()) return;
      return sendJson(res, 200, diffFiles(repo, pull.baseSha, pull.headSha), reqId);
    }

    // pull merge
    if (rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'merge') {
      const n = parseInt(rest[1], 10);
      const pull = Number.isInteger(n) ? repo.pullByNumber.get(n) : undefined;
      if (pull === undefined) return sendErr(res, 404, 'Not Found', reqId);
      if (method !== 'PUT') return sendErr(res, 404, 'Not Found', reqId);
      if (needAuth()) return;
      const parsed = getBody();
      if (!parsed.ok) return;
      if (pull.state !== 'open') return sendErr(res, 405, 'Pull request is not open', reqId);
      const merged = squashMerge(repo, pull);
      if (!merged.ok) return sendErr(res, 405, merged.reason ?? 'Merge failed', reqId);
      const mergeCommit = merged.sha!;
      const message = 'Merge pull request #' + pull.number + ' from ' + pull.headRef;
      return sendJson(res, 200, { merged: true, sha: mergeCommit, message }, reqId);
    }

    // single pull GET
    if (rest.length === 2 && rest[0] === 'pulls') {
      const n = parseInt(rest[1], 10);
      const pull = Number.isInteger(n) ? repo.pullByNumber.get(n) : undefined;
      if (pull === undefined) return sendErr(res, 404, 'Not Found', reqId);
      if (method !== 'GET') return sendErr(res, 404, 'Not Found', reqId);
      if (readGate()) return;
      if (pull.state === 'open') refreshMergeable(repo, pull);
      return sendRaw(res, 200, pullJson(pull, repo), 'application/json', reqId);
    }
  }

  // anything else under /api/v3
  if (seg.length >= 2 && seg[0] === 'api' && seg[1] === 'v3') {
    return sendErr(res, 404, 'Not Found', reqId);
  }

  return sendErr(res, 404, 'Not Found', reqId);
}
