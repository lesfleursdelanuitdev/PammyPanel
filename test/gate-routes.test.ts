// The gate on every lfdln host (docs/phase8-plan.md 8-2): the routes as the gate reads
// them (gate-routes.json, written by the routing helper), where a page on a host is,
// and route areas in every "may this visitor see it" check (P8-4). The media API through
// a private route is in gate.test.ts; the files themselves in hosts.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { renderAll } from '@panel/hosts/render';
import { parseSiteRoutes, SiteRoutes } from '@panel/core/gate/site-routes';
import type { Access, AreaLookup } from '@panel/core/gate/live';
import type { Area } from '@panel/core/gate/store';
import { decide, loginUrl, needsVisitor, resolve } from '@panel/areas/gate/policy';
import { PROFILE as LFDLN } from './fixtures/lfdln-profile.ts';

const PRIVATE = 'P'.repeat(32);
const OPEN = 'O'.repeat(32);
let root: string;
let sites: string;
let file: string;

const routesJson = (hosts: Record<string, unknown[]>, domains = ['lesfleursdelanuit.com', 'gonsalvesfamily.com']) => JSON.stringify({ v: 1, domains, hosts });
const HOSTS = {
  'lesfleursdelanuit.com': [{ path: '/', kind: 'folder', folder: 'home', area: null }],
  'tutor.lesfleursdelanuit.com': [{ path: '/docs/', kind: 'folder', folder: 'docs', area: PRIVATE }, { path: '/', kind: 'service', service: 'tutorstar', area: null }],
  'club.lesfleursdelanuit.com': [{ path: '/', kind: 'folder', folder: 'club', area: OPEN }],
  'admin.gonsalvesfamily.com': [{ path: '/', kind: 'service', service: 'gonsalves', area: null }],
};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'gate-routes-'));
  sites = join(root, 'sites');
  for (const f of ['home', 'docs', 'club']) {
    mkdirSync(join(sites, f, 'media'), { recursive: true });
    writeFileSync(join(sites, f, 'index.html'), f);
    writeFileSync(join(sites, f, 'media', 'a.jpg'), 'x');
  }
  file = join(root, 'gate-routes.json');
  writeFileSync(file, routesJson(HOSTS));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('the routes as the gate reads them', () => {
  it('reads what the routing helper writes', () => {
    const cfg = hostsConfigOf(LFDLN);
    const text = renderAll(cfg, {
      hosts: [{ name: 'tutor', enabled: true }], folders: [{ name: 'docs', runPhp: false }],
      routes: [{ host: 'tutor', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false, accounts: { token: PRIVATE } }],
    }).get('gate-routes.json')!;
    const r = parseSiteRoutes(text);
    assert.deepEqual([...r.hosts.keys()], ['tutor.lesfleursdelanuit.com']);
    assert.deepEqual(r.byFolder.get('docs'), [PRIVATE]);
  });

  it('where a page on a host is: a site folder and a path in it, or a service page', () => {
    const s = new SiteRoutes(file);
    assert.deepEqual(s.placeOf('lesfleursdelanuit.com', '/about/x.html'), { kind: 'folder', folder: 'home', base: '/home', path: '/about/x.html', route: HOSTS['lesfleursdelanuit.com'][0] });
    assert.equal(s.placeOf('tutor.lesfleursdelanuit.com', '/docs/a/b.html')?.kind, 'folder');
    assert.deepEqual(s.placeOf('tutor.lesfleursdelanuit.com', '/docs/a/b.html'), { kind: 'folder', folder: 'docs', base: '/docs', path: '/a/b.html', route: HOSTS['tutor.lesfleursdelanuit.com'][0] });
    assert.equal((s.placeOf('tutor.lesfleursdelanuit.com', '/docs') as { path: string }).path, '/', 'the route\'s own address without its slash');
    assert.deepEqual(s.placeOf('tutor.lesfleursdelanuit.com', '/docsx'), { kind: 'other', route: HOSTS['tutor.lesfleursdelanuit.com'][1] }, 'not under /docs/');
    assert.equal(s.placeOf('tutor.lesfleursdelanuit.com', '/sessions/12')?.kind, 'other');
    assert.equal(s.placeOf('nope.lesfleursdelanuit.com', '/'), null);
    assert.ok(s.hasHost('admin.gonsalvesfamily.com') && !s.hasHost('gonsalvesfamily.com'));
    assert.deepEqual(s.areasOverFolder('docs'), [PRIVATE]);
    assert.deepEqual(s.areasOverFolder('home'), []);
  });

  it('reads it again when it changes, keeps the last good copy over a broken one, and without any fails closed', () => {
    const f = join(root, 'changing.json');
    const s = new SiteRoutes(f);
    assert.equal(s.known, false);
    assert.throws(() => s.placeOf('lesfleursdelanuit.com', '/'), /not known yet/);
    assert.throws(() => s.areasOverFolder('docs'), /not known yet/);
    assert.equal(s.hasHost('lesfleursdelanuit.com'), false);
    writeFileSync(f, routesJson({ 'a.lesfleursdelanuit.com': [] }));
    assert.ok(s.hasHost('a.lesfleursdelanuit.com'));
    writeFileSync(f, routesJson({ 'b.lesfleursdelanuit.com': [] }, ['lesfleursdelanuit.com', 'x']) + 'garbage');
    assert.ok(s.hasHost('a.lesfleursdelanuit.com'), 'the last good copy');
    writeFileSync(f, routesJson({ 'b.lesfleursdelanuit.com': [] }));
    assert.ok(s.hasHost('b.lesfleursdelanuit.com') && !s.hasHost('a.lesfleursdelanuit.com'));
  });

  it('refuses a file that isn\'t what the helper writes', () => {
    for (const bad of [
      '{}', routesJson({ 'a b': [] }), routesJson({ a: [{ path: 'x', kind: 'folder', folder: 'd', area: null }] }),
      routesJson({ a: [{ path: '/', kind: 'folder', folder: '../etc', area: null }] }),
      routesJson({ a: [{ path: '/', kind: 'folder', folder: 'd', area: 'short' }] }),
      JSON.stringify({ v: 2, domains: [], hosts: {} }),
    ]) assert.throws(() => parseSiteRoutes(bad), Error, bad);
  });
});

describe('route areas in "may this visitor see it" (P8-4)', () => {
  const area = (id: number, token: string, open: boolean): Area => ({
    id, token, path: `/route/${id}`, kind: 'route', guest_privileges: open ? 'pages.read' : '',
  } as unknown as Area);
  const areas = new Map([[PRIVATE, area(1, PRIVATE, false)], [OPEN, area(2, OPEN, true)]]);
  const lookup = (s: SiteRoutes): AreaLookup => ({
    byToken: (t) => areas.get(t),
    byPath: () => undefined,
    routeAreasOf: (folder) => s.areasOverFolder(folder).map((t) => areas.get(t) ?? null),
  });
  const member = { visitor: { username: 'm' }, opens: new Set([1]), roles: new Map() } as unknown as Access;

  it('a folder behind a private route is private, wherever else it is shown; an open one is open', () => {
    const l = lookup(new SiteRoutes(file));
    const docs = resolve(l, sites, '/docs/media/a.jpg');
    assert.ok(needsVisitor(docs));
    const d = decide(docs, null);
    assert.equal(d.allow ? 'allow' : d.reason, 'login');
    if (!d.allow && d.reason === 'login') assert.equal(loginUrl(d.protection, '', '/x', 'login'), `/_pammy/login?next=%2Fx&area=${PRIVATE}`, "a route has no sign-in page of its own: the gate's");
    assert.equal(decide(docs, member).allow, true, 'someone let in');
    assert.equal(decide(resolve(l, sites, '/club/media/a.jpg'), null).allow, true, 'open with accounts: anyone');
    assert.equal(decide(resolve(l, sites, '/home/index.html'), null).allow, true, 'no accounts');
    assert.equal(decide(resolve(l, sites, '/docs/login.html'), null).allow, false, "a folder's own login.html isn't exempt: a route has none");
  });

  it("a route's token the gate doesn't know locks the folder; unknown routes fail closed", () => {
    const f = join(root, 'unknown.json');
    writeFileSync(f, routesJson({ 'x.lesfleursdelanuit.com': [{ path: '/', kind: 'folder', folder: 'home', area: 'Z'.repeat(32) }] }));
    const d = decide(resolve(lookup(new SiteRoutes(f)), sites, '/home/index.html'), member);
    assert.equal(d.allow ? 'allow' : d.reason, 'locked');
    assert.throws(() => resolve(lookup(new SiteRoutes(join(root, 'none.json'))), sites, '/home/index.html'), /not known yet/);
  });

  it('pammy.org (no routes): nothing changes', () => {
    const r = resolve({ byToken: () => undefined, byPath: () => undefined }, sites, '/docs/media/a.jpg');
    assert.equal(needsVisitor(r), false);
    assert.equal(decide(r, null).allow, true);
  });
});
