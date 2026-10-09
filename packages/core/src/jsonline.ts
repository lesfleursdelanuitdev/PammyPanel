// A tiny request/response protocol over a Unix socket: one JSON object per
// connection, one JSON line back. Used by the website folder helper and the
// gate's admin socket. Handlers throw errors with a `code` to refuse.
import { connect, createServer, type Server } from 'node:net';
import { PassThrough, type Readable } from 'node:stream';

// The JSON line of a request. A form with 100 items and their choices fits
// comfortably. It is the default, not the law: a server may ask for more
// (docs/studio-plan.md S3 -- a schema patch is an inbound line, and 64KB is the
// wall it hits, while replies already have 4MB of headroom in callJsonLine).
const MAX_REQUEST = 64 * 1024;

// How long a connection may be idle before the server hangs up. Slice 1's
// database ops are well inside it; `introspect` and `apply-schema` on an adopted
// WordPress-sized database are not, so that server asks for longer.
const TIMEOUT = 10_000;

export type JsonRequest = { op: string; actor?: unknown; [key: string]: unknown };
export type Refusal = Error & { code: string };

const isRefusal = (e: unknown): e is Refusal =>
  e instanceof Error && typeof (e as Refusal).code === 'string' && !/^E[A-Z]+$/.test((e as Refusal).code);

// Streams: an op in `streams` gets the rest of the connection as a body (an
// upload) and/or answers with a JSON line followed by bytes (a download).
export type StreamContext = { body: Readable; send: (header: object, bytes?: Readable) => void };
export type StreamOps = Record<string, (req: JsonRequest, ctx: StreamContext) => Promise<unknown | typeof SENT>>;
export const SENT = Symbol('sent');

// Everything past the handler and the log is per server, in one object rather
// than a fifth positional parameter. The two sizes default to what every server
// had before this existed, so only the one that asks gets something different.
export type JsonLineOptions = {
  // what a log line says the request was about; never a password or a row
  describe?: (req: JsonRequest) => string;
  streams?: StreamOps;
  maxRequest?: number;          // the inbound line, default 64KB
  timeoutMs?: number;           // idle before the server hangs up, default 10s
};

export function createJsonLineServer(
  handle: (req: JsonRequest) => unknown | Promise<unknown>,
  log: (line: string) => void = () => {},
  opts: JsonLineOptions = {},
): Server {
  const describe = opts.describe ?? ((req: JsonRequest) => JSON.stringify(req.name ?? req.entry ?? req.path ?? req.folder ?? req.id ?? '').slice(0, 120));
  const streams = opts.streams ?? {};
  const maxRequest = opts.maxRequest ?? MAX_REQUEST;
  // allowHalfOpen: an upload ends its side when the file is sent, and still needs the answer
  return createServer({ allowHalfOpen: true }, (sock) => {
    let buf = Buffer.alloc(0);
    let done = false;
    sock.setTimeout(opts.timeoutMs ?? TIMEOUT, () => sock.destroy());
    const reply = (body: object) => {
      done = true;
      sock.end(`${JSON.stringify(body)}\n`);
    };
    sock.on('error', () => {});
    const onData = (chunk: Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > maxRequest) reply({ ok: false, error: 'invalid', message: 'Request too large.' });
        return;
      }
      if (nl > maxRequest) return reply({ ok: false, error: 'invalid', message: 'Request too large.' });
      done = true;
      let req: JsonRequest;
      try {
        req = JSON.parse(buf.subarray(0, nl).toString('utf8'));
        if (!req || typeof req !== 'object' || Array.isArray(req) || typeof req.op !== 'string') throw new Error('shape');
      } catch {
        return reply({ ok: false, error: 'invalid', message: 'Malformed request.' });
      }
      const actor = typeof req.actor === 'string' ? req.actor.slice(0, 40) : '-';
      const quiet = ['list', 'state', 'dirs', 'markers', 'forms.state', 'form.get', 'responses.list', 'apikeys.list', 'media-sites', 'media-list', 'media-info', 'media-read', 'media-buckets', 'media-trash-list', 'media-scan', 'media-hash', 'files-tree', 'files-list', 'files-stat', 'files-read', 'files-hash', 'files-versions', 'files-version-read', 'list-databases', 'database-size', 'list-users', 'user-access', 'introspect', 'list-rows', 'get-row', 'notices.since', 'status', 'backups', 'mail-get'].includes(req.op);
      const refused = (e: unknown) => {
        if (isRefusal(e)) {
          log(`op=${req.op} target=${describe(req)} actor=${actor} refused=${e.code}`);
          return { ok: false, error: e.code, message: e.message };
        }
        log(`op=${req.op} target=${describe(req)} actor=${actor} ERROR ${(e as Error)?.stack ?? e}`);
        return { ok: false, error: 'internal', message: 'The helper hit an unexpected error.' };
      };
      const stream = Object.hasOwn(streams, req.op) ? streams[req.op]! : null;
      if (stream) {
        sock.off('data', onData);
        sock.setTimeout(120_000, () => sock.destroy());          // a slow upload, or a paused video
        const body = new PassThrough();
        const rest = buf.subarray(nl + 1);
        if (rest.length) body.write(rest);
        sock.pipe(body);
        let sent = false;
        const send = (header: object, bytes?: Readable) => {
          sent = true;
          sock.write(`${JSON.stringify({ ok: true, result: header })}\n`);
          if (!bytes) return void sock.end();
          bytes.on('error', () => sock.destroy());
          bytes.pipe(sock);
        };
        Promise.resolve()
          .then(() => stream(req, { body, send }))
          .then((result) => {
            if (!quiet) log(`op=${req.op} target=${describe(req)} actor=${actor} ok`);
            if (!sent && result !== SENT) sock.end(`${JSON.stringify({ ok: true, result })}\n`);
          })
          .catch((e: unknown) => {
            const answer = refused(e);
            if (sent) sock.destroy(); else sock.end(`${JSON.stringify(answer)}\n`);
          });
        return;
      }
      Promise.resolve()
        .then(() => handle(req))
        .then((result) => {
          if (!quiet) log(`op=${req.op} target=${describe(req)} actor=${actor} ok`);
          reply({ ok: true, result });
        })
        .catch((e: unknown) => reply(refused(e)));
    };
    sock.on('data', onData);
  });
}

export class CallError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Two ways a call can end without an answer, and they are not the same thing
// (docs/refactor-plan.md W4):
//
//   unavailable  it never got as far as asking -- nothing has happened, so the
//                caller may simply try again;
//   timeout      the request was written and the answer never came. Whatever
//                was asked for may well have been done.
//
// A caller that can tell the difference (a write that must not happen twice)
// has to; one that cannot, treats both as "not answering".
export function callJsonLine<T = unknown>(socketPath: string, req: Record<string, unknown>, what: string, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    let settled = false;
    let asked = false;                // the request line is on its way
    const fail = (e: CallError) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(e);
    };
    const unavailable = () => fail(asked
      ? new CallError('timeout', `The ${what} took this and then stopped answering.`)
      : new CallError('unavailable', `The ${what} isn't answering. Try again in a minute, or ask momolig.`));
    sock.setEncoding('utf8');
    sock.setTimeout(timeoutMs, unavailable);
    sock.on('error', unavailable);
    sock.on('connect', () => { sock.write(`${JSON.stringify(req)}\n`); asked = true; });
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 4 * 1024 * 1024) fail(new CallError('internal', `The ${what} sent too much data.`));
    });
    sock.on('end', () => {
      if (settled) return;
      let res: { ok?: boolean; result?: T; error?: string; message?: string };
      try { res = JSON.parse(buf); } catch { return unavailable(); }
      settled = true;
      if (res.ok) resolve(res.result as T);
      else reject(new CallError(res.error ?? 'internal', res.message ?? `The ${what} refused.`));
    });
  });
}

// An upload: the request line, then `body` piped after it; resolves with the reply.
export function callJsonLineUpload<T = unknown>(socketPath: string, req: Record<string, unknown>, body: Readable, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    let settled = false;
    // on failure the body is left for the caller to finish reading (see /api/media/upload)
    const fail = (e: CallError) => { if (!settled) { settled = true; body.unpipe(sock); sock.destroy(); reject(e); } };
    sock.setTimeout(120_000, () => fail(new CallError('unavailable', `The ${what} stopped answering.`)));
    sock.on('error', () => fail(new CallError('unavailable', `The ${what} isn't answering. Try again in a minute, or ask momolig.`)));
    body.on('error', () => fail(new CallError('invalid', 'The upload stopped before the whole file arrived. Please try again.')));
    sock.on('connect', () => {
      sock.write(`${JSON.stringify(req)}\n`);
      body.pipe(sock, { end: false });
      body.on('end', () => sock.end());
    });
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => { buf += chunk; });
    sock.on('end', () => {
      if (settled) return;
      settled = true;
      body.unpipe(sock);
      let res: { ok?: boolean; result?: T; error?: string; message?: string };
      try { res = JSON.parse(buf); } catch { return reject(new CallError('unavailable', `The ${what} stopped answering.`)); }
      if (res.ok) resolve(res.result as T);
      else reject(new CallError(res.error ?? 'internal', res.message ?? `The ${what} refused.`));
    });
  });
}

// A download: resolves with the reply's header and the bytes that follow it.
export function callJsonLineRead<T = unknown>(socketPath: string, req: Record<string, unknown>, what: string): Promise<{ header: T; bytes: Readable }> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = (e: CallError) => { if (!settled) { settled = true; sock.destroy(); reject(e); } };
    sock.setTimeout(15_000, () => fail(new CallError('unavailable', `The ${what} isn't answering.`)));
    sock.on('error', () => fail(new CallError('unavailable', `The ${what} isn't answering. Try again in a minute, or ask momolig.`)));
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) { if (buf.length > MAX_REQUEST) fail(new CallError('internal', `The ${what} sent too much.`)); return; }
      sock.off('data', onData);
      sock.pause();
      let res: { ok?: boolean; result?: T; error?: string; message?: string };
      try { res = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch { return fail(new CallError('unavailable', `The ${what} stopped answering.`)); }
      if (!res.ok) { settled = true; sock.destroy(); return reject(new CallError(res.error ?? 'internal', res.message ?? `The ${what} refused.`)); }
      settled = true;
      sock.setTimeout(120_000, () => sock.destroy());
      const bytes = new PassThrough();
      const rest = buf.subarray(nl + 1);
      if (rest.length) bytes.write(rest);
      sock.pipe(bytes);
      bytes.on('close', () => sock.destroy());
      resolve({ header: res.result as T, bytes });
    };
    sock.on('data', onData);
    sock.on('end', () => { if (!settled) fail(new CallError('unavailable', `The ${what} stopped answering.`)); });
  });
}
