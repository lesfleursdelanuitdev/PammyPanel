// Monitoring step 2 (docs/monitoring-plan.md): what the helpers read for it -- the
// probe's DNS records (the routing helper's records op) and the backups and disks (the
// services helper's storage op, a root unit running packages/services/src/storage.ts).
// The rules they feed are in test/monitoring.test.ts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RunSpec } from '@panel/core/runner';
import { createRoutesOps } from '@panel/hosts/helper/ops';
import { certCovers, checkTask, RDAP_BASES, runTask, type ProbeEnv, type RecordType, type Result } from '@panel/hosts/probe';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { PROFILE } from '@panel/lfdln/profile';
import { createServicesOps } from '@panel/services/helper/ops';
import { BACKUPS, DISKS } from '@panel/services/known';
import { checkStorageTask, newestNightly, readBackups, readDisk, readStorage } from '@panel/services/storage';
import { checkPruneTask, prune, stampOf, toDelete } from '@panel/services/prune';

const NOW = 1_800_000_000;
const env = (records?: ProbeEnv['records']): ProbeEnv => ({ ip: '127.0.0.1', port: 1, own: () => [], now: () => NOW, resolve: async () => [], timeoutMs: 100, records });

describe('the probe: DNS records', () => {
  it('only a name and TXT, MX or NS; an underscore may start a label (_dmarc, a DKIM selector)', () => {
    assert.deepEqual(checkTask({ kind: 'records', name: '_dmarc.example.org', type: 'TXT' }), { kind: 'records', name: '_dmarc.example.org', type: 'TXT' });
    assert.ok(checkTask({ kind: 'records', name: 'resend._domainkey.mail.example.org', type: 'TXT' }));
    for (const bad of [{ name: 'example.org', type: 'A' }, { name: 'a b.org', type: 'NS' }, { name: '-x.org', type: 'NS' }, { name: 'x', type: 'NS' }, { name: 'a..org', type: 'MX' }]) {
      assert.throws(() => checkTask({ kind: 'records', ...bad }), Error, JSON.stringify(bad));
    }
  });

  it('sorted and without repeats; none there is said, not thrown; DNS failing is said', async () => {
    const answers: Record<string, string[] | Error> = {
      'a.org NS': ['ns2.x.net', 'ns1.x.net', 'ns1.x.net'],
      'none.org TXT': Object.assign(new Error('queryTxt ENODATA none.org'), { code: 'ENODATA' }),
      'down.org MX': Object.assign(new Error('queryMx ESERVFAIL down.org'), { code: 'ESERVFAIL' }),
    };
    const e = env(async (name: string, type: RecordType) => { const a = answers[`${name} ${type}`]; if (a instanceof Error) throw a; return a ?? []; });
    assert.deepEqual(await runTask({ kind: 'records', name: 'a.org', type: 'NS' }, e), { kind: 'records', name: 'a.org', type: 'NS', ok: true, why: '', values: ['ns1.x.net', 'ns2.x.net'] });
    assert.deepEqual(await runTask({ kind: 'records', name: 'none.org', type: 'TXT' }, e), { kind: 'records', name: 'none.org', type: 'TXT', ok: false, why: 'no TXT record', values: [] });
    const down = await runTask({ kind: 'records', name: 'down.org', type: 'MX' }, e);
    assert.ok(down.kind === 'records' && !down.ok && /^DNS didn't answer: .*ESERVFAIL/.test(down.why));
  });

  it('a certificate says whether it covers the name, whatever its days left', () => {
    assert.equal(certCovers(['a.org'], NOW + 3 * 86400, ['a.org'], NOW).covers, true);
    assert.equal(certCovers(['a.org'], NOW + 3 * 86400, ['a.org'], NOW).ok, false);
    assert.equal(certCovers(['b.org'], NOW + 90 * 86400, ['a.org'], NOW).covers, false);
  });
});

describe('the routing helper\'s records op', () => {
  const asked: unknown[] = [];
  const run = async (spec: RunSpec) => {
    assert.equal(spec.what, 'check');
    const tasks = JSON.parse(spec.stdin!) as { name: string; type: RecordType }[];
    asked.push(tasks);
    return { code: 0, stderr: '', stdout: JSON.stringify(tasks.map((t) => ({ kind: 'records', name: t.name, type: t.type, ok: true, why: '', values: ['x'] }))) };
  };
  const ops = createRoutesOps({ cfg: hostsConfigOf(PROFILE), run, zone: { taken: async () => null }, now: () => NOW });

  it('reads names under the domain, fresh each time', async () => {
    const want = [{ name: '_dmarc.lesfleursdelanuit.com', type: 'TXT' }, { name: 'lesfleursdelanuit.com', type: 'NS' }];
    const r = await ops.records({ records: want });
    assert.deepEqual(r.records.map((x) => x.kind === 'records' && [x.name, x.type]), want.map((w) => [w.name, w.type]));
    await ops.records({ records: want });
    assert.equal(asked.length, 2);
  });

  it('refuses a name elsewhere, a type it doesn\'t read, and more than 20', async () => {
    await assert.rejects(ops.records({ records: [{ name: 'example.com', type: 'NS' }] }), /isn't under lesfleursdelanuit\.com/);
    await assert.rejects(ops.records({ records: [{ name: 'evil-lesfleursdelanuit.com', type: 'NS' }] }), /isn't under/);
    await assert.rejects(ops.records({ records: [{ name: 'lesfleursdelanuit.com', type: 'A' }] }), /not a record type/);
    await assert.rejects(ops.records({ records: Array(21).fill({ name: 'lesfleursdelanuit.com', type: 'NS' }) }), /at most 20/);
    await assert.rejects(ops.records({ records: [] }), /at most 20/);
  });
});

describe('the backups and the disk (storage.ts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'storage-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('the newest nightly batch by its stamp: not the installer\'s, not the roles, not a part', () => {
    const f = (name: string, size = 10) => ({ name, size });
    const n = newestNightly('/x', '', [
      f('tutorstar-20260926T050000Z-nightly.dump'), f('examprep-20260927T050001Z-nightly.dump'), f('tutorstar-20260927T050001Z-nightly.dump', 0),
      f('tutorstar-20260927T090000Z-before-switch-tutorstar.dump'), f('roles-20260927T050001Z-nightly.sql'), f('x-20260928T050000Z-nightly.dump.part'),
    ]);
    assert.deepEqual(n, { at: Date.UTC(2026, 8, 27, 5, 0, 1) / 1000, files: 2, empty: 1, bytes: 10 });
    assert.equal(newestNightly('/x', 'lfdln-', [f('pammy-20260927T043000Z-nightly.dump')]), null, 'another prefix');
    assert.equal(newestNightly('/x', 'lfdln-', [f('lfdln-20260927T044500Z-nightly.dump')])?.files, 1);
    // lfdln-appmaria's (docs/lfdln-mariadb-plan.md M5): gzipped SQL, and its accounts file left out
    assert.deepEqual(newestNightly('/x', '', [
      f('notes-20261004T051500Z-nightly.sql.gz', 7), f('accounts-20261004T051500Z-nightly.sql'), f('notes-20261003T051500Z-nightly.sql.gz'),
    ]), { at: Date.UTC(2026, 9, 4, 5, 15, 0) / 1000, files: 1, empty: 0, bytes: 7 });
    // a run with no databases yet: only its accounts file, newer than any dump
    assert.deepEqual(newestNightly('/x', '', [f('accounts-20261004T051500Z-nightly.sql'), f('notes-20261003T051500Z-nightly.sql.gz')]),
      { at: Date.UTC(2026, 9, 4, 5, 15, 0) / 1000, files: 0, empty: 0, bytes: 0 });
    assert.deepEqual(newestNightly('/x', '', [f('accounts-20261004T051500Z-nightly.sql')])?.files, 0);
    assert.equal(newestNightly('/x', 'lfdln-', [f('accounts-20261004T051500Z-nightly.sql')]), null, 'only where the prefix is empty');
  });

  it('reads a folder, and says when it can\'t', () => {
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'b/lfdln-20260927T044500Z-nightly.dump'), 'dump');
    writeFileSync(join(dir, 'b/lfdln-20260927T044500Z-nightly.roles.sql'), 'roles');
    assert.deepEqual(readBackups({ id: 'b', dir: join(dir, 'b'), prefix: 'lfdln-' }).newest?.bytes, 4);
    assert.match(readBackups({ id: 'c', dir: join(dir, 'nope'), prefix: '' }).why!, /ENOENT/);
    const d = readDisk({ path: dir });
    assert.ok(d.size > 0 && d.avail > 0 && d.dev && d.why === null);
    assert.match(readDisk({ path: join(dir, 'nope') }).why!, /ENOENT/);
  });

  it('the unit takes only backup folders under /var/lib/svc-*/ and plain disk paths', () => {
    const ok = { backups: [{ id: 'lfdln-pg', dir: '/var/lib/svc-lfdlnpanel-db/backups', prefix: 'lfdln-' }], disks: [{ path: '/' }, { path: '/mnt/storage' }] };
    assert.deepEqual(checkStorageTask(ok), ok);
    for (const dir of ['/etc', '/var/lib/svc-x/backups/../../../etc', '/var/lib/other/backups', 'var/lib/svc-x/backups']) {
      assert.throws(() => checkStorageTask({ ...ok, backups: [{ id: 'x', dir, prefix: '' }] }), Error, dir);
    }
    assert.throws(() => checkStorageTask({ ...ok, disks: [{ path: '/a/../etc' }] }));
    assert.throws(() => checkStorageTask({ ...ok, backups: [{ id: 'x', dir: '/var/lib/svc-x/backups', prefix: '../' }] }));
    // what the helper sends passes
    assert.ok(checkStorageTask({ backups: BACKUPS.map(({ id, dir, prefix }) => ({ id, dir, prefix })), disks: DISKS.map((path) => ({ path })) }));
    assert.equal(readStorage({ backups: [], disks: [{ path: '/' }] }).disks.length, 1);
  });

  it('the services helper runs it as a root unit, with known.ts\'s folders, and names each', async () => {
    const specs: RunSpec[] = [];
    let answer = { code: 0, stdout: '', stderr: '' };
    const ops = createServicesOps({ record: () => ({ version: 1, services: [] }), run: async (s) => { specs.push(s); return answer; }, probe: async () => ({ status: 200, ms: 1 }) });
    answer = { code: 0, stderr: '', stdout: JSON.stringify({ backups: [{ id: 'lfdln-pg', newest: null, why: null }], disks: [] }) };
    const r = await ops.storage();
    assert.equal(specs[0]!.as, 'root');
    assert.equal(specs[0]!.what, 'storage');
    assert.match(specs[0]!.argv[2]!, /packages\/services\/src\/storage\.ts$/);
    assert.deepEqual(JSON.parse(specs[0]!.stdin!).backups.map((b: { id: string }) => b.id), BACKUPS.map((b) => b.id));
    assert.equal(r.backups[0]!.title, "The panel's database (lfdln-pg)");
    answer = { code: 1, stdout: '', stderr: 'Failed to start transient service unit' };
    await assert.rejects(ops.storage(), /couldn't be read \(Failed to start/);
  });
});

// How long the database copies are kept (docs/lfdln-mariadb-plan.md B2): prune.ts, run by the
// services helper as a root unit with the panel's Settings > Backups
describe('pruning the database backups (prune.ts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prune-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const NOW = Date.UTC(2026, 9, 4, 12, 0, 0) / 1000;

  it('reads a backup\'s stamp from its name, and nothing else counts', () => {
    assert.deepEqual(stampOf('tutorstar-20260927T050001Z-nightly.dump'), { at: Date.UTC(2026, 8, 27, 5, 0, 1) / 1000, label: 'nightly' });
    assert.equal(stampOf('notes-20261004T051500Z-nightly.sql.gz')?.label, 'nightly');
    assert.equal(stampOf('roles-20260927T090000Z-before-switch-tutorstar.sql')?.label, 'before-switch-tutorstar');
    for (const n of ['notes.sql.gz', 'x-20261004T051500Z-nightly.dump.part', 'README', 'x-2026-10-04-nightly.dump']) assert.equal(stampOf(n), null, n);
  });

  it('deletes what is older than the days, never the newest nightly batch', () => {
    const names = [
      'a-20260701T050000Z-nightly.dump', 'b-20260701T050000Z-nightly.dump', 'roles-20260701T050000Z-nightly.sql',
      'a-20260920T050000Z-nightly.dump', 'a-20261004T050000Z-nightly.dump', 'a-20260801T090000Z-before-switch-a.dump', 'keep-me.txt',
    ];
    assert.deepEqual(toDelete(names, 30, NOW).sort(), [
      'a-20260701T050000Z-nightly.dump', 'a-20260801T090000Z-before-switch-a.dump', 'b-20260701T050000Z-nightly.dump', 'roles-20260701T050000Z-nightly.sql',
    ]);
    assert.deepEqual(toDelete(names, 365, NOW), []);
    // backups that stopped months ago: the last nightly batch stays, whatever its age
    assert.deepEqual(toDelete(['a-20260101T050000Z-nightly.dump', 'a-20260102T050000Z-nightly.dump', 'roles-20260102T050000Z-nightly.sql'], 7, NOW),
      ['a-20260101T050000Z-nightly.dump']);
  });

  it('deletes in a folder, and says what went', () => {
    for (const n of ['a-20260701T050000Z-nightly.dump', 'a-20261004T050000Z-nightly.dump', 'notes.txt']) writeFileSync(join(dir, n), 'x'.repeat(10));
    const r = prune({ sets: [{ id: 'a', dir }, { id: 'gone', dir: join(dir, 'nope') }], days: 30 }, NOW);
    assert.deepEqual(r.sets[0], { id: 'a', deleted: 1, bytes: 10, kept: 1, why: null });
    assert.match(r.sets[1]!.why!, /ENOENT/);
    assert.deepEqual(execFileSync('ls', [dir]).toString().trim().split('\n'), ['a-20261004T050000Z-nightly.dump', 'notes.txt']);
  });

  it('the unit takes 7 to 365 days and backup folders under /var/lib/svc-*/ only', () => {
    const ok = { sets: [{ id: 'lfdln-appdb', dir: '/var/lib/svc-lfdlnappdb/backups' }], days: 60 };
    assert.deepEqual(checkPruneTask(ok), ok);
    for (const days of [0, 6, 366, 1.5, '60']) assert.throws(() => checkPruneTask({ ...ok, days }), Error, String(days));
    for (const d of ['/etc', '/var/lib/svc-x/backups/../../../etc', '/var/lib/other/backups']) assert.throws(() => checkPruneTask({ ...ok, sets: [{ id: 'x', dir: d }] }), Error, d);
  });

  it('the services helper runs it as a root unit, with the pruned folders only', async () => {
    const specs: RunSpec[] = [];
    const ops = createServicesOps({ record: () => ({ version: 1, services: [] }), run: async (s) => { specs.push(s); return { code: 0, stderr: '', stdout: JSON.stringify({ sets: [] }) }; }, probe: async () => ({ status: 200, ms: 1 }) });
    await ops.prune(45);
    assert.equal(specs[0]!.as, 'root');
    assert.equal(specs[0]!.what, 'prune');
    assert.match(specs[0]!.argv[2]!, /packages\/services\/src\/prune\.ts$/);
    const task = JSON.parse(specs[0]!.stdin!);
    assert.equal(task.days, 45);
    assert.deepEqual(task.sets.map((s: { id: string }) => s.id), ['lfdln-appdb', 'lfdln-appmaria'], "the Studio's engines, not the panels' own");
    await assert.rejects(ops.prune(3), /7 to 365 days/);
    await assert.rejects(ops.prune('60'), /7 to 365 days/);
  });
});

// Step 3: other addresses (the probe's url, the routing helper's urls) and the
// registration (the probe's rdap, the routing helper's registration)
describe('the probe: other addresses and the registration', () => {
  let dir = '';
  let server: Server;
  let tls: ProbeEnv;
  const reached: string[] = [];
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'monitoring-urls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=example.test',
      '-addext', 'subjectAltName=DNS:example.test,DNS:*.example.test', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    server = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
      res.statusCode = req.url === '/health' ? 200 : 502;
      res.end('x');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    tls = {
      ip: '127.0.0.1', port, timeoutMs: 3000, now: () => Math.floor(Date.now() / 1000), own: () => ['192.0.2.1'],
      resolve: async (name) => (name.startsWith('here.') ? ['192.0.2.1'] : name.startsWith('cf.') ? ['104.21.28.205', '172.67.147.146'] : name.startsWith('away.') ? ['203.0.113.5'] : ['192.0.2.1', '203.0.113.5']),
      via: (a) => { reached.push(a); return { ip: '127.0.0.1', port }; },
    };
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  type Url = Extract<Result, { kind: 'url' }>;

  it('only a name and a path', () => {
    assert.deepEqual(checkTask({ kind: 'url', name: 'a.org', path: '/api/health' }), { kind: 'url', name: 'a.org', path: '/api/health' });
    for (const bad of [{ name: 'a.org', path: 'x' }, { name: 'a.org', path: '/../etc' }, { name: 'a.org' }, { name: '*.a.org', path: '/' }, { name: 'a.org/x', path: '/' }, { name: 'a.org', path: '/?q=1' }]) {
      assert.throws(() => checkTask({ kind: 'url', ...bad }), Error, JSON.stringify(bad));
    }
  });

  it('pointing here: asked of nginx here; through Cloudflare: asked through it; elsewhere, or mixed: not asked at all', async () => {
    const here = await runTask({ kind: 'url', name: 'here.example.test', path: '/health' }, tls) as Url;
    assert.deepEqual([here.via, here.dns.ok, here.cert.covers, here.answers.status], ['here', true, true, 200]);
    assert.equal(reached.length, 0);
    const cf = await runTask({ kind: 'url', name: 'cf.example.test', path: '/' }, tls) as Url;
    assert.deepEqual([cf.via, cf.dns.why, cf.answers.ok, cf.answers.status], ['cloudflare', 'through Cloudflare', false, 502]);
    assert.deepEqual(reached, ['104.21.28.205']);
    for (const n of ['away.example.test', 'mixed.example.test']) {
      const x = await runTask({ kind: 'url', name: n, path: '/' }, tls) as Url;
      assert.deepEqual([x.via, x.dns.ok, x.answers.ok], [null, false, false], n);
      assert.match(x.dns.why, /points elsewhere/);
      assert.match(x.answers.why, /not asked/);
    }
    assert.equal(reached.length, 1, 'nothing else was reached');
  });

  it('the registration: only a registry it knows, its end date or why not', async () => {
    assert.deepEqual(checkTask({ kind: 'rdap', domain: 'example.org' }), { kind: 'rdap', domain: 'example.org' });
    for (const d of ['example.io', 'a.example.com', 'com']) assert.throws(() => checkTask({ kind: 'rdap', domain: d }), Error, d);
    const asked: string[] = [];
    const e = (answer: unknown): ProbeEnv => ({ ...env(), rdap: async (u) => { asked.push(u); if (answer instanceof Error) throw answer; return answer; } });
    const r = await runTask({ kind: 'rdap', domain: 'lesfleursdelanuit.com' }, e({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-10-09T00:42:14Z' }] }));
    assert.deepEqual(r, { kind: 'rdap', domain: 'lesfleursdelanuit.com', ok: true, why: '', expires: Date.parse('2027-10-09T00:42:14Z') / 1000 });
    assert.deepEqual(asked, [`${RDAP_BASES.com}domain/lesfleursdelanuit.com`]);
    assert.deepEqual(await runTask({ kind: 'rdap', domain: 'a.org' }, e({ events: [] })), { kind: 'rdap', domain: 'a.org', ok: false, why: 'the registry gave no end date', expires: null });
    const down = await runTask({ kind: 'rdap', domain: 'a.org' }, e(new Error('it answered 503')));
    assert.ok(down.kind === 'rdap' && !down.ok && /didn't answer: it answered 503/.test(down.why));
  });
});

describe('the routing helper\'s urls and registration ops', () => {
  const asked: { kind: string }[][] = [];
  const run = async (spec: RunSpec) => {
    const tasks = JSON.parse(spec.stdin!) as { kind: string; name?: string; path?: string; domain?: string }[];
    asked.push(tasks);
    return { code: 0, stderr: '', stdout: JSON.stringify(tasks.map((t) => (t.kind === 'rdap' ? { kind: 'rdap', domain: t.domain, ok: true, why: '', expires: NOW + 86400 } : { kind: 'url', name: t.name, path: t.path, via: 'here' }))) };
  };
  const ops = createRoutesOps({ cfg: hostsConfigOf(PROFILE), run, zone: { taken: async () => null }, now: () => NOW });

  it('checks the addresses asked, fresh each time; refuses what isn\'t a name and a path, and more than 20', async () => {
    const r = await ops.urls({ urls: [{ name: 'gonsalvesfamily.com', path: '/' }, { name: 'Panel.Pammy.org', path: '/login' }] });
    assert.deepEqual(r.urls.map((x) => x.kind === 'url' && [x.name, x.path]), [['gonsalvesfamily.com', '/'], ['panel.pammy.org', '/login']]);
    await assert.rejects(ops.urls({ urls: [{ name: 'a.org', path: 'http://evil' }] }), /not a path/);
    await assert.rejects(ops.urls({ urls: [{ name: 'http://a.org', path: '/' }] }), /not a name/);
    await assert.rejects(ops.urls({ urls: Array(21).fill({ name: 'a.org', path: '/' }) }), /at most 20/);
    await assert.rejects(ops.urls({ urls: [] }), /at most 20/);
  });

  it('the registration of the site\'s domain, unless another is asked', async () => {
    asked.length = 0;
    const r = await ops.registration({});
    assert.deepEqual(r, { kind: 'rdap', domain: 'lesfleursdelanuit.com', ok: true, why: '', expires: NOW + 86400 });
    assert.deepEqual(asked, [[{ kind: 'rdap', domain: 'lesfleursdelanuit.com' }]]);
    await assert.rejects(ops.registration({ domain: 'example.io' }), /no registry known/);
  });
});
