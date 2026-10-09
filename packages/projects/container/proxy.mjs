// The build boxes' one way out (docs/phase8b-plan.md 8b-8b, P8b-11): a proxy on the internal
// network lfdln-build, where the boxes are (they have no route out of their own). It lets
// through HTTPS (CONNECT to port 443) to the hosts in proxy-allow.txt and nothing else, and
// says each one it turns away. No plain HTTP, no other ports, nothing cached or looked into.
//   node /lfdln/proxy.mjs            (lfdln-build-proxy.container, as svc-lfdln-apps)
import { lookup as systemLookup, Resolver } from 'node:dns';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';

export const PORT = 3128;
// one host a line; "*.example.com" for its subdomains (not example.com itself); # notes
export function loadAllow(text) {
  return text.split('\n').map((l) => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean);
}
export function allowed(list, host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]{1,253}$/.test(h)) return false;
  return list.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a));
}
// "registry.npmjs.org:443" -> its host, if the port is 443
export function target(authority) {
  const m = /^([a-zA-Z0-9.-]+):(\d+)$/.exec(String(authority));
  return m && m[2] === '443' ? m[1] : null;
}

// Names looked up at the server's own resolvers (PROXY_DNS, from install-lfdln.sh), not the
// internal network's forwarder: on two networks that forwarder is the container's only one,
// and under a burst of lookups it answers EAI_AGAIN (seen twice in the builds test, 2026-10-06).
// A failure is tried again, then the container's own lookup.
export function makeLookup(servers, log = () => {}) {
  const r = servers.length ? new Resolver({ timeout: 3000, tries: 2 }) : null;
  if (r) r.setServers(servers);
  return (host, opts, cb) => {
    const answer = (addr) => (opts?.all ? cb(null, [{ address: addr, family: 4 }]) : cb(null, addr, 4));
    const attempt = (left) => {
      const system = () => systemLookup(host, { family: 4 }, (e, addr) => {
        if (!e) return answer(addr);
        if (left > 0) return setTimeout(() => attempt(left - 1), 300);
        log(`${host}: no address (${e.code ?? e.message})`);
        cb(e);
      });
      if (!r) return system();
      r.resolve4(host, (e, addrs) => (!e && addrs.length ? answer(addrs[0]) : system()));
    };
    attempt(2);
  };
}

// a tunnel left with nothing going through it goes (npm keeps its connections open between requests)
export const IDLE_MS = 60_000;

export function createProxy(list, log = (l) => console.log(l), dns = []) {
  const lookup = makeLookup(dns, log);
  let open = 0;
  let loud = 100;
  const server = createServer((req, res) => {
    // plain HTTP (a proxied GET): never
    log(`refused ${req.method} ${String(req.url).slice(0, 120)} (plain HTTP)`);
    res.writeHead(403, { 'content-type': 'text/plain' }).end('lfdln-build-proxy: only HTTPS to the package registries\n');
  });
  server.on('connect', (req, client, head) => {
    const host = target(req.url);
    if (!host || !allowed(list, host)) {
      log(`refused CONNECT ${String(req.url).slice(0, 120)}`);
      client.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nlfdln-build-proxy: not on the allow-list (docs/phase8b-plan.md P8b-11)\n');
      return;
    }
    let connected = false;
    const up = connect({ port: 443, host, lookup }, () => {
      connected = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    // TLS inside: when either side is done, so is the tunnel (never left half-closed, waiting
    // on the far end to close its side)
    let gone = false;
    open++;
    if (open >= loud) { log(`${open} tunnels open`); loud *= 2; }
    const done = () => {
      if (gone) return;
      gone = true;
      open--;
      if (open < loud / 4 && loud > 100) loud /= 2;
      up.destroy();
      // never got through: the box is told so (end, so the answer is sent before it closes)
      if (!connected && !client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
    };
    up.setTimeout(IDLE_MS, done);
    client.setTimeout(IDLE_MS, done);
    up.on('error', (e) => { log(`${host}: ${e.code ?? e.message}`); done(); });
    for (const ev of ['end', 'close']) { up.on(ev, done); client.on(ev, done); }
    client.on('error', done);
  });
  server.openTunnels = () => open;
  return server;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const list = loadAllow(readFileSync(new URL('./proxy-allow.txt', import.meta.url), 'utf8'));
  const dns = String(process.env.PROXY_DNS ?? '').split(/[\s,]+/).filter((x) => /^[0-9a-f.:]+$/i.test(x));
  createProxy(list, undefined, dns).listen(PORT, '0.0.0.0', () => console.log(`lfdln-build-proxy on :${PORT}, ${list.length} hosts allowed: ${list.join(' ')}; names from ${dns.length ? dns.join(' ') : 'the container\'s resolver'}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
}
