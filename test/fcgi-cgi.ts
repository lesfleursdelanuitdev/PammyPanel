// A stand-in for fcgiwrap in test/run-git-nginx-test.sh (fcgiwrap isn't on a machine without
// sudo): FastCGI from nginx on a unix socket, each request run as a CGI program (the one in
// SCRIPT_FILENAME, with exactly the params nginx sent as its environment), its stdout sent back.
// Every request's params are appended to a log, one JSON line each, for the test to look at.
//
//   node test/fcgi-cgi.ts <socket> <params.log>
import { spawn } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';

const [sockArg, logArg] = process.argv.slice(2);
if (!sockArg || !logArg) { console.error('usage: fcgi-cgi.ts <socket> <params.log>'); process.exit(2); }
const sock: string = sockArg, paramsLog: string = logArg;

const BEGIN = 1, END = 3, PARAMS = 4, STDIN = 5, STDOUT = 6, STDERR = 7;

const record = (type: number, id: number, body: Buffer) => {
  const pad = (8 - (body.length % 8)) % 8;
  const h = Buffer.alloc(8);
  h.writeUInt8(1, 0); h.writeUInt8(type, 1); h.writeUInt16BE(id, 2); h.writeUInt16BE(body.length, 4); h.writeUInt8(pad, 6);
  return Buffer.concat([h, body, Buffer.alloc(pad)]);
};

function pairs(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const len = () => { const b = buf[i]!; if (b < 128) { i += 1; return b; } const n = buf.readUInt32BE(i) & 0x7fffffff; i += 4; return n; };
  while (i < buf.length) {
    const nl = len(), vl = len();
    out[buf.subarray(i, i + nl).toString('latin1')] = buf.subarray(i + nl, i + nl + vl).toString('latin1');
    i += nl + vl;
  }
  return out;
}

function serve(c: Socket) {
  let buf = Buffer.alloc(0);
  let id = 0;
  let params = Buffer.alloc(0);
  let child: ReturnType<typeof spawn> | null = null;
  const pending: Buffer[] = [];
  let stdinDone = false;
  const send = (type: number, body: Buffer) => {
    for (let o = 0; o < body.length || (o === 0 && body.length === 0); o += 65535) {
      c.write(record(type, id, body.subarray(o, o + 65535)));
      if (body.length === 0) break;
    }
  };
  const start = () => {
    const env = pairs(params);
    appendFileSync(paramsLog, `${JSON.stringify(env)}\n`);
    child = spawn(env.SCRIPT_FILENAME!, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.on('data', (d: Buffer) => send(STDOUT, d));
    child.stderr!.on('data', (d: Buffer) => send(STDERR, d));
    child.on('close', (code) => {
      send(STDOUT, Buffer.alloc(0));
      const end = Buffer.alloc(8);
      end.writeUInt32BE(code ?? 1, 0);
      c.end(record(END, id, end));
    });
    for (const p of pending) child.stdin!.write(p);
    if (stdinDone) child.stdin!.end();
  };
  c.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const type = buf.readUInt8(1), rid = buf.readUInt16BE(2), n = buf.readUInt16BE(4), pad = buf.readUInt8(6);
      if (buf.length < 8 + n + pad) break;
      const body = buf.subarray(8, 8 + n);
      buf = buf.subarray(8 + n + pad);
      if (type === BEGIN) id = rid;
      else if (type === PARAMS) { if (n) params = Buffer.concat([params, body]); else start(); }
      else if (type === STDIN) {
        if (n === 0) { stdinDone = true; if (child) child.stdin!.end(); }
        else if (child) child.stdin!.write(body); else pending.push(Buffer.from(body));
      }
    }
  });
  c.on('error', () => child?.kill());
}

rmSync(sock, { force: true });
createServer(serve).listen(sock, () => console.log(`fcgi-cgi on ${sock}`));
