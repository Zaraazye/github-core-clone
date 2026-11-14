// Tiny response helpers. The hot paths write pre-serialized Buffers
// straight to the socket; nothing here allocates per request beyond the
// headers object Node needs anyway.

import type { IncomingMessage, ServerResponse } from 'node:http';

let reqCounter = 0;

export function nextReqId(): string {
  reqCounter += 1;
  return 'gh-' + reqCounter.toString(36);
}

export const JSON_TYPE = 'application/json';

/** Read the whole request body (empty body -> empty Buffer). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns { ok: true, value } or { ok: false }. */
export function parseJsonBody(buf: Buffer): { ok: boolean; value?: unknown } {
  if (buf.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function sendJson(res: ServerResponse, status: number, value: unknown, reqId: string): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': reqId });
  res.end(body);
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  reqId: string,
  extra?: Record<string, string>,
): void {
  const headers: Record<string, string> = { 'content-type': contentType, 'x-github-request-id': reqId };
  if (extra !== undefined) for (const k of Object.keys(extra)) headers[k] = extra[k];
  res.writeHead(status, headers);
  res.end(body);
}

export function sendErr(res: ServerResponse, status: number, message: string, reqId: string): void {
  sendJson(res, status, { message }, reqId);
}

/** Parse a query string into a Map (no URL object allocation). */
export function parseQuery(qs: string): Map<string, string> {
  const map = new Map<string, string>();
  if (qs === '') return map;
  for (const pair of qs.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) {
      if (pair !== '') map.set(decodeURIComponent(pair), '');
    } else {
      map.set(decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1)));
    }
  }
  return map;
}
