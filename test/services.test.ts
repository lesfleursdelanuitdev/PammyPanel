// The services helper (docs/adopt-plan.md V7): its record, what it asks systemd for
// (a recording runner stands in, answering as a user's systemd would), taking in what
// already runs, its socket and its unit. The real thing is checked live by
// verify-lfdln.sh, which restarts TutorStar once through it (Q4).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { callJsonLine, CallError } from '@panel/core/jsonline';
import type { RunResult, RunSpec } from '@panel/core/runner';
import { adopt } from '@panel/services/adopt';
import { KNOWN } from '@panel/services/known';
import { createServicesOps, type ServiceStatus } from '@panel/services/helper/ops';
import { createServicesServer } from '@panel/services/helper/service';
import { checkRecord, dependentsOf, loadRecord, neededBy, saveRecord, ServicesError, type ServicesRecord } from '@panel/services/record';

let root = '';
before(() => {
  root = mkdtempSync(join(tmpdir(), 'services-'));
  mkdirSync(join(root, 'etc'), { recursive: true });
  writeFileSync(join(root, 'etc/passwd'), 'root:x:0:0::/root:/bin/bash\nsvc-tutorstar:x:990:990::/var/lib/svc-tutorstar:/usr/sbin/nologin\nsvc-ligneous:x:993:993::/var/lib/svc-ligneous:/usr/sbin/nologin\nsvc-lfdln-apps:x:974:966::/var/lib/svc-lfdln-apps:/usr/sbin/nologin\n');
  const cg = join(root, 'sys/fs/cgroup/user.slice/user-990.slice/user@990.service/app.slice/tutorstar.service');
  mkdirSync(cg, { recursive: true });
  writeFileSync(join(cg, 'memory.stat'), 'anon 104857600\nfile 5\n');
});
after(() => rmSync(root, { recursive: true, force: true }));

const record = (): ServicesRecord => ({
  version: 1,
  services: KNOWN.map((k) => ({ ...k, adoptedAt: 1_700_000_000, parts: k.parts.map((p) => ({ ...p, source: p.port ? `/q/${p.unit}.container` : null, sha256: p.port ? 'a'.repeat(64) : null })) })),
});

// A user's systemd, stood in for: which units are active and which masked, per user.
function world() {
  const calls: RunSpec[] = [];
  const active = new Set(['tutorstar', 'ligneous-gedcom-api', 'ligneous-flask-api', 'ligneous-public', 'ligneous-admin', 'examprep']);
  const masked = new Set<string>();
  const w = {
    calls, active, masked, fail: '' as string,
    answers: new Map<number, number | null>([[3041, 200], [8091, 200], [5001, 200], [3039, 200], [3040, 200], [4101, 200]]),
    run: async (spec: RunSpec): Promise<RunResult> => {
      calls.push(spec);
      const [cmd, ...a] = spec.argv;
      if (w.fail && spec.what === w.fail) return { code: 1, stdout: '', stderr: `${spec.what} went wrong` };
      if (cmd === 'systemctl' && a[0] === '--user') {
        const verb = a[1];
        const units = a.filter((x) => x.endsWith('.service')).map((x) => x.slice(0, -'.service'.length));
        if (verb === 'show') {
          return { code: 0, stderr: '', stdout: units.map((u) => [
            `Id=${u}.service`, `LoadState=${masked.has(u) ? 'masked' : 'loaded'}`, `ActiveState=${active.has(u) ? 'active' : 'inactive'}`,
            `SubState=${active.has(u) ? 'running' : 'dead'}`, 'NRestarts=2', 'ActiveEnterTimestamp=@1700000100', `SourcePath=/q/${u}.container`,
          ].join('\n')).join('\n\n') };
        }
        if (verb === 'stop') units.forEach((u) => active.delete(u));
        if (verb === 'start' || verb === 'restart') {
          const m = units.filter((u) => masked.has(u));
          if (m.length) return { code: 1, stdout: '', stderr: `Unit ${m[0]}.service is masked.` };
          units.forEach((u) => active.add(u));
        }
        if (verb === 'mask') units.forEach((u) => masked.add(u));
        if (verb === 'unmask') units.forEach((u) => masked.delete(u));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'sha256sum') return { code: 0, stderr: '', stdout: a.slice(1).map((f) => `${f.includes('tutorstar') ? 'b'.repeat(64) : 'a'.repeat(64)}  ${f}`).join('\n') };
      if (cmd === 'journalctl') return { code: 0, stderr: '', stdout: '2026-09-25T07:00:00+00:00 host tutorstar[1]: ready\n' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return w;
}
const opsOf = (w: ReturnType<typeof world>, rec = record()) => createServicesOps({
  record: () => rec, run: w.run, root, sleep: async () => {}, waitMs: 30,
  probe: async (port) => ({ status: w.active.size && w.answers.get(port) !== undefined ? w.answers.get(port)! : null, ms: 3 }),
});
const verbs = (w: ReturnType<typeof world>) => w.calls.filter((c) => c.argv[0] === 'systemctl' && c.argv[2] !== 'show').map((c) => c.argv.slice(2).join(' '));

describe('the record', () => {
  it('is checked when read: ids, users, units, ports and health paths nginx or systemd could misread are refused', () => {
    assert.ok(checkRecord(record()));
    const bad = (f: (r: ServicesRecord) => void) => { const r = record(); f(r); assert.throws(() => checkRecord(r), ServicesError); };
    bad((r) => { r.services[0]!.id = 'Tutor Star'; });
    bad((r) => { r.services[0]!.user = 'root'; });
    bad((r) => { r.services[0]!.parts[0]!.unit = 'tutorstar.service; rm -rf /'; });
    bad((r) => { r.services[0]!.parts[0]!.port = 80; });
    bad((r) => { r.services[0]!.parts[0]!.health = 'http://x/'; });
    assert.throws(() => checkRecord({ version: 2, services: [] }), ServicesError);
  });

  it('is written whole, root-only (600), and read back the same; missing is empty', () => {
    const p = join(root, 'var/lib/lfdln-services/services.json');
    assert.deepEqual(loadRecord(p), { version: 1, services: [] });
    saveRecord(p, record());
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.deepEqual(loadRecord(p), record());
  });

  it('knows what can\'t run without what: Gonsalves\'s sites need both APIs', () => {
    const g = record().services[1]!;
    assert.deepEqual(dependentsOf(g, 'gedcom-api').map((p) => p.id), ['gedcom-api', 'public', 'admin']);
    assert.deepEqual(dependentsOf(g, 'public').map((p) => p.id), ['public']);
    assert.deepEqual(neededBy(g, 'admin').map((p) => p.id), ['gedcom-api', 'flask-api', 'admin']);
  });
});

describe('how they are', () => {
  it('each part: systemd\'s state, since, restarts, memory, whether it answers, and whether its Quadlet file changed', async () => {
    const w = world();
    const { services } = await opsOf(w).list();
    const t = services.find((s) => s.id === 'tutorstar')!.parts[0]!;
    assert.deepEqual({ active: t.active, masked: t.masked, since: t.since, restarts: t.restarts, memory: t.memory, answering: t.answering, well: t.well, changed: t.changed },
      { active: 'active', masked: false, since: 1_700_000_100, restarts: 2, memory: 104_857_600, answering: { status: 200, ms: 3 }, well: true, changed: true });
    const g = services.find((s) => s.id === 'gonsalves')!;
    assert.equal(g.parts.find((p) => p.id === 'public')!.changed, false);
    assert.equal(g.parts.find((p) => p.id === 'migrator')!.answering, null, 'a one-shot has nothing to ask');
    // asked as each service's own user, never as root
    for (const c of w.calls.filter((x) => x.argv[0] === 'systemctl' || x.argv[0] === 'sha256sum')) assert.notEqual(c.as, 'root');
    assert.deepEqual(w.calls.find((c) => c.argv[2] === 'show' && c.argv.includes('tutorstar.service'))!.as, { user: 'svc-tutorstar', uid: 990, home: '/var/lib/svc-tutorstar' });
  });

  it('a part that answers 5xx, or not at all, isn\'t well', async () => {
    const w = world();
    w.answers.set(3041, 502);
    assert.equal((await opsOf(w).status('tutorstar')).parts[0]!.well, false);
    w.answers.set(3041, null);
    assert.equal((await opsOf(w).status('tutorstar')).parts[0]!.well, false);
  });

  it('where each one\'s data is: :5432 until move-db.sh writes down a switch; anything it can\'t read is :5432 too', async () => {
    const w = world();
    let file: Record<string, unknown> = {};
    const ops = createServicesOps({ record, run: w.run, root, sleep: async () => {}, waitMs: 30, probe: async () => ({ status: 200, ms: 1 }), databases: () => file as never });
    assert.deepEqual((await ops.status('tutorstar')).database, { database: 'tutorstar', engine: 'server', port: 5432, since: null });
    file = { tutorstar: { database: 'tutorstar', engine: 'lfdln-appdb', port: 5436, since: 1_700_000_200 } };
    assert.deepEqual((await ops.status('tutorstar')).database, { database: 'tutorstar', engine: 'lfdln-appdb', port: 5436, since: 1_700_000_200 });
    assert.equal((await ops.status('gonsalves')).database!.engine, 'server', 'one service switched says nothing of the other');
    file = { tutorstar: { database: 'something_else', engine: 'lfdln-appdb', port: 5436 } };
    assert.equal((await ops.status('tutorstar')).database!.engine, 'server', 'a record for another database is not believed');
    const broken = createServicesOps({ record, run: w.run, root, sleep: async () => {}, probe: async () => ({ status: 200, ms: 1 }), databases: () => { throw new Error('bad json'); } });
    assert.equal((await broken.status('tutorstar')).database!.port, 5432);
  });

  it('ports: every part with one, for the hosts\' service routes', async () => {
    const { parts } = await opsOf(world()).ports();
    assert.deepEqual(parts.map((p) => `${p.service}/${p.part}:${p.port}`), ['tutorstar/web:3041', 'gonsalves/gedcom-api:8091', 'gonsalves/flask-api:5001', 'gonsalves/public:3039', 'gonsalves/admin:3040', 'examprep/web:4101']);
  });
});

describe('start, stop, restart', () => {
  it('stop: stops, then masks, so it stays stopped after a reboot', async () => {
    const w = world();
    const s = await opsOf(w).stop('tutorstar', undefined, 'momolig');
    assert.deepEqual(verbs(w), ['stop tutorstar.service', 'mask tutorstar.service']);
    assert.equal(s.parts[0]!.masked, true);
  });

  it('start: unmasks, reloads, starts, and waits until it answers', async () => {
    const w = world();
    const ops = opsOf(w);
    await ops.stop('tutorstar', undefined, 'm');
    w.calls.length = 0;
    const s = await ops.start('tutorstar', undefined, 'm');
    assert.deepEqual(verbs(w), ['unmask tutorstar.service', 'daemon-reload', 'start tutorstar.service']);
    assert.equal(s.parts[0]!.well, true);
  });

  it('stopping an API stops the sites that need it too (and keeps them stopped); starting a site starts its APIs first', async () => {
    const w = world();
    const ops = opsOf(w);
    await ops.stop('gonsalves', 'flask-api', 'm');
    assert.deepEqual(verbs(w), ['stop ligneous-admin.service ligneous-public.service ligneous-flask-api.service', 'mask ligneous-admin.service ligneous-public.service ligneous-flask-api.service']);
    assert.ok(w.active.has('ligneous-gedcom-api'), 'the other API goes on');
    w.calls.length = 0;
    await ops.start('gonsalves', 'public', 'm');
    assert.deepEqual(verbs(w), ['unmask ligneous-gedcom-api.service ligneous-flask-api.service ligneous-public.service', 'daemon-reload',
      'start ligneous-gedcom-api.service ligneous-flask-api.service ligneous-public.service']);
    assert.ok(!w.active.has('ligneous-admin') && w.masked.has('ligneous-admin'), 'admin wasn\'t asked for: it stays stopped');
  });

  it('the whole service: every part it may control, in order, never the migrator', async () => {
    const w = world();
    const ops = opsOf(w);
    await ops.stop('gonsalves', undefined, 'm');
    assert.equal(verbs(w)[0], 'stop ligneous-admin.service ligneous-public.service ligneous-flask-api.service ligneous-gedcom-api.service');
    w.calls.length = 0;
    await ops.start('gonsalves', null, 'm');
    assert.equal(verbs(w)[2], 'start ligneous-gedcom-api.service ligneous-flask-api.service ligneous-public.service ligneous-admin.service');
    await assert.rejects(ops.start('gonsalves', 'migrator', 'm'), (e: ServicesError) => e.code === 'invalid');
    await assert.rejects(ops.stop('gonsalves', 'migrator', 'm'), (e: ServicesError) => e.code === 'invalid');
  });

  it('restart: only what runs; a stopped part is to be started instead', async () => {
    const w = world();
    const ops = opsOf(w);
    await ops.restart('tutorstar', undefined, 'm');
    assert.deepEqual(verbs(w), ['restart tutorstar.service']);
    await ops.stop('tutorstar', undefined, 'm');
    await assert.rejects(ops.restart('tutorstar', undefined, 'm'), (e: ServicesError) => e.code === 'conflict' && /start it instead/.test(e.message));
  });

  it('a start that never answers says so, after its wait', async () => {
    const w = world();
    w.answers.set(3041, 503);
    await assert.rejects(opsOf(w).start('tutorstar', undefined, 'm'), (e: ServicesError) => e.code === 'internal' && /didn't answer/.test(e.message));
  });

  it('a step systemd refuses is said, with its own words', async () => {
    const w = world();
    w.fail = 'stop';
    await assert.rejects(opsOf(w).stop('tutorstar', undefined, 'm'), (e: ServicesError) => /couldn't be stopped \(stop went wrong\)/.test(e.message));
  });

  it('one thing at a time per service', async () => {
    const w = world();
    let release!: () => void;
    const slow = { ...w, run: async (spec: RunSpec) => { if (spec.argv[2] === 'restart') await new Promise<void>((r) => { release = r; }); return w.run(spec); } };
    const ops = createServicesOps({ record, run: slow.run, root, sleep: async () => {}, probe: async () => ({ status: 200, ms: 1 }) });
    const first = ops.restart('tutorstar', undefined, 'a');
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(ops.stop('tutorstar', undefined, 'b'), (e: ServicesError) => e.code === 'busy');
    release();
    await first;
  });

  it('unknown services and parts, and a missing user, are refused', async () => {
    const ops = opsOf(world());
    await assert.rejects(ops.status('nope'), (e: ServicesError) => e.code === 'not-found');
    await assert.rejects(ops.restart('gonsalves', 'nope', 'm'), (e: ServicesError) => e.code === 'not-found');
    const rec = record();
    rec.services[0]!.user = 'svc-gone';
    await assert.rejects(opsOf(world(), rec).status('tutorstar'), (e: ServicesError) => e.code === 'unavailable');
  });

  it('logs: its lines from the journal, by its unit and its user', async () => {
    const w = world();
    assert.deepEqual(await opsOf(w).logs('tutorstar', 'web'), { lines: ['2026-09-25T07:00:00+00:00 host tutorstar[1]: ready'] });
    const c = w.calls.at(-1)!;
    assert.equal(c.as, 'root');
    assert.deepEqual(c.argv.slice(0, 3), ['journalctl', '_SYSTEMD_USER_UNIT=tutorstar.service', '_UID=990']);
  });
});

// docs/roles-plan.md step 6 (S6-3): the file the known services list names, for Read again
describe("a service's pammy-panel.json", () => {
  const file = () => join(root, 'etc/lfdln-projects/examprep/pammy-panel.json');
  it('is read from where its installer puts it, only for a service taken in, and 64 KB at most', async () => {
    const ops = opsOf(world());
    await assert.rejects(ops.manifest('examprep'), (e) => e instanceof ServicesError && e.code === 'not-found' && /isn't at \/etc\/lfdln-projects\/examprep\/pammy-panel\.json/.test(e.message));
    mkdirSync(join(root, 'etc/lfdln-projects/examprep'), { recursive: true });
    writeFileSync(file(), '{"version":1}');
    assert.deepEqual(await ops.manifest('examprep'), { text: '{"version":1}', path: '/etc/lfdln-projects/examprep/pammy-panel.json' });
    await assert.rejects(ops.manifest('tutorstar'), /TutorStar has no pammy-panel\.json/);
    await assert.rejects(ops.manifest('nope'), ServicesError);
    const without = record();
    without.services = without.services.filter((x) => x.id !== 'examprep');
    await assert.rejects(opsOf(world(), without).manifest('examprep'), ServicesError, 'not taken in: nothing read');
    writeFileSync(file(), 'x'.repeat(64 * 1024 + 1));
    await assert.rejects(ops.manifest('examprep'), /larger than 64 KB/);
    rmSync(join(root, 'etc/lfdln-projects'), { recursive: true });
  });
});

describe('taking them in', () => {
  const passwd = () => readFileSync(join(root, 'etc/passwd'), 'utf8');
  it('writes down what systemd says of each unit, and asks it nothing else', async () => {
    const w = world();
    const { record: r, said } = await adopt({ run: w.run, passwd, now: () => 1_800_000_000 });
    assert.deepEqual(r.services.map((s) => s.id), ['tutorstar', 'gonsalves', 'examprep']);
    assert.equal(r.services[0]!.parts[0]!.source, '/q/tutorstar.container');
    assert.equal(r.services[0]!.parts[0]!.sha256, 'b'.repeat(64));
    assert.equal(r.services[0]!.adoptedAt, 1_800_000_000);
    assert.deepEqual([...new Set(w.calls.map((c) => `${c.argv[0]} ${c.argv[0] === 'systemctl' ? c.argv[2] : c.argv[1]}`))].sort(), ['sha256sum --', 'systemctl show']);
    assert.ok(said.every((l) => l.startsWith('ok')), said.join('\n'));
    // again: the same, with the first time kept
    const again = await adopt({ run: w.run, passwd, now: () => 1_900_000_000 }, r);
    assert.deepEqual(again.record, r);
  });

  it('a service whose user or units aren\'t on this server isn\'t taken in, and says why', async () => {
    const w = world();
    const noLigneous = () => passwd().split('\n').filter((l) => !l.startsWith('svc-ligneous')).join('\n');
    const { record: r, said } = await adopt({ run: w.run, passwd: noLigneous, now: () => 1 });
    assert.deepEqual(r.services.map((s) => s.id), ['tutorstar', 'examprep']);
    assert.match(said.join('\n'), /Gonsalves family: no user svc-ligneous/);
    const notLoaded = { run: async (spec: RunSpec) => (spec.argv[2] === 'show' ? { code: 0, stdout: 'Id=tutorstar.service\nLoadState=not-found\n', stderr: '' } : w.run(spec)) };
    assert.match((await adopt({ run: notLoaded.run, passwd, now: () => 1 })).said.join('\n'), /tutorstar not in svc-tutorstar's systemd/);
  });
});

describe('the socket', () => {
  it('answers its operations, and has no delete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'services-s-'));
    const sock = join(dir, 's.sock');
    const server = createServicesServer(opsOf(world()));
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const l = await callJsonLine<{ services: ServiceStatus[] }>(sock, { op: 'list' }, 'the services helper');
      assert.equal(l.services.length, 3);
      assert.equal((await callJsonLine<ServiceStatus>(sock, { op: 'restart', id: 'tutorstar', actor: 'x' }, 'the services helper')).parts[0]!.well, true);
      for (const op of ['delete', 'remove', 'purge', 'exec']) {
        await assert.rejects(callJsonLine(sock, { op, id: 'tutorstar' }, 'the services helper'), (e: CallError) => e.code === 'invalid', op);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The unit runs only on lfdln (verify-lfdln.sh checks it live); here, that it says what
// docs/adopt-plan.md V7 promises.
describe('its unit', () => {
  const unit = readFileSync(join(import.meta.dirname, '..', 'packages', 'services', 'deploy', 'lfdln-services.service'), 'utf8');
  const socket = readFileSync(join(import.meta.dirname, '..', 'packages', 'services', 'deploy', 'lfdln-services.socket'), 'utf8');
  const lines = (text: string, key: string) => text.split('\n').filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));
  it('holds no capabilities, writes nothing, and reaches only 127.0.0.1', () => {
    assert.deepEqual(lines(unit, 'CapabilityBoundingSet'), ['']);
    assert.deepEqual(lines(unit, 'ProtectSystem'), ['strict']);
    assert.deepEqual(lines(unit, 'ReadWritePaths'), []);
    assert.deepEqual(lines(unit, 'IPAddressDeny'), ['any']);
    assert.deepEqual(lines(unit, 'IPAddressAllow'), ['localhost']);
    assert.deepEqual(lines(unit, 'NoNewPrivileges'), ['yes']);
  });
  it('only the panel may open its socket', () => {
    assert.deepEqual([lines(socket, 'SocketUser'), lines(socket, 'SocketGroup'), lines(socket, 'SocketMode')], [['root'], ['svc-lfdlnpanel'], ['0660']]);
  });
});
