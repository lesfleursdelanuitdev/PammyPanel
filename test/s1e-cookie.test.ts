// The gate's cookie stays with the gate (docs/s1-plan.md S1e, review SF3): what nginx hands
// an app -- a service, a project's server, PHP in a site folder -- never has the visitor's
// session cookie in it; the gate's own locations still get it. Real requests through a real
// nginx (an upstream that echoes the Cookie it got) are in test/run-route-accounts-nginx-test.sh.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { hostsConfigOf as pammyHostsConfigOf } from '@panel/pammy/hosts';
import { appCookieLine, appCookieMaps, renderAll, type HostsConfig, type Table } from '@panel/hosts/render';
import { projectKind } from '@panel/projects/route-kind';
import { VISITOR_COOKIE } from '@panel/core/gate/context';
import { readCookie } from '@panel/core/sessions';
import { WITH_HOSTS } from '@panel/pammy/nginx-hosts';
import { PROFILE as LFDLN } from './fixtures/lfdln-profile.ts';
import { PROFILE as LFDLN_REAL } from '@panel/lfdln/profile';
import { readFileSync } from 'node:fs';
import { renderAll as renderWordPress } from '@panel/apps/apps/nginx';

const cfg = hostsConfigOf(LFDLN);
const TOKEN = 'T'.repeat(32);
const table = (t: Partial<Table> = {}): Table => ({
  hosts: [{ name: 'tutor', enabled: true }], folders: [{ name: 'docs', runPhp: true }],
  routes: [{ host: 'tutor', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false }],
  ...t,
});
const svc = (r: Record<string, unknown> = {}) => ({
  host: 'tutor', path: '/', enabled: true, kind: 'service', service: 'examprep', part: 'web',
  websockets: false, maxBodyMb: null, signInPaths: [] as string[], ...r,
});
const services = [{ service: 'examprep', part: 'web', port: 4101 }];
const LINE = 'proxy_set_header Cookie $app_cookie_lfdln_visitor;';

// The two maps, as nginx reads them (PCRE; these regexes mean the same in JavaScript).
function asNginx(c: HostsConfig, cookie: string): string {
  const maps = appCookieMaps(c).join('\n');
  const blocks = [...maps.matchAll(/map \S+ \S+ \{\n([\s\S]*?)\n\}/g)].map((m) => m[1]!.split('\n').map((l) => l.trim()));
  assert.equal(blocks.length, 2);
  let v = cookie;
  for (const lines of blocks) {
    let out: string | null = null;
    for (const l of lines) {
      const m = /^"~(.*)" "(.*)";$/.exec(l);
      if (!m) continue;
      const hit = new RegExp(m[1]!).exec(v);
      if (hit) { out = m[2]!.replace(/\$([a-z]+)/g, (_, g: string) => hit.groups?.[g] ?? ''); break; }
    }
    v = out ?? v;   // default: the value as it came
  }
  return v;
}

describe('the gate\'s cookie is never handed to an app (S1e)', () => {
  it('the site\'s visitor cookie is the gate\'s: lfdln\'s own, pammy.org\'s the default', () => {
    assert.equal(cfg.visitorCookie, '__Host-lfdln_visitor');
    assert.equal(hostsConfigOf(LFDLN_REAL).visitorCookie, '__Host-lfdln_visitor');
    assert.equal(pammyHostsConfigOf(WITH_HOSTS).visitorCookie, VISITOR_COOKIE, 'config.ts names the gate\'s default');
  });

  it('takes the cookie out wherever it is, and keeps the app\'s own as they came', () => {
    const N = '__Host-lfdln_visitor';
    const cases: [string, string][] = [
      ['', ''],
      [`${N}=abc`, ''],
      [`${N}=abc; a=1`, 'a=1'],
      [`${N}=abc;a=1`, 'a=1'],
      [`a=1; ${N}=abc`, 'a=1'],
      [`a=1; ${N}=abc; b=2`, 'a=1; b=2'],
      [`a=1;${N}=abc;b=2`, 'a=1;b=2'],
      [`a=1; ${N}=; b=2`, 'a=1; b=2'],
      ['a=1; b=2', 'a=1; b=2'],
      // names that only look like it stay
      [`x${N}=1; b=2`, `x${N}=1; b=2`],
      [`${N}2=1; b=2`, `${N}2=1; b=2`],
      [`a=${N}=1`, `a=${N}=1`],
      // a tab after the ";" (the review's F1): taken out cleanly
      [`a=1;\t${N}=jo`, 'a=1'],
      [`a=1;\t${N}=jo; b=2`, 'a=1; b=2'],
      // spaces before the "=", or a tab before the name at the start: no cookies at all
      [`a=1; ${N} =jo`, ''],
      [`${N} =jo; a=1`, ''],
      [`\t${N}=jo; a=1`, ''],
      // sent twice (or more): nothing at all, never one of them
      [`${N}=a; b=2; ${N}=c`, ''],
      [`b=2; ${N}=a; ${N}=c`, ''],
    ];
    for (const [given, want] of cases) assert.equal(asNginx(cfg, given), want, given);
  });

  it('the gate reads a cookie only by its exact name: spaces after the ";" are the separator\'s', () => {
    const N = '__Host-lfdln_visitor';
    assert.equal(readCookie(`a=1; ${N}=jo`, N), 'jo');
    assert.equal(readCookie(`a=1;${N}=jo`, N), 'jo');
    assert.equal(readCookie(`a=1;\t${N}=jo`, N), 'jo');
    assert.equal(readCookie(`${N}=jo`, N), 'jo');
    assert.equal(readCookie(`a=1; ${N} =jo`, N), null, 'a name with a space after it is another name');
    assert.equal(readCookie(`my${N}=jo; ${N}2=jo`, N), null);
    // whatever the gate reads as its cookie, an app never gets (the maps take it out or send nothing)
    for (const h of [`a=1; ${N}=jo`, `a=1;${N}=jo`, `a=1;\t${N}=jo`, `${N}=jo`, `\t${N}=jo`]) {
      assert.equal(readCookie(asNginx(cfg, h), N), null, h);
    }
  });

  it('site.conf has the maps before the includes; a site without a gate has none', () => {
    const site = renderAll(cfg, table()).get('site.conf')!;
    assert.ok(site.indexOf('map $http_cookie $app_cookie_lfdln_visitor_once {') < site.indexOf('include '));
    assert.match(site, /map \$app_cookie_lfdln_visitor_once \$app_cookie_lfdln_visitor \{/);
    const none = { ...cfg, visitorCookie: undefined };
    assert.ok(!renderAll(none, table()).get('site.conf')!.includes('map '));
    assert.deepEqual(appCookieLine(none, ''), []);
  });

  it('refuses a cookie name nginx could read as its own', () => {
    for (const bad of ['lfdln_visitor', '__Host-a b', '__Host-a;b', '__Host-$x', '__Host-a"', '__Host-A']) {
      assert.throws(() => appCookieMaps({ ...cfg, visitorCookie: bad }), /can't be the visitor cookie's name/, bad);
    }
  });

  it('a service route, with accounts or without, and its sign-in path: without the gate\'s cookie', () => {
    const open = renderAll(cfg, table({ routes: [svc()], services })).get('hosts/tutor.conf')!;
    assert.equal(open.split(LINE).length - 1, 1);
    const gated = renderAll(cfg, table({ routes: [svc({ accounts: { token: TOKEN }, signInPaths: ['=/login'] })], services })).get('hosts/tutor.conf')!;
    assert.equal(gated.split(LINE).length - 1, 2, 'the route and its sign-in path');
    // the gate's own still get it: its check sends the visitor's header as it is, its pages are proxied untouched
    assert.match(gated, /location \^~ \/_pammy\/check\/ \{[\s\S]*?proxy_set_header Cookie       \$http_cookie;/);
    const pages = /location \^~ \/_pammy\/ \{[\s\S]*?\n {4}\}/.exec(gated)![0];
    assert.ok(!pages.includes('Cookie'));
  });

  it('a project\'s server, with accounts or without; its files need nothing', () => {
    const k = projectKind('/srv/lfdln-projects');
    const r = { kind: 'project', host: 'app', path: '/', enabled: true, project: 'app', branch: 'main', spa: false, cacheForever: [], serve: 'proxy' };
    for (const route of [r, { ...r, accounts: { token: TOKEN } }]) {
      assert.ok(k.locations({ cfg, host: 'app' } as never, route as never).includes(`        ${LINE}`));
    }
    const files = k.locations({ cfg, host: 'app' } as never, { ...r, serve: 'files' } as never).join('\n');
    assert.ok(!files.includes('Cookie'));
  });

  it('PHP in a site folder gets the cookies without the gate\'s (it reaches the API with a key)', () => {
    const f = renderAll(cfg, table()).get('hosts/tutor.conf')!;
    assert.match(f, /fastcgi_param PAMMY_USER "";\n\s+fastcgi_param HTTP_COOKIE \$app_cookie_lfdln_visitor;/);
    const noPhp = renderAll(cfg, table({ folders: [{ name: 'docs', runPhp: false }] })).get('hosts/tutor.conf')!;
    assert.ok(!noPhp.includes('Cookie'));
  });

  // WordPress (momolig 2026-10-08): its proxy files hand it the cookies without pammy.org's
  // gate's, through a map of its own at http level (conf.d), so whichever site includes them has it
  it('WordPress: its own map, the line in every proxy file, and its own cookies go along', () => {
    const WP = new URL('../../wordpress/nginx/', import.meta.url).pathname;
    const pammy = pammyHostsConfigOf(WITH_HOSTS);
    const map = readFileSync(`${WP}cookie-map.conf`, 'utf8');
    assert.ok(map.endsWith(`${appCookieMaps(pammy, 'wp_cookie_pammy_visitor').join('\n')}\n`), 'cookie-map.conf is what the renderer makes');
    assert.ok(!map.includes('$app_cookie_pammy_visitor '), 'its own variable, never the one in pammy.org\'s site.conf');
    const line = /^proxy_set_header Cookie +\$wp_cookie_pammy_visitor;$/m;
    assert.equal(readFileSync(`${WP}proxy.conf`, 'utf8').split('\n').filter((l) => l.startsWith('proxy_set_header Cookie')).length, 1);
    assert.match(readFileSync(`${WP}proxy.conf`, 'utf8'), line);
    const files = renderWordPress(`${WP}templates`, [
      { id: 'blog', placement: { mode: 'subdomain', name: 'blog' }, placementFile: '/etc/nginx/pammy-wordpress/placement', port: 3043, adopted: true },
      { id: 'shop', placement: { mode: 'path', name: 'shop' }, placementFile: '/etc/nginx/pammy-wordpress/placement-shop', port: 3100, adopted: false },
    ]);
    assert.match(files.get('/etc/nginx/pammy-wordpress/proxy-shop.conf')!, line, 'a second install\'s proxy file too');
    const N = '__Host-pammy_visitor';
    assert.equal(asNginx(pammy, `wordpress_logged_in_abc=1; ${N}=x; wp-settings-1=a; wp-settings-time-1=2; comment_author_y=z`),
      'wordpress_logged_in_abc=1; wp-settings-1=a; wp-settings-time-1=2; comment_author_y=z');
    assert.equal(asNginx(pammy, 'wordpress_test_cookie=WP%20Cookie%20check'), 'wordpress_test_cookie=WP%20Cookie%20check');
  });
});
