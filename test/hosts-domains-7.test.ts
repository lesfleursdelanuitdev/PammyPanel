// gonsalvesfamily.com (docs/domains-hosts-plan.md step 7): hosts on another domain, a
// certificate for named hosts only (7-1), folders from disk on a service route (7-2) and
// certbot's webroot challenges (7-3). What the renderer writes, and what the routing
// helper does with it; real requests through a real nginx are
// test/run-adopt-nginx-test.sh (Gonsalves's two hand-written files beside the panel's).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RunResult, RunSpec } from '@panel/core/runner';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { createRoutesOps, tableOf } from '@panel/hosts/helper/ops';
import { certNames, kindsOf, renderAll, type Table } from '@panel/hosts/render';
import { TAKEOVERS, fullName, hostOf } from '@panel/hosts/takeover';
import { SERVED_FOLDERS } from '@panel/services/known';
import { PROFILE } from './fixtures/lfdln-profile.ts';

const G = 'gonsalvesfamily.com';
const cfg = { ...hostsConfigOf(PROFILE), signInZone: 'login' };
const LE = '/etc/letsencrypt/live';
const HOME = { name: PROFILE.domain, home: true, tls: { cert: `${LE}/${PROFILE.domain}/fullchain.pem`, key: `${LE}/${PROFILE.domain}/privkey.pem` } };
const GONSALVES = { name: G, home: false, tls: { cert: `${LE}/${G}/fullchain.pem`, key: `${LE}/${G}/privkey.pem` }, names: [G, `www.${G}`, `admin.${G}`] };
const PORTS = [{ service: 'gonsalves', part: 'public', port: 3039 }, { service: 'gonsalves', part: 'admin', port: 3040 }];

// lfdln's own "@" (a folder) and Gonsalves's two, as the takeovers make them
const table = (t: Partial<Table> = {}): Table => ({
  hosts: [{ name: '@', enabled: true, withWww: true }, ...TAKEOVERS.filter((x) => x.domain === G).map((x) => x.host)],
  folders: [{ name: 'home', runPhp: false }],
  routes: [{ host: '@', path: '/', enabled: true, kind: 'folder', folder: 'home', spa: false }, ...TAKEOVERS.filter((x) => x.domain === G).flatMap((x) => x.routes)],
  services: PORTS,
  domains: [HOME, GONSALVES],
  ...t,
});

describe('a certificate for named hosts (7-1)', () => {
  it('its names are the domain or one label under it, each once, sorted; nothing else', () => {
    assert.deepEqual(certNames(G, [`www.${G}`, G, `admin.${G}`, G]), [`admin.${G}`, G, `www.${G}`].sort());
    for (const bad of [[], [`*.${G}`], [`a.b.${G}`], ['example.com'], [`x${G}`], [`-a.${G}`], 'nope', [3]]) {
      assert.throws(() => certNames(G, bad), /isn't|not a list/, JSON.stringify(bad));
    }
  });

  it('each host on it its own file under domains/<name>/hosts/, no catch-all, and site.conf includes them', () => {
    const files = renderAll(cfg, table());
    assert.deepEqual([...files.keys()].filter((f) => f.startsWith('domains/')).sort(),
      [`domains/${G}/hosts/@.conf`, `domains/${G}/hosts/admin.conf`, `domains/${G}/pages/_lfdln/404.html`]);
    assert.equal(files.get('site.conf')!.split('\n').filter((l) => l.startsWith('include')).join('\n'),
      `include ${cfg.dir}/catch-all.conf;\ninclude ${cfg.dir}/hosts/*.conf;\ninclude ${cfg.dir}/domains/*/hosts/*.conf;`);
    const pub = files.get(`domains/${G}/hosts/@.conf`)!;
    assert.match(pub, new RegExp(`server_name ${G} www\\.${G};`));
    assert.match(pub, new RegExp(`ssl_certificate +${LE}/${G}/fullchain\\.pem;`));
    // its own 404 page, under its own folder
    assert.match(pub, new RegExp(`location = /_lfdln/404\\.html \\{ root ${cfg.dir}/domains/${G}/pages; \\}`));
    // the home domain's "@" is as it always was: on lfdln's certificate, in hosts/
    assert.match(files.get('hosts/@.conf')!, new RegExp(`server_name ${PROFILE.domain.replace(/\./g, '\\.')} www\\.`));
    assert.ok(!files.get('hosts/@.conf')!.includes(G));
  });

  it('every host has its own port-80 block: certbot\'s challenges from the webroot, everything else to https (7-3)', () => {
    const files = renderAll(cfg, table());
    for (const [f, names] of [['@', `${G} www.${G}`], ['admin', `admin.${G}`]] as const) {
      const text = files.get(`domains/${G}/hosts/${f}.conf`)!;
      const http = text.split('server {')[1]!;
      assert.match(http, /listen 80;/);
      assert.match(http, new RegExp(`server_name ${names.replace(/\./g, '\\.')};`));
      assert.match(http, /location \^~ \/\.well-known\/acme-challenge\/ \{ root \/var\/www\/letsencrypt; \}/);
      assert.match(http, /location \/ \{ return 301 https:\/\/\$host\$request_uri; \}/);
      // ...and on 443 too, before any route (as admin's hand-written file had it)
      const https = text.split('server {')[2]!;
      assert.match(https, /location \^~ \/\.well-known\/acme-challenge\/ \{ root \/var\/www\/letsencrypt; \}/);
    }
    // the home domain's hosts don't have one: its catch-all's http block and the wildcard's DNS-01
    assert.ok(![...files].some(([f, t]) => !f.startsWith('domains/') && t.includes('acme-challenge')));
  });

  it('refuses a host whose names aren\'t on the certificate, www beside it too', () => {
    const t = table();
    t.hosts.push({ name: 'shop', enabled: true, domain: G });
    t.routes.push({ host: 'shop', domain: G, path: '/', enabled: true, kind: 'folder', folder: 'home', spa: false });
    assert.throws(() => renderAll(cfg, t), /certificate doesn't cover shop\.gonsalvesfamily\.com/);
    const noWww = table({ domains: [HOME, { ...GONSALVES, names: [G, `admin.${G}`] }] });
    assert.throws(() => renderAll(cfg, noWww), /doesn't cover www\.gonsalvesfamily\.com/);
  });

  it('a wildcard domain beside it keeps its catch-all; one with named hosts only has none', () => {
    const t = table({ domains: [HOME, GONSALVES, { name: 'other.test', home: false, tls: HOME.tls }] });
    const files = renderAll(cfg, t);
    assert.ok(files.has('domains/other.test/catch-all.conf'));
    assert.ok(!files.has(`domains/${G}/catch-all.conf`));
    assert.match(files.get('site.conf')!, /domains\/\*\/catch-all\.conf;\n.*domains\/\*\/hosts\/\*\.conf;/);
  });
});

describe('hosts on another domain', () => {
  it('"@" on two domains is two hosts; the same name twice on one domain is refused', () => {
    assert.doesNotThrow(() => renderAll(cfg, table()));
    const t = table();
    t.hosts.push({ name: 'admin', enabled: true, domain: G });
    assert.throws(() => renderAll(cfg, t), /admin\.gonsalvesfamily\.com is there twice/);
  });

  it('a host or a route on a domain that isn\'t one here is refused; a route finds its host on its own domain', () => {
    assert.throws(() => renderAll(cfg, table({ domains: [HOME] })), /is on gonsalvesfamily\.com, which isn't a domain here/);
    const t = table();
    t.routes = t.routes.map((r) => (r.host === 'admin' ? { ...r, domain: undefined } : r));
    assert.throws(() => renderAll(cfg, t), /a route is on admin, which isn't a host/);
  });

  it('no accounts on another domain\'s routes yet', () => {
    const t = table();
    t.routes = t.routes.map((r) => (r.host === 'admin' ? { ...r, accounts: { token: 'a'.repeat(32) } } : r));
    assert.throws(() => renderAll({ ...cfg, gate: '127.0.0.1:3090' }, t), /another domain, where no route can have accounts/);
  });

  it('the routing helper takes the new fields and refuses them badly shaped', () => {
    const kinds = kindsOf(cfg);
    const t = tableOf(JSON.parse(JSON.stringify(table())), kinds);
    assert.equal(t.hosts.find((h) => h.name === 'admin')!.domain, G);
    assert.equal(t.routes.find((r) => r.host === 'admin')!.domain, G);
    assert.deepEqual(t.domains!.find((d) => d.name === G)!.names, GONSALVES.names);
    assert.throws(() => tableOf({ ...table(), hosts: [{ name: 'a', enabled: true, domain: 3 }] }, kinds), /a host's domain is missing/);
    assert.throws(() => tableOf({ ...table(), domains: [HOME, { ...GONSALVES, names: 'all' }] }, kinds), /certificate names is not a list/);
  });
});

describe('folders from disk on a service route (7-2)', () => {
  const pub = () => renderAll(cfg, table()).get(`domains/${G}/hosts/@.conf`)!;

  it('Gonsalves\'s public part: its two media folders, 30 days and immutable, before the sign-in path and the proxy', () => {
    const text = pub();
    for (const f of ['gedcom-admin', 'site-media']) {
      assert.ok(text.includes([
        `    location ^~ /uploads/${f}/ {`, `        alias /mnt/storage/uploads/${f}/;`, '        access_log off;', '        expires 30d;',
        '        add_header Cache-Control "public, immutable";', '        location ~ /\\. { deny all; }', '    }',
      ].join('\n')), f);
    }
    assert.ok(text.indexOf('/uploads/site-media/') < text.indexOf('location = /api/auth/login'));
    assert.ok(text.indexOf('location = /api/auth/login') < text.indexOf('location ^~ / {'));
    assert.match(text, /location = \/api\/auth\/login \{\n {8}limit_req zone=login burst=3 nodelay;\n {8}proxy_pass http:\/\/127\.0\.0\.1:3039;/);
    assert.match(text, /client_max_body_size 25m;/);
    // (admin has none: user-media is the admin app's to check)
    assert.ok(!renderAll(cfg, table()).get(`domains/${G}/hosts/admin.conf`)!.includes('/uploads/'));
  });

  it('come from code, not the table: a route can\'t name a folder', () => {
    const kinds = kindsOf(cfg);
    const t = tableOf({ ...table(), routes: table().routes.map((r) => ({ ...r, served: [{ path: '/etc/', dir: '/etc/' }] })) }, kinds);
    assert.ok(t.routes.every((r) => !('served' in r)));
    assert.deepEqual(Object.keys(SERVED_FOLDERS), ['gonsalves/public']);
  });

  it('a route with accounts in front of them is refused (they would be open to anyone)', () => {
    const t = table({ domains: [HOME, GONSALVES] });
    // (on the home domain, where accounts are possible)
    t.hosts.push({ name: 'fam', enabled: true });
    t.routes.push({ host: 'fam', path: '/', enabled: true, kind: 'service', service: 'gonsalves', part: 'public', websockets: true, maxBodyMb: 25, signInPaths: [], accounts: { token: 'a'.repeat(32) } });
    assert.throws(() => renderAll({ ...cfg, gate: '127.0.0.1:3090' }, t), /has accounts, but gonsalves\/public's folders would be open to anyone/);
  });

  it('a route further down than "/" keeps them only inside its own path', () => {
    const t = table();
    t.routes = t.routes.map((r) => (r.host === '@' && r.domain === G ? { ...r, path: '/app/' } : r));
    assert.throws(() => renderAll(cfg, t), /folder at \/uploads\/gedcom-admin\/ isn't inside \/app\//);
  });
});

describe('the takeovers (7-4)', () => {
  it('Gonsalves\'s two, by their full names; lfdln\'s as before', () => {
    assert.deepEqual(TAKEOVERS.map((t) => fullName(t, PROFILE.domain)),
      ['instastylr.lesfleursdelanuit.com', 'lesfleursdelanuit.com', 'tutor.lesfleursdelanuit.com', G, `admin.${G}`]);
    const pub = TAKEOVERS.find((t) => t.link === 'gonsalves-public')!;
    assert.equal(hostOf(pub, { path: '/', www: true }, PROFILE.domain), `www.${G}`);
  });

  it('on the server they never ask the sign-in address (it would spend the live limit), nor send big bodies', () => {
    for (const t of TAKEOVERS.filter((x) => x.domain === G)) {
      const live = t.checks('/nowhere').filter((c) => !c.harness);
      assert.ok(live.every((c) => !c.path.startsWith('/api/auth/') && !c.bytes && (c.method ?? 'GET') === 'GET'), t.link);
    }
  });
});

describe('the routing helper with another domain\'s hosts', () => {
  let root = '';
  before(() => { root = mkdtempSync(join(tmpdir(), 'hosts-7-')); });
  after(() => rmSync(root, { recursive: true, force: true }));
  const run = async (_: RunSpec): Promise<RunResult> => ({ code: 0, stdout: '', stderr: '' });

  it('writes them, and removes them (and the domain\'s folder) when they go', async () => {
    const ops = createRoutesOps({ cfg, run, zone: { taken: async () => null }, root, ports: () => PORTS });
    const at = (f: string) => join(root, cfg.dir, f);
    const r = await ops.apply(table());
    assert.ok(r.changed.includes(`domains/${G}/hosts/admin.conf`));
    assert.match(readFileSync(at(`domains/${G}/hosts/admin.conf`), 'utf8'), /proxy_pass http:\/\/127\.0\.0\.1:3040;/);
    const t = table();
    t.hosts = t.hosts.filter((h) => h.name !== 'admin');
    t.routes = t.routes.filter((r2) => r2.host !== 'admin');
    assert.deepEqual((await ops.apply(t)).removed, [`domains/${G}/hosts/admin.conf`]);
    const none = table({ hosts: [{ name: '@', enabled: true, withWww: true }], routes: [table().routes[0]!], domains: [HOME] });
    const gone = await ops.apply(none);
    assert.deepEqual(gone.removed, [`domains/${G}/hosts/@.conf`, `domains/${G}/pages/_lfdln/404.html`]);
    assert.ok(!existsSync(at(`domains/${G}`)));
    assert.ok(!readFileSync(at('site.conf'), 'utf8').includes('domains/'));
  });

  it('checks a domain with named hosts against its names, and nothing else in nginx is in its way', async () => {
    const tasks: unknown[] = [];
    const ops = createRoutesOps({
      cfg, zone: { taken: async () => null }, root, ports: () => PORTS,
      run: async (spec) => {
        if (spec.what !== 'check') return { code: 0, stdout: '', stderr: '' };
        const got = JSON.parse(spec.stdin!) as { kind: string; path?: string }[];
        tasks.push(...got);
        return { code: 0, stderr: '', stdout: JSON.stringify(got.map((x) => (x.kind === 'resolve' ? { kind: 'resolve', name: G, dns: { ok: true, why: 'here' } } : { kind: 'cert-file', path: x.path, cert: { ok: true, why: 'covers them' } }))) };
      },
    });
    const r = await ops.checkDomain({ domain: G, dns: 'manual', front: 'direct', tls: GONSALVES.tls, names: GONSALVES.names });
    assert.deepEqual((tasks.find((x) => (x as { kind: string }).kind === 'cert-file') as { names: string[] }).names, [...GONSALVES.names].sort());
    assert.equal(r.checks.find((c) => c.key === 'nginx')!.ok, true);
    assert.match(r.checks.find((c) => c.key === 'certificate')!.label, /covers admin\.gonsalvesfamily\.com, gonsalvesfamily\.com, www\.gonsalvesfamily\.com/);
    await assert.rejects(ops.checkDomain({ domain: G, names: ['example.com'] }), /isn't gonsalvesfamily\.com or one name under it/);
  });
});
