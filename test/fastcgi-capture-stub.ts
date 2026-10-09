// For test/run-route-accounts-nginx-test.sh (docs/s1-plan.md S1e, review F3): a stand-in PHP
// on a unix socket that answers every FastCGI request with the params nginx sent it, as JSON
// -- every HTTP_COOKIE it was given (so one sent twice shows), and who it was told is signed in.
//   node test/fastcgi-capture-stub.ts <socket>
import { createServer, type Socket } from 'node:net';
import { rmSync } from 'node:fs';

const [path] = process.argv.slice(2);
if (!path) throw new Error('usage: fastcgi-capture-stub.ts <socket>');

const BEGIN = 1, END = 3, PARAMS = 4, STDIN = 5, STDOUT = 6;
const record = (type: number, id: number, body: Buffer) => {
  const h = Buffer.alloc(8);
  h.writeUInt8(1, 0); h.writeUInt8(type, 1); h.writeUInt16BE(id, 2); h.writeUInt16BE(body.length, 4);
  return Buffer.concat([h, body]);
};
// name/value pairs: each length one byte, or four with the top bit set
function pairs(buf: Buffer): [string, string][] {
  const out: [string, string][] = [];
  let i = 0;
  const len = () => { const b = buf[i]!; if (b < 128) { i += 1; return b; } const n = buf.readUInt32BE(i) & 0x7fffffff; i += 4; return n; };
  while (i < buf.length) {
    const nl = len(), vl = len();
    const name = buf.subarray(i, i + nl).toString('latin1'); i += nl;
    const value = buf.subarray(i, i + vl).toString('latin1'); i += vl;
    out.push([name, value]);
  }
  return out;
}

function serve(sock: Socket) {
  let buf = Buffer.alloc(0);
  let params = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const type = buf.readUInt8(1), id = buf.readUInt16BE(2), n = buf.readUInt16BE(4), pad = buf.readUInt8(6);
      if (buf.length < 8 + n + pad) return;
      const body = buf.subarray(8, 8 + n);
      buf = buf.subarray(8 + n + pad);
      if (type === BEGIN) params = Buffer.alloc(0);
      else if (type === PARAMS) params = Buffer.concat([params, body]);
      else if (type === STDIN && n === 0) {
        const all = pairs(params);
        const of = (k: string) => all.filter(([name]) => name === k).map(([, v]) => v);
        const json = JSON.stringify({ cookies: of('HTTP_COOKIE'), account: of('LFDLN_ACCOUNT')[0] ?? null });
        const out = Buffer.from(`Content-Type: application/json\r\n\r\n${json}`, 'latin1');
        const end = Buffer.alloc(8);
        sock.end(Buffer.concat([record(STDOUT, id, out), record(STDOUT, id, Buffer.alloc(0)), record(END, id, end)]));
      }
    }
  });
  sock.on('error', () => {});
}

rmSync(path, { force: true });
createServer(serve).listen(path);
