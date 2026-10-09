// The software helper (src/apps/, docs/apps-plan.md phase 1): adopting the
// WordPress that is already there, and reading how it is doing -- over a real
// socket, against a folder laid out like the server (its passwd, WordPress's
// files and backups, the containers' control groups, nginx's placement line).
// Only the request through nginx is stood in for; realProbe has its own test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ADOPTED_WORDPRESS, adoptWordPress } from '@panel/apps/apps/adopt';
import { callApps, AppsCallError } from '@panel/apps/apps/client';
import { answerSoon, realProbe, type Host, type ProbeTarget } from '@panel/apps/apps/host';
import { addressOf, createOps, parsePlacement, type Status } from '@panel/apps/apps/ops';
import { readState, STATE_FILE, writeState } from '@panel/apps/apps/record';
import { createAppsServer } from '@panel/apps/apps/service';
import { VERSION_PHP, wordpressServer } from './apps-world.ts';

const NOW = 1_790_000_000;

let dir: string;
let root: string;
let state: string;
let sock: string;
let clock = NOW;
let asked: ProbeTarget[] = [];
let answer: { status: number | null; error: string | null } = { status: 200, error: null };
let server: ReturnType<typeof createAppsServer>;
let world: ReturnType<typeof wordpressServer>;
const put = (p: string, text: string) => world.put(p, text);
const container = (unit: string, running: boolean) => world.container(unit, running);
const placement = (line: string) => world.placement(line);
const layServer = () => world.lay();

const host = (): Host => ({
  root, domain: 'pammy.org', nginx: { host: '127.0.0.1', port: 443 },
  probe: async (t) => { asked.push(t); return { ...answer, ms: 12 }; },
  now: () => clock,
});
const ask = <T>(req: Record<string, unknown>) => callApps<T>(sock, req);
const status = () => ask<Status>({ op: 'status', id: 'blog' });

// every file under the fake server, and what is in it: adopting must leave all of it alone
function fingerprint(): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out.push(`${p.slice(root.length)} ${s.mode.toString(8)} ${s.mtimeMs} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(root);
  return out.join('\n');
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pammy-apps-test-'));
  root = join(dir, 'root');
  world = wordpressServer(root);
  state = join(dir, 'state');
  sock = join(dir, 'apps.sock');
  server = createAppsServer(createOps(host(), state));
  await new Promise<void>((r) => server.listen(sock, r));
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  layServer();
  rmSync(state, { recursive: true, force: true });
  asked = [];
  answer = { status: 200, error: null };
  clock += 3600;      // past any sizes kept from the test before
});

describe('placements', () => {
  it('reads the placement line the WordPress scripts write, and nothing else', () => {
    assert.deepEqual(parsePlacement('subdomain blog\n'), { mode: 'subdomain', name: 'blog' });
    assert.deepEqual(parsePlacement('path my-blog'), { mode: 'path', name: 'my-blog' });
    assert.deepEqual(parsePlacement('root'), { mode: 'root', name: null });
    assert.deepEqual(parsePlacement('off'), { mode: 'off', name: null });
    for (const bad of [null, '', 'subdomain', 'subdomain Blog', 'subdomain ../x', 'path a b', 'root x', 'sideways blog', 'subdomain -blog']) {
      assert.equal(parsePlacement(bad), null, String(bad));
    }
  });
  it('turns each into the address visitors use', () => {
    assert.equal(addressOf({ mode: 'subdomain', name: 'blog' }, 'pammy.org'), 'https://blog.pammy.org/');
    assert.equal(addressOf({ mode: 'path', name: 'blog' }, 'pammy.org'), 'https://pammy.org/blog/');
    assert.equal(addressOf({ mode: 'root', name: null }, 'pammy.org'), 'https://pammy.org/');
    assert.equal(addressOf({ mode: 'off', name: null }, 'pammy.org'), null);
  });
});

describe('adopting the WordPress that is already there (A1)', () => {
  it('writes the record, and only the record', async () => {
    const before = fingerprint();
    const r = await adoptWordPress({ root, domain: 'pammy.org' }, state, NOW);
    assert.equal(r.done, 'adopted');
    assert.equal(fingerprint(), before, 'nothing of WordPress changed');
    const s = readState(state);
    assert.equal(s.apps.length, 1);
    const a = s.apps[0]!;
    assert.deepEqual({ ...a, installedAt: 0 }, { ...ADOPTED_WORDPRESS, units: { ...ADOPTED_WORDPRESS.units }, installedAt: 0, adoptedAt: NOW });
    assert.ok(a.installedAt > 0 && a.installedAt <= Math.ceil(Date.now() / 1000), 'installed when its home was made');
    assert.equal(r.done === 'adopted' && r.address, 'https://blog.pammy.org/');
    assert.equal(statSync(join(state, STATE_FILE)).mode & 0o777, 0o600, 'root 600');
    assert.equal(statSync(state).mode & 0o777, 0o700);
  });

  it('is safe to run again: the second time it says so and writes nothing', async () => {
    await adoptWordPress({ root, domain: 'pammy.org' }, state, NOW);
    const first = readFileSync(join(state, STATE_FILE), 'utf8');
    const r = await adoptWordPress({ root, domain: 'pammy.org' }, state, NOW + 999);
    assert.equal(r.done, 'already');
    assert.equal(readFileSync(join(state, STATE_FILE), 'utf8'), first);
  });

  it('a dry run writes nothing at all', async () => {
    const r = await adoptWordPress({ root, domain: 'pammy.org' }, state, NOW, true);
    assert.equal(r.done, 'adopted');
    assert.throws(() => statSync(join(state, STATE_FILE)));
  });

  it('adopts nothing where WordPress was never installed', async () => {
    put('/etc/passwd', 'root:x:0:0:root:/root:/bin/bash\n');
    const r = await adoptWordPress({ root, domain: 'pammy.org' }, state, NOW);
    assert.deepEqual(r, { done: 'nothing', why: 'no svc-pammywp user (WordPress was never installed here)' });
    assert.deepEqual(readState(state).apps, []);
  });

  it('adopts nothing without a placement line or WordPress files', async () => {
    placement('sideways');
    assert.equal((await adoptWordPress({ root, domain: 'pammy.org' }, state, NOW)).done, 'nothing');
    layServer();
    rmSync(join(root, 'srv/pamela-wordpress/wp-includes/version.php'));
    assert.equal((await adoptWordPress({ root, domain: 'pammy.org' }, state, NOW)).done, 'nothing');
    assert.deepEqual(readState(state).apps, []);
  });

  it('never writes over another app of the same name', async () => {
    writeState(state, { version: 1, apps: [{ ...ADOPTED_WORDPRESS, units: { ...ADOPTED_WORDPRESS.units }, user: 'svc-app-blog', installedAt: NOW, adoptedAt: null }] });
    const first = readFileSync(join(state, STATE_FILE), 'utf8');
    await assert.rejects(adoptWordPress({ root, domain: 'pammy.org' }, state, NOW), /already has an app called "blog"/);
    assert.equal(readFileSync(join(state, STATE_FILE), 'utf8'), first);
  });
});

describe('the helper, over its socket', () => {
  beforeEach(async () => { await adoptWordPress({ root, domain: 'pammy.org' }, state, NOW); });

  it('lists what is installed', async () => {
    const r = await ask<{ apps: unknown[] }>({ op: 'list', actor: 'test' });
    assert.deepEqual(r.apps, [{
      id: 'blog', kind: 'wordpress', kindName: 'WordPress', placement: { mode: 'subdomain', name: 'blog' },
      address: 'https://blog.pammy.org/', adminAddress: 'https://blog.pammy.org/wp-admin/', version: '6.8.2', running: true, setup: null, deleted: null,
    }]);
    assert.deepEqual(asked, [], 'a list never asks the site anything');
  });

  it('lists nothing before anything is adopted', async () => {
    rmSync(state, { recursive: true, force: true });
    assert.deepEqual(await ask({ op: 'list' }), { apps: [], wholeSite: true });
  });

  it('says how it is doing, in full', async () => {
    const s = await status();
    assert.equal(s.state, 'running');
    assert.deepEqual(s.problems, []);
    assert.equal(s.siteAddress, 'https://blog.pammy.org');
    assert.equal(s.filesPath, '/pamela/wordpress', 'where she finds the files, not /srv');
    assert.equal(s.adoptedAt, NOW);
    assert.deepEqual(s.containers, [
      { role: 'web', unit: 'pammywp-web', running: true, memory: 46_419_968 },
      { role: 'db', unit: 'pammywp-db', running: true, memory: 122_650_624 },
    ]);
    assert.deepEqual({ ...s.answering, checkedAt: 0 }, { ok: true, status: 200, ms: 12, url: 'https://blog.pammy.org/', error: null, checkedAt: 0 });
    assert.deepEqual(s.disk, { files: 5000 + VERSION_PHP.length, database: 7000, backups: 100 + 300 + 23 + 110 + 310 + 120, measuredAt: clock });
    assert.deepEqual(s.backups, { count: 2, last: { at: Date.UTC(2026, 8, 22, 3, 45, 1) / 1000, bytes: 420 } }, 'the half backup of the 23rd does not count');
    assert.deepEqual(s.server, { memoryTotal: 8_000_000 * 1024, memoryAvailable: 3_000_000 * 1024 });
  });

  it('asks nginx on this machine for the address visitors use', async () => {
    await status();
    assert.deepEqual(asked, [{ url: 'https://blog.pammy.org/', connect: { host: '127.0.0.1', port: 443, tls: true }, timeoutMs: 8000 }]);
    asked = [];
    placement('path blog');
    assert.equal((await status()).address, 'https://pammy.org/blog/');
    assert.equal(asked[0]!.url, 'https://pammy.org/blog/');
    asked = [];
    placement('root');
    assert.equal((await status()).address, 'https://pammy.org/');
    assert.equal(asked[0]!.url, 'https://pammy.org/');
  });

  it('served nowhere: offline, and the container itself is asked, so offline and broken differ', async () => {
    placement('off');
    const s = await status();
    assert.equal(s.state, 'offline');
    assert.equal(s.address, null);
    assert.deepEqual(asked, [{ url: 'https://blog.pammy.org/', connect: { host: '127.0.0.1', port: 3043, tls: false }, timeoutMs: 8000 }]);
    assert.equal(s.answering?.url, null);
    answer = { status: null, error: 'ECONNREFUSED' };
    const t = await status();
    assert.equal(t.state, 'trouble');
    assert.deepEqual(t.problems, ['It did not answer when the panel opened it.']);
  });

  it('an error page is trouble, in her words', async () => {
    answer = { status: 502, error: null };
    const s = await status();
    assert.equal(s.state, 'trouble');
    assert.deepEqual(s.problems, ['It answered with an error (502) when the panel opened it.']);
    answer = { status: 404, error: null };
    assert.deepEqual((await status()).problems, ['It answered with an error (404) when the panel opened it.']);
    answer = { status: 301, error: null };
    assert.equal((await status()).state, 'running', 'a redirect to its own address is an answer');
  });

  it('one container down is trouble; both down is stopped', async () => {
    container('pammywp-db', false);
    let s = await status();
    assert.equal(s.state, 'trouble');
    assert.deepEqual(s.problems, ['Its database is not running.']);
    assert.equal(s.running, false);
    assert.deepEqual(s.containers[1], { role: 'db', unit: 'pammywp-db', running: false, memory: null });
    container('pammywp-web', false);
    s = await status();
    assert.equal(s.state, 'stopped');
    assert.deepEqual(s.problems, ['WordPress is not running.']);
    // its whole user manager gone (no lingering, say): the same, not a crash
    rmSync(join(root, 'sys'), { recursive: true });
    assert.equal((await status()).state, 'stopped');
  });

  it('a placement line it cannot read is said, not guessed', async () => {
    placement('sideways blog');
    const s = await status();
    assert.equal(s.placement, null);
    assert.equal(s.address, null);
    assert.equal(s.answering, null);
    assert.equal(s.state, 'trouble');
    assert.deepEqual(s.problems, ['Its address setting could not be read, so the panel does not know where it is served.']);
  });

  it('keeps sizes for ten minutes, then measures again', async () => {
    const first = (await status()).disk;
    put('/srv/pamela-wordpress/wp-content/uploads/2026/09/big.jpg', 'q'.repeat(10_000));
    clock += 599;
    assert.equal((await status()).disk.files, first.files);
    clock += 2;
    assert.equal((await status()).disk.files, first.files! + 10_000);
  });

  it('refuses what it was not built to do, whatever is in the request', async () => {
    await assert.rejects(ask({ op: 'status', id: 'nope' }), (e: AppsCallError) => e.code === 'not-found');
    for (const id of ['../blog', 'Blog', '', 'blog/x', 12, null]) {
      await assert.rejects(ask({ op: 'status', id }), (e: AppsCallError) => e.code === 'not-found', String(id));
    }
    for (const op of ['remove', 'start', 'stop', 'adopt', 'exec', 'userdel', '__proto__', 'toString']) {
      await assert.rejects(ask({ op, id: 'blog' }), (e: AppsCallError) => e.code === 'invalid', op);
    }
    // extra fields are not read: a request can never name a path
    const s = await ask<Status>({ op: 'status', id: 'blog', files: '/etc', placementFile: '/etc/shadow', user: 'root' });
    assert.equal(s.filesPath, '/pamela/wordpress');
    assert.equal(s.placement?.mode, 'subdomain');
  });

  it('stops at a damaged record with a plain reason', async () => {
    const good = readFileSync(join(state, STATE_FILE), 'utf8');
    for (const bad of [
      '{not json',
      JSON.stringify({ version: 2, apps: [] }),
      good.replace('"/srv/pamela-wordpress"', '"srv/relative"'),
      good.replace('"/srv/pamela-wordpress"', '"/srv/../etc"'),
      good.replace('"svc-pammywp"', '"root"'),
      good.replace('"wordpress"', '"drupal"'),
      good.replace('"pammywp-web"', '"../../x"'),
      JSON.stringify({ version: 1, apps: [JSON.parse(good).apps[0], JSON.parse(good).apps[0]] }),
    ]) {
      writeFileSync(join(state, STATE_FILE), bad);
      await assert.rejects(ask({ op: 'list' }), (e: AppsCallError) => e.code === 'unavailable' && /record of installed software/.test(e.message), bad.slice(0, 60));
    }
  });
});

describe('a new address, asked until it answers (answerSoon, 8-7d)', () => {
  const hostAnswering = (statuses: (number | null)[]) => {
    const asked: ProbeTarget[] = [];
    const h: Host = { root: '/', domain: 'pammy.org', nginx: { host: '127.0.0.1', port: 443 }, now: () => 0,
      probe: async (t) => { asked.push(t); const status = statuses[Math.min(asked.length - 1, statuses.length - 1)]!; return { status, ms: 1, error: status === null ? 'ECONNREFUSED' : null }; } };
    return { h, asked };
  };
  it('asks through nginx every 5 seconds until it answers under 400', async () => {
    const { h, asked } = hostAnswering([404, null, 200]);
    const slept: number[] = [];
    const r = await answerSoon(h, 'https://journal.pammy.org/', async (ms) => { slept.push(ms); });
    assert.equal(r.status, 200);
    assert.deepEqual(slept, [5000, 5000]);
    assert.deepEqual(asked[0], { url: 'https://journal.pammy.org/', connect: { host: '127.0.0.1', port: 443, tls: true }, timeoutMs: 8000 });
  });
  it('gives up after 18 tries (90 seconds) with the last answer', async () => {
    const { h, asked } = hostAnswering([404]);
    const r = await answerSoon(h, 'https://journal.pammy.org/', async () => {});
    assert.deepEqual([r.status, asked.length], [404, 18]);
  });
});

describe('the request through nginx (realProbe)', () => {
  it('reports the status as it came, redirects included, without following them', async () => {
    const seen: { host?: string; url?: string }[] = [];
    const web = createHttpServer((req, res) => {
      seen.push({ host: req.headers.host, url: req.url });
      if (req.url === '/blog/') res.writeHead(301, { location: 'https://pammy.org/blog' }).end();
      else if (req.url === '/slow/') setTimeout(() => res.writeHead(200).end(), 2000);
      else res.writeHead(200).end('<h1>hello</h1>');
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    const port = (web.address() as { port: number }).port;
    try {
      const at = { host: '127.0.0.1', port, tls: false };
      assert.equal((await realProbe({ url: 'https://blog.pammy.org/', connect: at, timeoutMs: 3000 })).status, 200);
      assert.equal((await realProbe({ url: 'https://pammy.org/blog/', connect: at, timeoutMs: 3000 })).status, 301);
      assert.deepEqual(seen, [{ host: 'blog.pammy.org', url: '/' }, { host: 'pammy.org', url: '/blog/' }], 'asked as the visitor would');
      const slow = await realProbe({ url: 'https://pammy.org/slow/', connect: at, timeoutMs: 200 });
      assert.deepEqual([slow.status, slow.error], [null, 'no answer in time']);
      const closed = await realProbe({ url: 'https://pammy.org/', connect: { host: '127.0.0.1', port: 9, tls: false }, timeoutMs: 1000 });
      assert.deepEqual([closed.status, closed.error], [null, 'ECONNREFUSED']);
    } finally {
      web.closeAllConnections();
      await new Promise<void>((r) => web.close(() => r()));
    }
  });
});
