// Entry point. Two modes:
//   - Trial mode (MAKEFUN_ENV_URL set): bind an ephemeral port, register
//     it with the env, then serve until the env reports done.
//   - Standalone mode (no env URL): serve on PORT (default 8080) so the
//     kit's local trial and ad-hoc checks can talk to the forge.
// The entry NEVER binds 8080 when an env URL is set — the env owns it.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;
const PORT = parseInt(process.env.PORT ?? '8080', 10) || 8080;

/** First retry delay, doubled each attempt up to MAX_DELAY_MS. */
const FIRST_DELAY_MS = 250;
const MAX_DELAY_MS = 2000;
/** Per-request timeout for the register / done calls. */
const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Next backoff delay (exponential from FIRST_DELAY_MS, capped). */
function nextDelay(delay: number): number {
  return Math.min(delay * 2, MAX_DELAY_MS);
}

/** POST {url}/register {"port": n} with backoff; resolves true once registered. */
async function register(envUrl: string, port: number): Promise<boolean> {
  let delay = FIRST_DELAY_MS;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(envUrl + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: controller.signal,
      });
      if (res.status === 200) return true;
      if (res.status === 400 || res.status === 405) {
        console.error(`register: fatal HTTP ${res.status}`);
        return false;
      }
      // 409 (another entry won) and anything else: keep waiting
      console.error(`register: HTTP ${res.status}, retrying in ${delay} ms`);
    } catch (err) {
      console.error(`register: ${(err as Error).message}, retrying in ${delay} ms`);
    } finally {
      clearTimeout(timer);
    }
    await sleep(delay);
    delay = nextDelay(delay);
  }
}

/** Poll {url}/done until {"done": true}. */
async function waitDone(envUrl: string): Promise<void> {
  let delay = FIRST_DELAY_MS;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(envUrl + '/done', { signal: controller.signal });
      if (res.status === 200) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // transient: keep polling
    } finally {
      clearTimeout(timer);
    }
    await sleep(delay);
    delay = nextDelay(delay);
  }
}

/** Close the server, waiting briefly for in-flight requests to drain. */
function shutdown(server: import('node:http').Server): void {
  server.close(() => process.exit(0));
  // do not hang forever on a stuck keep-alive socket
  setTimeout(() => process.exit(0), 2000).unref();
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createApp(store);

  if (ENV_URL !== undefined && ENV_URL !== '') {
    // trial mode: ephemeral port, then register
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      console.error('could not bind an ephemeral port');
      process.exit(1);
    }
    const port = address.port;
    console.log(`listening on 127.0.0.1:${port} (trial mode)`);
    const ok = await register(ENV_URL, port);
    if (!ok) {
      server.close();
      process.exit(1);
    }
    console.log('registered with the env');
    await waitDone(ENV_URL);
    console.log('env reports done; shutting down');
    shutdown(server);
    return;
  }

  // standalone mode
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve());
  });
  console.log(`listening on 127.0.0.1:${PORT} (standalone mode)`);
  process.on('SIGTERM', () => shutdown(server));
  process.on('SIGINT', () => shutdown(server));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
