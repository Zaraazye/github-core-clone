// Git smart-HTTP engine: object model, pack read/write (full + delta),
// pkt-line framing, v0/v2 advertisements, ls-refs, fetch selection and
// receive-pack. All objects are stored as raw Buffers so anything the
// client pushed round-trips byte-exactly.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { commitParents, commitTree, sortedRefs } from './store.ts';
import type { GitObj, GitObjectType, Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
export const PKT_FLUSH = Buffer.from('0000');
export const PKT_DELIM = Buffer.from('0001');

const TYPE_NUM: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Object id for a loose object: sha1("<type> <size>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(type + ' ' + data.length + '\0', 'latin1');
  return sha1Hex(Buffer.concat([head, data]));
}

/** One pkt-line: 4 hex digits of (payload length + 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** Split a sideband payload into band-1 pkt-lines (<= 32768 payload bytes). */
export function sideband(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const MAX = 32768;
  for (let off = 0; off < pack.length; off += MAX) {
    const slice = pack.subarray(off, Math.min(off + MAX, pack.length));
    const pkt = Buffer.alloc(4 + 1 + slice.length);
    pkt.write((5 + slice.length).toString(16).padStart(4, '0'), 'ascii');
    pkt[4] = 1;
    slice.copy(pkt, 5);
    chunks.push(pkt);
  }
  return Buffer.concat(chunks);
}

/** Inflate one zlib stream starting at `offset`; returns bytes + next offset. */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

interface PackEntry {
  oid: string;
  type: GitObjectType;
  data: Buffer;
}

interface DeltaEntry {
  offset: number;
  baseOffset: number | null;
  baseOid: string | null;
  data: Buffer;
  size: number;
}

/** Read a varint size/type header at `pos`; returns type, size, next pos. */
function readEntryHeader(buf: Buffer, pos: number): { typeNum: number; size: number; next: number } {
  const b0 = buf[pos++];
  const typeNum = (b0 >> 4) & 7;
  let size = b0 & 15;
  let shift = 4;
  let b = b0;
  while (b & 0x80) {
    b = buf[pos++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { typeNum, size, next: pos };
}

/** Read an ofs-delta negative offset varint. */
function readOfsOffset(buf: Buffer, pos: number): { offset: number; next: number } {
  let b = buf[pos++];
  let off = b & 0x7f;
  while (b & 0x80) {
    b = buf[pos++];
    off = ((off + 1) << 7) | (b & 0x7f);
  }
  return { offset: off, next: pos };
}

/** Read a delta size varint. */
function readDeltaSize(buf: Buffer, pos: number): { size: number; next: number } {
  let size = 0;
  let shift = 0;
  let b: number;
  do {
    b = buf[pos++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return { size, next: pos };
}

/** Apply a git delta to a base object; returns the reconstructed bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readDeltaSize(delta, pos);
  pos = src.next;
  if (src.size !== base.length) throw new Error('delta source size mismatch');
  const tgt = readDeltaSize(delta, pos);
  pos = tgt.next;
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off = delta[pos++];
      if (op & 0x02) off |= delta[pos++] << 8;
      if (op & 0x04) off |= delta[pos++] << 16;
      if (op & 0x08) off |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      total += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== tgt.size) throw new Error('delta target size mismatch');
  return Buffer.concat(out, total);
}

/**
 * Parse a whole pack. Returns every object (full + delta-resolved). Throws
 * on any malformed input; the caller turns that into a 400, never a crash.
 */
export function parsePack(buf: Buffer): PackEntry[] {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const deltas: DeltaEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const start = pos;
    const head = readEntryHeader(buf, pos);
    pos = head.next;
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (head.typeNum === 6) {
      const r = readOfsOffset(buf, pos);
      pos = r.next;
      baseOffset = start - r.offset;
    } else if (head.typeNum === 7) {
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateAt(buf, pos);
    pos = inflated.next;
    if (inflated.data.length !== head.size) throw new Error('pack entry size mismatch');
    if (head.typeNum === 6 || head.typeNum === 7) {
      deltas.push({ offset: start, baseOffset, baseOid, data: inflated.data, size: head.size });
    } else {
      const type = NUM_TYPE[head.typeNum];
      if (type === undefined) throw new Error('unknown pack entry type ' + head.typeNum);
      const entry: PackEntry = { oid: hashObject(type, inflated.data), type, data: inflated.data };
      entries.push(entry);
      byOffset.set(start, entry);
    }
  }
  // Resolve deltas (a delta may chain onto another delta; iterate until done).
  const byOid = new Map<string, PackEntry>();
  for (const e of entries) byOid.set(e.oid, e);
  let pending = deltas;
  for (let round = 0; round < 16 && pending.length > 0; round++) {
    const next: DeltaEntry[] = [];
    for (const d of pending) {
      let base: PackEntry | undefined;
      if (d.baseOffset !== null) base = byOffset.get(d.baseOffset);
      else if (d.baseOid !== null) base = byOid.get(d.baseOid);
      if (base === undefined) {
        next.push(d);
        continue;
      }
      const data = applyDelta(base.data, d.data);
      const entry: PackEntry = { oid: hashObject(base.type, data), type: base.type, data };
      entries.push(entry);
      byOid.set(entry.oid, entry);
      byOffset.set(d.offset, entry);
    }
    pending = next;
  }
  if (pending.length > 0) throw new Error('unresolved pack delta');
  return entries;
}

/** Serialize objects as a pack (all full entries, deflate level 1). */
export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const typeNum = TYPE_NUM[obj.type];
    const size = obj.data.length;
    const hdr: number[] = [];
    let b = (typeNum << 4) | (size & 15);
    let rest = size >> 4;
    if (rest > 0) b |= 0x80;
    hdr.push(b);
    while (rest > 0) {
      let nb = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) nb |= 0x80;
      hdr.push(nb);
    }
    parts.push(Buffer.from(hdr));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---- trees ----

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    const mode = data.toString('latin1', pos, sp);
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directories compare as if their name ended in '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.sort((a, b) => {
    const ka = a.mode === '40000' ? a.name + '/' : a.name;
    const kb = b.mode === '40000' ? b.name + '/' : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of sortTreeEntries(entries)) {
    const head = Buffer.from(e.mode + ' ' + e.name + '\0', 'utf8');
    const oid = Buffer.from(e.oid, 'hex');
    parts.push(Buffer.concat([head, oid]));
  }
  return Buffer.concat(parts);
}

/** Store a tree object in the repo; returns its oid. */
export function storeTree(repo: Repo, entries: TreeEntry[]): string {
  const data = serializeTree(entries);
  const oid = hashObject('tree', data);
  repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

/** Build a commit object, store it, return its oid. */
export function storeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  let text = 'tree ' + treeOid + '\n';
  for (const p of parents) text += 'parent ' + p + '\n';
  text += 'author adaiversen <adaiversen@example.invalid> 1735689600 +0000\n';
  text += 'committer adaiversen <adaiversen@example.invalid> 1735689600 +0000\n\n';
  text += message.endsWith('\n') ? message : message + '\n';
  const data = Buffer.from(text, 'utf8');
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  repo.parents.set(oid, [...parents]);
  return oid;
}

/** Store a blob; returns its oid. */
export function storeBlob(repo: Repo, data: Buffer): string {
  const oid = hashObject('blob', data);
  repo.objects.set(oid, { type: 'blob', data });
  return oid;
}

/**
 * Set (or replace) the file at `segments` inside the tree `treeOid`
 * (null = no tree yet). Returns the new tree oid.
 */
export function treeSetPath(repo: Repo, treeOid: string | null, segments: string[], blobOid: string): string {
  const entries: TreeEntry[] = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
  const [head, ...rest] = segments;
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    const entry: TreeEntry = { mode: '100644', name: head, oid: blobOid };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
  } else {
    let subOid: string | null = null;
    if (idx >= 0 && entries[idx].mode === '40000') subOid = entries[idx].oid;
    const newSub = treeSetPath(repo, subOid, rest, blobOid);
    const entry: TreeEntry = { mode: '40000', name: head, oid: newSub };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
  }
  return storeTree(repo, entries);
}

/** Remove the file at `segments` from the tree; returns the new tree oid. */
export function treeDeletePath(repo: Repo, treeOid: string | null, segments: string[]): string | null {
  if (treeOid === null) return null;
  const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
  const [head, ...rest] = segments;
  const idx = entries.findIndex((e) => e.name === head);
  if (idx < 0) return treeOid;
  if (rest.length === 0) {
    entries.splice(idx, 1);
  } else {
    if (entries[idx].mode !== '40000') return treeOid;
    const sub = treeDeletePath(repo, entries[idx].oid, rest);
    if (sub === null) entries.splice(idx, 1);
    else entries[idx] = { mode: '40000', name: head, oid: sub };
  }
  return storeTree(repo, entries);
}

/** Resolve a path inside a tree: file/blob, dir/tree, or null. */
export function treeGetPath(
  repo: Repo,
  treeOid: string | null,
  segments: string[],
): { kind: 'file' | 'dir'; oid: string } | null {
  if (treeOid === null) return null;
  let current: string | null = treeOid;
  for (let i = 0; i < segments.length; i++) {
    if (current === null) return null;
    const entries = parseTree(repo.objects.get(current)?.data ?? Buffer.alloc(0));
    const found = entries.find((e) => e.name === segments[i]);
    if (found === undefined) return null;
    if (i === segments.length - 1) {
      return found.mode === '40000' ? { kind: 'dir', oid: found.oid } : { kind: 'file', oid: found.oid };
    }
    if (found.mode !== '40000') return null;
    current = found.oid;
  }
  return null;
}

/** All ancestors of `oids` (inclusive), using the cached parent map. */
export function commitClosure(repo: Repo, oids: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...oids];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    let parents = repo.parents.get(oid);
    if (parents === undefined) {
      parents = commitParents(obj.data);
      repo.parents.set(oid, parents);
    }
    for (const p of parents) stack.push(p);
  }
  return seen;
}

/** Collect a commit's tree closure (trees + blobs) into `out`. */
function collectTreeObjects(repo: Repo, treeOid: string, out: Map<string, GitObj>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined) return;
  if (out.has(treeOid)) return;
  out.set(treeOid, obj);
  if (obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') collectTreeObjects(repo, e.oid, out);
    else {
      const blob = repo.objects.get(e.oid);
      if (blob !== undefined) out.set(e.oid, blob);
    }
  }
}

export interface FetchPlan {
  /** objects to send (commit + tree + blob), in pack order */
  objects: Array<{ type: GitObjectType; data: Buffer }>;
  /** new shallow boundaries (commits at the depth cutoff) */
  shallow: string[];
  /** old boundaries whose parents are now included */
  unshallow: string[];
}

/** The target oid of an annotated tag object, or null. */
export function tagTarget(data: Buffer): string | null {
  const text = data.toString('latin1');
  const m = /^object ([0-9a-f]{40})\n/.exec(text);
  return m ? m[1] : null;
}

/**
 * The fetch object-selection algorithm: walk the wants with generations,
 * honouring haves and old shallow boundaries, and honouring `depth`.
 *
 * Held commits are the ancestors of the haves MINUS the ancestors of the
 * old shallow boundaries' parents (a shallow boundary's parents are NOT
 * held — that is exactly what a deepen fetch delivers).
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  shallowOld: Set<string>,
  depth: number | null,
): FetchPlan {
  const H = commitClosure(repo, haves);
  const parentsOfS: string[] = [];
  for (const s of shallowOld) {
    const obj = repo.objects.get(s);
    if (obj !== undefined && obj.type === 'commit') {
      let parents = repo.parents.get(s);
      if (parents === undefined) {
        parents = commitParents(obj.data);
        repo.parents.set(s, parents);
      }
      parentsOfS.push(...parents);
    }
  }
  const PS = commitClosure(repo, parentsOfS);
  const heldCommits = new Set<string>();
  for (const c of H) if (!PS.has(c)) heldCommits.add(c);

  // Resolve tag wants: a tag object is sent itself, and its target commit
  // is walked as a want (tags can nest).
  const tagObjects = new Set<string>();
  const commitWants: string[] = [];
  for (const want of wants) {
    let oid = want;
    for (let guard = 0; guard < 8; guard++) {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tag') break;
      tagObjects.add(oid);
      const target = tagTarget(obj.data);
      if (target === null) break;
      oid = target;
    }
    commitWants.push(oid);
  }

  const included = new Set<string>();
  const newBoundaries = new Set<string>();
  // walk: [oid, generation]; generation 1 = the want itself
  const stack: Array<[string, number]> = commitWants.map((w) => [w, 1] as [string, number]);
  const visited = new Set<string>();
  while (stack.length > 0) {
    const [oid, gen] = stack.pop()!;
    const key = oid + ':' + gen;
    if (visited.has(key)) continue;
    visited.add(key);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (heldCommits.has(oid) && !shallowOld.has(oid)) continue; // held: excluded, not traversed
    if (heldCommits.has(oid) && shallowOld.has(oid)) {
      // held boundary: excluded, but traversed (deepen)
      let parents = repo.parents.get(oid);
      if (parents === undefined) {
        parents = commitParents(obj.data);
        repo.parents.set(oid, parents);
      }
      for (const p of parents) stack.push([p, gen + 1]);
      continue;
    }
    // not held: include when depth allows
    if (depth !== null && gen > depth) continue;
    included.add(oid);
    let parents = repo.parents.get(oid);
    if (parents === undefined) {
      parents = commitParents(obj.data);
      repo.parents.set(oid, parents);
    }
    if (depth !== null && gen === depth) {
      newBoundaries.add(oid);
      continue; // boundary: do not traverse parents
    }
    for (const p of parents) stack.push([p, gen + 1]);
  }

  const unshallow: string[] = [];
  for (const s of shallowOld) {
    const obj = repo.objects.get(s);
    if (obj === undefined) continue;
    let parents = repo.parents.get(s);
    if (parents === undefined) {
      parents = commitParents(obj.data);
      repo.parents.set(s, parents);
    }
    if (parents.some((p) => included.has(p))) unshallow.push(s);
  }

  // objects needed = tag objects + closure of included commits
  const needed = new Map<string, GitObj>();
  for (const oid of tagObjects) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) needed.set(oid, obj);
  }
  for (const oid of included) {
    const commit = repo.objects.get(oid);
    if (commit === undefined) continue;
    needed.set(oid, commit);
    const tree = commitTree(commit.data);
    if (tree !== null) collectTreeObjects(repo, tree, needed);
  }
  // objects held = closure of held commits
  const heldObjects = new Map<string, GitObj>();
  for (const oid of heldCommits) {
    const commit = repo.objects.get(oid);
    if (commit === undefined) continue;
    heldObjects.set(oid, commit);
    const tree = commitTree(commit.data);
    if (tree !== null) collectTreeObjects(repo, tree, heldObjects);
  }
  const objects: Array<{ type: GitObjectType; data: Buffer }> = [];
  for (const [oid, obj] of needed) {
    if (!heldObjects.has(oid)) objects.push({ type: obj.type, data: obj.data });
  }
  return { objects, shallow: [...newBoundaries], unshallow };
}

/** Cache key for a fetch pack: only haves-free, shallow-free fetches cache. */
export function fetchCacheKey(wants: string[], depth: number | null): string {
  return [...wants].sort().join(',') + '|' + (depth === null ? '' : String(depth));
}

/** Fast-forward check: does `from` descend from `to` (or equal)? */
export function isDescendant(repo: Repo, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    let parents = repo.parents.get(oid);
    if (parents === undefined) {
      parents = commitParents(obj.data);
      repo.parents.set(oid, parents);
    }
    for (const p of parents) {
      if (p === to) return true;
      stack.push(p);
    }
  }
  return false;
}

// ---- advertisements ----

/** The v2 upload-pack advertisement: constant for every repo. */
export const V2_UPLOAD_AD: Buffer = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  PKT_FLUSH,
  pktLine('version 2\n'),
  pktLine('agent=ghclone/1.0\n'),
  pktLine('ls-refs\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

/** The peeled target of an annotated tag ref, or null. */
function peeledTarget(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const text = obj.data.toString('latin1');
  const m = /^object ([0-9a-f]{40})\n/m.exec(text);
  return m ? m[1] : null;
}

/** v0 advertisement for a service; cached on the repo. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const cached = service === 'git-upload-pack' ? repo.v0UploadAd : repo.v0ReceiveAd;
  if (cached !== null) return cached;
  const refs = sortedRefs(repo);
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k shallow thin-pack ofs-delta agent=ghclone/1.0 symref=HEAD:refs/heads/main'
      : 'report-status side-band-64k delete-refs agent=ghclone/1.0 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine('# service=' + service + '\n'), PKT_FLUSH];
  const headOid = repo.refs.get('refs/heads/' + repo.defaultBranch) ?? repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pktLine(ZERO_OID + ' capabilities^{}\0' + caps + '\n'));
  } else {
    const head = headOid ?? refs[0][1];
    parts.push(pktLine(head + ' HEAD\0' + caps + '\n'));
    for (const [name, oid] of refs) {
      parts.push(pktLine(oid + ' ' + name + '\n'));
      const peeled = peeledTarget(repo, oid);
      if (peeled !== null) parts.push(pktLine(peeled + ' ' + name + '^{}\n'));
    }
  }
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  if (service === 'git-upload-pack') repo.v0UploadAd = out;
  else repo.v0ReceiveAd = out;
  return out;
}

/**
 * Build an ls-refs answer. `prefixes` empty = all refs (HEAD first);
 * otherwise only refs matching a prefix (HEAD never matches a prefix).
 */
export function lsRefsAnswer(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean): Buffer {
  const refs = sortedRefs(repo);
  const parts: Buffer[] = [];
  const headOid = repo.refs.get('refs/heads/' + repo.defaultBranch) ?? repo.refs.get('refs/heads/main');
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  // HEAD is listed when it matches a prefix (e.g. real git asks for
  // ref-prefix HEAD); with refs-only prefixes it stays out.
  if (headOid !== undefined && (prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p)))) {
    let line = headOid + ' HEAD';
    if (symrefs) line += ' symref-target:refs/heads/' + repo.defaultBranch;
    parts.push(pktLine(line + '\n'));
  }
  for (const [name, oid] of refs) {
    if (!matches(name)) continue;
    let line = oid + ' ' + name;
    if (peel) {
      const peeled = peeledTarget(repo, oid);
      if (peeled !== null) line += ' peeled:' + peeled;
    }
    parts.push(pktLine(line + '\n'));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Parse ALL pkt-line text in a body (skipping flush/delim); for v0
 * upload-pack, whose request has two flush-separated sections. */
export function parseAllPktLines(body: Buffer): string[] {
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const len = parseInt(body.toString('ascii', pos, pos + 4), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0 || len === 1) {
      pos += 4;
      continue;
    }
    if (pos + len > body.length) break;
    lines.push(body.toString('utf8', pos + 4, pos + len));
    pos += len;
  }
  return lines;
}

/** Parse pkt-lines from a request body; returns the text lines + pack offset. */
export function parsePktLines(body: Buffer): { lines: string[]; packOffset: number } {
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const lenHex = body.toString('ascii', pos, pos + 4);
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) {
      pos += 4;
      break; // flush: the rest is the pack (receive-pack) or nothing
    }
    if (len === 1) {
      pos += 4; // delim
      continue;
    }
    if (pos + len > body.length) break;
    const payload = body.toString('utf8', pos + 4, pos + len);
    lines.push(payload);
    pos += len;
  }
  return { lines, packOffset: pos };
}

// ---- pull-request diff + squash merge (shared by REST, GraphQL, MCP) ----

/** Flatten a tree into path -> blob oid. */
export function flattenTree(repo: Repo, treeOid: string | null, prefix: string, out: Map<string, string>): void {
  if (treeOid === null) return;
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : prefix + '/' + e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, e.oid);
  }
}

/** Line counts for a changed file (multiset line difference). */
export function lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldLines = oldText === null ? [] : oldText.split('\n');
  const newLines = newText === null ? [] : newText.split('\n');
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = oldCount.get(l) ?? 0;
    if (c > 0) oldCount.set(l, c - 1);
    else additions++;
  }
  let deletions = 0;
  for (const c of oldCount.values()) deletions += c;
  return { additions, deletions };
}

export interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff base tree -> head tree: the changed files of a pull request. */
export function diffFiles(repo: Repo, baseSha: string, headSha: string): DiffFile[] {
  const baseObj = repo.objects.get(baseSha);
  const headObj = repo.objects.get(headSha);
  const baseTree = baseObj !== undefined && baseObj.type === 'commit' ? commitTree(baseObj.data) : null;
  const headTree = headObj !== undefined && headObj.type === 'commit' ? commitTree(headObj.data) : null;
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  flattenTree(repo, baseTree, '', baseFiles);
  flattenTree(repo, headTree, '', headFiles);
  const out: DiffFile[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === h) continue;
    const oldText = b === undefined ? null : repo.objects.get(b)?.data.toString('utf8') ?? null;
    const newText = h === undefined ? null : repo.objects.get(h)?.data.toString('utf8') ?? null;
    const { additions, deletions } = lineCounts(oldText, newText);
    const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
}

/** Would merging this pull conflict? (a changed file moved on the base) */
export function mergeConflicts(repo: Repo, pull: { baseRef: string; baseSha: string; headSha: string }): boolean {
  const currentBase = repo.refs.get('refs/heads/' + pull.baseRef);
  if (currentBase === undefined) return true;
  if (currentBase === pull.baseSha) return false;
  const changed = diffFiles(repo, pull.baseSha, pull.headSha);
  const baseObj = repo.objects.get(pull.baseSha);
  const curObj = repo.objects.get(currentBase);
  const baseTree = baseObj !== undefined && baseObj.type === 'commit' ? commitTree(baseObj.data) : null;
  const curTree = curObj !== undefined && curObj.type === 'commit' ? commitTree(curObj.data) : null;
  const baseFiles = new Map<string, string>();
  const curFiles = new Map<string, string>();
  flattenTree(repo, baseTree, '', baseFiles);
  flattenTree(repo, curTree, '', curFiles);
  for (const f of changed) {
    if (baseFiles.get(f.filename) !== curFiles.get(f.filename)) return true;
  }
  return false;
}

/**
 * Squash-merge a pull request onto its base branch. Returns the merge
 * commit sha, or a reason when it cannot merge.
 */
export function squashMerge(
  repo: Repo,
  pull: { number: number; state: string; headRef: string; headSha: string; baseRef: string; baseSha: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; mergeable: boolean; updatedAt: string; json: Buffer | null },
): { ok: boolean; sha?: string; reason?: string } {
  if (pull.state !== 'open') return { ok: false, reason: 'Pull request is not open' };
  if (mergeConflicts(repo, pull)) return { ok: false, reason: 'Merge conflict' };
  const headObj = repo.objects.get(pull.headSha);
  const headTree = headObj !== undefined && headObj.type === 'commit' ? commitTree(headObj.data) : null;
  if (headTree === null) return { ok: false, reason: 'head commit has no tree' };
  const currentBase = repo.refs.get('refs/heads/' + pull.baseRef) ?? pull.baseSha;
  const message = 'Merge pull request #' + pull.number + ' from ' + pull.headRef;
  const mergeCommit = storeCommit(repo, headTree, [currentBase], message);
  repo.refs.set('refs/heads/' + pull.baseRef, mergeCommit);
  pull.state = 'merged';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = mergeCommit;
  pull.mergeable = false;
  pull.updatedAt = pull.mergedAt;
  pull.json = null;
  repo.refList = null;
  repo.v0UploadAd = null;
  repo.v0ReceiveAd = null;
  repo.packCache.clear();
  return { ok: true, sha: mergeCommit };
}
