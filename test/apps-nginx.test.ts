// The helper writes WordPress's nginx files byte for byte as
// ~/pamela-setup/wordpress/lib.sh render_placement does (src/apps/nginx.ts):
// both are run here, from the same templates, for every kind of placement.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { clash, renderAll, renderPlacement, type Placed } from '@panel/apps/apps/nginx';
import { parsePlacement } from '@panel/apps/apps/ops';

const WP = new URL('../../wordpress/', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'pammy-apps-nginx-'));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("WordPress's nginx files", () => {
  for (const line of ['subdomain blog', 'path blog', 'path my-journal', 'root', 'off', 'subdomain b']) {
    it(`"${line}" is what render_placement writes`, () => {
      const out = join(dir, line.replace(' ', '-'));
      const [mode, name = ''] = line.split(' ');
      execFileSync('bash', ['-c', 'source "$1/lib.sh"; render_placement "$2" "$3" "$4" "https://pammy.org"', '_', WP, mode!, name, out]);
      const mine = renderPlacement(join(WP, 'nginx/templates'), parsePlacement(line)!);
      for (const f of ['main.conf', 'server.conf', 'placement'] as const) {
        assert.equal(mine[f], readFileSync(join(out, f), 'utf8'), `${line}: ${f}`);
      }
    });
  }
});

describe('several installs (4a, P4a)', () => {
  const T = join(WP, 'nginx/templates');
  const blog = (mode: string, name: string | null = null): Placed => ({ id: 'blog', placement: { mode, name } as Placed['placement'], placementFile: '/etc/nginx/pammy-wordpress/placement', port: 3043, adopted: true });
  const shop = (mode: string, name: string | null = null): Placed => ({ id: 'shop', placement: { mode, name } as Placed['placement'], placementFile: '/etc/nginx/pammy-wordpress/placement-shop', port: 3100, adopted: false });

  it('each install has its own placement line and, but for the blog, its own proxy file', () => {
    const files = renderAll(T, [blog('subdomain', 'blog'), shop('path', 'shop')]);
    assert.deepEqual([...files.keys()].sort(), ['/etc/nginx/pammy-wordpress/main.conf', '/etc/nginx/pammy-wordpress/placement', '/etc/nginx/pammy-wordpress/placement-shop', '/etc/nginx/pammy-wordpress/proxy-shop.conf', '/etc/nginx/pammy-wordpress/server.conf']);
    assert.equal(files.get('/etc/nginx/pammy-wordpress/placement-shop'), 'path shop\n');
    const proxy = files.get('/etc/nginx/pammy-wordpress/proxy-shop.conf')!;
    assert.match(proxy, /^proxy_pass http:\/\/127\.0\.0\.1:3100;$/m);
    assert.ok(!proxy.includes('3043'));
    const main = files.get('/etc/nginx/pammy-wordpress/main.conf')!;
    assert.match(main, /location \^~ \/shop\/ \{[\s\S]*include \/etc\/nginx\/pammy-wordpress\/proxy-shop\.conf;/);
    assert.match(main, /# Placement: blog: subdomain blog; shop: path shop/);
    assert.match(files.get('/etc/nginx/pammy-wordpress/server.conf')!, /server_name blog\.pammy\.org;[\s\S]*include \/etc\/nginx\/pammy-wordpress\/proxy\.conf;/);
  });

  it('an install that is off adds nothing but its placement line', () => {
    const files = renderAll(T, [blog('subdomain', 'blog'), shop('off')]);
    assert.ok(!files.get('/etc/nginx/pammy-wordpress/main.conf')!.includes('/shop/'));
    assert.equal(files.get('/etc/nginx/pammy-wordpress/placement-shop'), 'off\n');
  });

  it('refuses two on the whole site, or one name twice', () => {
    assert.equal(clash([blog('root'), shop('root')]), 'Only one piece of software can be the whole of pammy.org.');
    assert.equal(clash([blog('subdomain', 'x'), shop('subdomain', 'x')]), 'x.pammy.org is already used by other software.');
    assert.equal(clash([blog('path', 'x'), shop('path', 'x')]), 'pammy.org/x/ is already used by other software.');
    assert.equal(clash([blog('subdomain', 'x'), shop('path', 'x')]), null, 'two different addresses');
    assert.equal(clash([blog('off'), shop('off')]), null);
    assert.throws(() => renderAll(T, [blog('root'), shop('root')]), /Only one/);
  });
});
