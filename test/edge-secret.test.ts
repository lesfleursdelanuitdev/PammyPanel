// X-Real-IP only from nginx (docs/s1-plan.md S1c): once a site has an edge secret, the
// panel and the gate believe the header only on a request from this machine that also
// carries the secret in X-Lfdln-Edge, which nginx adds from a root-only include. Without a
// secret, as before (any local caller is believed).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clientIp, edgeHeaders, EDGE_HEADER, fromNginx, loadEdgeSecret, useEdgeSecret } from '@panel/core/security';
import { gateCtx } from '@panel/core/gate/context';
import type { GateConfig } from '@panel/core/gate/context';
import type { GateLive } from '@panel/core/gate/live';
import { renderNginx } from '@panel/core/nginx';
import { NGINX_FILES } from '@panel/pammy/nginx';
import { PROFILE } from '@panel/pammy/profile';
import { PROFILE as LFDLN } from './fixtures/lfdln-profile.ts';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { renderAll, type Table } from '@panel/hosts/render';
import { checkEdge } from '../tools/edge-check.ts';

const SECRET = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
const req = (peer: string, headers: Record<string, string> = {}) =>
  ({ socket: { remoteAddress: peer }, headers }) as unknown as FastifyRequest;
const gateIp = gateCtx({} as FastifyInstance, { domain: 'pammy.org', now: () => 0 } as unknown as GateConfig, {} as GateLive).ipOf;

describe('X-Real-IP and the edge secret (S1c)', () => {
  afterEach(() => useEdgeSecret(null));

  it('without a secret, believes any local caller, as before', () => {
    assert.equal(clientIp(req('127.0.0.1', { 'x-real-ip': '203.0.113.5' })), '203.0.113.5');
    assert.equal(gateIp(req('::1', { 'x-real-ip': '203.0.113.5' })), '203.0.113.5');
    assert.equal(clientIp(req('198.51.100.1', { 'x-real-ip': '203.0.113.5' })), '198.51.100.1');
    assert.deepEqual(edgeHeaders(), {});
  });

  it('with one, believes X-Real-IP only when the secret comes with it', () => {
    useEdgeSecret(`${SECRET}\n`);
    for (const ip of [clientIp, gateIp]) {
      assert.equal(ip(req('127.0.0.1', { 'x-real-ip': '203.0.113.5' })), '127.0.0.1', 'no secret: the caller itself');
      assert.equal(ip(req('127.0.0.1', { 'x-real-ip': '203.0.113.5', [EDGE_HEADER]: 'b'.repeat(64) })), '127.0.0.1', 'a wrong secret');
      assert.equal(ip(req('127.0.0.1', { 'x-real-ip': '203.0.113.5', [EDGE_HEADER]: SECRET.slice(1) })), '127.0.0.1', 'a shorter one');
      assert.equal(ip(req('127.0.0.1', { 'x-real-ip': '203.0.113.5', [EDGE_HEADER]: SECRET })), '203.0.113.5', 'nginx');
      assert.equal(ip(req('::ffff:127.0.0.1', { 'x-real-ip': '203.0.113.5', [EDGE_HEADER]: SECRET })), '203.0.113.5');
      assert.equal(ip(req('198.51.100.1', { 'x-real-ip': '203.0.113.5', [EDGE_HEADER]: SECRET })), '198.51.100.1', 'never from outside');
    }
    assert.equal(fromNginx(req('127.0.0.1')), false);
    assert.deepEqual(edgeHeaders(), { [EDGE_HEADER]: SECRET });
  });

  it('refuses a secret that is not 64 hex characters', () => {
    assert.throws(() => useEdgeSecret(''), /64 hex/);
    assert.throws(() => useEdgeSecret('xyz'), /64 hex/);
    assert.throws(() => useEdgeSecret(SECRET.toUpperCase()), /64 hex/);
  });

  it("reads systemd's credential, a file named by hand, or nothing; the installer's hold and an empty name are none", () => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-'));
    assert.deepEqual(loadEdgeSecret({ CREDENTIALS_DIRECTORY: dir }, 'GATE'), { on: false, says: 'no edge secret: X-Real-IP believed from any local caller, as before S1c' });
    assert.equal(fromNginx(req('127.0.0.1')), true);
    writeFileSync(join(dir, 'edge.secret'), `${SECRET}\n`);
    assert.equal(loadEdgeSecret({ CREDENTIALS_DIRECTORY: dir }, 'GATE').on, true);
    assert.equal(fromNginx(req('127.0.0.1')), false);
    useEdgeSecret(null);
    assert.equal(loadEdgeSecret({ PANEL_EDGE_SECRET_FILE: join(dir, 'edge.secret') }, 'PANEL').on, true);
    assert.equal(fromNginx(req('127.0.0.1', { [EDGE_HEADER]: SECRET })), true);
    // the installer's hold (deploy/edge-secret.sh edge_hold): the credential is there, and not used
    const held = loadEdgeSecret({ CREDENTIALS_DIRECTORY: dir, GATE_EDGE: 'off' }, 'GATE');
    assert.equal(held.on, false);
    assert.match(held.says, /held off by the installer \(GATE_EDGE=off/);
    assert.equal(fromNginx(req('127.0.0.1')), true, 'held: as before');
    assert.equal(loadEdgeSecret({ CREDENTIALS_DIRECTORY: dir, GATE_EDGE: 'off' }, 'PANEL').on, true, "the gate's hold isn't the panel's");
    // named but empty: none, and it says so (review L3)
    const empty = loadEdgeSecret({ CREDENTIALS_DIRECTORY: dir, PANEL_EDGE_SECRET_FILE: '' }, 'PANEL');
    assert.equal(empty.on, false);
    assert.match(empty.says, /PANEL_EDGE_SECRET_FILE is empty/);
    assert.equal(fromNginx(req('127.0.0.1')), true);
    writeFileSync(join(dir, 'bad'), 'nope\n');
    assert.throws(() => loadEdgeSecret({ GATE_EDGE_SECRET_FILE: join(dir, 'bad') }, 'GATE'), /64 hex/);
  });
});

describe('nginx sends the edge secret to the panel and the gate, and to nothing else (S1c)', () => {
  const IPS = '173.245.48.0/20\n103.21.244.0/22\n103.22.200.0/22\n103.31.4.0/22\n141.101.64.0/18\n108.162.192.0/18\n190.93.240.0/20\n188.114.96.0/20\n197.234.240.0/22\n198.41.128.0/17\n';
  const PAMMY_EDGE = { edge: '/etc/nginx/pammy-panel/edge.conf', ports: ['3044', '3045'] };
  const LFDLN_EDGE = { edge: '/etc/nginx/lfdln-panel/edge.conf', ports: ['3046', '3047'] };
  const files = (m: Map<string, string>) => [...m].map(([path, text]) => ({ path, text }));

  it("pammy.org's files: every location to the panel and the gate, its check clears X-Real-IP", () => {
    const r = checkEdge(PAMMY_EDGE, files(renderNginx(PROFILE, NGINX_FILES, { text: IPS })));
    assert.deepEqual(r.problems, []);
    assert.equal(r.count, 9);
  });
  it("lfdln's files, git's site among them, and its hosts with a service and accounts", () => {
    assert.deepEqual(checkEdge(LFDLN_EDGE, files(renderNginx(LFDLN, NGINX_FILES))).problems, []);
    const cfg = hostsConfigOf(LFDLN);
    assert.equal(cfg.edge, LFDLN_EDGE.edge);
    const hosts = renderAll(cfg, {
      hosts: [{ name: 'tutor', enabled: true }], folders: [{ name: 'docs', runPhp: true }],
      routes: [
        { host: 'tutor', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false },
        { host: 'tutor', path: '/app/', enabled: true, kind: 'service', service: 'examprep', part: 'web', websockets: false, maxBodyMb: null, signInPaths: [], accounts: { token: 'T'.repeat(32) } },
      ],
      services: [{ service: 'examprep', part: 'web', port: 4101 }],
    } as Table);
    const r = checkEdge(LFDLN_EDGE, files(hosts));
    assert.deepEqual(r.problems, []);
    assert.equal(r.count, 2, '/_pammy/ and its data-API writes');
    assert.match(hosts.get('hosts/tutor.conf')!, /location \^~ \/_pammy\/check\/ \{[\s\S]*?proxy_set_header X-Real-IP {4}"";/);
  });

  // the checker itself (tools/edge-check.ts, run by verify and the installers on the live files)
  const E = '/etc/nginx/lfdln-panel/edge.conf';
  const one = (text: string) => checkEdge(LFDLN_EDGE, [{ path: 'f.conf', text }]);
  it('finds the location around a line, whichever order its lines are in, and any way of naming this machine', () => {
    for (const to of ['127.0.0.1:3047', 'localhost:3047', '[::1]:3047', 'gate']) {
      const r = one(`upstream gate { server 127.0.0.1:3047; }\nserver {\n  location /a {\n    include ${E};\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_pass http://${to}/x;\n  }\n}\n`);
      assert.deepEqual(r, { problems: [], count: 1 }, to);
      assert.match(one(`upstream gate { server 127.0.0.1:3047; }\nlocation /a {\n  proxy_set_header X-Real-IP $remote_addr;\n  proxy_pass http://${to};\n}\n`).problems.join(), /without the edge secret/, to);
    }
  });
  it("reports a location to the panel or gate that doesn't set X-Real-IP, and allows clearing it", () => {
    assert.match(one('location /c { internal; proxy_pass http://127.0.0.1:3047/check; proxy_set_header Host $host; }').problems.join(), /without setting X-Real-IP/);
    assert.deepEqual(one('location /c { proxy_pass http://127.0.0.1:3047/check; proxy_set_header X-Real-IP ""; }'), { problems: [], count: 0 });
  });
  it('reports the secret going anywhere else: an app, a nested location inheriting it, no proxy, no location', () => {
    assert.match(one(`location /app { proxy_pass http://127.0.0.1:4101; proxy_set_header X-Real-IP $remote_addr; include ${E}; }`).problems.join(), /sends the edge secret to http:\/\/127\.0\.0\.1:4101/);
    const nested = one(`location /_pammy/ {\n  proxy_pass http://127.0.0.1:3047;\n  proxy_set_header X-Real-IP $remote_addr;\n  include ${E};\n  location /_pammy/app/ { proxy_pass http://127.0.0.1:4101; }\n}`);
    assert.equal(nested.count, 1);
    assert.match(nested.problems.join(), /sends the edge secret to http:\/\/127\.0\.0\.1:4101 \(inherited from f\.conf:1\)/);
    assert.deepEqual(one(`location /_pammy/ {\n  proxy_pass http://127.0.0.1:3047;\n  proxy_set_header X-Real-IP $remote_addr;\n  include ${E};\n  location /_pammy/app/ { proxy_pass http://127.0.0.1:4101; proxy_set_header Host $host; }\n}`).problems, [], 'a nested one that sets its own headers inherits none');
    assert.match(one(`location /x { root /tmp; include ${E}; }`).problems.join(), /proxies nowhere/);
    assert.match(one(`server { include ${E}; }`).problems.join(), /outside any location/);
    assert.match(one(`server {\n  proxy_set_header X-Real-IP $remote_addr;\n  include ${E};\n  location /app { proxy_pass http://127.0.0.1:4101; }\n}`).problems.join(), /inherited from f\.conf:1/);
  });
  it("S1e's lines are no findings: WordPress's cookie map (http level) and its proxy file", () => {
    const wp = join(import.meta.dirname, '..', '..', 'wordpress', 'nginx');
    const r = checkEdge(PAMMY_EDGE, ['cookie-map.conf', 'proxy.conf'].map((f) => ({ path: f, text: readFileSync(join(wp, f), 'utf8') }))
      .concat({ path: 'server.conf', text: `server {\n  location /blog/ {\n    include /etc/nginx/pammy-wordpress/proxy.conf;\n  }\n}\n` }));
    assert.deepEqual(r, { problems: [], count: 0 });
    // a proxy file's directives on their own, as the location would hold them
    assert.deepEqual(checkEdge(PAMMY_EDGE, [{ path: 'loc.conf', text: `location /blog/ {\n${readFileSync(join(wp, 'proxy.conf'), 'utf8')}\n}\n` }]).problems, []);
  });
  it("reads quotes and comments as nginx does, and leaves another site's edge file to that site", () => {
    assert.deepEqual(one(`# include ${E};\nlocation ~ "^/(?<p>[a-z]{1,3})$" { proxy_pass http://127.0.0.1:4101; } # include ${E};`).problems, []);
    assert.deepEqual(one('location /p { proxy_pass http://127.0.0.1:3045; proxy_set_header X-Real-IP $remote_addr; include /etc/nginx/pammy-panel/edge.conf; }').problems, []);
  });
});

// The secret never reaches a command line or a child's environment (review M1): anyone on
// the machine can read /proc/<pid>/cmdline. verify_edge, verify_edge_limits and
// make_edge_secret run with every program they call replaced by one that writes down its
// arguments, environment and (curl) what it was given on stdin, then does the real thing.
describe('the edge secret stays off command lines (S1c, review M1)', () => {
  const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  it('verify and the installer hand it over only on stdin and in files', () => {
    const T = mkdtempSync(join(tmpdir(), 'edge-argv-'));
    const bin = join(T, 'bin');
    mkdirSync(bin);
    const log = join(T, 'calls.log');
    const real = (cmd: string) => ['/usr/bin', '/bin'].map((d) => join(d, cmd)).find((f) => existsSync(f))!;
    for (const cmd of ['stat', 'tr', 'grep', 'find', 'sort', 'sed', 'seq', 'cmp', 'sh', 'ls', 'cat', 'openssl', 'chown', 'chmod', 'install', 'mv', 'rm']) {
      const passthrough = ['chown', 'install'].includes(cmd) ? 'exit 0' : `exec ${real(cmd)} "$@"`;
      writeFileSync(join(bin, cmd), `#!/bin/bash\n{ printf 'ARGV %s' ${sh(cmd)}; printf ' %s' "$@"; echo; /usr/bin/env | /usr/bin/sed 's/^/ENV /'; } >> ${sh(log)}\n${passthrough}\n`, { mode: 0o755 });
    }
    // curl: 401/400 when the secret came on stdin as a config, 429 without
    writeFileSync(join(bin, 'curl'), `#!/bin/bash\n{ printf 'ARGV curl'; printf ' %s' "$@"; echo; /usr/bin/env | /usr/bin/sed 's/^/ENV /'; } >> ${sh(log)}\nin=; for a in "$@"; do [[ $a == -K ]] && in=$(/usr/bin/cat); done\nprintf 'STDIN %s\\n' "$in" >> ${sh(join(T, 'stdin.log'))}\nif [[ $in == *X-Lfdln-Edge:* ]]; then [[ $* == */_pammy/* ]] && printf 401 || printf 400; else printf 429; fi\n`, { mode: 0o755 });
    // the checker: its arguments written down too
    mkdirSync(join(T, 'app', 'tools'), { recursive: true });
    writeFileSync(join(T, 'app', 'tools', 'edge-check.ts'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'ARGV edge-check ' + process.argv.slice(2).join(' ') + '\\n' + Object.entries(process.env).map(([k, v]) => 'ENV ' + k + '=' + v).join('\\n') + '\\n');\nconsole.log('ok 1');\n`);
    const etc = join(T, 'etc'), ngx = join(T, 'ngx');
    const deploy = join(import.meta.dirname, '..', 'deploy');
    const script = `
      set -u
      ok() { echo "ok $1"; }; bad() { echo "FAIL $1"; }; say() { echo "$1 $2"; }; die() { echo "DIE $1"; exit 1; }
      t_ok() { local l=$1; shift; if "$@" >/dev/null 2>&1; then ok "$l"; else bad "$l"; fi; }
      t_no() { local l=$1; shift; if "$@" >/dev/null 2>&1; then bad "$l"; else ok "$l"; fi; }
      APP=${sh(join(T, 'app'))}
      source ${sh(join(deploy, 'edge-secret.sh'))}
      source ${sh(join(deploy, 'verify-edge.sh'))}
      mkdir -p ${sh(etc)} ${sh(ngx)}
      make_edge_secret ${sh(etc)} ${sh(ngx)}
      make_edge_secret ${sh(etc)} ${sh(ngx)}
      verify_edge ${sh(etc)} ${sh(ngx)} x-panel 1 x-gate 2 panel.example example.org
      verify_edge_limits ${sh(etc)} 1 2 panel.example example.org
    `;
    const out = execFileSync('/bin/bash', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: T }, encoding: 'utf8', timeout: 60_000 });
    const secret = readFileSync(join(etc, 'edge.secret'), 'utf8').trim();
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(ngx, 'edge.conf'), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n'), `proxy_set_header X-Lfdln-Edge "${secret}";\n`);
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /^ARGV curl /m, 'curl was called');
    assert.match(calls, /^ARGV edge-check /m, 'the checker was called');
    assert.ok(!calls.includes(secret), 'the secret is on no command line and in no environment');
    assert.ok(!calls.includes(secret.slice(0, 16)), '...not even part of it');
    assert.match(readFileSync(join(T, 'stdin.log'), 'utf8'), new RegExp(`header = "X-Lfdln-Edge: ${secret}"`), 'curl had it on stdin');
    // and it all came out as it should (the files' owners aren't root here, so those two fail)
    for (const l of ['the include says the same secret', 'the gate: X-Real-IP with the secret is believed', 'the panel: X-Real-IP with the secret is believed',
      "the gate: a made-up X-Real-IP without the edge secret isn't believed", "the panel: a made-up X-Real-IP without the edge secret isn't believed",
      'every location to the panel and the gate sends it']) assert.match(out, new RegExp(`^ok ${l.replace(/[()]/g, '\\$&')}`, 'm'), l);
    assert.doesNotMatch(out, /^DIE/m);
    rmSync(T, { recursive: true, force: true });
  });
});
