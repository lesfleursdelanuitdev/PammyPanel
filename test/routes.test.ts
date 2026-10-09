// The route list (docs/refactor-plan.md R4): every route of the panel and the
// gate, with its body limit and -- for the panel -- what it needs
// (docs/permissions-plan.md R3), whether it is about the whole site (not for a
// person kept to places), and who that lets in, compared with
// test/routes.snapshot.txt.
//
// Who: A an account manager, M an account with what members have always had, K
// one kept to a folder with what those have always had (the core's migration
// 0001 wrote both down, R8); "public" needs no one signed in.
//
// A route lost, renamed, or quietly un-limited while code moves fails here. When
// a change to the list is meant, look at the diff this prints, then:
//
//   UPDATE_ROUTES=1 node --test test/routes.test.ts
//
// Both apps are built with stubs instead of a database: registering routes never
// touches Postgres, and this test must stay fast enough to run on every change.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RouteOptions } from 'fastify';
import { buildApp } from '@panel/pammy/app';
import { MEMBER_RIGHTS, mayUse, PLACE_RIGHTS, RIGHTS, type Needs, type Right, type Who } from '@panel/core/panel/rights';
import type { Config } from '@panel/core/config';
import { siteFacts } from '@panel/core/profile';
import { PROFILE } from '@panel/pammy/profile';
import type { Sql } from '@panel/core/pg';
import type { MediaSync } from '@panel/files/media-sync';
import type { Publisher } from '@panel/media/media-public';
import type { Thumbnailer } from '@panel/thumbs/media-thumbs';
import { buildGateApp, type GateOptions } from '@panel/pammy/gate/app';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';

const SNAPSHOT = join(import.meta.dirname, 'routes.snapshot.txt');
const now = () => 1_800_000_000;
const nothing = {} as unknown as Sql;

let dir: string;
const lines: string[] = [];

// "64K", "2M", "8K": the limit as it is written in the code it comes from.
const size = (bytes: number) =>
  bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)}M` : bytes % 1024 === 0 ? `${bytes / 1024}K` : String(bytes);

// who a route lets in, worked out the way need() works it out: an admin, a member
// with what members always had, an account kept to a folder with what those
// always had (K), and one kept to folders with every part they can be given (P)
const KEPT_RIGHTS: readonly Right[] = ['files', 'media', 'forms', 'responses', 'comments'];
const ACCOUNTS: [string, Who][] = [
  ['A', { role: 'manager', rights: [], places: [] }],
  ['M', { role: 'member', rights: MEMBER_RIGHTS, places: [] }],
  ['K', { role: 'member', rights: KEPT_RIGHTS, places: ['/f'] }],
  ['P', { role: 'member', rights: PLACE_RIGHTS, places: ['/f', '/g'] }],
];
function who(needs: Needs, wholeSite: boolean): string {
  if (needs === 'public') return 'public';
  return ACCOUNTS.filter(([, u]) => mayUse(u, needs, wholeSite)).map(([k]) => k).join('') || 'nobody';
}
const unnamed: string[] = [];

function record(app: 'panel' | 'gate', fallback: number) {
  return (route: RouteOptions) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).map(String).sort();
    for (const method of methods) {
      const limit = size(route.bodyLimit ?? fallback);
      let rest = '';
      if (app === 'panel') {
        const needs = route.config?.needs;
        if (!needs && route.url.startsWith('/api/')) unnamed.push(`${method} ${route.url}`);
        const n = needs ?? 'public';
        const wholeSite = route.config?.wholeSite === true;
        rest = `${n.padEnd(10)} ${(wholeSite ? 'whole-site' : '').padEnd(10)} ${who(n, wholeSite)}`;
      }
      lines.push(`${app} ${method.padEnd(6)} ${route.url.padEnd(58)} ${limit.padStart(5)} ${rest}`.trimEnd());
    }
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pammy-routes-test-'));
  mkdirSync(join(dir, 'help'));
  writeFileSync(join(dir, 'help', '00-README.txt'), `${'='.repeat(30)}\n Your instructions\n${'='.repeat(30)}\n\nRead these.\n`);
  const config: Config = {
    site: siteFacts(PROFILE),
    origin: 'https://panel.pammy.org', rpID: 'panel.pammy.org', rpName: 'pammy.org panel', pgPasswordFile: '',
    host: '127.0.0.1', port: 0, publicDir: new URL('../public/', import.meta.url).pathname, helpDir: join(dir, 'help'),
    sitefsSocket: join(dir, 'sitefs.sock'), gateSocket: join(dir, 'gate.sock'), now,
    thumbsSocket: join(dir, 'thumbs.sock'), thumbsDir: join(dir, 'thumbs'), mediaPublicDir: join(dir, 'media-public'),
    pammydbSocket: join(dir, 'pammydb.sock'), appsSocket: join(dir, 'apps.sock'), mailSocket: join(dir, 'mail.sock'),
    tutorialsDir: new URL('../tutorials/', import.meta.url).pathname,
    tutorialExamplesDir: join(dir, 'tutorial-examples'), gateUrl: 'http://127.0.0.1:9',
  };
  const panel = buildApp(config, nothing, {
    media: {} as unknown as MediaSync,
    thumbs: { kick() {} } as unknown as Thumbnailer,
    publisher: { kick() {} } as unknown as Publisher,
    onRoute: record('panel', 64 * 1024),
  });
  await panel.ready();
  await panel.close();

  const gateCfg: GateOptions = { publicRoot: join(dir, 'public'), domain: 'pammy.org', now, pammydbSocket: join(dir, 'pammydb.sock') };
  const gate = buildGateApp(gateCfg, new GateLive(nothing, { sessions: visitorSessions, now }), { onRoute: record('gate', 8 * 1024) });
  await gate.ready();
  await gate.close();
});
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe('the route list', () => {
  it('is the one that is checked in', () => {
    const found = `${lines.join('\n')}\n`;
    if (process.env.UPDATE_ROUTES) { writeFileSync(SNAPSHOT, found); return; }
    const want = readFileSync(SNAPSHOT, 'utf8');
    if (want === found) return;
    const wantLines = new Set(want.trimEnd().split('\n'));
    const foundLines = new Set(lines);
    const gone = [...wantLines].filter((l) => !foundLines.has(l));
    const extra = [...foundLines].filter((l) => !wantLines.has(l));
    assert.fail([
      'the routes are not the ones in test/routes.snapshot.txt.',
      ...gone.map((l) => `  gone:  ${l}`),
      ...extra.map((l) => `  new:   ${l}`),
      'If that is meant: UPDATE_ROUTES=1 node --test test/routes.test.ts',
    ].join('\n'));
  });

  it('the web knows the same rights as the server', () => {
    // read, not imported: the web's files are built for the browser, not for Node
    const web = readFileSync(join(import.meta.dirname, '..', 'packages', 'core', 'web', 'lib', 'rights.ts'), 'utf8');
    const list = /export const RIGHTS = \[([^\]]*)\] as const;/.exec(web)?.[1] ?? '';
    assert.deepEqual([...list.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]), [...RIGHTS]);
    // and the same parts for someone kept to places
    const place = /export const PLACE_RIGHTS: readonly Right\[\] = \[([^\]]*)\];/.exec(web)?.[1] ?? '';
    assert.deepEqual([...place.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]), [...PLACE_RIGHTS]);
  });

  it('names what every /api route of the panel needs', () => {
    assert.deepEqual(unnamed, [], 'an /api route without { config: { needs } } refuses everyone (docs/permissions-plan.md R3)');
  });

  it('has every route exactly once', () => {
    const seen = new Map<string, number>();
    for (const l of lines) seen.set(l, (seen.get(l) ?? 0) + 1);
    assert.deepEqual([...seen].filter(([, n]) => n > 1).map(([l]) => l), []);
  });

  it('lets a person kept to places reach only the parts that know about places', () => {
    const limited = lines.filter((l) => l.startsWith('panel ') && /KP?$/.test(l)).map((l) => l.split(/\s+/)[2] ?? '');
    assert.ok(limited.length > 10, `only ${limited.length} routes are open to a person kept to places`);
    // Given what those accounts always had, Subdomains, People, Requests, Protected
    // folders, Accounts, API keys and Form examples stay shut (docs/media-plan.md
    // D22-D23). Activity is open since docs/permissions-plan.md R7: it sends such an
    // account only its own lines.
    for (const shut of ['/api/folders', '/api/users', '/api/areas', '/api/visitors', '/api/keys', '/api/databases', '/api/examples', '/api/sites', '/api/protected']) {
      assert.deepEqual(limited.filter((u) => u.startsWith(shut)), [], `${shut} is open to a person kept to places`);
    }
  });

  it('gives someone kept to places, with every part they can have, only their own folders\' things (step 3)', () => {
    const reach = (l: string) => /\s(A?M?K?P)$/.exec(l)?.[1] ?? '';
    const route = (l: string) => l.split(/\s+/).slice(1, 3).join(' ');
    const p = lines.filter((l) => l.startsWith('panel ') && reach(l).includes('P')).map(route);
    // subdomains and protected folders now tell places apart
    for (const open of ['GET /api/sites', 'GET /api/protected', 'POST /api/protected', 'POST /api/visitors', 'GET /api/requests']) assert.ok(p.includes(open), `${open} is shut to them`);
    // but making, trashing or restoring a folder at the top is the whole site's business
    for (const shut of ['POST /api/sites', 'POST /api/sites/trash', 'POST /api/sites/restore', 'GET /api/folders']) assert.ok(!p.includes(shut), `${shut} is open to them`);
    // and never Accounts, databases, programs, software or the examples
    for (const shut of ['/api/users', '/api/databases', '/api/api-keys', '/api/software', '/api/examples']) {
      assert.deepEqual(p.filter((r) => r.split(' ')[1]!.startsWith(shut)), [], `${shut} is open to them`);
    }
  });
});
