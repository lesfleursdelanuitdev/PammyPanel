// lfdln's hosts, routes and site folders (docs/hosts-plan.md step 1): what may be a
// name, a path or a redirect, and what the renderer writes for them. Real requests
// through a real nginx are test/run-hosts-nginx-test.sh.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { folderName, hostName, NameError, redirectStatus, redirectTo, routePath } from '@panel/hosts/names';
import { appCookieMaps, kindsOf, renderAll, type Table } from '@panel/hosts/render';
import { tableOf } from '@panel/hosts/helper/ops';
import { PROFILE as PAMMY } from '@panel/pammy/profile';
import { PROFILE as LFDLN } from './fixtures/lfdln-profile.ts';
import { PROFILE as LFDLN_REAL } from '@panel/lfdln/profile';

const cfg = hostsConfigOf(LFDLN);
const table = (t: Partial<Table> = {}): Table => ({
  hosts: [{ name: 'tutor', enabled: true }], folders: [{ name: 'docs', runPhp: true }],
  routes: [{ host: 'tutor', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false }],
  ...t,
});

describe('names', () => {
  it('a host is one DNS label, never one the server keeps', () => {
    for (const ok of ['a', 'tutor', 'my-site', 'x1', 'a'.repeat(63)]) assert.equal(hostName(ok), ok);
    for (const bad of ['', '-a', 'a-', 'A', 'a.b', 'a b', 'a_b', 'a'.repeat(64), 'www', 'panel', 'api', 'mail', 'é', 3]) {
      assert.throws(() => hostName(bad), NameError, String(bad));
    }
  });

  it('a site folder is one DNS label too', () => {
    assert.equal(folderName('docs'), 'docs');
    for (const bad of ['.git', '..', 'a/b', 'Docs', '']) assert.throws(() => folderName(bad), NameError, bad);
  });

  it('a path is tidied to /x/ and refuses dots at the start of a part', () => {
    assert.equal(routePath(''), '/');
    assert.equal(routePath('docs'), '/docs/');
    assert.equal(routePath('/a/b'), '/a/b/');
    assert.equal(routePath('/v1.2/'), '/v1.2/');
    for (const bad of ['/../', '/.git/', '/a//b/', '/a b/', '/a"/', '/a;/', '/$x/', '/{a}/']) assert.throws(() => routePath(bad), NameError, bad);
  });

  it('a redirect is an address or a path, with nothing nginx would read as its own', () => {
    for (const ok of ['https://example.com', 'https://example.com/new/page', 'http://a.b.c:8080/x', '/docs/', '/']) assert.equal(redirectTo(ok), ok);
    for (const bad of ['example.com', 'javascript:alert(1)', 'https://x.com/$host', 'https://x.com/a b', 'https://x.com/a;b', 'https://x.com/"', 'https://x.com/a{b}',
      'https://x.com/a/../b', '//evil.com', 'ftp://x.com', 'https://localhost', 'x'.repeat(501)]) {
      assert.throws(() => redirectTo(bad), NameError, bad);
    }
    assert.equal(redirectStatus(301), 301);
    assert.throws(() => redirectStatus(307), NameError);
  });
});

describe('rendering', () => {
  it('writes a block per host with a route on, the catch-all, the plain 404 and the includes', () => {
    const files = renderAll(cfg, table());
    assert.deepEqual([...files.keys()].sort(), ['catch-all.conf', 'cloudflare-realip.conf', 'gate-routes.json', 'hosts/tutor.conf', 'pages/_lfdln/404.html', 'site.conf']);
    const host = files.get('hosts/tutor.conf')!;
    assert.match(host, /server_name tutor\.lesfleursdelanuit\.com;/);
    assert.match(host, /root \/var\/www\/lesfleursdelanuit-sub\/docs;/);
    assert.match(host, /ssl_certificate +\/etc\/letsencrypt\/live\/wildcard\.lesfleursdelanuit\.com\/fullchain\.pem;/);
    assert.match(host, /ssl_dhparam \/etc\/letsencrypt\/ssl-dhparams\.pem;/);
    assert.match(host, /disable_symlinks on from=\$document_root;/);
    assert.match(host, /fastcgi_pass unix:\/run\/lfdln-php\/fpm\.sock;/, "PHP is on in the test profile (the site's own pool), and on for the folder");
    // the gate's cookie maps first (docs/s1-plan.md S1e), then the includes
    assert.equal(files.get('site.conf'), `# Written by the panel's routing helper (docs/hosts-plan.md). Changes here are overwritten.\n${appCookieMaps(cfg).join('\n')}\ninclude /etc/nginx/lfdln-hosts/catch-all.conf;\ninclude /etc/nginx/lfdln-hosts/hosts/*.conf;\n`);
  });

  it('a host switched off, or with every route stopped, has no file: the catch-all answers', () => {
    assert.ok(!renderAll(cfg, table({ hosts: [{ name: 'tutor', enabled: false }] })).has('hosts/tutor.conf'));
    assert.ok(!renderAll(cfg, table({ routes: [{ host: 'tutor', path: '/', enabled: false, kind: 'folder', folder: 'docs', spa: false }] })).has('hosts/tutor.conf'));
  });

  it("a folder's Run PHP switch off: PHP pages are never run, never text", () => {
    const host = renderAll(cfg, table({ folders: [{ name: 'docs', runPhp: false }] })).get('hosts/tutor.conf')!;
    assert.doesNotMatch(host, /fastcgi_pass/);
    assert.match(host, /php\[0-9\]\?\|phtml\|phar\|phps\)\$" \{ return 404; \}/);
    // and the same when the site has no PHP at all
    assert.doesNotMatch(renderAll({ ...cfg, php: null }, table()).get('hosts/tutor.conf')!, /fastcgi_pass/);
  });

  it('is the same text for the same table, whatever order it came in', () => {
    const t = table({
      hosts: [{ name: 'b', enabled: true }, { name: 'a', enabled: true }],
      routes: [
        { host: 'a', path: '/x/', enabled: true, kind: 'redirect', to: '/', status: 302, keepPath: false },
        { host: 'a', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false },
        { host: 'b', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: true },
      ],
    });
    const again = { ...t, hosts: [...t.hosts].reverse(), routes: [...t.routes].reverse() };
    assert.deepEqual(renderAll(cfg, t), renderAll(cfg, again));
  });

  it('refuses a redirect to a path inside its own route (it would loop)', () => {
    const r = (path: string, to: string) => table({ routes: [{ host: 'tutor', path, enabled: true, kind: 'redirect', to, status: 302, keepPath: false }] });
    assert.throws(() => renderAll(cfg, r('/', '/docs/')), /a loop/);
    assert.throws(() => renderAll(cfg, r('/away/', '/away/x')), /a loop/);
    assert.throws(() => renderAll(cfg, r('/away/', '/away')), /a loop/);
    assert.ok(renderAll(cfg, r('/away/', '/docs/')).has('hosts/tutor.conf'));
    assert.ok(renderAll(cfg, r('/', 'https://example.com/')).has('hosts/tutor.conf'), 'another site is fine');
  });

  it('refuses a route on a host that is not there, and a host twice', () => {
    assert.throws(() => renderAll(cfg, table({ routes: [{ host: 'nope', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false }] })), /isn't a host/);
    assert.throws(() => renderAll(cfg, table({ hosts: [{ name: 'tutor', enabled: true }, { name: 'tutor', enabled: true }] })), /twice/);
  });

  it('is only for a site with the hosts module on: pammy.org has none', () => {
    assert.ok(!PAMMY.modules.includes('hosts'));
    assert.throws(() => hostsConfigOf(PAMMY), /hosts module is off/);
  });
});

// ---------------------------------------------------------------- phase 6 (docs/adopt-plan.md V2-V4)
describe('taking over what already runs: the domain itself, services, headers', () => {
  const svc = (r: Record<string, unknown> = {}) => ({
    host: 'tutor', path: '/', enabled: true, kind: 'service' as const, service: 'tutorstar', part: 'web',
    websockets: true, maxBodyMb: 25, signInPaths: ['/api/auth/sign-in'], ...r,
  });
  const services = [{ service: 'tutorstar', part: 'web', port: 3041 }];
  const folderWith = (r: Record<string, unknown>) => table({ routes: [{ host: 'tutor', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: true, ...r }] });

  it('"@" is the domain itself, with www beside it, and nobody can make it or www from the page', () => {
    assert.throws(() => hostName('@'), NameError);
    const files = renderAll(cfg, table({ hosts: [{ name: '@', enabled: true, withWww: true }], routes: [{ host: '@', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false }] }));
    const f = files.get('hosts/@.conf')!;
    assert.match(f, /server_name lesfleursdelanuit\.com www\.lesfleursdelanuit\.com;/);
    assert.match(f, /return 301 https:\/\/\$host\$request_uri;/, 'its own http block (the catch-all never takes the domain or www)');
    assert.throws(() => renderAll(cfg, table({ hosts: [{ name: 'tutor', enabled: true, withWww: true }] })), /only the domain itself/);
    assert.throws(() => renderAll(cfg, table({ hosts: [{ name: 'www', enabled: true }] })), NameError);
  });

  it('a service route: the port from the service, websockets, the largest upload, the sign-in limit', () => {
    const f = renderAll(cfg, table({ routes: [svc()], services })).get('hosts/tutor.conf')!;
    assert.match(f, /location \^~ \/api\/auth\/sign-in \{\n\s+limit_req zone=login burst=3 nodelay;\n\s+proxy_pass http:\/\/127\.0\.0\.1:3041;/);
    assert.match(f, /location \^~ \/ \{\n\s+proxy_pass http:\/\/127\.0\.0\.1:3041;[\s\S]*Connection "upgrade";\n\s+client_max_body_size 25m;/);
    assert.match(renderAll(cfg, table({ routes: [svc({ signInPaths: ['=/api/auth/login'] })], services })).get('hosts/tutor.conf')!, /location = \/api\/auth\/login \{/);
    const plain = renderAll(cfg, table({ routes: [svc({ websockets: false, maxBodyMb: null, signInPaths: [] })], services })).get('hosts/tutor.conf')!;
    assert.doesNotMatch(plain.slice(plain.indexOf('    # /: ')), /Upgrade|client_max_body_size|limit_req/, "the route's own locations (the gate's /_pammy/ has its own limit)");
  });

  it('refuses a service that isn\'t there, the panel\'s own ports, and sign-in paths outside the route', () => {
    assert.throws(() => renderAll(cfg, table({ routes: [svc()] })), /isn't a service here/);
    for (const port of [cfg.reservedPorts![0]!, 80, 70000, 3.5]) {
      assert.throws(() => renderAll(cfg, table({ routes: [svc()], services: [{ ...services[0]!, port }] })), /port/, String(port));
    }
    assert.throws(() => renderAll(cfg, table({ routes: [svc({ path: '/app/', signInPaths: ['/api/x'] })], services })), /isn't inside/);
    assert.throws(() => renderAll(cfg, table({ routes: [svc({ signInPaths: ['/'] })], services })), /isn't inside/);
    for (const bad of ['/a b', '/a;b', '/a"', '/$x', '/.git', '//x', '/a/../b', 'x']) {
      assert.throws(() => renderAll(cfg, table({ routes: [svc({ signInPaths: [bad] })], services })), NameError, bad);
    }
    assert.throws(() => renderAll(cfg, table({ routes: [svc({ signInPaths: ['/a', '/a'] })], services })), /twice/);
    assert.throws(() => renderAll({ ...cfg, signInZone: null }, table({ routes: [svc()], services })), /no sign-in rate limit/);
    assert.throws(() => renderAll(cfg, table({ routes: [svc({ maxBodyMb: 0 })], services })), NameError);
  });

  it('a folder route\'s headers go on every answer, and on the paths cached for good again', () => {
    const f = renderAll(cfg, folderWith({ headers: [{ name: 'x-frame-options', value: 'DENY' }], cacheForever: ['/assets/'] })).get('hosts/tutor.conf')!;
    assert.equal(f.match(/add_header X-Frame-Options "DENY" always;/g)?.length, 3, 'the host (its 404 page), the route, the cached path');
    assert.match(f, /location \/assets\/ \{\n\s+try_files \$uri =404;\n\s+expires 1y;\n\s+add_header Cache-Control "public, immutable" always;\n\s+add_header X-Frame-Options/);
  });

  it('refuses a header it doesn\'t know, a value that could break out, and caching the whole host', () => {
    for (const bad of [{ name: 'Set-Cookie', value: 'a=b' }, { name: 'X-Frame-Options', value: 'DENY" always; return 200 "x' }, { name: 'X-Frame-Options', value: '$host' },
      { name: 'X-Frame-Options', value: 'a\nb' }, { name: 'X-Frame-Options', value: 'a\\b' }, { name: 'X-Frame-Options', value: '{a}' }, { name: 'X-Frame-Options', value: '' }]) {
      assert.throws(() => renderAll(cfg, folderWith({ headers: [bad] })), NameError, JSON.stringify(bad));
    }
    assert.throws(() => renderAll(cfg, folderWith({ headers: [{ name: 'X-Frame-Options', value: 'DENY' }, { name: 'x-frame-options', value: 'DENY' }] })), /twice/);
    assert.throws(() => renderAll(cfg, folderWith({ cacheForever: ['/'] })), /whole host/);
    assert.throws(() => renderAll(cfg, table({ routes: [{ host: 'tutor', path: '/docs/', enabled: true, kind: 'folder', folder: 'docs', spa: false, cacheForever: ['/docs/a/'] }] })), /only a folder at the top/);
  });
});

// docs/roles-plan.md step 5 (S5-4): a route with accounts asks the gate, and every
// service or PHP location clears the identity headers a visitor might send.
describe('accounts on a route', () => {
  const TOKEN = 'T'.repeat(32);
  const services = [{ service: 'examprep', part: 'web', port: 4101 }];
  const svc = (r: Record<string, unknown> = {}) => ({
    host: 'tutor', path: '/', enabled: true, kind: 'service' as const, service: 'examprep', part: 'web',
    websockets: false, maxBodyMb: null, signInPaths: [] as string[], ...r,
  });
  const host = (t: Partial<Table>) => renderAll(cfg, table(t)).get('hosts/tutor.conf')!;

  it('the site profile names the gate and what apps are told', () => {
    assert.equal(cfg.gate, '127.0.0.1:3047');
    assert.equal(cfg.identity, 'Lfdln');
    const real = hostsConfigOf(LFDLN_REAL);
    assert.equal(real.gate, '127.0.0.1:3047', "lfdln's own: areas and people on");
  });

  it('a service route with accounts: the gate first, its answer to the app, the gate\'s pages on the host', () => {
    const f = host({ routes: [svc({ accounts: { token: TOKEN }, signInPaths: ['=/login'] })], services });
    assert.match(f, /location \^~ \/_pammy\/check\/ \{\n\s+internal;\n\s+proxy_pass http:\/\/127\.0\.0\.1:3047\/check\/;/);
    assert.match(f, /location \^~ \/_pammy\/ \{\n\s+proxy_pass http:\/\/127\.0\.0\.1:3047;[\s\S]*?X-Pammy-Base\s+"\/";/);
    assert.match(f, /location @lfdln_login \{\n\s+add_header Cache-Control "private, no-store" always;\n\s+return 302 \$lfdln_login;/);
    // the route's own location, and its sign-in path's: both ask
    // ... naming the app, so the gate signs what it is told for it alone (docs/s1-plan.md S1a)
    assert.equal(f.match(new RegExp(`auth_request /_pammy/check/${TOKEN}/service\\.examprep\\.web;`, 'g'))?.length, 2);
    assert.equal(f.match(/auth_request_set \$lfdln_proof \$upstream_http_x_pammy_proof;/g)?.length, 2);
    assert.equal(f.match(/proxy_set_header X-Lfdln-Proof \$lfdln_proof;/g)?.length, 2);
    assert.equal(f.match(/error_page 401 = @lfdln_login;/g)?.length, 2);
    for (const [h, v] of [['Account', 'account'], ['Username', 'username'], ['Role', 'role'], ['Privileges', 'privileges']]) {
      assert.equal(f.match(new RegExp(`proxy_set_header X-Lfdln-${h} \\$lfdln_${v};`, 'g'))?.length, 2, h);
    }
    assert.match(f, /auth_request_set \$lfdln_username \$upstream_http_x_pammy_user;/);
    // the gate signs for that app only on this route's area (review B1): gate-routes.json says which
    const gr = JSON.parse(renderAll(cfg, table({ routes: [svc({ accounts: { token: TOKEN } })], services })).get('gate-routes.json')!);
    assert.deepEqual(gr.hosts[`tutor.${cfg.domain}`], [{ path: '/', kind: 'service', service: 'examprep', area: TOKEN, audience: 'service.examprep.web' }]);
    const plain = JSON.parse(renderAll(cfg, table({ routes: [svc()], services })).get('gate-routes.json')!);
    assert.equal(plain.hosts[`tutor.${cfg.domain}`][0].audience, undefined, 'no accounts: no app to sign for');
  });

  it('without accounts: nothing asks the gate, and the headers a visitor sends are cleared all the same', () => {
    const f = host({ routes: [svc()], services });
    assert.doesNotMatch(f, /auth_request|_pammy\/check|@lfdln_login/);
    // the gate's own pages are there all the same (docs/phase8-plan.md 8-2, P8-3)
    assert.match(f, /location \^~ \/_pammy\/ \{\n\s+proxy_pass http:\/\/127\.0\.0\.1:3047;/);
    for (const h of ['Account', 'Username', 'Role', 'Privileges', 'Proof']) assert.match(f, new RegExp(`proxy_set_header X-Lfdln-${h} "";`));
  });

  it('a folder route with accounts: nested locations inherit it, PHP is told, and private answers stay private', () => {
    const f = host({ routes: [{ host: 'tutor', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false, accounts: { token: TOKEN }, cacheForever: ['/assets/'] }] });
    const route = f.slice(f.indexOf('location ^~ / {'));
    assert.match(route, new RegExp(`try_files \\$uri \\$uri/ =404;\\n\\s+auth_request /_pammy/check/${TOKEN};`));
    assert.match(route, /add_header Cache-Control \$lfdln_cache always;/);
    assert.match(route, /fastcgi_param LFDLN_ACCOUNT \$lfdln_account;/);
    assert.match(route, /fastcgi_param LFDLN_PRIVILEGES \$lfdln_privileges;/);
    assert.match(route, /fastcgi_param HTTP_X_LFDLN_ACCOUNT "";/);
    // the paths cached for good don't say private and public at once
    assert.match(route, /location \/assets\/ \{\n\s+try_files \$uri =404;\n\s+expires 1y;\n\s+add_header Cache-Control "public, immutable" always;\n\s+\}/);
    const plain = host({});
    // an app's pammy-panel.json is the panel's to read, never a visitor's (step 6)
    assert.match(plain, /location ~ "\/pammy-panel\\.json\$" \{ return 404; \}/);
    assert.match(plain, /fastcgi_param LFDLN_ACCOUNT "";/);
    assert.match(plain, /fastcgi_param HTTP_X_LFDLN_ROLE "";/);
    assert.doesNotMatch(plain, /lfdln_cache|auth_request/);
  });

  it('refuses accounts on a redirect, a route under /_pammy/ beside them, a token that isn\'t one, and a site with no gate', () => {
    assert.throws(() => host({ routes: [{ host: 'tutor', path: '/', enabled: true, kind: 'redirect', to: '/x/', status: 302, keepPath: false, accounts: { token: TOKEN } }] }), /can't have accounts/);
    assert.throws(() => host({ routes: [svc({ accounts: { token: TOKEN } }), { host: 'tutor', path: '/_pammy/x/', enabled: true, kind: 'folder', folder: 'docs', spa: false }], services }), /can't have a route at \/_pammy\/x\//);
    assert.throws(() => host({ routes: [svc({ accounts: { token: 'short' } })], services }), /isn't one/);
    assert.throws(() => renderAll({ ...cfg, gate: null }, table({ routes: [svc({ accounts: { token: TOKEN } })], services })), /no gate/);
    assert.throws(() => renderAll({ ...cfg, identity: 'x-y' }, table({ routes: [svc()], services })), /identity headers/);
  });
});

describe('domains as data (docs/domains-hosts-plan.md step 1)', () => {
  const home = { name: LFDLN.domain, home: true, tls: { ...LFDLN.hosts.tls } };
  const full = (domains: NonNullable<Table['domains']>) => table({
    hosts: [{ name: 'tutor', enabled: true }, { name: '@', enabled: true, withWww: true }],
    routes: [
      { host: 'tutor', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false },
      { host: '@', path: '/', enabled: true, kind: 'redirect', to: 'https://example.com/', status: 302, keepPath: false },
    ],
    domains,
  });

  it('the home domain\'s row, as the installer seeds it from the profile, renders byte for byte what the profile did', () => {
    const before = renderAll(cfg, { ...full([home]), domains: undefined });
    const after = renderAll(cfg, full([home]));
    assert.deepEqual([...after.keys()], [...before.keys()]);
    for (const [f, text] of before) assert.equal(after.get(f), text, f);
  });

  it('the certificate comes from the row', () => {
    const moved = { ...home, tls: { cert: '/etc/letsencrypt/live/other/fullchain.pem', key: '/etc/letsencrypt/live/other/privkey.pem' } };
    const f = renderAll(cfg, full([moved])).get('hosts/tutor.conf')!;
    assert.match(f, /ssl_certificate     \/etc\/letsencrypt\/live\/other\/fullchain\.pem;/);
    assert.doesNotMatch(f, /options-ssl-nginx/);
  });

  it('refuses a home domain that isn\'t the site\'s, no home or two, a domain it doesn\'t serve yet, and certificate paths outside the roots', () => {
    assert.throws(() => renderAll(cfg, full([{ ...home, name: 'example.com' }])), /home domain is lesfleursdelanuit\.com/);
    assert.throws(() => renderAll(cfg, full([{ ...home, home: false }])), /no home domain/);
    assert.throws(() => renderAll(cfg, full([home, { ...home }])), /more than one/);
    assert.throws(() => renderAll(cfg, full([home, { ...home, name: 'shop.lesfleursdelanuit.com', home: false }])), /inside lesfleursdelanuit\.com/);
    assert.throws(() => renderAll(cfg, full([home, { ...home, name: 'com', home: false }])), /not a domain|A domain/);
    for (const bad of ['/root/cert.pem', '/etc/letsencrypt/../shadow', '/etc/ssl/a;b', 'relative.pem']) {
      assert.throws(() => renderAll(cfg, full([{ ...home, tls: { ...home.tls, cert: bad } }])), /certificate/, bad);
    }
    assert.throws(() => renderAll(cfg, full([{ ...home, tls: { ...home.tls, include: ['/etc/nginx/nginx.conf'] } }])), /TLS include/);
    assert.throws(() => renderAll({ ...cfg, tlsRoots: ['/etc/ssl/'] }, full([home])), /isn't under \/etc\/ssl\//);
  });

  it('a domain\'s name is two or more DNS labels', async () => {
    const { domainName } = await import('@panel/hosts/names');
    assert.equal(domainName('Example.COM.'), 'example.com');
    assert.equal(domainName('a.b.gonsalvesfamily.com'), 'a.b.gonsalvesfamily.com');
    for (const bad of ['', 'com', 'a..b', '-a.com', 'a.1com', 'a b.com', 'a_b.com', `${'a'.repeat(64)}.com`, 'é.com', 3]) {
      assert.throws(() => domainName(bad), NameError, String(bad));
    }
  });
});

describe('target kinds as a registry (docs/domains-hosts-plan.md step 2)', () => {
  const svcRoute = { host: 'tutor', path: '/', enabled: true, kind: 'service', service: 'tutorstar', part: 'web', websockets: true, maxBodyMb: null, signInPaths: [] };
  const services = [{ service: 'tutorstar', part: 'web', port: 3041 }];

  it('a route of a kind the site doesn\'t have is refused: a service without the services module, a word nobody knows', async () => {
    const { hostsConfigOf: bare } = await import('@panel/hosts/config');
    assert.throws(() => renderAll(bare(LFDLN), table({ routes: [svcRoute], services })), /is a service, which this site doesn't have/);
    assert.ok(renderAll(cfg, table({ routes: [svcRoute], services })).get('hosts/tutor.conf'));
    assert.throws(() => renderAll(cfg, table({ routes: [{ host: 'tutor', path: '/', enabled: true, kind: 'teapot' }] })), /is a teapot, which this site doesn't have/);
    const { tableOf } = await import('@panel/hosts/helper/ops');
    const { kindsOf } = await import('@panel/hosts/render');
    assert.throws(() => tableOf({ hosts: [], folders: [], routes: [{ ...svcRoute, kind: 'teapot' }] }, kindsOf(cfg)), /A route shows a folder, a redirect, a service, a project; not teapot/);
    assert.throws(() => tableOf({ hosts: [], folders: [], routes: [{ ...svcRoute, websockets: 'yes' }] }, kindsOf(cfg)), /websockets is not true or false/);
    // each kind keeps only its own fields
    assert.deepEqual(tableOf({ hosts: [], folders: [], routes: [{ ...svcRoute, folder: 'docs', to: '/x' }] }, kindsOf(cfg)).routes[0],
      { host: 'tutor', path: '/', enabled: true, kind: 'service', service: 'tutorstar', part: 'web', websockets: true, maxBodyMb: null, signInPaths: [] });
  });

  it('a module\'s own kind renders its own locations, and the renderer checks the rest as for any route', async () => {
    const { HOSTS_KINDS } = await import('@panel/hosts/render');
    const teapot = {
      kind: 'teapot', accounts: false,
      fields: () => ({}),
      describe: () => 'a teapot',
      locations: (_ctx: unknown, r: { path: string }) => [`    location ^~ ${r.path} { return 418; }`],
    };
    const c = { ...cfg, kinds: [...HOSTS_KINDS, teapot] };
    const f = renderAll(c, table({ routes: [{ host: 'tutor', path: '/tea/', enabled: true, kind: 'teapot' }] })).get('hosts/tutor.conf')!;
    assert.match(f, /# \/tea\/: a teapot\n    location \^~ \/tea\/ \{ return 418; \}/);
    assert.throws(() => renderAll(c, table({ routes: [{ host: 'tutor', path: '/tea/', enabled: true, kind: 'teapot', accounts: { token: 'a'.repeat(32) } }] })), /is a teapot, which can't have accounts/);
    assert.throws(() => renderAll({ ...cfg, kinds: [...HOSTS_KINDS, teapot, teapot] }, table()), /there twice/);
  });
});

describe('another domain (docs/domains-hosts-plan.md step 4)', () => {
  const home = { name: LFDLN.domain, home: true, tls: { ...LFDLN.hosts.tls } };
  const g = { name: 'gonsalvesfamily.com', home: false, tls: { cert: '/etc/letsencrypt/live/wildcard.gonsalvesfamily.com/fullchain.pem', key: '/etc/letsencrypt/live/wildcard.gonsalvesfamily.com/privkey.pem' } };

  it('its own catch-all and 404 page under domains/<name>/, and site.conf includes them; the home domain\'s files unchanged', () => {
    const before = renderAll(cfg, table({ domains: [home] }));
    const after = renderAll(cfg, table({ domains: [home, g] }));
    for (const f of ['catch-all.conf', 'hosts/tutor.conf', 'pages/_lfdln/404.html']) assert.equal(after.get(f), before.get(f), f);
    assert.equal(before.get('site.conf')!.includes('domains'), false);
    assert.match(after.get('site.conf')!, /include \/etc\/nginx\/lfdln-hosts\/domains\/\*\/catch-all\.conf;\n$/);
    const c = after.get('domains/gonsalvesfamily.com/catch-all.conf')!;
    assert.match(c, /server_name "~\^\(\?!www\\\.\)\[a-z0-9\]\(\?:\[a-z0-9-\]\*\[a-z0-9\]\)\?\\\.gonsalvesfamily\\\.com\$";/);
    assert.match(c, /ssl_certificate_key \/etc\/letsencrypt\/live\/wildcard\.gonsalvesfamily\.com\/privkey\.pem;/);
    assert.match(c, /root \/etc\/nginx\/lfdln-hosts\/domains\/gonsalvesfamily\.com\/pages;/);
    assert.match(after.get('domains/gonsalvesfamily.com/pages/_lfdln/404.html')!, /on gonsalvesfamily\.com\./);
  });

  it('refuses it twice, its certificate outside the roots', () => {
    assert.throws(() => renderAll(cfg, table({ domains: [home, g, { ...g }] })), /there twice/);
    assert.throws(() => renderAll(cfg, table({ domains: [home, { ...g, tls: { cert: '/home/x/c.pem', key: '/etc/ssl/k' } }] })), /isn't under/);
  });
});

// docs/phase8-plan.md 8-2: the gate on every host, and the routes as the gate reads them
describe('the gate on every host (phase 8, 8-2)', () => {
  const TOKEN = 'T'.repeat(32);
  const services = [{ service: 'examprep', part: 'web', port: 4101 }];
  const svc = (r: Record<string, unknown> = {}) => ({
    host: 'tutor', path: '/', enabled: true, kind: 'service' as const, service: 'examprep', part: 'web',
    websockets: false, maxBodyMb: null, signInPaths: [] as string[], ...r,
  });

  it("/_pammy/ on every host with a route on, its base the site folder at the host's top, the data API's writes up to 2 MB", () => {
    const f = renderAll(cfg, table()).get('hosts/tutor.conf')!;
    const gate = f.slice(f.indexOf('    location ^~ /_pammy/ {'), f.indexOf('    # /: '));
    assert.match(gate, /proxy_pass http:\/\/127\.0\.0\.1:3047;[\s\S]*?X-Pammy-Base\s+"\/docs";[\s\S]*?client_max_body_size 64k;/);
    assert.match(gate, /location ~ \^\/_pammy\/api\/data\/\[\^\/\]\+\/\[\^\/\]\+\/\[\^\/\]\+\/\(new\|\[\^\/\]\+\/save\)\$ \{[\s\S]*?X-Pammy-Base\s+"\/docs";[\s\S]*?client_max_body_size 2m;/);
    assert.doesNotMatch(f, /_pammy\/check|@lfdln_login/, 'no route with accounts: nothing asks');
    // a service at the top: "/", and the gate finds the rest by the routes
    const s = renderAll(cfg, table({ routes: [svc()], services })).get('hosts/tutor.conf')!;
    assert.match(s, /X-Pammy-Base\s+"\/";/);
    // a site with no gate: none of it
    const none = renderAll({ ...cfg, gate: null }, table());
    assert.doesNotMatch(none.get('hosts/tutor.conf')!, /_pammy/);
    assert.ok(!none.has('gate-routes.json'));
  });

  it("the gate's locations carry nginx's edge secret, a service's never (docs/s1-plan.md S1c)", () => {
    const f = renderAll(cfg, table({ routes: [svc({ path: '/app/' })], services })).get('hosts/tutor.conf')!;
    const gate = f.slice(f.indexOf('    location ^~ /_pammy/ {'), f.indexOf('    # /: '));
    assert.equal(gate.match(/include \/etc\/nginx\/lfdln-panel\/edge\.conf;/g)?.length, 2, '/_pammy/ and its data-API writes');
    assert.equal(f.match(/edge\.conf/g)?.length, 2, 'nowhere else on the host');
    assert.doesNotMatch(renderAll({ ...cfg, edge: undefined }, table()).get('hosts/tutor.conf')!, /edge\.conf/, 'no edge file: none');
  });

  it('no route under /_pammy/ on any host, accounts or not', () => {
    assert.throws(() => renderAll(cfg, table({ routes: [{ host: 'tutor', path: '/_pammy/', enabled: true, kind: 'folder', folder: 'docs', spa: false }] })), /the gate's on every host/);
  });

  it("gate-routes.json: every name a host answers to, on every domain, and what each route shows", () => {
    const t = table({
      hosts: [{ name: 'tutor', enabled: true }, { name: '@', enabled: true, withWww: true }, { name: 'off', enabled: false }, { name: 'admin', enabled: true, domain: 'other.example' }],
      folders: [{ name: 'docs', runPhp: false }, { name: 'home', runPhp: false }],
      routes: [
        svc({ accounts: { token: TOKEN } }),
        { host: 'tutor', path: '/docs/', enabled: true, kind: 'folder', folder: 'docs', spa: false, accounts: { token: 'U'.repeat(32) } },
        { host: 'tutor', path: '/gone/', enabled: false, kind: 'folder', folder: 'docs', spa: false },
        { host: '@', path: '/', enabled: true, kind: 'folder', folder: 'home', spa: false },
        { host: 'off', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false },
        { host: 'admin', domain: 'other.example', path: '/', enabled: true, kind: 'redirect', to: 'https://example.org/', status: 302, keepPath: false },
      ],
      services,
      domains: [
        { name: 'lesfleursdelanuit.com', home: true, tls: cfg.tls },
        { name: 'other.example', home: false, tls: cfg.tls },
      ],
    });
    const files = renderAll(cfg, t);
    assert.deepEqual(JSON.parse(files.get('gate-routes.json')!), {
      v: 1, domains: ['lesfleursdelanuit.com', 'other.example'],
      hosts: {
        'lesfleursdelanuit.com': [{ path: '/', kind: 'folder', folder: 'home', area: null }],
        'www.lesfleursdelanuit.com': [{ path: '/', kind: 'folder', folder: 'home', area: null }],
        'tutor.lesfleursdelanuit.com': [{ path: '/', kind: 'service', service: 'examprep', area: TOKEN, audience: 'service.examprep.web' }, { path: '/docs/', kind: 'folder', folder: 'docs', area: 'U'.repeat(32) }],
        'admin.other.example': [{ path: '/', kind: 'redirect', area: null }],
      },
    });
    assert.match(files.get('domains/other.example/hosts/admin.conf')!, /location \^~ \/_pammy\/ \{/, "another domain's host has the gate's pages too");
  });
});

// Cloudflare in front (docs/security-performance-review.md S6): on a domain whose row says
// so, every server block includes the real-IP file, so the logs, limit_req and X-Real-IP see
// the visitor; on any other, none does, and CF-Connecting-IP means nothing there.
describe('Cloudflare in front (S6)', () => {
  const LE = '/etc/letsencrypt/live';
  const tls = (d: string) => ({ cert: `${LE}/${d}/fullchain.pem`, key: `${LE}/${d}/privkey.pem` });
  const HOME = { name: LFDLN.domain, home: true, tls: tls(LFDLN.domain), front: 'direct' as const };
  const CF = { name: 'tutorlumi.test', home: false, tls: tls('tutorlumi.test'), front: 'cloudflare' as const, names: ['tutorlumi.test', 'www.tutorlumi.test'] };
  const t = table({
    hosts: [{ name: 'tutor', enabled: true }, { name: '@', enabled: true, withWww: true, domain: 'tutorlumi.test' }],
    routes: [
      { host: 'tutor', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false },
      { host: '@', domain: 'tutorlumi.test', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false },
    ],
    domains: [HOME, CF],
  });
  const inc = /include \/etc\/nginx\/lfdln-hosts\/cloudflare-realip\.conf;/g;

  it('the real-IP file trusts CF-Connecting-IP from Cloudflare\'s ranges only', () => {
    const f = renderAll(cfg, t).get('cloudflare-realip.conf')!;
    assert.match(f, /^set_real_ip_from 173\.245\.48\.0\/20;$/m);
    assert.match(f, /^set_real_ip_from 2606:4700::\/32;$/m);
    assert.match(f, /^real_ip_header CF-Connecting-IP;$/m);
    for (const l of f.split('\n').filter((x) => x.startsWith('set_real_ip_from'))) {
      assert.doesNotMatch(l, /127\.|::1\/|0\.0\.0\.0|10\.|192\.168\./, l);
    }
    assert.doesNotMatch(f, /real_ip_recursive/);
  });

  it('every block on a Cloudflare domain includes it (http and https); none on a direct one', () => {
    const files = renderAll(cfg, t);
    const cf = files.get('domains/tutorlumi.test/hosts/@.conf')!;
    assert.equal(cf.match(/^server \{/gm)!.length, 2);
    assert.equal(cf.match(inc)!.length, 2, 'both server blocks');
    assert.doesNotMatch(files.get('hosts/tutor.conf')!, /cloudflare-realip/);
    assert.doesNotMatch(files.get('catch-all.conf')!, /cloudflare-realip/);
  });

  it('a domain\'s catch-all follows its front; the home domain\'s row beats the profile', () => {
    const files = renderAll(cfg, table({ domains: [{ ...HOME, front: 'cloudflare' }, { ...CF, names: undefined, front: 'direct' }] }));
    assert.equal(files.get('catch-all.conf')!.match(inc)!.length, 2);
    assert.equal(files.get('hosts/tutor.conf')!.match(inc)!.length, 1, 'the https block');
    assert.doesNotMatch(files.get('domains/tutorlumi.test/catch-all.conf')!, /cloudflare-realip/);
    // no rows: the profile says (lfdln: nothing in front; pammy.org: Cloudflare)
    assert.doesNotMatch(renderAll(cfg, table()).get('hosts/tutor.conf')!, /cloudflare-realip/);
    assert.match(renderAll({ ...cfg, front: 'cloudflare' }, table()).get('hosts/tutor.conf')!, inc);
  });

  it('another domain\'s row without a front has nothing in front, whatever the home one has', () => {
    const { front: _, ...noFront } = CF;
    const files = renderAll(cfg, table({ ...t, domains: [{ ...HOME, front: 'cloudflare' }, noFront] }));
    assert.doesNotMatch(files.get('domains/tutorlumi.test/hosts/@.conf')!, /cloudflare-realip/);
  });

  it('the routing helper takes a domain\'s front as the panel sends it: Cloudflare or nothing', () => {
    const kinds = kindsOf(cfg);
    assert.equal(tableOf(t, kinds).domains![1]!.front, 'cloudflare');
    assert.equal(tableOf({ ...t, domains: [HOME, { ...CF, front: undefined }] }, kinds).domains![1]!.front, undefined);
    assert.throws(() => tableOf({ ...t, domains: [HOME, { ...CF, front: 'akamai' }] }, kinds), /Cloudflare or nothing/);
  });

  it('a range too wide, or not a range, is refused', () => {
    assert.throws(() => renderAll({ ...cfg, cloudflareRanges: [...Array(10).fill('173.245.48.0/20'), '0.0.0.0/0'] }, t), /far too wide/);
    assert.throws(() => renderAll({ ...cfg, cloudflareRanges: [...Array(10).fill('173.245.48.0/20'), '1.2.3.4; deny all'] }, t), /not an address range/);
    assert.throws(() => renderAll({ ...cfg, cloudflareRanges: ['173.245.48.0/20'] }, t), /suspiciously few/);
  });
});
