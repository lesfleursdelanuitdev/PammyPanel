// nginx files rendered from a site's profile (docs/adapters-plan.md A4). For
// pammy.org's profile they must be byte for byte the live ones, kept here as
// test/nginx-snapshot/pammy/ (what the installer wrote before phase 2). A change
// to them is a change to production nginx: update the snapshot on purpose.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { renderNginx, renderTemplate } from '@panel/core/nginx';
import { NGINX_FILES } from '@panel/pammy/nginx';
import { PROFILE } from '@panel/pammy/profile';
import { PROFILE as LFDLN } from './fixtures/lfdln-profile.ts';

const ROOT = join(import.meta.dirname, '..');
const SNAPSHOT = join(ROOT, 'test', 'nginx-snapshot', 'pammy');
const IPS = readFileSync(join(ROOT, 'deploy', 'cloudflare-ips.txt'), 'utf8');

const filesIn = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? filesIn(join(dir, e.name)) : [relative(SNAPSHOT, join(dir, e.name))]);

describe('nginx from the profile', () => {
  it("renders exactly what pammy.org runs today", () => {
    const out = renderNginx(PROFILE, NGINX_FILES, { text: IPS });
    assert.deepEqual([...out.keys()].sort(), filesIn(SNAPSHOT).sort());
    for (const [path, text] of out) assert.equal(text, readFileSync(join(SNAPSHOT, path), 'utf8'), path);
  });

  it('renders a direct site with no Cloudflare in it, its panel open to passkeys', () => {
    const out = renderNginx(LFDLN, NGINX_FILES);
    assert.ok(!out.has('panel/cloudflare-realip.conf') && !out.has('panel/cloudflare-ips.geo'));
    for (const [path, text] of out) {
      assert.doesNotMatch(text, /@@|^#@/m, `${path}: a token or block left over`);
      assert.doesNotMatch(text, /cloudflare-(realip|ips)|CF-Connecting-IP|x_forwarded_proto/, `${path}: Cloudflare`);
      assert.doesNotMatch(text, /pammy\.org|\/etc\/nginx\/pammy-/, `${path}: pammy.org's names`);
    }
    const site = out.get('site/panel.conf')!;
    assert.doesNotMatch(site, /return 444|geo /, 'nobody is turned away before the sign-in page');
    assert.match(site, /ssl_certificate {5}\/etc\/letsencrypt\/live\/wildcard\.lesfleursdelanuit\.com\/fullchain\.pem;/);
    assert.match(site, /server_name panel\.lesfleursdelanuit\.com;/);
  });

  // an option the code keeps, unused since the VPN was dropped (platform plan N2)
  it('can still close the panel to all but a VPN subnet', () => {
    const site = renderNginx({ ...LFDLN, panelAccess: { kind: 'vpn', subnet: '10.66.0.0/24' } }, NGINX_FILES).get('site/panel.conf')!;
    assert.match(site, /geo \$remote_addr \$pammy_panel_via_vpn \{\n {4}default 0;\n {4}10\.66\.0\.0\/24 1;\n\}/);
    assert.equal(site.match(/if \(\$pammy_panel_via_vpn = 0\)/g)?.length, 2, 'both server blocks refuse everyone else');
  });

  it('needs the Cloudflare ranges when Cloudflare is in front, and refuses too few', () => {
    assert.throws(() => renderNginx(PROFILE, NGINX_FILES), /no ranges/);
    assert.throws(() => renderNginx(PROFILE, NGINX_FILES, { text: '1.2.3.0/24\n' }), /few/);
  });

  it("leaves out a switched-off module's files", () => {
    const out = renderNginx({ ...LFDLN, modules: LFDLN.modules.filter((m) => m !== 'php' && m !== 'help' && m !== 'examples') }, NGINX_FILES);
    assert.ok(!out.has('gate/php.conf') && !out.has('panel/tutorial-examples.conf'));
    assert.doesNotMatch(out.get('gate/gate.conf')!, /include .*php\.conf/);
    assert.doesNotMatch(out.get('site/panel.conf')!, /tutorial-examples/);
  });

  it('refuses a template it cannot fill in completely', () => {
    assert.throws(() => renderTemplate('a @@NOPE@@', {}, {}), /no value for @@NOPE@@/);
    assert.throws(() => renderTemplate('#@if nope\nx\n#@end', {}, {}), /no flag "nope"/);
    assert.throws(() => renderTemplate('#@if a\nx', {}, { a: true }), /without #@end/);
    assert.throws(() => renderTemplate('#@end', {}, {}), /without #@if/);
    assert.equal(renderTemplate('#@if !a\nno\n#@else\nyes\n#@end\n@@X@@', { X: 'x' }, { a: true }), 'yes\nx');
  });
});
