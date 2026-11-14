// GraphQL v4 (api.github.com/graphql surface the suite probes): a small
// tokenizer + recursive-descent parser + a type-driven executor over the
// same store the REST layer uses. Supports the documents gh sends:
// viewer, repository, issues (with states/orderBy/cursors), pull requests,
// node(id:), __type introspection and the five mutations.

import type { ServerResponse } from 'node:http';
import { nodeId, parseNodeId, VIEWER_ID, VIEWER_LOGIN } from './store.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { diffFiles, mergeConflicts, squashMerge } from './git.ts';
import { sendErr, sendJson } from './http.ts';

// ---- tokenizer ----

type Tok =
  | { k: 'name'; v: string }
  | { k: 'int'; v: number }
  | { k: 'float'; v: number }
  | { k: 'string'; v: string }
  | { k: 'punct'; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === '"') out += '"';
          else if (e === '\\') out += '\\';
          else if (e === '/') out += '/';
          else if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      toks.push({ k: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
      let isFloat = false;
      if (src[j] === '.' || src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        if (src[j] === '.') {
          j++;
          while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
        }
        if (src[j] === 'e' || src[j] === 'E') {
          j++;
          if (src[j] === '+' || src[j] === '-') j++;
          while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
        }
      }
      const num = Number(src.slice(i, j));
      toks.push(isFloat ? { k: 'float', v: num } : { k: 'int', v: num });
      i = j;
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ k: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      toks.push({ k: 'punct', v: '...' });
      i += 3;
      continue;
    }
    toks.push({ k: 'punct', v: c });
    i++;
  }
  return toks;
}

// ---- AST ----

type Value =
  | { k: 'var'; name: string }
  | { k: 'int'; v: number }
  | { k: 'float'; v: number }
  | { k: 'string'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'enum'; v: string }
  | { k: 'list'; items: Value[] }
  | { k: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldSel {
  kind: 'field';
  alias: string;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selections: Selection[];
}

interface FragmentSel {
  kind: 'fragment';
  name: string | null;
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldSel | FragmentSel;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentSel>;
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok {
    return this.toks[this.pos++];
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.k !== 'punct' || t.v !== v) throw new Error('expected ' + v);
  }
  private isPunct(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.k === 'punct' && t.v === v;
  }
  private name(): string {
    const t = this.next();
    if (t.k !== 'name') throw new Error('expected name');
    return t.v;
  }

  parseDocument(): Document {
    const doc: Document = { operations: [], fragments: new Map() };
    while (this.pos < this.toks.length) {
      const t = this.peek()!;
      if (t.k === 'name' && t.v === 'fragment') {
        this.next();
        const name = this.name();
        const on = this.name(); // 'on'
        if (on !== 'on') throw new Error('expected on');
        const typeCondition = this.name();
        const selections = this.parseSelections();
        doc.fragments.set(name, { kind: 'fragment', name, typeCondition, selections });
      } else if (t.k === 'name' && (t.v === 'query' || t.v === 'mutation')) {
        doc.operations.push(this.parseOperation());
      } else if (t.k === 'punct' && t.v === '{') {
        doc.operations.push({ kind: 'query', name: null, variables: [], selections: this.parseSelections() });
      } else {
        throw new Error('unexpected token in document');
      }
    }
    return doc;
  }

  private parseOperation(): Operation {
    const kind = this.next().v as 'query' | 'mutation';
    let name: string | null = null;
    const t = this.peek();
    if (t !== undefined && t.k === 'name') name = this.next().v;
    const variables: string[] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const vt = this.next();
        if (vt.k === 'punct' && vt.v === '$') {
          variables.push(this.name());
        }
        // skip the type and any default value until ',' or ')'
        let depth = 0;
        while (this.pos < this.toks.length) {
          const x = this.peek()!;
          if (x.k === 'punct' && (x.v === '[' || x.v === '{' || x.v === '(')) depth++;
          if (x.k === 'punct' && (x.v === ']' || x.v === '}' || x.v === ')')) {
            if (depth === 0) break;
            depth--;
          }
          if (depth === 0 && x.k === 'punct' && x.v === ',') break;
          if (depth === 0 && x.k === 'punct' && x.v === '=') {
            this.next();
            this.parseValue();
            continue;
          }
          this.next();
        }
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelections();
    return { kind, name, variables, selections };
  }

  private parseSelections(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!this.isPunct('}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): Selection {
    if (this.isPunct('...')) {
      this.next();
      const t = this.peek();
      if (t !== undefined && t.k === 'name' && t.v === 'on') {
        this.next();
        const typeCondition = this.name();
        const selections = this.parseSelections();
        return { kind: 'fragment', name: null, typeCondition, selections };
      }
      if (t !== undefined && t.k === 'name') {
        const name = this.next().v;
        return { kind: 'fragment', name, typeCondition: null, selections: [] };
      }
      throw new Error('bad fragment');
    }
    let alias = '';
    let name = this.name();
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.name();
    } else {
      alias = name;
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.name();
        this.expectPunct(':');
        const value = this.parseValue();
        args.push({ name: argName, value });
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(')');
    }
    // directives: skip @name[(args)]
    while (this.isPunct('@')) {
      this.next();
      this.name();
      if (this.isPunct('(')) {
        this.next();
        let depth = 1;
        while (depth > 0 && this.pos < this.toks.length) {
          const x = this.next();
          if (x.k === 'punct' && x.v === '(') depth++;
          if (x.k === 'punct' && x.v === ')') depth--;
        }
      }
    }
    let selections: Selection[] = [];
    if (this.isPunct('{')) selections = this.parseSelections();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.k === 'punct' && t.v === '$') return { k: 'var', name: this.name() };
    if (t.k === 'punct' && t.v === '[') {
      const items: Value[] = [];
      while (!this.isPunct(']')) {
        items.push(this.parseValue());
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(']');
      return { k: 'list', items };
    }
    if (t.k === 'punct' && t.v === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.isPunct('}')) {
        const fname = this.name();
        this.expectPunct(':');
        fields.push({ name: fname, value: this.parseValue() });
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct('}');
      return { k: 'object', fields };
    }
    if (t.k === 'string') return { k: 'string', v: t.v };
    if (t.k === 'int') return { k: 'int', v: t.v };
    if (t.k === 'float') return { k: 'float', v: t.v };
    if (t.k === 'name') {
      if (t.v === 'true') return { k: 'bool', v: true };
      if (t.v === 'false') return { k: 'bool', v: false };
      if (t.v === 'null') return { k: 'null' };
      return { k: 'enum', v: t.v };
    }
    throw new Error('unexpected value token');
  }
}

// ---- schema (for __type / __schema) ----

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'repository', 'comments', 'labels', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergedAt', 'mergeCommit', 'files', 'author', 'createdAt', 'updatedAt'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Ref: ['name', 'target'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---- executor ----

interface Tagged {
  __t: string;
  v: unknown;
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentSel>;
}

function tag(t: string, v: unknown): Tagged {
  return { __t: t, v };
}

function argValue(args: Array<{ name: string; value: Value }>, name: string, ctx: Ctx): unknown {
  for (const a of args) {
    if (a.name === name) return resolveValue(a.value, ctx);
  }
  return undefined;
}

function resolveValue(value: Value, ctx: Ctx): unknown {
  switch (value.k) {
    case 'var':
      return ctx.variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return value.v;
    case 'null':
      return null;
    case 'enum':
      return value.v;
    case 'list':
      return value.items.map((i) => resolveValue(i, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = resolveValue(f.value, ctx);
      return out;
    }
  }
}

function issueCursor(issue: Issue): string {
  return Buffer.from('cursor:issue:' + issue.number, 'utf8').toString('base64');
}

function cursorIssueNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:issue:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function resolveIssuesConnection(repo: Repo, args: Array<{ name: string; value: Value }>, ctx: Ctx): Tagged {
  const first = (argValue(args, 'first', ctx) as number | undefined) ?? 100;
  const after = argValue(args, 'after', ctx) as string | undefined;
  const states = argValue(args, 'states', ctx) as string[] | undefined;
  const orderBy = (argValue(args, 'orderBy', ctx) as { field?: string; direction?: string } | undefined) ?? {};
  const field = orderBy.field ?? 'CREATED_AT';
  const direction = orderBy.direction ?? 'DESC';
  let items = [...repo.issues];
  if (states !== undefined && Array.isArray(states)) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    items = items.filter((i) => wanted.has(i.state));
  }
  const key = (i: Issue): number => (field === 'UPDATED_AT' ? i.updatedSeq : field === 'COMMENTS' ? i.commentCount : i.seq);
  items.sort((a, b) => (direction === 'ASC' ? key(a) - key(b) : key(b) - key(a)));
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const n = cursorIssueNumber(after);
    if (n !== null) {
      const idx = items.findIndex((i) => i.number === n);
      if (idx >= 0) start = idx + 1;
    }
  }
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? issueCursor(page[page.length - 1]) : null;
  return tag('IssueConnection', { repo, items: page, hasNextPage, endCursor });
}

function resolvePullFiles(pull: Pull, repo: Repo, args: Array<{ name: string; value: Value }>, ctx: Ctx): Tagged {
  const first = (argValue(args, 'first', ctx) as number | undefined) ?? 100;
  const diff = diffFiles(repo, pull.baseSha, pull.headSha);
  const files = diff.slice(0, first).map((d) => ({ path: d.filename, additions: d.additions, deletions: d.deletions }));
  return tag('PullRequestChangedFileConnection', { files });
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function mergeableOf(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  return mergeConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

function doSquashMerge(repo: Repo, pull: Pull): boolean {
  return squashMerge(repo, pull).ok;
}

/** Resolve one field of a tagged value; returns raw JSON-ready value. */
function resolveField(parent: Tagged, field: FieldSel, ctx: Ctx): unknown {
  const type = parent.__t;
  const name = field.name;
  const args = field.args;
  const v = parent.v as Record<string, unknown>;

  const unknown = (): null => {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
    return null;
  };

  if (type === 'Query') {
    if (name === 'viewer') return tag('User', { login: VIEWER_LOGIN, id: VIEWER_ID });
    if (name === 'repository') {
      const owner = argValue(args, 'owner', ctx) as string | undefined;
      const repoName = argValue(args, 'name', ctx) as string | undefined;
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      const repo = ctx.store.getRepo(owner, repoName);
      return repo === undefined ? null : tag('Repository', repo);
    }
    if (name === 'node') {
      const id = argValue(args, 'id', ctx) as string | undefined;
      if (typeof id !== 'string') return null;
      const parsed = parseNodeId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoById(ctx.store, parseInt(parsed.parts[0], 10));
        return repo === undefined ? null : tag('Repository', repo);
      }
      if (parsed.kind === 'Issue') {
        const repo = findRepoById(ctx.store, parseInt(parsed.parts[0], 10));
        const issue = repo?.issueByNumber.get(parseInt(parsed.parts[1], 10));
        return issue === undefined ? null : tag('Issue', { repo, issue });
      }
      if (parsed.kind === 'PullRequest') {
        const repo = findRepoById(ctx.store, parseInt(parsed.parts[0], 10));
        const pull = repo?.pullByNumber.get(parseInt(parsed.parts[1], 10));
        return pull === undefined ? null : tag('PullRequest', { repo, pull });
      }
      if (parsed.kind === 'User') return tag('User', { login: parsed.parts[0], id: VIEWER_ID });
      return null;
    }
    if (name === '__type') {
      const typeName = argValue(args, 'name', ctx) as string | undefined;
      if (typeof typeName !== 'string') return null;
      if (SCHEMA_FIELDS[typeName] !== undefined) return tag('__Type', { name: typeName, kind: 'OBJECT' });
      if (SCHEMA_ENUMS[typeName] !== undefined) return tag('__Type', { name: typeName, kind: 'ENUM' });
      return null;
    }
    if (name === '__schema') return tag('__Schema', {});
    return unknown();
  }

  if (type === 'Mutation') {
    if (name === 'createIssue') {
      const input = argValue(args, 'input', ctx) as Record<string, unknown> | undefined;
      if (input === undefined) return null;
      const parsed = parseNodeId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.kind === 'Repository' ? findRepoById(ctx.store, parseInt(parsed.parts[0], 10)) : undefined;
      if (repo === undefined) return tag('CreateIssuePayload', { issue: null });
      const now = new Date().toISOString();
      const issue: Issue = {
        number: repo.nextIssue++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        user: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
        seq: repo.issues.length + 1,
        updatedSeq: repo.issues.length + 1,
        commentCount: 0,
        json: null,
      };
      repo.issues.push(issue);
      repo.issueByNumber.set(issue.number, issue);
      return tag('CreateIssuePayload', { issue: tag('Issue', { repo, issue }) });
    }
    if (name === 'closeIssue') {
      const input = argValue(args, 'input', ctx) as Record<string, unknown> | undefined;
      if (input === undefined) return null;
      const parsed = parseNodeId(String(input.issueId ?? ''));
      let found: { repo: Repo; issue: Issue } | null = null;
      if (parsed !== null && parsed.kind === 'Issue') {
        const repo = findRepoById(ctx.store, parseInt(parsed.parts[0], 10));
        const issue = repo?.issueByNumber.get(parseInt(parsed.parts[1], 10));
        if (repo !== undefined && issue !== undefined) found = { repo, issue };
      }
      if (found === null) return tag('CloseIssuePayload', { issue: null });
      found.issue.state = 'closed';
      found.issue.updatedAt = new Date().toISOString();
      found.issue.json = null;
      return tag('CloseIssuePayload', { issue: tag('Issue', found) });
    }
    if (name === 'createPullRequest') {
      const input = argValue(args, 'input', ctx) as Record<string, unknown> | undefined;
      if (input === undefined) return null;
      const parsed = parseNodeId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.kind === 'Repository' ? findRepoById(ctx.store, parseInt(parsed.parts[0], 10)) : undefined;
      if (repo === undefined) return tag('CreatePullRequestPayload', { pullRequest: null });
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get('refs/heads/' + headRef);
      const baseSha = repo.refs.get('refs/heads/' + baseRef);
      if (headSha === undefined || baseSha === undefined) return tag('CreatePullRequestPayload', { pullRequest: null });
      const now = new Date().toISOString();
      const pull: Pull = {
        number: repo.nextPull++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef,
        headSha,
        baseRef,
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
      pull.mergeable = mergeableOf(repo, pull) !== 'CONFLICTING';
      repo.pulls.push(pull);
      repo.pullByNumber.set(pull.number, pull);
      return tag('CreatePullRequestPayload', { pullRequest: tag('PullRequest', { repo, pull }) });
    }
    if (name === 'mergePullRequest') {
      const input = argValue(args, 'input', ctx) as Record<string, unknown> | undefined;
      if (input === undefined) return null;
      const parsed = parseNodeId(String(input.pullRequestId ?? ''));
      let found: { repo: Repo; pull: Pull } | null = null;
      if (parsed !== null && parsed.kind === 'PullRequest') {
        const repo = findRepoById(ctx.store, parseInt(parsed.parts[0], 10));
        const pull = repo?.pullByNumber.get(parseInt(parsed.parts[1], 10));
        if (repo !== undefined && pull !== undefined) found = { repo, pull };
      }
      if (found === null) return tag('MergePullRequestPayload', { pullRequest: null });
      doSquashMerge(found.repo, found.pull);
      return tag('MergePullRequestPayload', { pullRequest: tag('PullRequest', found) });
    }
    if (name === 'addComment') {
      const input = argValue(args, 'input', ctx) as Record<string, unknown> | undefined;
      if (input === undefined) return null;
      const parsed = parseNodeId(String(input.subjectId ?? ''));
      let target: { repo: Repo; issue: Issue } | null = null;
      if (parsed !== null && parsed.kind === 'Issue') {
        const repo = findRepoById(ctx.store, parseInt(parsed.parts[0], 10));
        const issue = repo?.issueByNumber.get(parseInt(parsed.parts[1], 10));
        if (repo !== undefined && issue !== undefined) target = { repo, issue };
      }
      if (target === null) return tag('AddCommentPayload', { commentEdge: null });
      const now = new Date().toISOString();
      const comment = { id: target.repo.nextComment++, body: String(input.body ?? ''), user: VIEWER_LOGIN, createdAt: now, updatedAt: now };
      const list = target.repo.comments.get(target.issue.number) ?? [];
      list.push(comment);
      target.repo.comments.set(target.issue.number, list);
      target.issue.commentCount = list.length;
      target.issue.json = null;
      const node = tag('IssueComment', { repo: target.repo, comment });
      return tag('AddCommentPayload', { commentEdge: tag('IssueCommentEdge', { node }) });
    }
    return unknown();
  }

  if (type === 'User') {
    if (name === 'login') return v.login;
    if (name === 'id') return nodeId('User', String(v.login));
    if (name === 'name') return 'Ada Iversen';
    if (name === 'email') return String(v.login) + '@example.invalid';
    if (name === 'url') return '';
    return unknown();
  }

  if (type === 'Repository') {
    const repo = v as unknown as Repo;
    if (name === 'id') return nodeId('Repository', repo.id);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return repo.owner + '/' + repo.name;
    if (name === 'owner') return tag('User', { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 2000 + repo.id });
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get('refs/heads/' + repo.defaultBranch);
      return tip === undefined ? null : tag('Ref', { name: repo.defaultBranch });
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'description') return repo.description;
    if (name === 'isPrivate') return repo.private;
    if (name === 'createdAt') return repo.createdAt;
    if (name === 'updatedAt') return repo.updatedAt;
    if (name === 'url') return '';
    if (name === 'issue') {
      const n = argValue(args, 'number', ctx) as number | undefined;
      if (typeof n !== 'number') return null;
      const issue = repo.issueByNumber.get(n);
      return issue === undefined ? null : tag('Issue', { repo, issue });
    }
    if (name === 'issues') return resolveIssuesConnection(repo, args, ctx);
    if (name === 'pullRequests') {
      const first = (argValue(args, 'first', ctx) as number | undefined) ?? 100;
      const items = [...repo.pulls].sort((a, b) => b.seq - a.seq).slice(0, first);
      return tag('PullRequestConnection', { repo, items, hasNextPage: false, endCursor: null });
    }
    if (name === 'pullRequest') {
      const n = argValue(args, 'number', ctx) as number | undefined;
      if (typeof n !== 'number') return null;
      const pull = repo.pullByNumber.get(n);
      return pull === undefined ? null : tag('PullRequest', { repo, pull });
    }
    return unknown();
  }

  if (type === 'Ref') {
    if (name === 'name') return v.name;
    if (name === 'target') return null;
    return unknown();
  }

  if (type === 'Issue') {
    const { repo, issue } = v as { repo: Repo; issue: Issue };
    if (name === 'id') return nodeId('Issue', repo.id, issue.number);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return issue.state.toUpperCase();
    if (name === 'createdAt') return issue.createdAt;
    if (name === 'updatedAt') return issue.updatedAt;
    if (name === 'author') return tag('User', { login: issue.user, id: VIEWER_ID });
    if (name === 'repository') return tag('Repository', repo);
    if (name === 'url') return '';
    return unknown();
  }

  if (type === 'IssueConnection') {
    const conn = v as { repo: Repo; items: Issue[]; hasNextPage: boolean; endCursor: string | null };
    if (name === 'nodes') return conn.items.map((issue) => tag('Issue', { repo: conn.repo, issue }));
    if (name === 'edges') return conn.items.map((issue) => tag('IssueEdge', { repo: conn.repo, issue }));
    if (name === 'pageInfo') return tag('PageInfo', { hasNextPage: conn.hasNextPage, hasPreviousPage: false, startCursor: conn.items.length > 0 ? issueCursor(conn.items[0]) : null, endCursor: conn.endCursor });
    if (name === 'totalCount') return conn.repo.issues.length;
    return unknown();
  }

  if (type === 'IssueEdge') {
    const { repo, issue } = v as { repo: Repo; issue: Issue };
    if (name === 'node') return tag('Issue', { repo, issue });
    if (name === 'cursor') return issueCursor(issue);
    return unknown();
  }

  if (type === 'PageInfo') {
    if (name === 'hasNextPage') return v.hasNextPage;
    if (name === 'hasPreviousPage') return v.hasPreviousPage;
    if (name === 'startCursor') return v.startCursor;
    if (name === 'endCursor') return v.endCursor;
    return unknown();
  }

  if (type === 'PullRequest') {
    const { repo, pull } = v as { repo: Repo; pull: Pull };
    if (name === 'id') return nodeId('PullRequest', repo.id, pull.number);
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return pull.state === 'merged' ? 'MERGED' : pull.state.toUpperCase();
    if (name === 'merged') return pull.merged;
    if (name === 'mergeable') return mergeableOf(repo, pull);
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'headRefOid') return pull.headSha;
    if (name === 'baseRefOid') return pull.baseSha;
    if (name === 'mergedAt') return pull.mergedAt;
    if (name === 'mergeCommit') return pull.mergeCommitSha === null ? null : tag('Commit', { sha: pull.mergeCommitSha });
    if (name === 'files') return resolvePullFiles(pull, repo, args, ctx);
    if (name === 'author') return tag('User', { login: pull.user, id: VIEWER_ID });
    if (name === 'createdAt') return pull.createdAt;
    if (name === 'updatedAt') return pull.updatedAt;
    return unknown();
  }

  if (type === 'PullRequestConnection') {
    const conn = v as { repo: Repo; items: Pull[]; hasNextPage: boolean; endCursor: string | null };
    if (name === 'nodes') return conn.items.map((pull) => tag('PullRequest', { repo: conn.repo, pull }));
    if (name === 'edges') return conn.items.map((pull) => tag('PullRequestEdge', { repo: conn.repo, pull }));
    if (name === 'pageInfo') return tag('PageInfo', { hasNextPage: conn.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: conn.endCursor });
    if (name === 'totalCount') return conn.repo.pulls.length;
    return unknown();
  }

  if (type === 'PullRequestEdge') {
    const { repo, pull } = v as { repo: Repo; pull: Pull };
    if (name === 'node') return tag('PullRequest', { repo, pull });
    if (name === 'cursor') return Buffer.from('cursor:pull:' + pull.number, 'utf8').toString('base64');
    return unknown();
  }

  if (type === 'PullRequestChangedFileConnection') {
    const conn = v as { files: Array<{ path: string; additions: number; deletions: number }> };
    if (name === 'nodes') return conn.files.map((f) => tag('PullRequestChangedFile', f));
    if (name === 'edges') return conn.files.map((f) => tag('PullRequestChangedFileEdge', { file: f }));
    if (name === 'pageInfo') return tag('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null });
    if (name === 'totalCount') return conn.files.length;
    return unknown();
  }

  if (type === 'PullRequestChangedFile') {
    const f = v as { path: string; additions: number; deletions: number };
    if (name === 'path') return f.path;
    if (name === 'additions') return f.additions;
    if (name === 'deletions') return f.deletions;
    if (name === 'changeType') return 'MODIFIED';
    return unknown();
  }

  if (type === 'PullRequestChangedFileEdge') {
    const { file } = v as { file: { path: string; additions: number; deletions: number } };
    if (name === 'node') return tag('PullRequestChangedFile', file);
    if (name === 'cursor') return Buffer.from('cursor:file:' + file.path, 'utf8').toString('base64');
    return unknown();
  }

  if (type === '__Type') {
    const t = v as { name: string; kind: string };
    if (name === 'name') return t.name;
    if (name === 'kind') return t.kind;
    if (name === 'description') return '';
    if (name === 'fields') {
      const fields = SCHEMA_FIELDS[t.name] ?? [];
      return fields.map((f) => tag('__Field', { name: f }));
    }
    if (name === 'enumValues') {
      const values = SCHEMA_ENUMS[t.name] ?? [];
      return values.map((e) => tag('__EnumValue', { name: e }));
    }
    return unknown();
  }

  if (type === '__Field') {
    if (name === 'name') return v.name;
    if (name === 'description') return '';
    return unknown();
  }

  if (type === '__EnumValue') {
    if (name === 'name') return v.name;
    if (name === 'description') return '';
    return unknown();
  }

  if (type === '__Schema') {
    if (name === 'types') {
      const names = [...Object.keys(SCHEMA_FIELDS), ...Object.keys(SCHEMA_ENUMS)];
      return names.map((n) => tag('__Type', { name: n, kind: SCHEMA_ENUMS[n] !== undefined ? 'ENUM' : 'OBJECT' }));
    }
    if (name === 'queryType') return tag('__Type', { name: 'Query', kind: 'OBJECT' });
    if (name === 'mutationType') return tag('__Type', { name: 'Mutation', kind: 'OBJECT' });
    return unknown();
  }

  if (type === 'IssueComment') {
    const { repo, comment } = v as { repo: Repo; comment: { id: number; body: string; user: string; createdAt: string; updatedAt: string } };
    if (name === 'id') return nodeId('IssueComment', repo.id, comment.id);
    if (name === 'body') return comment.body;
    if (name === 'author') return tag('User', { login: comment.user, id: VIEWER_ID });
    if (name === 'createdAt') return comment.createdAt;
    if (name === 'updatedAt') return comment.updatedAt;
    return unknown();
  }

  if (type === 'IssueCommentEdge') {
    const { node } = v as { node: Tagged };
    if (name === 'node') return node;
    if (name === 'cursor') return '';
    return unknown();
  }

  // payload wrappers: resolve the named child field
  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (name === 'issue') return (v as { issue: unknown }).issue;
    if (name === 'clientMutationId') return null;
    return unknown();
  }
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return (v as { pullRequest: unknown }).pullRequest;
    if (name === 'clientMutationId') return null;
    return unknown();
  }
  if (type === 'AddCommentPayload') {
    if (name === 'commentEdge') return (v as { commentEdge: unknown }).commentEdge;
    if (name === 'clientMutationId') return null;
    return unknown();
  }
  if (type === 'Commit') {
    if (name === 'oid') return (v as { sha: string }).sha;
    return unknown();
  }

  return unknown();
}

/** Execute a selection set against a tagged value into a plain object. */
function executeSelections(selections: Selection[], parent: Tagged, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.name !== null) {
        const frag = ctx.fragments.get(sel.name);
        if (frag !== undefined && (frag.typeCondition === null || frag.typeCondition === parent.__t)) {
          Object.assign(out, executeSelections(frag.selections, parent, ctx));
        }
      } else if (sel.typeCondition === null || sel.typeCondition === parent.__t) {
        Object.assign(out, executeSelections(sel.selections, parent, ctx));
      }
      continue;
    }
    const value = resolveField(parent, sel, ctx);
    if (value === null || value === undefined) {
      out[sel.alias] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[sel.alias] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__t' in item) {
          return executeSelections(sel.selections, item as Tagged, ctx);
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__t' in (value as Record<string, unknown>)) {
      out[sel.alias] = executeSelections(sel.selections, value as Tagged, ctx);
      continue;
    }
    out[sel.alias] = value;
  }
  return out;
}

function executeDocument(doc: Document, operationName: string | undefined, variables: Record<string, unknown>, store: Store): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: Ctx = { store, variables, errors: [], fragments: doc.fragments };
  let op: Operation | undefined;
  if (operationName !== undefined) op = doc.operations.find((o) => o.name === operationName);
  if (op === undefined) op = doc.operations[0];
  if (op === undefined) {
    return { data: null, errors: [{ message: 'No operation provided.' }] };
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(op.selections, tag(rootType, {}), ctx);
  return { data, errors: ctx.errors };
}

// ---- HTTP handler ----

export function handleGraphQL(
  res: ServerResponse,
  store: Store,
  authed: boolean,
  reqId: string,
  body: Buffer | null,
): void {
  if (!authed) {
    sendErr(res, 401, 'Requires authentication', reqId);
    return;
  }
  if (body === null || body.length === 0) {
    sendErr(res, 400, 'Problems parsing JSON', reqId);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendErr(res, 400, 'Problems parsing JSON', reqId);
    return;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return { errors: [{ message: 'Expected a GraphQL document object.' }] };
    }
    const d = doc as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof d.query !== 'string') {
      return { errors: [{ message: 'Expected a query string.' }] };
    }
    let document: Document;
    try {
      document = new Parser(tokenize(d.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: 'Syntax Error: ' + (err as Error).message }] };
    }
    const variables = typeof d.variables === 'object' && d.variables !== null ? (d.variables as Record<string, unknown>) : {};
    const result = executeDocument(document, typeof d.operationName === 'string' ? d.operationName : undefined, variables, store);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map(runOne);
    sendJson(res, 200, results, reqId);
    return;
  }
  sendJson(res, 200, runOne(parsed), reqId);
}
