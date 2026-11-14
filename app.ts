// HTTP server + router. Routing is plain string work (no URL object, no
// framework): the hot paths are a handful of comparisons and Map lookups.
// The server never sends a Date header (sendDate: false) and every reply
// carries X-GitHub-Request-Id.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Store, commitParents } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { nextReqId, parseQuery, readBody, sendErr, sendJson, sendRaw } from './http.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  V2_UPLOAD_AD,
  ZERO_OID,
  fetchCacheKey,
  isDescendant,
  lsRefsAnswer,
  parseAllPktLines,
  parsePack,
  parsePktLines,
  planFetch,
  pktLine,
  sideband,
  v0Advertisement,
  writePack,
} from './git.ts';

function authedOf(req: IncomingMessage): boolean {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') && h.length > 7;
}

function gitNotFound(res: ServerResponse, reqId: string): void {
  sendErr(res, 404, 'Not Found', reqId);
}

function handleInfoRefs(
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  service: string | undefined,
  isV2: boolean,
  authed: boolean,
  reqId: string,
): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return gitNotFound(res, reqId);
  if (!authed && repo.private) return sendErr(res, 401, 'Requires authentication', reqId);
  if (service === 'git-upload-pack') {
    if (isV2) {
      return sendRaw(res, 200, V2_UPLOAD_AD, 'application/x-git-upload-pack-advertisement', reqId);
    }
    return sendRaw(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement', reqId);
  }
  if (service === 'git-receive-pack') {
    return sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement', reqId);
  }
  return sendErr(res, 400, 'service is required', reqId);
}

function handleUploadPack(
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  isV2: boolean,
  authed: boolean,
  reqId: string,
): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return gitNotFound(res, reqId);
  if (!authed && repo.private) return sendErr(res, 401, 'Requires authentication', reqId);
  let lines: string[];
  try {
    lines = parsePktLines(body).lines;
  } catch {
    return sendErr(res, 400, 'malformed request', reqId);
  }
  if (lines.length === 0) return sendErr(res, 400, 'malformed request', reqId);

  if (isV2) {
    const first = lines[0];
    if (first.startsWith('command=ls-refs')) {
      const prefixes: string[] = [];
      let peel = false;
      let symrefs = false;
      for (const line of lines.slice(1)) {
        const arg = line.replace(/\n$/, '');
        if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
        else if (arg === 'peel') peel = true;
        else if (arg === 'symrefs') symrefs = true;
      }
      return sendRaw(res, 200, lsRefsAnswer(repo, prefixes, peel, symrefs), 'application/x-git-upload-pack-result', reqId);
    }
    if (first.startsWith('command=fetch')) {
      const wants: string[] = [];
      const haves = new Set<string>();
      const shallowOld = new Set<string>();
      let depth: number | null = null;
      for (const line of lines.slice(1)) {
        const arg = line.replace(/\n$/, '');
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.add(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallowOld.add(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = parseInt(arg.slice(7), 10) || null;
      }
      if (wants.length === 0) return sendErr(res, 400, 'no want', reqId);
      // acknowledgments (labeled section)
      const ackParts: Buffer[] = [pktLine('acknowledgments\n')];
      if (haves.size === 0) {
        ackParts.push(pktLine('NAK\n'));
      } else {
        let acked = 0;
        for (const h of haves) {
          if (repo.objects.has(h)) {
            ackParts.push(pktLine('ACK ' + h + '\n'));
            acked++;
          }
        }
        if (acked === 0) ackParts.push(pktLine('NAK\n'));
        else ackParts.push(pktLine('ready\n'));
      }
      ackParts.push(PKT_DELIM);
      // pack (cached when the fetch is haves-free and shallow-free)
      const cacheable = haves.size === 0 && shallowOld.size === 0;
      const key = cacheable ? fetchCacheKey(wants, depth) : '';
      let pack = cacheable ? repo.packCache.get(key) : undefined;
      let shallow: string[] = [];
      let unshallow: string[] = [];
      if (pack === undefined) {
        const plan = planFetch(repo, wants, haves, shallowOld, depth);
        shallow = plan.shallow;
        unshallow = plan.unshallow;
        pack = writePack(plan.objects);
        if (cacheable) repo.packCache.set(key, pack);
      } else {
        // cached pack: the shallow boundaries are the depth cutoff of the tip
        if (depth !== null) {
          for (const w of wants) {
            const obj = repo.objects.get(w);
            if (obj !== undefined && obj.type === 'commit') shallow.push(w);
          }
        }
      }
      // shallow-info (labeled section)
      const shallowParts: Buffer[] = [pktLine('shallow-info\n')];
      for (const s of shallow) shallowParts.push(pktLine('shallow ' + s + '\n'));
      for (const s of unshallow) shallowParts.push(pktLine('unshallow ' + s + '\n'));
      shallowParts.push(PKT_DELIM);
      // packfile (labeled section)
      const out = Buffer.concat([...ackParts, ...shallowParts, pktLine('packfile\n'), sideband(pack), PKT_FLUSH]);
      return sendRaw(res, 200, out, 'application/x-git-upload-pack-result', reqId);
    }
    return sendErr(res, 400, 'unknown command', reqId);
  }

  // v0 fetch: want/have/shallow/deepen lines across two flush-separated
  // sections, then the pack. The first want line may carry capabilities
  // space-separated after the oid.
  const allLines = parseAllPktLines(body);
  const wants: string[] = [];
  const haves = new Set<string>();
  const shallowOld = new Set<string>();
  let depth: number | null = null;
  for (const raw of allLines) {
    const line = raw.split('\0')[0].replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const verb = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
    if (verb === 'want') wants.push(rest.split(' ')[0].trim());
    else if (verb === 'have') haves.add(rest.trim());
    else if (verb === 'shallow') shallowOld.add(rest.trim());
    else if (verb === 'deepen') depth = parseInt(rest, 10) || null;
  }
  if (wants.length === 0) return sendErr(res, 400, 'no want', reqId);
  const parts: Buffer[] = [];
  if (haves.size === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    let acked = 0;
    for (const h of haves) {
      if (repo.objects.has(h)) {
        parts.push(pktLine('ACK ' + h + '\n'));
        acked++;
      }
    }
    if (acked === 0) parts.push(pktLine('NAK\n'));
  }
  const plan = planFetch(repo, wants, haves, shallowOld, depth);
  for (const s of plan.shallow) parts.push(pktLine('shallow ' + s + '\n'));
  for (const s of plan.unshallow) parts.push(pktLine('unshallow ' + s + '\n'));
  parts.push(sideband(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result', reqId);
}

function handleReceivePack(
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  authed: boolean,
  reqId: string,
): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return gitNotFound(res, reqId);
  if (!authed && repo.private) return sendErr(res, 401, 'Requires authentication', reqId);
  let lines: string[];
  let packOffset: number;
  try {
    const parsed = parsePktLines(body);
    lines = parsed.lines;
    packOffset = parsed.packOffset;
  } catch {
    return sendErr(res, 400, 'malformed request', reqId);
  }
  // commands: "<old> <new> <ref>" (+ "\0<caps>" on the first line)
  interface Command {
    old: string;
    next: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const raw of lines) {
    const line = raw.split('\0')[0].replace(/\n$/, '');
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (m === null) continue;
    commands.push({ old: m[1], next: m[2], ref: m[3] });
  }
  if (commands.length === 0) return sendErr(res, 400, 'no commands', reqId);
  // unpack + verify the pack first (a refused push still unpacks ok).
  // A delete-only command list carries no pack at all.
  const remaining = body.subarray(packOffset);
  let entries;
  try {
    entries = remaining.length === 0 ? [] : parsePack(remaining);
  } catch {
    return sendErr(res, 400, 'malformed pack', reqId);
  }
  for (const e of entries) {
    repo.objects.set(e.oid, { type: e.type, data: e.data });
    if (e.type === 'commit') {
      repo.parents.set(e.oid, commitParents(e.data));
    }
  }
  const results: string[] = ['unpack ok\n'];
  let changed = false;
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let problem: string | null = null;
    if (cmd.old !== ZERO_OID && current === undefined) problem = 'old value does not match';
    else if (cmd.old !== ZERO_OID && current !== cmd.old) problem = 'old value does not match';
    else if (cmd.old === ZERO_OID && current !== undefined) problem = 'already exists';
    else if (cmd.next === ZERO_OID) {
      // delete: always ok
    } else if (!repo.objects.has(cmd.next)) {
      problem = 'object not found';
    } else if (cmd.old !== ZERO_OID && !isDescendant(repo, cmd.next, cmd.old)) {
      problem = 'non-fast-forward';
    }
    if (problem !== null) {
      results.push('ng ' + cmd.ref + ' ' + problem + '\n');
      continue;
    }
    if (cmd.next === ZERO_OID) repo.refs.delete(cmd.ref);
    else repo.refs.set(cmd.ref, cmd.next);
    changed = true;
    results.push('ok ' + cmd.ref + '\n');
  }
  if (changed) store.touchGit(repo);
  const out = Buffer.concat([sideband(Buffer.from(results.join(''), 'utf8')), PKT_FLUSH]);
  return sendRaw(res, 200, out, 'application/x-git-receive-pack-result', reqId);
}

export function createApp(store: Store): Server {
  const server = createServer({ sendDate: false }, (req, res) => {
    void (async () => {
      const reqId = nextReqId();
      try {
        const method = req.method ?? 'GET';
        const rawUrl = req.url ?? '/';
        const qPos = rawUrl.indexOf('?');
        const path = qPos < 0 ? rawUrl : rawUrl.slice(0, qPos);
        const query = parseQuery(qPos < 0 ? '' : rawUrl.slice(qPos + 1));
        const authed = authedOf(req);
        const seg = path.split('/').filter((s) => s !== '');

        // health
        if (seg.length === 1 && seg[0] === 'healthz') {
          if (method !== 'GET') return sendErr(res, 404, 'Not Found', reqId);
          return sendJson(res, 200, { ok: true }, reqId);
        }

        // MCP
        if (seg.length === 1 && seg[0] === 'mcp') {
          const body = method === 'POST' ? await readBody(req) : null;
          return handleMcp(res, store, authed, reqId, method, body);
        }

        // GraphQL
        if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'graphql') {
          if (method !== 'POST') return sendErr(res, 404, 'Not Found', reqId);
          const body = await readBody(req);
          return handleGraphQL(res, store, authed, reqId, body);
        }

        // REST v3
        if (seg.length >= 2 && seg[0] === 'api' && seg[1] === 'v3') {
          const needsBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
          const body = needsBody ? await readBody(req) : null;
          return handleRest({ req, res, store, authed, reqId, host: req.headers.host ?? 'localhost' }, method, seg, query, body);
        }

        // git smart HTTP: /{owner}/{repo}.git/...
        if (seg.length >= 3 && seg[1].endsWith('.git')) {
          const owner = seg[0];
          const repoName = seg[1].slice(0, -4);
          if (seg[2] === 'info' && seg[3] === 'refs' && method === 'GET') {
            const service = query.get('service');
            const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            return handleInfoRefs(res, store, owner, repoName, service, isV2, authed, reqId);
          }
          if (seg[2] === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            return handleUploadPack(res, store, owner, repoName, body, isV2, authed, reqId);
          }
          if (seg[2] === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            return handleReceivePack(res, store, owner, repoName, body, authed, reqId);
          }
          return sendErr(res, 404, 'Not Found', reqId);
        }

        return sendErr(res, 404, 'Not Found', reqId);
      } catch (err) {
        // never crash the server on a bad request
        try {
          if (!res.headersSent) sendErr(res, 500, 'Internal Server Error', reqId);
          else res.end();
        } catch {
          // ignore
        }
        void err;
      }
    })();
  });
  return server;
}
