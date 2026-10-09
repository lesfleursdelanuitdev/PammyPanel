// The routing helper (docs/hosts-plan.md step 2): apply writes only what changed,
// removes host files no longer wanted, puts everything back when nginx says no,
// reloads once nginx says yes, one apply at a time; check-name refuses names the
// server keeps, names with their own DreamHost record, and everything while the
// zone can't be read (Q3). A stand-in runner here; a real nginx in
// test/run-hosts-nginx-test.sh.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { callJsonLine, CallError } from '@panel/core/jsonline';
import type { RunResult, RunSpec } from '@panel/core/runner';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { createRoutesOps, HostsError } from '@panel/hosts/helper/ops';
import { createRoutesServer } from '@panel/hosts/helper/service';
import { ZONE_COMMAND } from '@panel/hosts/helper/main';
import type { Table } from '@panel/hosts/render';
import { takenLabels, ZONE_TTL, zoneReader } from '@panel/hosts/zone';
import { PROFILE } from './fixtures/lfdln-profile.ts';

const cfg = hostsConfigOf(PROFILE);
const DIR = cfg.dir;
let root = '';
before(() => { root = mkdtempSync(join(tmpdir(), 'hosts-helper-')); });
after(() => rmSync(root, { recursive: true, force: true }));

// records every command; nginx -t answers what `nginxSays` says
function world() {
  const calls: RunSpec[] = [];
  const w = {
    calls, nginxSays: 0, zoneSays: { code: 0, stdout: '' } as RunResult,
    run: async (spec: RunSpec): Promise<RunResult> => {
      calls.push(spec);
      if (spec.what === 'nginx-test') return { code: w.nginxSays, stdout: '', stderr: w.nginxSays ? 'nginx: [emerg] something is wrong in hosts/x.conf:3\nnginx: configuration file test failed' : '' };
      if (spec.what === 'zone') return w.zoneSays;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return w;
}
const at = (f: string) => join(root, DIR, f);
const tbl = (hosts: string[], extra: Partial<Table> = {}): Table => ({
  hosts: hosts.map((name) => ({ name, enabled: true })),
  folders: [{ name: 'docs', runPhp: false }],
  routes: hosts.map((host) => ({ host, path: '/', enabled: true, kind: 'folder' as const, folder: 'docs', spa: false })),
  ...extra,
});

describe('apply', () => {
  const w = world();
  // where the services answer, as the services helper's record says (docs/adopt-plan.md V3)
  const ops = createRoutesOps({ cfg, run: w.run, zone: { taken: async () => null }, root, ports: () => [{ service: 'tutorstar', part: 'web', port: 3041 }] });

  it('writes every file the first time, tests, and reloads', async () => {
    const r = await ops.apply(tbl(['a', 'b']));
    assert.deepEqual(r, { changed: ['catch-all.conf', 'cloudflare-realip.conf', 'gate-routes.json', 'hosts/a.conf', 'hosts/b.conf', 'pages/_lfdln/404.html', 'site.conf'], removed: [], reloaded: true });
    assert.deepEqual(w.calls.map((c) => [c.as, c.argv.join(' ')]), [['root', 'nginx -t -q'], ['root', 'systemctl reload nginx']]);
    assert.match(readFileSync(at('hosts/a.conf'), 'utf8'), /server_name a\.lesfleursdelanuit\.com;/);
  });

  it('the same table again changes nothing, and asks nginx nothing', async () => {
    w.calls.length = 0;
    assert.deepEqual(await ops.apply(tbl(['a', 'b'])), { changed: [], removed: [], reloaded: false });
    assert.equal(w.calls.length, 0);
  });

  it('a host that goes is removed; the others are left alone', async () => {
    const r = await ops.apply(tbl(['a']));
    // (the gate's copy of the routes is written again, never removed: docs/phase8-plan.md 8-2)
    assert.deepEqual([r.changed, r.removed], [['gate-routes.json'], ['hosts/b.conf']]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(at('gate-routes.json'), 'utf8')).hosts), ['a.lesfleursdelanuit.com']);
    assert.ok(!existsSync(at('hosts/b.conf')) && existsSync(at('hosts/a.conf')));
  });

  it('nginx says no: every file is put back exactly, new ones removed, and nothing reloads', async () => {
    const a = readFileSync(at('hosts/a.conf'), 'utf8');
    const routes = readFileSync(at('gate-routes.json'), 'utf8');
    w.calls.length = 0;
    w.nginxSays = 1;
    await assert.rejects(ops.apply(tbl(['c'], { folders: [{ name: 'docs', runPhp: true }] })), (e: HostsError) =>
      e.code === 'refused' && /put back as it was: nginx: \[emerg\] something is wrong/.test(e.message));
    assert.equal(readFileSync(at('hosts/a.conf'), 'utf8'), a, 'a is as it was');
    assert.equal(readFileSync(at('gate-routes.json'), 'utf8'), routes, "and so is the gate's copy of the routes");
    assert.ok(!existsSync(at('hosts/c.conf')), 'c, new, is gone again');
    assert.deepEqual(w.calls.map((c) => c.what), ['nginx-test']);
    w.nginxSays = 0;
  });

  it('refuses a table that is not one, or with a name that could break a file, before touching anything', async () => {
    const before = readFileSync(at('hosts/a.conf'), 'utf8');
    for (const bad of [null, { hosts: 'x' }, tbl(['a b']), tbl(['a'], { routes: [{ host: 'a', path: '/', enabled: true, kind: 'redirect', to: 'https://x.com/$host', status: 301, keepPath: false }] }),
      { ...tbl(['a']), routes: [{ host: 'a', path: '/', enabled: true, kind: 'proxy', port: 22 }] }]) {
      await assert.rejects(ops.apply(bad), (e: HostsError) => e.code === 'invalid', JSON.stringify(bad));
    }
    assert.equal(readFileSync(at('hosts/a.conf'), 'utf8'), before);
  });

  it('takes the domain itself, a service route and a folder\'s headers, and refuses a service it wasn\'t told of (docs/adopt-plan.md)', async () => {
    const svc = { host: 'tutor', path: '/', enabled: true, kind: 'service' as const, service: 'tutorstar', part: 'web', websockets: true, maxBodyMb: 25, signInPaths: ['/api/auth/sign-in'] };
    const t: Table = {
      hosts: [{ name: 'a', enabled: true }, { name: '@', enabled: true, withWww: true }, { name: 'tutor', enabled: true }],
      folders: [{ name: 'docs', runPhp: false }],
      routes: [
        { host: 'a', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: true, headers: [{ name: 'X-Frame-Options', value: 'DENY' }], cacheForever: ['/assets/'] },
        { host: '@', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false }, svc,
      ],
      services: [{ service: 'tutorstar', part: 'web', port: 3041 }],
    };
    const r = await ops.apply(JSON.parse(JSON.stringify(t)));
    assert.deepEqual(r.changed, ['gate-routes.json', 'hosts/@.conf', 'hosts/a.conf', 'hosts/tutor.conf']);
    assert.match(readFileSync(at('hosts/tutor.conf'), 'utf8'), /proxy_pass http:\/\/127\.0\.0\.1:3041;/);
    assert.deepEqual(await ops.status(), { hosts: ['@', 'a', 'tutor'] });
    for (const bad of [{ ...t, services: [] }, { ...t, services: [{ service: 'tutorstar', part: 'web', port: '3041' }] },
      { ...t, services: [{ service: 'tutorstar', part: 'web', port: 5435 }] }, { ...t, services: [{ service: 'nope', part: 'web', port: 3041 }] },
      { ...t, routes: [{ ...svc, maxBodyMb: '25' }] }, { ...t, routes: [{ ...svc, signInPaths: '/x' }] },
      { ...t, routes: [{ ...t.routes[0]!, headers: [{ name: 'X-Frame-Options', value: 'a"b' }] }] }]) {
      await assert.rejects(ops.apply(bad), (e: HostsError) => e.code === 'invalid', JSON.stringify(bad).slice(0, 200));
    }
    await ops.apply(tbl(['a']));
  });

  it('takes out, or puts back, only a hand-written file\'s own link, and puts it back if nginx says no (docs/adopt-plan.md V6)', async () => {
    // (under the tests' root, as /etc/nginx/sites-enabled and sites-available are on the server)
    const se = join(root, 'se'), sa = join(root, 'sa');
    mkdirSync(se, { recursive: true }); mkdirSync(sa, { recursive: true });
    writeFileSync(join(sa, 'instastylr'), 'server {}');
    symlinkSync('/sa/instastylr', join(se, 'instastylr'));
    const lops = createRoutesOps({ cfg, run: w.run, zone: { taken: async () => null }, root, sitesEnabled: '/se', sitesAvailable: '/sa' });
    const isLink = () => { try { return lstatSync(join(se, 'instastylr')).isSymbolicLink(); } catch { return false; } };
    for (const bad of [{ takeOver: 'default-443' }, { takeOver: '../../passwd' }, { giveBack: 'instastylr' }, { takeOver: 'instastylr', giveBack: 'instastylr' }]) {
      await assert.rejects(lops.apply(tbl(['a']), bad), (e: HostsError) => e.code === 'invalid', JSON.stringify(bad));
    }
    assert.ok(isLink(), 'refused: the link is as it was');
    w.nginxSays = 1;
    await assert.rejects(lops.apply(tbl(['a']), { takeOver: 'instastylr' }), (e: HostsError) => e.code === 'refused');
    w.nginxSays = 0;
    assert.ok(isLink(), 'nginx said no: the link is back');
    const r = await lops.apply(tbl(['a']), { takeOver: 'instastylr' });
    assert.equal(r.link, 'taken-over');
    assert.ok(!isLink() && readFileSync(join(sa, 'instastylr'), 'utf8') === 'server {}', 'the link out, the file itself untouched');
    await assert.rejects(lops.apply(tbl(['a']), { takeOver: 'instastylr' }), (e: HostsError) => e.code === 'invalid', 'not twice');
    assert.equal((await lops.apply(tbl(['a']), { giveBack: 'instastylr' })).link, 'given-back');
    assert.equal(readlinkSync(join(se, 'instastylr')), '/sa/instastylr');
  });

  it('writes nowhere but its own folder', async () => {
    writeFileSync(join(root, 'elsewhere.conf'), 'mine');
    await ops.apply(tbl(['a', 'z']));
    assert.equal(readFileSync(join(root, 'elsewhere.conf'), 'utf8'), 'mine');
  });

  it('one apply at a time: the second waits for the first', async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = world();
    const run = async (spec: RunSpec) => {
      order.push(`${spec.what}:start`);
      if (spec.what === 'nginx-test' && order.length === 1) await new Promise<void>((r) => { release = r; });
      order.push(`${spec.what}:end`);
      return slow.run(spec);
    };
    const r2 = mkdtempSync(join(tmpdir(), 'hosts-helper-q-'));
    const o = createRoutesOps({ cfg, run, zone: { taken: async () => null }, root: r2 });
    const first = o.apply(tbl(['one']));
    const second = o.apply(tbl(['two']));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(order, ['nginx-test:start'], 'the second has not started');
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['nginx-test:start', 'nginx-test:end', 'nginx-reload:start', 'nginx-reload:end', 'nginx-test:start', 'nginx-test:end', 'nginx-reload:start', 'nginx-reload:end']);
    rmSync(r2, { recursive: true, force: true });
  });
});

describe('the zone', () => {
  const LISTING = [
    'lesfleursdelanuit.com                         A      0  203.0.113.200',
    '*.lesfleursdelanuit.com                       A      1  203.0.113.200',
    'webmail.lesfleursdelanuit.com                 CNAME  0  webmail.dreamhost.com.',
    'ftp.lesfleursdelanuit.com                     A      1  1.2.3.4',
    '_acme-challenge.lesfleursdelanuit.com         TXT    1  xyz',
    'deep.sub.lesfleursdelanuit.com                A      1  1.2.3.5',
    'other.com                                     A      1  1.1.1.1',
    'MiXeD.lesfleursdelanuit.com.                  A      1  1.1.1.2',
  ].join('\n');

  // systemd-run looks for argv[0] from inside the helper's sandbox, which hides
  // /etc/letsencrypt: the script can only be an argument (found 2026-09-26)
  it('the zone command starts from a program the helper can see', () => {
    assert.equal(ZONE_COMMAND[0], '/bin/bash');
    assert.match(ZONE_COMMAND[1]!, /^\/etc\/letsencrypt\//);
  });

  it('a read that fails says why, for the journal', async () => {
    const lines: string[] = [];
    const run = async () => ({ code: 1, stdout: '', stderr: 'Failed to find executable x: Permission denied' });
    assert.equal(await zoneReader(run, ['dh', 'list'], 'lesfleursdelanuit.com', () => 0, (l) => lines.push(l)).taken(), null);
    assert.deepEqual(lines, ["zone: can't be read (exit 1: Failed to find executable x: Permission denied)"]);
  });

  it('the labels right under the domain, not the wildcard or _acme-challenge', () => {
    assert.deepEqual([...takenLabels(LISTING, 'lesfleursdelanuit.com')].sort(), ['ftp', 'mixed', 'sub', 'webmail']);
  });

  it('check-name: the server\'s own names, then the zone\'s, and nothing while it can\'t be read', async () => {
    const w = world();
    let t = 1000;
    const ops = createRoutesOps({ cfg, run: w.run, zone: zoneReader(w.run, ['dh', 'list'], cfg.domain, () => t), root });
    w.zoneSays = { code: 1, stdout: '', stderr: 'dns-list_records failed' };
    await assert.rejects(ops.checkName('tutor2'), (e: HostsError) => e.code === 'unavailable');
    w.zoneSays = { code: 0, stdout: 'nothing useful\n', stderr: '' };
    await assert.rejects(ops.checkName('tutor2'), (e: HostsError) => e.code === 'unavailable', 'a listing without the apex is no listing');
    w.zoneSays = { code: 0, stdout: LISTING, stderr: '' };
    assert.deepEqual(await ops.checkName('tutor2'), { ok: true, name: 'tutor2' });
    await assert.rejects(ops.checkName('webmail'), (e: HostsError) => e.code === 'exists' && /DNS record of its own/.test(e.message));
    await assert.rejects(ops.checkName('sub'), (e: HostsError) => e.code === 'exists');
    await assert.rejects(ops.checkName('www'), (e: HostsError) => e.code === 'invalid');
    await assert.rejects(ops.checkName('a.b'), (e: HostsError) => e.code === 'invalid');
    // kept ten minutes, then read again
    const reads = () => w.calls.filter((c) => c.what === 'zone').length;
    const n = reads();
    await ops.checkName('x1');
    assert.equal(reads(), n);
    t += ZONE_TTL;
    w.zoneSays = { code: 1, stdout: '', stderr: 'down' };
    await assert.rejects(ops.checkName('x1'), (e: HostsError) => e.code === 'unavailable', 'an old answer is not used once it is stale');
    assert.deepEqual(w.calls.filter((c) => c.what === 'zone').map((c) => [c.as, c.argv.join(' ')])[0], ['root', 'dh list']);
  });
});

describe('the socket', () => {
  it('answers the four operations, refuses anything else, and takes a big table', async () => {
    const w = world();
    const r3 = mkdtempSync(join(tmpdir(), 'hosts-helper-s-'));
    const sock = join(r3, 'routes.sock');
    const server = createRoutesServer(createRoutesOps({ cfg, run: w.run, zone: { taken: async () => ({ labels: new Set(['webmail']), readAt: 1 }) }, root: r3 }));
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const names = Array.from({ length: 1500 }, (_, i) => `host-${i}`);
      const big = await callJsonLine<{ changed: string[] }>(sock, { op: 'apply', table: tbl(names) }, 'the routing helper', 30_000);
      assert.equal(big.changed.filter((f) => f.startsWith('hosts/')).length, 1500);
      assert.deepEqual(await callJsonLine(sock, { op: 'status' }, 'the routing helper'), { hosts: [...names].sort() });
      assert.deepEqual(await callJsonLine(sock, { op: 'zone' }, 'the routing helper'), { taken: ['webmail'], readAt: 1 });
      await assert.rejects(callJsonLine(sock, { op: 'check-name', name: 'webmail' }, 'the routing helper'), (e: CallError) => e.code === 'exists');
      await assert.rejects(callJsonLine(sock, { op: 'write-file', path: '/etc/passwd' }, 'the routing helper'), (e: CallError) => e.code === 'invalid');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(r3, { recursive: true, force: true });
    }
  });
});

// The unit itself runs only on lfdln (phase 5, whose verify checks it live); here,
// that it says what docs/hosts-plan.md H7 promises.
describe('its unit', () => {
  const unit = readFileSync(join(import.meta.dirname, '..', 'packages', 'hosts', 'deploy', 'lfdln-routes.service'), 'utf8');
  const lines = (key: string) => unit.split('\n').filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));
  it('holds no capabilities, has no network, and writes only its own nginx folder', () => {
    assert.deepEqual(lines('CapabilityBoundingSet'), ['']);
    assert.deepEqual(lines('PrivateNetwork'), ['yes']);
    assert.deepEqual(lines('RestrictAddressFamilies'), ['AF_UNIX']);
    assert.deepEqual(lines('ProtectSystem'), ['strict']);
    // and sites-enabled, for the hand-written files' links (docs/adopt-plan.md V6)
    assert.deepEqual(lines('ReadWritePaths'), [`${PROFILE.hosts!.dir} /etc/nginx/sites-enabled`]);
    assert.deepEqual(lines('NoNewPrivileges'), ['yes']);
  });
  it("can't see the certificates' keys or the DreamHost key", () => {
    assert.ok(lines('InaccessiblePaths').join(' ').split(/\s+/).includes('-/etc/letsencrypt'));
  });
  it('only the panel may open its socket', () => {
    const sock = readFileSync(join(import.meta.dirname, '..', 'packages', 'hosts', 'deploy', 'lfdln-routes.socket'), 'utf8');
    assert.match(sock, /^SocketUser=root$/m);
    assert.match(sock, /^SocketMode=0660$/m);
  });
});
