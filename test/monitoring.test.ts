// Monitoring (docs/monitoring-plan.md step 1): the round's rules (state.ts), what it
// collects from the helpers (collect.ts, with stand-ins), and the round itself against a
// real Postgres (monitor.ts): down after two failures, back after one pass, stopped on
// purpose, one reminder a day, quiet, one email per round, 10 a day, 90 days kept.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { all, one, run, type Sql } from '@panel/core/pg';
import { migrate } from '@panel/core/pg-migrate';
import { collect, type ProjectServerLike, type Sources } from '@panel/monitoring/panel/collect';
import { createMonitor, type Notice } from '@panel/monitoring/panel/monitor';
import { mailFor, step, type Result, type Row } from '@panel/monitoring/state';
import { decide, FRESH, roundAge } from '@panel/monitoring/watchdog';
import { startPg, type PgTest } from './pg-harness.ts';

const T = 1_800_000_000;
const r = (key: string, ok: boolean, extra: Partial<Result> = {}): Result =>
  ({ key, group: 'hosts', subject: key.replace(/^host:/, ''), label: key.replace(/^host:/, ''), ok, why: ok ? '' : 'no answer: 502', ...extra });
const walk = (rounds: Result[][], start = T, every = 300) => {
  let prev = new Map<string, Row>();
  const all: ReturnType<typeof step>['changes'] = [];
  rounds.forEach((res, i) => {
    const s = step(prev, res, start + i * every);
    all.push(...s.changes);
    prev = new Map(s.rows.map((x) => [x.key, x]));
  });
  return { prev, changes: all };
};

describe('the rules of a round (state.ts)', () => {
  it('a first failure only counts; the second is down; one pass is back', () => {
    const { prev, changes } = walk([[r('host:a', true)], [r('host:a', false)], [r('host:a', false)], [r('host:a', false)], [r('host:a', true)]]);
    assert.deepEqual(changes.map((c) => [c.kind, c.at]), [['down', T + 600], ['back', T + 1200]]);
    assert.equal(prev.get('host:a')!.state, 'up');
    assert.equal(prev.get('host:a')!.fails, 0);
  });
  it('a single failure between passes is no news', () => {
    assert.deepEqual(walk([[r('host:a', true)], [r('host:a', false)], [r('host:a', true)]]).changes, []);
  });
  it('down from the start: two failures of a new check', () => {
    assert.deepEqual(walk([[r('host:a', false)], [r('host:a', false)]]).changes.map((c) => c.kind), ['down']);
  });
  it('stopped on purpose is never down, and said without an email; started again, the same', () => {
    const { changes } = walk([[r('host:a', true)], [r('host:a', true, { stopped: true })], [r('host:a', true, { stopped: true })], [r('host:a', true)]]);
    assert.deepEqual(changes.map((c) => c.kind), ['stopped', 'started']);
    assert.equal(mailFor(changes, 'x'), null);
  });
  it('still down: one reminder a day, not every round', () => {
    const rounds = Array.from({ length: 2 * 288 + 3 }, () => [r('host:a', false)]);
    assert.deepEqual(walk(rounds).changes.map((c) => c.kind), ['down', 'still-down', 'still-down']);
  });
  it('a warning is mailed once, then back', () => {
    const { changes } = walk([[r('host:a', true, { warn: true, why: '20 days left' })], [r('host:a', true, { warn: true, why: '19 days left' })], [r('host:a', true)]]);
    assert.deepEqual(changes.map((c) => c.kind), ['warn', 'back']);
  });
  it('a check there is no more of goes quietly; a group whose helper was unread stays as it was', () => {
    let s = step(new Map(), [r('host:a', true), r('host:b', false)], T);
    s = step(new Map(s.rows.map((x) => [x.key, x])), [r('host:a', true)], T + 300);
    assert.deepEqual(s.gone, ['host:b']);
    const prev = new Map(step(new Map(), [r('host:a', false), r('host:a', false)], T).rows.map((x) => [x.key, x]));
    const kept = step(prev, [], T + 300, new Set(['hosts']));
    assert.deepEqual(kept.gone, []);
    assert.deepEqual(kept.rows, [...prev.values()]);
  });
  it('the email: counted in its subject, a line each, down first, 10 lines at most', () => {
    const changes = [
      { key: 'k1', subject: 's', label: 'tutor.lesfleursdelanuit.com', kind: 'back' as const, why: '', at: T },
      { key: 'k2', subject: 's', label: 'Gonsalves family / Public site', kind: 'down' as const, why: 'not running (failed)', at: T },
      { key: 'k3', subject: 's', label: 'x', kind: 'started' as const, why: '', at: T },
    ];
    assert.deepEqual(mailFor(changes, 'lesfleursdelanuit.com'), {
      subject: 'lesfleursdelanuit.com: 1 down, 1 back',
      lines: ['Down: Gonsalves family / Public site: not running (failed)', 'Back: tutor.lesfleursdelanuit.com'],
    });
    const many = Array.from({ length: 14 }, (_, i) => ({ ...changes[1]!, key: `k${i}`, label: `part ${i}` }));
    const m = mailFor(many, 'x')!;
    assert.equal(m.lines.length, 10);
    assert.equal(m.lines[9], 'And 5 more: see the panel.');
  });
});

describe('what a round collects (collect.ts)', () => {
  const sources = (over: Partial<Sources> = {}): Sources => ({
    domain: async () => ({ name: 'example.org', front: 'direct' }),
    hosts: async () => [{ name: '@', with_www: true, enabled: true }, { name: 'tutor', with_www: false, enabled: true }, { name: 'old', with_www: false, enabled: false }],
    check: async (_d, hosts) => {
      assert.deepEqual(hosts.map((h) => h.name), ['@', 'tutor'], 'a host switched off is not asked about');
      return [
        { name: 'example.org', dns: { ok: true, why: '' }, cert: { ok: true, why: '' }, answers: { ok: true, why: '' } },
        { name: 'www.example.org', dns: { ok: true, why: '' }, cert: { ok: false, why: 'expired' }, answers: { ok: true, why: '' } },
        { name: 'tutor.example.org', dns: { ok: true, why: '' }, cert: { ok: true, why: '' }, answers: { ok: false, why: 'answers 502' } },
      ];
    },
    services: async () => [{ id: 'gonsalves', title: 'Gonsalves family', parts: [
      { id: 'public', title: 'Public site', controls: true, active: 'active', sub: 'running', masked: false, answering: { status: 200, ms: 3 }, well: true },
      { id: 'admin', title: 'Admin site', controls: true, active: 'active', sub: 'running', masked: false, answering: { status: 500, ms: 3 }, well: false },
      { id: 'api', title: 'API', controls: true, active: 'failed', sub: 'failed', masked: false, answering: null, well: null },
      { id: 'web', title: 'Web', controls: true, active: 'inactive', sub: 'dead', masked: true, answering: null, well: null },
      { id: 'migrator', title: 'Migrator', controls: false, active: 'active', sub: 'exited', masked: false, answering: null, well: null },
    ] }],
    pieces: [{ id: 'mail', label: 'The mail service', ask: async () => 'No Resend key has been set.' }, { id: 'gate', label: 'The gate', ask: async () => { throw new Error('connect ENOENT'); } }],
    ...over,
  });
  it('every name, part and piece, each with why it failed', async () => {
    const { results, unread } = await collect(sources(), { slow: true });
    const by = Object.fromEntries(results.map((x) => [x.key, x]));
    assert.equal(unread.size, 0);
    assert.equal(by['host:example.org']!.ok, true);
    assert.deepEqual([by['host:www.example.org']!.ok, by['host:www.example.org']!.why], [false, 'expired']);
    assert.deepEqual([by['host:tutor.example.org']!.ok, by['host:tutor.example.org']!.why], [false, 'answers 502']);
    assert.equal(by['host:old.example.org']!.stopped, true);
    assert.equal(by['service:gonsalves/public']!.ok, true);
    assert.equal(by['service:gonsalves/admin']!.why, 'answers 500');
    assert.equal(by['service:gonsalves/api']!.why, 'not running (failed, failed)');
    assert.equal(by['service:gonsalves/web']!.stopped, true);
    assert.equal(by['service:gonsalves/migrator'], undefined, 'nothing the panel starts or stops');
    assert.equal(by['service:gonsalves/api']!.subject, 'service:gonsalves');
    assert.deepEqual([by['panel:mail']!.ok, by['panel:mail']!.why], [false, 'No Resend key has been set.']);
    assert.deepEqual([by['panel:gate']!.ok, by['panel:gate']!.why], [false, 'connect ENOENT']);
    assert.equal(by['panel:routes']!.ok, true);
    assert.equal(by['panel:services']!.ok, true);
  });
  it('a helper that doesn\'t answer: one failure of its own, its group unread', async () => {
    const { results, unread } = await collect(sources({ check: async () => { throw new Error('the routing helper is not running'); }, services: async () => { throw new Error('no socket'); } }), { slow: true });
    assert.deepEqual([...unread].sort(), ['certs', 'hosts', 'services']);
    assert.equal(results.filter((x) => x.group !== 'panel').length, 0);
    assert.match(results.find((x) => x.key === 'panel:routes')!.why, /didn't answer: the routing helper is not running/);
    assert.match(results.find((x) => x.key === 'panel:services')!.why, /didn't answer: no socket/);
  });
  it('projects\' servers (docs/phase8b-plan.md D4-12): runs and answers; stopped from Projects is stopped on purpose; the helper not answering is its own failure', async () => {
    const srv = (over: Partial<ProjectServerLike>): ProjectServerLike => ({ project: 'blog', branch: 'main', port: 4200, active: 'active', sub: 'running', stopped: false, answering: { status: 200, ms: 4 }, ...over });
    const { results, unread } = await collect(sources({ projects: async () => [
      srv({}), srv({ branch: 'dev', port: 4202, answering: { status: 502, ms: 4 } }), srv({ project: 'shop', active: 'failed', sub: 'failed', answering: null }),
      srv({ project: 'quiet', stopped: true, active: 'inactive', answering: null }), srv({ project: 'mute', answering: { status: null, ms: 5000 } }),
    ] }), { slow: true });
    const by = Object.fromEntries(results.map((x) => [x.key, x]));
    assert.deepEqual([by['project:blog/main']!.ok, by['project:blog/main']!.label, by['project:blog/main']!.subject, by['project:blog/main']!.group], [true, 'blog (live)', 'project:blog', 'projects']);
    assert.deepEqual([by['project:blog/dev']!.why, by['project:blog/dev']!.label], ['answers 502', 'blog (preview)']);
    assert.equal(by['project:shop/main']!.why, 'not running (failed, failed)');
    assert.equal(by['project:quiet/main']!.stopped, true);
    assert.equal(by['project:mute/main']!.why, 'no answer on port 4200');
    assert.equal(by['panel:projects']!.ok, true);
    assert.equal(unread.size, 0);
    const off = await collect(sources({ projects: async () => { throw new Error('no socket'); } }), { slow: true });
    assert.deepEqual([...off.unread], ['projects']);
    assert.match(off.results.find((x) => x.key === 'panel:projects')!.why, /didn't answer: no socket/);
    assert.equal((await collect(sources(), { slow: true })).results.some((x) => x.key === 'panel:projects'), false, 'a site without projects has no such row');
    // 8b-8b: the builds' proxy, when the helper says
    const down = await collect(sources({ projects: async () => ({ servers: [srv({})], proxy: false }) }), { slow: true });
    const row = down.results.find((x) => x.key === 'project:build-proxy')!;
    assert.deepEqual([row.ok, row.group, row.why], [false, 'projects', "not running: builds can't reach the package registries"]);
    assert.equal((await collect(sources({ projects: async () => ({ servers: [], proxy: true }) }), { slow: true })).results.find((x) => x.key === 'project:build-proxy')!.ok, true);
    assert.equal(results.some((x) => x.key === 'project:build-proxy'), false, 'not asked: no row');
  });
  it('hosts on another domain: asked on their own domain, with its front, their names as visitors use them (docs/domains-hosts-plan.md step 7)', async () => {
    const asked: string[] = [];
    const { results } = await collect(sources({
      hosts: async () => [{ name: '@', with_www: true, enabled: true }, { name: '@', with_www: true, enabled: true, domain: 'gonsalvesfamily.com', front: 'direct' }, { name: 'admin', with_www: false, enabled: true, domain: 'gonsalvesfamily.com', front: 'direct' }],
      check: async (d, hosts) => {
        asked.push(`${d.name} ${d.front}: ${hosts.map((h) => h.name).join(' ')}`);
        return hosts.flatMap((h) => (h.name === '@' ? [d.name, `www.${d.name}`] : [`${h.name}.${d.name}`])).map((name) => ({ name, dns: { ok: true, why: '' }, cert: { ok: true, why: '' }, answers: { ok: true, why: '' } }));
      },
    }));
    assert.deepEqual(asked.sort(), ['example.org direct: @', 'gonsalvesfamily.com direct: @ admin']);
    const keys = results.filter((x) => x.group === 'hosts').map((x) => [x.key, x.ok]);
    assert.deepEqual(keys, [['host:example.org', true], ['host:www.example.org', true], ['host:gonsalvesfamily.com', true], ['host:www.gonsalvesfamily.com', true], ['host:admin.gonsalvesfamily.com', true]]);
  });
});

describe('the round (monitor.ts), on Postgres', () => {
  let pg: PgTest;
  let db: Sql;
  let clock = T;
  let results: Result[] = [];
  const sent: Notice[] = [];
  let mailFails = false;
  const slowAsked: boolean[] = [];
  let monitor: ReturnType<typeof createMonitor>;
  before(async () => {
    pg = await startPg();
    const database = pg.freshDatabase();
    const owner = pg.connect('owner', database, 1);
    await migrate(owner);
    await owner.end();
    db = pg.connect('panel', database, 4);
    monitor = createMonitor({
      db, now: () => clock, site: 'lesfleursdelanuit.com', origin: 'https://panel.lesfleursdelanuit.com',
      collect: async (o) => { slowAsked.push(o.slow); return { results, unread: new Set() }; },
      mail: async (n) => { if (mailFails) throw new Error('Resend is down'); sent.push(n); },
    });
  });
  after(async () => { await db?.end({ timeout: 2 }); pg?.stop(); });
  const tick = async (res: Result[]) => { results = res; clock += 300; return monitor.round(); };

  it('down after two rounds, one email; back, another; the changes kept', async () => {
    await tick([r('host:a', true), r('host:b', true)]);
    await tick([r('host:a', false), r('host:b', true)]);
    assert.equal(sent.length, 0);
    const s = await tick([r('host:a', false), r('host:b', true)]);
    assert.deepEqual([s.down, s.mail], [1, 'sent']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.subject, 'lesfleursdelanuit.com: 1 down');
    assert.equal(sent[0]!.link, 'https://panel.lesfleursdelanuit.com/monitoring');
    await tick([r('host:a', true), r('host:b', true)]);
    assert.equal(sent[1]!.subject, 'lesfleursdelanuit.com: 1 back');
    const ev = await all<{ kind: string; mail: string }>(db, 'SELECT kind, mail FROM monitor_events ORDER BY id');
    assert.deepEqual(ev.map((e) => [e.kind, e.mail]), [['down', 'sent'], ['back', 'sent']]);
    const st = await one<{ round_at: number }>(db, 'SELECT round_at FROM monitor_settings');
    assert.equal(st!.round_at, clock);
  });

  it('quiet: changes kept, not emailed; everything, or one subject', async () => {
    sent.length = 0;
    await run(db, 'INSERT INTO monitor_quiet (subject, until, created_at) VALUES (?, ?, ?)', 'a', clock + 3600, clock);
    await tick([r('host:a', false), r('host:b', true)]);
    const s = await tick([r('host:a', false), r('host:b', true)]);
    assert.equal(s.mail, 'quiet');
    assert.equal(sent.length, 0);
    assert.equal((await one<{ mail: string }>(db, "SELECT mail FROM monitor_events WHERE kind = 'down' ORDER BY id DESC LIMIT 1"))!.mail, 'quiet');
    // quiet ends: said in Activity, and the next change is emailed
    clock += 3600;
    await tick([r('host:a', true), r('host:b', true)]);
    assert.equal(sent.length, 1);
    assert.equal((await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM activity WHERE action = 'monitoring-quiet-ended' AND target = 'a'"))!.n, 1);
  });

  it('mail off: nothing emailed', async () => {
    sent.length = 0;
    await run(db, 'UPDATE monitor_settings SET mail = false');
    await tick([r('host:a', false), r('host:b', true)]);
    const s = await tick([r('host:a', false), r('host:b', true)]);
    assert.equal(s.mail, 'off');
    assert.equal(sent.length, 0);
    await run(db, 'UPDATE monitor_settings SET mail = true');
    await tick([r('host:a', true), r('host:b', true)]);
  });

  it('10 emails a day: the 10th says so, then held and counted', async () => {
    await run(db, 'DELETE FROM monitor_mail');
    sent.length = 0;
    for (let i = 0; i < 12; i++) {
      await tick([r('host:a', false), r('host:b', true)]);
      await tick([r('host:a', false), r('host:b', true)]);
      await tick([r('host:a', true), r('host:b', true)]);
    }
    assert.equal(sent.length, 10);
    assert.match(sent[9]!.lines.at(-1)!, /last monitoring email today \(10\)/);
    const m = await all<{ sent: number; held: number }>(db, 'SELECT sent, held FROM monitor_mail');
    assert.equal(m.reduce((n, x) => n + x.sent, 0), 10);
    assert.ok(m.reduce((n, x) => n + x.held, 0) >= 12);
  });

  it('a failed send is said on the round, and nothing breaks', async () => {
    await run(db, 'DELETE FROM monitor_mail');
    mailFails = true;
    await tick([r('host:a', false), r('host:b', true)]);
    const s = await tick([r('host:a', false), r('host:b', true)]);
    mailFails = false;
    assert.equal(s.mail, 'failed');
    assert.equal((await one<{ round_note: string }>(db, 'SELECT round_note FROM monitor_settings'))!.round_note, 'the email could not be sent');
    await tick([r('host:a', true), r('host:b', true)]);
  });

  it('changes older than 90 days go', async () => {
    await run(db, "INSERT INTO monitor_events (key, label, kind, at) VALUES ('host:old', 'old', 'down', ?)", clock - 91 * 86_400);
    await tick([r('host:a', true), r('host:b', true)]);
    assert.equal((await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM monitor_events WHERE key = 'host:old'"))!.n, 0);
  });

  it('two asks at once: one round', async () => {
    results = [r('host:a', true)];
    const [x, y] = await Promise.all([monitor.round(), monitor.round()]);
    assert.equal(x, y);
  });

  it('the hourly checks: the first round, then once an hour, and whenever Check now asks', async () => {
    assert.equal(slowAsked[0], true, 'the first round after a start asks them');
    slowAsked.length = 0;
    for (let i = 0; i < 11; i++) await tick([r('host:a', true)]);
    await tick([r('host:a', true)]);
    assert.deepEqual(slowAsked.map((x, i) => [i, x]).filter(([, x]) => x).length, 1, 'once in 12 rounds of 5 minutes');
    slowAsked.length = 0;
    await monitor.round({ all: true });
    assert.deepEqual(slowAsked, [true]);
  });
});

describe('the slow checks and the certificates (step 2)', () => {
  const NOW = 1_790_500_000;
  const base = (over: Partial<Sources> = {}): Sources => ({
    domain: async () => ({ name: 'example.org', front: 'direct' }),
    hosts: async () => [{ name: '@', with_www: true, enabled: true }, { name: 'tutor', with_www: false, enabled: true }],
    check: async () => [
      { name: 'example.org', dns: { ok: true, why: '' }, cert: { ok: true, why: '', covers: true, daysLeft: 60, notAfter: NOW + 60 * 86400, names: ['example.org', 'www.example.org'] }, answers: { ok: true, why: '' } },
      // the probe fails a certificate under 14 days: covered, so the host passes and the certs group says it
      { name: 'www.example.org', dns: { ok: true, why: '' }, cert: { ok: false, why: 'expires in 10 day(s)', covers: true, daysLeft: 60, notAfter: NOW + 60 * 86400, names: ['www.example.org', 'example.org'] }, answers: { ok: true, why: '' } },
      { name: 'tutor.example.org', dns: { ok: true, why: '' }, cert: { ok: false, why: 'expires in 10 day(s)', covers: true, daysLeft: 10, notAfter: NOW + 10 * 86400, names: ['*.example.org'] }, answers: { ok: true, why: '' } },
    ],
    services: null,
    pieces: [],
    ...over,
  });
  const byKey = (results: Result[]) => Object.fromEntries(results.map((x) => [x.key, x]));

  it('each certificate once, by its names: under 21 days to look at, under 7 down; the host passes when it is covered', async () => {
    const { results } = await collect(base(), { at: NOW });
    const by = byKey(results);
    assert.equal(by['host:www.example.org']!.ok, true);
    assert.equal(by['host:tutor.example.org']!.ok, true);
    const certs = results.filter((x) => x.group === 'certs');
    assert.deepEqual(certs.map((x) => x.key).sort(), ['cert:*.example.org', 'cert:example.org,www.example.org']);
    assert.deepEqual([by['cert:example.org,www.example.org']!.ok, !!by['cert:example.org,www.example.org']!.warn], [true, false]);
    assert.deepEqual([by['cert:*.example.org']!.ok, by['cert:*.example.org']!.warn], [true, true]);
    assert.match(by['cert:*.example.org']!.why, /^10 day\(s\) left \(until .*renewing has failed/);
    const late = await collect(base({ check: async () => [{ name: 'example.org', dns: { ok: true, why: '' }, cert: { ok: false, why: 'x', covers: true, daysLeft: 3, notAfter: null, names: ['example.org'] }, answers: { ok: true, why: '' } }] }), { at: NOW });
    assert.equal(byKey(late.results)['cert:example.org']!.ok, false);
  });

  it('not the hour: the slow groups and their helpers\' rows are left as they were', async () => {
    let asked = 0;
    const { results, unread } = await collect(base({ storage: async () => { asked++; return { backups: [], disks: [] }; } }), { at: NOW });
    assert.equal(asked, 0);
    for (const k of ['backups', 'disk', 'dns', 'panel:storage', 'panel:records']) assert.ok(unread.has(k), k);
    assert.equal(results.some((x) => ['backups', 'disk', 'dns'].includes(x.group)), false);
    // and step keeps a row named by key
    const prev = new Map<string, Row>([['panel:storage', { key: 'panel:storage', grp: 'panel', subject: 'panel', label: 's', state: 'down', fails: 2, since: 1, last_at: 1, why: 'x', link: null, reminded_at: null }]]);
    assert.equal(step(prev, [], NOW, unread).rows[0]?.key, 'panel:storage');
  });

  it('backups: the newest nightly batch under 26 hours old, none empty; a disk once, however many paths', async () => {
    const storage = async () => ({
      backups: [
        { id: 'fresh', title: 'Fresh', newest: { at: NOW - 5 * 3600, files: 3, empty: 0, bytes: 2_400_000 }, why: null },
        { id: 'old', title: 'Old', newest: { at: NOW - 30 * 3600, files: 1, empty: 0, bytes: 10 }, why: null },
        { id: 'empty', title: 'Empty', newest: { at: NOW - 3600, files: 2, empty: 1, bytes: 10 }, why: null },
        { id: 'none', title: 'None', newest: null, why: null },
        { id: 'shut', title: 'Shut', newest: null, why: "the folder can't be read: EACCES" },
      ],
      disks: [
        { path: '/', dev: '2051', size: 1000, avail: 100, why: null },
        { path: '/mnt/storage', dev: '2051', size: 1000, avail: 100, why: null },
        { path: '/full', dev: '9', size: 1000, avail: 20, why: null },
      ],
    });
    const { results, unread } = await collect(base({ storage }), { slow: true, at: NOW });
    const by = byKey(results);
    assert.equal(unread.size, 0);
    assert.deepEqual([by['backup:fresh']!.ok, by['backup:fresh']!.why], [true, '3 dumps, 2.4 MB, 5 h ago']);
    assert.deepEqual([by['backup:old']!.ok, by['backup:old']!.why], [false, 'the newest nightly one is 30 h old']);
    assert.deepEqual([by['backup:empty']!.ok, by['backup:empty']!.why], [false, '1 of the newest 2 dump(s) empty']);
    assert.equal(by['backup:none']!.why, 'no nightly backup there');
    assert.match(by['backup:shut']!.why, /EACCES/);
    assert.deepEqual([by['disk:/']!.label, by['disk:/']!.ok, by['disk:/']!.warn], ['Disk space: / and /mnt/storage', true, true]);
    assert.equal(by['disk:/mnt/storage'], undefined);
    assert.equal(by['disk:/full']!.ok, false);
    assert.equal(by['panel:storage']!.ok, true);
    const down = await collect(base({ storage: async () => { throw new Error('no socket'); } }), { slow: true, at: NOW });
    assert.ok(down.unread.has('backups') && down.unread.has('disk'));
    assert.match(byKey(down.results)['panel:storage']!.why, /didn't answer: no socket/);
  });

  it('DNS records: kept the first time, then the same passes; changed, gone or unread fails', async () => {
    const kept = new Map<string, string>();
    let values: Record<string, string[]> = { 'mx': ['10 feedback.example.net'], 'ns': ['ns2.dns.example', 'ns1.dns.example'] };
    const records = {
      want: [{ key: 'mx', label: 'MX', name: 'send.mail.example.org', type: 'MX' as const }, { key: 'ns', label: 'NS', name: 'example.org', type: 'NS' as const }],
      read: async (want: { key: string; name: string; type: 'TXT' | 'MX' | 'NS' }[]) => want.map((w) => ({ name: w.name, type: w.type, ok: !!values[w.key]?.length, why: values[w.key]?.length ? '' : `no ${w.type} record`, values: values[w.key] ?? [] })),
      baseline: async () => new Map(kept),
      keep: async (k: string, v: string) => { kept.set(k, v); },
    };
    let by = byKey((await collect(base({ records }), { slow: true, at: NOW })).results);
    assert.deepEqual([by['dns:ns']!.ok, by['dns:ns']!.why], [true, 'ns1.dns.example, ns2.dns.example']);
    assert.equal(kept.get('ns'), 'ns1.dns.example\nns2.dns.example', 'sorted, a line each');
    values = { mx: ['10 feedback.example.net'], ns: ['ns1.dns.example', 'ns2.dns.example'] };
    by = byKey((await collect(base({ records }), { slow: true, at: NOW })).results);
    assert.equal(by['dns:ns']!.ok, true, 'the same in another order');
    values = { ns: ['a.other.example'] };
    by = byKey((await collect(base({ records }), { slow: true, at: NOW })).results);
    assert.deepEqual([by['dns:ns']!.ok, by['dns:ns']!.why], [false, 'changed: now a.other.example; it was ns1.dns.example, ns2.dns.example']);
    assert.deepEqual([by['dns:mx']!.ok, by['dns:mx']!.why], [false, 'no MX record (it was 10 feedback.example.net)']);
    assert.equal(kept.get('ns'), 'ns1.dns.example\nns2.dns.example', 'a change is never kept by itself');
    const down = await collect(base({ records: { ...records, read: async () => { throw new Error('the routing helper is not running'); } } }), { slow: true, at: NOW });
    assert.ok(down.unread.has('dns'));
    assert.match(byKey(down.results)['panel:records']!.why, /didn't answer/);
  });
});

describe('other addresses, the registration and the watchdog (step 3)', () => {
  const NOW = 1_790_500_000;
  const want = [{ key: 'g', name: 'g.example.net', path: '/' }, { key: 'p', name: 'p.example.net', path: '/login' }];
  const got = (over: Record<string, unknown> = {}) => ({
    name: 'g.example.net', path: '/', via: 'here' as const, dns: { ok: true, why: 'points here' },
    cert: { ok: true, why: '', covers: true, daysLeft: 60, notAfter: NOW + 60 * 86400, names: ['g.example.net'] }, answers: { ok: true, why: 'answers 200', status: 200 }, ...over,
  });
  const base = (over: Partial<Sources> = {}): Sources => ({
    domain: async () => ({ name: 'example.org', front: 'direct' }), hosts: async () => [], check: async () => [], services: null, pieces: [], ...over,
  });
  const byKey = (results: Result[]) => Object.fromEntries(results.map((x) => [x.key, x]));

  it('an address that became a host (Gonsalves\'s, taken over: docs/domains-hosts-plan.md 7-5) is a host now, not asked twice', async () => {
    let asked: string[] = [];
    const { results } = await collect(base({
      hosts: async () => [{ name: '@', with_www: false, enabled: true, domain: 'g.example.net', front: 'direct' }],
      check: async () => [{ name: 'g.example.net', dns: { ok: true, why: '' }, cert: { ok: true, why: '' }, answers: { ok: true, why: '' } }],
      urls: { want, check: async (w) => { asked = w.map((x) => x.name); return [got({ name: 'p.example.net', path: '/login' })]; } },
    }), { at: NOW });
    assert.deepEqual(asked, ['p.example.net']);
    const by = byKey(results);
    assert.equal(by['url:g'], undefined);
    assert.equal(by['host:g.example.net']!.ok, true);
    assert.equal(by['url:p']!.ok, true);
  });

  it('each address every round: answers, through Cloudflare or here, its certificate days judged as the certs group\'s', async () => {
    const { results } = await collect(base({ urls: { want, check: async () => [got(), got({ name: 'p.example.net', path: '/login', via: 'cloudflare', cert: { ok: true, why: '', covers: true, daysLeft: 10, names: [] } })] } }), { at: NOW });
    const by = byKey(results);
    assert.deepEqual([by['url:g']!.ok, !!by['url:g']!.warn, by['url:g']!.why, by['url:g']!.group, by['url:g']!.subject], [true, false, 'answers 200, certificate: 60 day(s) left', 'other', 'g.example.net']);
    assert.deepEqual([by['url:p']!.ok, by['url:p']!.warn, by['url:p']!.why], [true, true, 'answers 200 through Cloudflare, certificate: 10 day(s) left']);
    assert.equal(by['panel:urls']!.ok, true);
    const late = await collect(base({ urls: { want: want.slice(0, 1), check: async () => [got({ cert: { ok: false, why: '', covers: true, daysLeft: 3 } })] } }), { at: NOW });
    assert.equal(byKey(late.results)['url:g']!.ok, false);
  });

  it('what fails is said: a 5xx, DNS elsewhere, a certificate for another name, not checked; the helper not answering leaves the group', async () => {
    const { results } = await collect(base({ urls: { want, check: async () => [got({ answers: { ok: false, why: 'answers 502', status: 502 } })] } }), { at: NOW });
    const by = byKey(results);
    assert.deepEqual([by['url:g']!.ok, by['url:g']!.why], [false, 'answers 502']);
    assert.deepEqual([by['url:p']!.ok, by['url:p']!.why], [false, 'not checked']);
    const dns = await collect(base({ urls: { want: want.slice(0, 1), check: async () => [got({ via: null, dns: { ok: false, why: 'points elsewhere: 203.0.113.5' } })] } }), { at: NOW });
    assert.equal(byKey(dns.results)['url:g']!.why, 'points elsewhere: 203.0.113.5');
    const cert = await collect(base({ urls: { want: want.slice(0, 1), check: async () => [got({ cert: { ok: false, why: "doesn't cover g.example.net", covers: false } })] } }), { at: NOW });
    assert.equal(byKey(cert.results)['url:g']!.why, "doesn't cover g.example.net");
    const down = await collect(base({ urls: { want, check: async () => { throw new Error('no socket'); } } }), { at: NOW });
    assert.ok(down.unread.has('other'));
    assert.equal(byKey(down.results)['panel:urls']!.ok, false);
    assert.equal(down.results.some((x) => x.group === 'other'), false);
  });

  it('the registration: hourly, its date and days; never down, whatever it says (Q4: never mailed)', async () => {
    let asked = 0;
    const src = (r: () => Promise<{ domain: string; ok: boolean; why: string; expires: number | null }>) => base({ registration: async () => { asked++; return r(); } });
    const quick = await collect(src(async () => ({ domain: 'example.org', ok: true, why: '', expires: NOW })), { at: NOW });
    assert.equal(asked, 0);
    assert.ok(quick.unread.has('domain'));
    const { results } = await collect(src(async () => ({ domain: 'example.org', ok: true, why: '', expires: NOW + 400 * 86400 })), { at: NOW, slow: true });
    const reg = byKey(results)['domain:registration']!;
    assert.deepEqual([reg.ok, reg.warn, reg.label, reg.group], [true, undefined, 'Registration: example.org', 'domain']);
    assert.match(reg.why, /^registered until \d{4}-\d{2}-\d{2} \(400 day\(s\)\)$/);
    for (const r of [async () => ({ domain: 'example.org', ok: true, why: '', expires: NOW - 86400 }), async () => ({ domain: 'example.org', ok: false, why: 'the registry didn\'t answer', expires: null }), async () => { throw new Error('no socket'); }]) {
      const x = byKey((await collect(src(r), { at: NOW, slow: true })).results)['domain:registration']!;
      assert.deepEqual([x.ok, !!x.warn], [true, false], x.why);
    }
    // so a round never mails it
    const rows = walk([[{ ...reg, why: 'not read: x' }], [{ ...reg, why: 'not read: x' }], [reg]]);
    assert.equal(rows.changes.length, 0);
  });

  it('the watchdog: two failures in a row mail once, then once a day; right again mails once', () => {
    const bad = { answers: 'it doesn\'t answer: ECONNREFUSED', round: null };
    const fine = { answers: null, round: null };
    let s = FRESH;
    const run = (r: typeof bad | typeof fine, at: number) => { const d = decide(s, r, at, 'x.org'); s = d.next; return d.notice; };
    assert.equal(run(fine, NOW), null);
    assert.equal(run(bad, NOW), null, 'one failure (a restart) mails no one');
    assert.equal(run(fine, NOW + 600), null);
    assert.equal(run(bad, NOW + 1200), null);
    const n = run(bad, NOW + 1800);
    assert.equal(n?.subject, 'x.org: the panel is down');
    assert.match(n!.lines[0]!, /ECONNREFUSED/);
    assert.equal(run(bad, NOW + 2400), null);
    assert.equal(run(bad, NOW + 1800 + 86_399), null);
    assert.equal(run(bad, NOW + 1800 + 86_400)?.subject, 'x.org: the panel is still down');
    const back = run(fine, NOW + 90_000);
    assert.equal(back?.subject, 'x.org: the panel is back');
    assert.deepEqual(s, FRESH);
    assert.equal(run(fine, NOW + 90_600), null);
  });

  it('the watchdog reads the round\'s file: under 15 minutes old, else how old; none, or unreadable, said', () => {
    assert.equal(roundAge(JSON.stringify({ at: NOW - 600 }), NOW), null);
    assert.equal(roundAge(JSON.stringify({ at: NOW - 1200 }), NOW), 'its last round of checks ran 20 minutes ago');
    assert.equal(roundAge(null, NOW), 'no round of checks recorded yet');
    assert.equal(roundAge('{', NOW), 'its round file can\'t be read');
    assert.equal(roundAge('{"at":"x"}', NOW), 'its round file can\'t be read');
  });
});
