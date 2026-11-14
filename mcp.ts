// MCP (Model Context Protocol) over streamable HTTP at POST /mcp:
// both the modern 2026-07-28 era (server/discover) and the legacy
// 2025-11-25 handshake (initialize + notifications/initialized), six
// github-mcp-server tools, plain JSON answers (no SSE needed — the client
// reads a JSON-RPC body either way).

import type { ServerResponse } from 'node:http';
import { VIEWER_LOGIN } from './store.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { squashMerge } from './git.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';
import { sendErr, sendRaw } from './http.ts';

const SERVER_NAME = 'ghclone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Byte-identical tools/list answer, serialized once. */
const TOOLS_LIST_JSON = Buffer.from(
  JSON.stringify({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }),
  'utf8',
);

const DISCOVER_RESULT = {
  resultType: 'discover',
  supportedVersions: SUPPORTED_VERSIONS,
  capabilities: { tools: {} },
  instructions: 'GitHub-compatible forge over MCP.',
  serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

type RpcId = string | number | null;

function rpcResult(res: ServerResponse, id: RpcId, result: unknown, reqId: string): void {
  sendRaw(res, 200, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8'), 'application/json', reqId);
}

function rpcError(res: ServerResponse, status: number, id: RpcId, code: number, message: string, reqId: string): void {
  sendRaw(res, status, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), 'utf8'), 'application/json', reqId);
}

/** Execute one tool; returns the text payload or an error string. */
function callTool(store: Store, name: string, args: Record<string, unknown>): { ok: boolean; text: string } {
  const missing = (field: string): { ok: boolean; text: string } => ({ ok: false, text: `Missing required argument: ${field}` });
  const repoOf = (owner: string, repoName: string): Repo | undefined => store.getRepo(owner, repoName);

  if (name === 'create_repo') {
    const repoName = str(args.name);
    if (repoName === '') return missing('name');
    if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return { ok: false, text: 'Repository already exists' };
    const repo = store.createRepo(VIEWER_LOGIN, repoName, str(args.description), typeof args.private === 'boolean' ? args.private : false);
    return { ok: true, text: JSON.stringify(repoJson(repo)) };
  }
  if (name === 'get_repo') {
    const owner = str(args.owner);
    const repoName = str(args.repo);
    if (owner === '') return missing('owner');
    if (repoName === '') return missing('repo');
    const repo = repoOf(owner, repoName);
    if (repo === undefined) return { ok: false, text: 'Repository not found' };
    return { ok: true, text: JSON.stringify(repoJson(repo)) };
  }
  if (name === 'create_issue') {
    const owner = str(args.owner);
    const repoName = str(args.repo);
    const title = str(args.title);
    if (owner === '') return missing('owner');
    if (repoName === '') return missing('repo');
    if (title === '') return missing('title');
    const repo = repoOf(owner, repoName);
    if (repo === undefined) return { ok: false, text: 'Repository not found' };
    const now = new Date().toISOString();
    const issue: Issue = {
      number: repo.nextIssue++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
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
    return { ok: true, text: issueJson(issue, repo).toString('utf8') };
  }
  if (name === 'list_issues') {
    const owner = str(args.owner);
    const repoName = str(args.repo);
    if (owner === '') return missing('owner');
    if (repoName === '') return missing('repo');
    const repo = repoOf(owner, repoName);
    if (repo === undefined) return { ok: false, text: 'Repository not found' };
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((i) => state === 'all' || i.state === state);
    const text = '[' + list.map((i) => issueJson(i, repo).toString('utf8')).join(',') + ']';
    return { ok: true, text };
  }
  if (name === 'create_pull_request') {
    const owner = str(args.owner);
    const repoName = str(args.repo);
    const title = str(args.title);
    const head = str(args.head);
    const base = str(args.base);
    if (owner === '') return missing('owner');
    if (repoName === '') return missing('repo');
    if (title === '') return missing('title');
    if (head === '') return missing('head');
    if (base === '') return missing('base');
    const repo = repoOf(owner, repoName);
    if (repo === undefined) return { ok: false, text: 'Repository not found' };
    const headSha = repo.refs.get('refs/heads/' + head);
    const baseSha = repo.refs.get('refs/heads/' + base);
    if (headSha === undefined || baseSha === undefined) return { ok: false, text: 'head or base branch does not exist' };
    const now = new Date().toISOString();
    const pull: Pull = {
      number: repo.nextPull++,
      title,
      body: '',
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
    repo.pulls.push(pull);
    repo.pullByNumber.set(pull.number, pull);
    return { ok: true, text: pullJson(pull, repo).toString('utf8') };
  }
  if (name === 'merge_pull_request') {
    const owner = str(args.owner);
    const repoName = str(args.repo);
    const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : -1;
    if (owner === '') return missing('owner');
    if (repoName === '') return missing('repo');
    if (pullNumber < 1) return missing('pull_number');
    const repo = repoOf(owner, repoName);
    if (repo === undefined) return { ok: false, text: 'Repository not found' };
    const pull = repo.pullByNumber.get(pullNumber);
    if (pull === undefined) return { ok: false, text: 'Pull request not found' };
    const merged = squashMerge(repo, pull);
    if (!merged.ok) return { ok: false, text: merged.reason ?? 'Merge failed' };
    return { ok: true, text: JSON.stringify({ merged: true, sha: merged.sha, message: 'Merge pull request #' + pull.number + ' from ' + pull.headRef }) };
  }
  return { ok: false, text: `Unknown tool: ${name}` };
}

export function handleMcp(res: ServerResponse, store: Store, authed: boolean, reqId: string, method: string, body: Buffer | null): void {
  if (method !== 'POST') {
    sendErr(res, 405, 'Method Not Allowed', reqId);
    return;
  }
  if (!authed) {
    sendErr(res, 401, 'Requires authentication', reqId);
    return;
  }
  if (body === null || body.length === 0) {
    rpcError(res, 400, null, -32700, 'Parse error', reqId);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error', reqId);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    rpcError(res, 400, null, -32600, 'Invalid Request', reqId);
    return;
  }
  const req = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: RpcId = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
  const rpcMethod = typeof req.method === 'string' ? req.method : '';
  const params = isRecord(req.params) ? req.params : {};

  // Notifications carry no id and get no JSON-RPC answer.
  if (id === null) {
    sendRaw(res, 202, Buffer.from('{}', 'utf8'), 'application/json', reqId);
    return;
  }

  if (rpcMethod === 'server/discover') {
    return rpcResult(res, id, DISCOVER_RESULT, reqId);
  }
  if (rpcMethod === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
    return rpcResult(res, id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }, reqId);
  }
  if (rpcMethod === 'ping') {
    return rpcResult(res, id, {}, reqId);
  }
  if (rpcMethod === 'tools/list') {
    // byte-identical every time (the same Buffer is sent)
    sendRaw(res, 200, Buffer.concat([Buffer.from(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":`, 'utf8'), TOOLS_LIST_JSON, Buffer.from('}', 'utf8')]), 'application/json', reqId);
    return;
  }
  if (rpcMethod === 'tools/call') {
    const toolName = str(params.name);
    const args = isRecord(params.arguments) ? params.arguments : {};
    const known = TOOLS.some((t) => t.name === toolName);
    if (!known) {
      return rpcError(res, 200, id, -32602, `Unknown tool: ${toolName}`, reqId);
    }
    const def = TOOLS.find((t) => t.name === toolName)!;
    for (const required of def.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return rpcResult(res, id, { content: [{ type: 'text', text: `Missing required argument: ${required}` }], isError: true }, reqId);
      }
    }
    const outcome = callTool(store, toolName, args);
    return rpcResult(res, id, { content: [{ type: 'text', text: outcome.text }], isError: !outcome.ok }, reqId);
  }
  return rpcError(res, 200, id, -32601, `Method not found: ${rpcMethod}`, reqId);
}
