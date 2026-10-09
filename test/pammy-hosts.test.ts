// pammy.org's hosts as the renderer makes them (docs/phase8-plan.md 8-7a). That they answer
// exactly as the hand-kept pamela file does is run-gate-nginx-test.sh's (VHOST=hosts); here,
// what the files say and what is refused.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hostsConfigOf } from '@panel/pammy/hosts';
import { hostsConfigOf as lfdlnConfigOf } from '@panel/lfdln/hosts';
import { WITH_HOSTS } from '@panel/pammy/nginx-hosts';
import { renderAll, type Route, type Table } from '@panel/hosts/render';
import { siteKind } from '@panel/hosts/folder-gate';
import { PROFILE as LFDLN } from './fixtures/lfdln-profile.ts';

const cfg = hostsConfigOf(WITH_HOSTS);
const table = (routes: Route[] = [], more: Partial<Table> = {}): Table => ({
  hosts: [{ name: '@', enabled: true, withWww: true }, { name: 'recipes', enabled: true }, { name: 'blog', enabled: true }],
  folders: [{ name: 'recipes', runPhp: true }],
  routes: [
    { host: '@', path: '/', enabled: true, kind: 'site' },
    { host: '@', path: '/api/', enabled: true, kind: 'proxy', port: 3042, websockets: true },
    { host: 'recipes', path: '/', enabled: true, kind: 'folder', folder: 'recipes', spa: false },
    { host: 'blog', path: '/', enabled: true, kind: 'software', app: 'blog' },
    ...routes,
  ],
  software: [{ id: 'blog', proxy: 'proxy.conf' }],
  domains: [{ name: 'pammy.org', home: true, tls: cfg.tls, folderHosts: true }],
  ...more,
});

describe("pammy.org's hosts (8-7a)", () => {
  const files = renderAll(cfg, table());
  it('the main block asks the gate the hand-kept way: its snippets, its base, no route gate', () => {
    const apex = files.get('hosts/@.conf')!;
    assert.match(apex, /server_name pammy\.org www\.pammy\.org;/);
    assert.match(apex, /root \/pamela\/public;\n    index index\.html;/);
    assert.match(apex, /set \$pammy_base \/;\n    include \/etc\/nginx\/pammy-gate\/gate\.conf;/);
    assert.match(apex, /location ~ "\^\/\(\?!api\/\)\(\?<folder>\[\^\/\.\]\+\)\/"/, 'the folder-404 rule keeps /api/ out');
    assert.match(apex, /ssl_certificate +\/etc\/ssl\/cloudflare\/pammy\.org-wildcard\.pem;/);
    assert.match(apex, /access_log \/var\/log\/nginx\/pammy\.access\.log;/);
    assert.ok(!apex.includes('/_pammy/check/'), "no route area's check");
    assert.ok(!apex.includes('disable_symlinks'), 'shortcuts inside her website work as before (the gate looks at the real path)');
    // the regexes in the hand-kept order: the gate's (in gate.conf), then hidden files, then the folder-404 rule
    assert.ok(apex.indexOf('gate.conf') < apex.indexOf('location ~ /\\.') && apex.indexOf('location ~ /\\.') < apex.indexOf('(?<folder>'));
  });
  it("a folder host is <folder>.pammy.org's block; software has no gate; no gate-routes.json", () => {
    assert.match(files.get('hosts/recipes.conf')!, /root \/pamela\/public\/recipes;[\s\S]*set \$pammy_base \/recipes;[\s\S]*try_files \/404\.html @pammy_404;/);
    const blog = files.get('hosts/blog.conf')!;
    assert.ok(!blog.includes('gate.conf') && blog.includes('include /etc/nginx/pammy-wordpress/proxy.conf;') && blog.includes('location = /xmlrpc.php'));
    assert.equal(files.has('gate-routes.json'), false);
  });
  it('folder hosts: the catch-all is the folder regex block, never www or api', () => {
    const c = files.get('catch-all.conf')!;
    assert.match(c, /server_name "~\^\(\?!\(\?:www\|api\)\\\.\)\(\?<sub>\[a-z0-9\]\(\?:\[a-z0-9-\]\*\[a-z0-9\]\)\?\)\\\.pammy\\\.org\$";/);
    assert.match(c, /root \/pamela\/public\/\$sub;[\s\S]*set \$pammy_base \/\$sub;/);
  });
  it('refuses what pammy.org has no place for', () => {
    const refused: [Route, RegExp][] = [
      [{ host: 'recipes', path: '/x/', enabled: true, kind: 'redirect', to: '/', status: 302, keepPath: false, accounts: { token: 'A'.repeat(32) } }, /no accounts/],
      [{ host: '@', path: '/docs/', enabled: true, kind: 'folder', folder: 'recipes', spa: false }, /at the top of a host here/],
      [{ host: 'recipes', path: '/p/', enabled: true, kind: 'proxy', port: 3044, websockets: false }, /panel's own/],
      [{ host: '@', path: '/shop/', enabled: true, kind: 'software', app: 'shop' }, /isn't installed/],
    ];
    for (const [r, why] of refused) assert.throws(() => renderAll(cfg, table([r])), why, JSON.stringify(r));
    assert.throws(() => renderAll(cfg, { ...table(), routes: [{ host: '@', path: '/', enabled: true, kind: 'proxy', port: 3042, websockets: true }] }), /at a path/);
  });
  it("lfdln has neither the whole website nor folder hosts", () => {
    const l = lfdlnConfigOf(LFDLN);
    assert.throws(() => renderAll({ ...l, kinds: [...l.kinds!, siteKind] }, { hosts: [{ name: 'x', enabled: true }], folders: [],
      routes: [{ host: 'x', path: '/', enabled: true, kind: 'site' }] }), /only shown where the gate looks at folders/);
    assert.throws(() => renderAll(l, { hosts: [], folders: [], routes: [], domains: [{ name: LFDLN.domain, home: true, tls: l.tls, folderHosts: true }] }), /folder hosts are only on/);
  });
});
