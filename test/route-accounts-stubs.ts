// For test/run-route-accounts-nginx-test.sh: a stand-in gate and a stand-in app.
//   node test/route-accounts-stubs.ts <gate-port> <app-port> <open-token> <private-token>
// The gate answers /check/<token> the way lfdln-gate does (packages/gate/src/app.ts):
// the cookie "__Host-lfdln_visitor=jo" is jo, signed in; anything else is nobody. Its own
// pages say the Cookie they were given (docs/s1-plan.md S1e: the gate's cookie is still theirs).
// The app answers with the request headers it was given, as JSON, and whether their
// proof is the gate's for it ("service.app.web", docs/s1-plan.md S1a): "proof": true/false.
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { makeProof, proofOk } from '@panel/core/identity-proof';

const keys = generateKeyPairSync('ed25519');

const [gatePort, appPort, OPEN, PRIVATE] = process.argv.slice(2);
if (!gatePort || !appPort || !OPEN || !PRIVATE) throw new Error('usage: route-accounts-stubs.ts <gate-port> <app-port> <open-token> <private-token>');

createServer((req, res) => {
  const jo = /(?:^|;\s*)__Host-lfdln_visitor=jo(?:;|$)/.test(req.headers.cookie ?? '');
  const m = /^\/check\/([A-Za-z0-9_-]{32})(?:\/([a-z0-9.-]+))?$/.exec(req.url ?? '');
  const token = m?.[1];
  const audience = m?.[2];
  const me = (h: Record<string, string>) => {
    if (jo) Object.assign(h, { 'X-Pammy-User': 'jo', 'X-Pammy-Account': '5', 'X-Pammy-Role': 'Member', 'X-Pammy-Privileges': 'pages.read progress.update:own' });
    else Object.assign(h, { 'X-Pammy-Role': 'Not signed in', 'X-Pammy-Privileges': 'pages.read' });
    if (audience) {
      const told = { account: h['X-Pammy-Account'] ?? '', username: h['X-Pammy-User'] ?? '', role: h['X-Pammy-Role'] ?? '', privileges: h['X-Pammy-Privileges'] ?? '' };
      h['X-Pammy-Proof'] = makeProof(keys.privateKey, audience, String(req.headers.host ?? ''), told, Date.now());
    }
    return h;
  };
  if (token === OPEN) { res.writeHead(204, me({})); return res.end(); }
  if (token === PRIVATE) {
    if (!jo) {
      const next = String(req.headers['x-pammy-next'] ?? '/');
      res.writeHead(401, { 'X-Pammy-Cache': 'private, no-store', 'X-Pammy-Login': `/_pammy/login?${new URLSearchParams({ next, area: PRIVATE })}` });
      return res.end();
    }
    res.writeHead(204, me({ 'X-Pammy-Cache': 'private, no-store' }));
    return res.end();
  }
  if (token) { res.writeHead(403); return res.end(); }
  // the gate's own pages
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`gate page ${req.url} base=${req.headers['x-pammy-base'] ?? ''} ip=${req.headers['x-real-ip'] ?? ''} cookie=${req.headers.cookie ?? ''}`);
}).listen(Number(gatePort), '127.0.0.1');

createServer((req, res) => {
  const h = (n: string) => String(req.headers[n] ?? '');
  const told = { account: h('x-lfdln-account'), username: h('x-lfdln-username'), role: h('x-lfdln-role'), privileges: h('x-lfdln-privileges') };
  const proof = proofOk(keys.publicKey, req.headers['x-lfdln-proof'], 'service.app.web', h('host').replace(/:\d+$/, ''), told, Date.now());
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ url: req.url, headers: req.headers, proof }));
}).listen(Number(appPort), '127.0.0.1');
