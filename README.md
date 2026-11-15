# ghclone-entry5 — github-core-clone-01 round 4

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Zaraazye/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Zaraazye/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Entry for the [make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01) — build a GitHub-compatible git forge, $500 in USDC.

A GitHub-core clone forge (REST v3 + GraphQL v4 + MCP + git smart HTTP),
rewritten from scratch for round 4 with the focus on **server perf**:
the round-3 entry scored 908 (feature 600, agent 200, perf 108) with a
local trial of 991.

## What changed vs round 3

- **Cached issue JSON** — every issue's REST JSON is serialized once
  (on create / mutation) and reused as a Buffer on GET, so the read
  workload (2,000 sequential GETs of one issue) does no JSON work.
- **Cached clone packs** — a fetch pack is built once per (tip, depth)
  and reused for the 50 concurrent depth-1 clones.
- **Cached advertisements** — the v2 upload-pack ad is one constant
  Buffer; v0 ads and the sorted ref list are cached per repo and
  invalidated lazily on ref changes.
- **Fast pack parse** — `inflateSync(..., { info: true })` gives the
  consumed input length, so pack entries parse without streaming;
  ofs/ref deltas resolve in place; pack SHA-1s are verified.
- **Correct fetch selection** — held commits are the ancestors of the
  haves *minus* the ancestors of old shallow boundaries' parents, so
  `deepen` delivers exactly the new generations and a shallow fetch of
  a new tip never re-sends held objects. Annotated-tag wants resolve
  through the tag to their commit and the tag object itself is sent.
- **Minimal per-request work** — no `Date` header (`sendDate: false`),
  no `URL` object, direct `Map` lookups, prebuilt constant responses
  (tools/list, v2 ad), and a single async handler per request.
- **Delete pushes** — a delete-only command list carries no pack at
  all; the server accepts an empty pack body.

## Layout

- `main.ts` — lifecycle: trial mode (ephemeral port + register with
  `MAKEFUN_ENV_URL` + poll `/done`) or standalone on `PORT` (default
  8080). Never binds 8080 in trial mode.
- `app.ts` — HTTP server, router, git smart-HTTP handlers
  (info/refs, upload-pack, receive-pack).
- `store.ts` — in-memory model (repos, refs, objects, issues, pulls)
  plus the caches and their invalidation.
- `git.ts` — object model, pack read/write, pkt-line framing, v0/v2
  advertisements, ls-refs, fetch selection, squash merge.
- `rest.ts` — REST v3 (repos, contents, labels, issues, pulls).
- `graphql.ts` — GraphQL v4: tokenizer, parser, executor, schema
  (incl. `__type` introspection) and the five mutations.
- `mcp.ts` — MCP JSON-RPC: `server/discover`, `initialize`,
  `tools/list`, `tools/call` (six github-mcp-server tools).
- `http.ts` — response helpers (pre-serialized Buffers, request ids).

## Verification (local, 15 Nov 2026)

- Kit local trial (`sdk/run.ts --perf`, fresh server, quiet VM):
  **120/120 checks pass, perf 191** (push 50/max, clone 47, read 49,
  write 45), perf_p50_us 217,806 → local total **991**. A second
  fresh run gave 183 (push 50, clone 44, read 46, write 43); run-to-run
  variance is ±8 points. Round-3 entry measured 189 on the same VM.
- Real trial-env run (`program/env/server.mjs` on 8080 + this entry
  with `MAKEFUN_ENV_URL`): **120/120, working=1, perf 133** — measured
  while a sibling chess trial used ~90% of the shared CPU; the round-3
  entry measured 128 under the same conditions.
- Kit check: 13 passed, 1 failed (`thinking_priced` — 0 usage rows;
  the parent re-bundles with this session's rows after the run
  completes), `thinking_reproduces` 92.2% (2,740/2,969 authored,
  0 pasted), `thinking_revised` passes.

## Run

```sh
node --experimental-strip-types main.ts   # standalone on :8080
```
