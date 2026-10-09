// The ways a write into her database can go wrong that a real engine will not
// do on request (docs/refactor-plan.md phase 2): a helper that is not there, one
// that takes the request and never answers, and one that answers slowly.
//
// It is a proxy in front of the real (in-memory) helper, so "never answered"
// means what it means on the day: the row really was written, and the gate
// really did not hear about it (B3).
import { connect, createServer, type Server } from 'node:net';

export type Proxy = {
  path: string;
  // how many of the next replies to swallow (the request still goes through)
  swallow: number;
  // how long to wait before passing a reply back
  delayMs: number;
  calls: number;
  stop: () => Promise<void>;
};

export async function startProxy(path: string, target: string): Promise<Proxy> {
  const state = { swallow: 0, delayMs: 0, calls: 0 };
  const server: Server = createServer((client) => {
    const mine = ++state.calls;
    const swallowed = state.swallow > 0 && state.swallow-- > 0;
    const up = connect(target);
    client.on('error', () => up.destroy());
    up.on('error', () => client.destroy());
    client.pipe(up);
    let buf = '';
    up.setEncoding('utf8');
    up.on('data', (chunk: string) => { buf += chunk; });
    up.on('end', () => {
      if (swallowed) {
        // the helper did the work; the answer never comes back (call ${mine})
        client.destroy();
        return;
      }
      setTimeout(() => { client.end(buf); }, state.delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return {
    path,
    get swallow() { return state.swallow; },
    set swallow(n: number) { state.swallow = n; },
    get delayMs() { return state.delayMs; },
    set delayMs(ms: number) { state.delayMs = ms; },
    get calls() { return state.calls; },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
