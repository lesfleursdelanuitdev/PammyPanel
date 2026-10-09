// S2 (docs/security-performance-review.md S2, docs/s2-plan.md): the gate's own door to the
// database helper. The internet-facing gate used to share the panel's socket, and through it
// could ask for anything: drop a database, change a schema, make a login, reset a password.
// Now it has a socket of its own, served by a helper process that answers only the row ops
// the gate really sends; the panel's socket is the panel's alone.
//
// Written before the fix (master plan rule 12): every test here failed on main 502ffbe.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { DatabaseFacts, Driver } from '@panel/studio/pammydb/driver';
import { callPammyDb, PammyDbCallError } from '@panel/studio/pammydb/client';
import { ALL_OPS, createPammyDbServer, GATE_OPS } from '@panel/studio/pammydb/service';
import { PROFILE } from '@panel/pammy/profile';
import { PROFILE as LFDLN } from '@panel/lfdln/profile';
import { LFDLN_HELPER } from '@panel/lfdln/studio-site';

const ROOT = join(import.meta.dirname, '..');
const DEPLOY = join(ROOT, 'deploy');

// A driver that writes down every call it gets: a refused op must never reach it.
function spyDriver(engine: 'postgres' | 'mariadb', calls: string[]): Driver {
  const facts = (name: string): DatabaseFacts => ({ engine, name, bytes: 1, tables: 1, owner: null, protectedName: false, system: false });
  const seen = <T>(what: string, v: T) => async () => { calls.push(`${engine}.${what}`); return v; };
  return {
    engine,
    state: seen('state', { engine, ok: true, version: null, message: null }),
    list: seen('list', [facts('recipes')]),
    create: async (name) => { calls.push(`${engine}.create`); return facts(name); },
    drop: seen('drop', undefined),
    size: seen('size', { bytes: 1, tables: 1 }),
    introspect: async (database) => { calls.push(`${engine}.introspect`); return { engine, database, tables: [], notes: [] }; },
    apply: seen('apply', { applied: 0, failed: null, rolledBack: false }),
    listUsers: seen('listUsers', []),
    createUser: async (name) => { calls.push(`${engine}.createUser`); return { engine, name, host: null, canLogin: true, reserved: false, serverWide: false }; },
    dropUser: seen('dropUser', undefined),
    setPassword: seen('setPassword', undefined),
    accessOf: seen('accessOf', []),
    grant: seen('grant', undefined),
    revoke: seen('revoke', undefined),
    listRows: seen('listRows', { items: [], total: 0 }),
    getRow: seen('getRow', null),
    insertRow: seen('insertRow', { id: 1 }),
    updateRow: seen('updateRow', null),
    deleteRow: seen('deleteRow', false),
    setLinks: seen('setLinks', 0),
    close: async () => {},
  };
}

// A request for each op that would get past the op layer's own checks, so a refusal can
// only have come from the door.
const REQUESTS: Record<string, Record<string, unknown>> = {
  'list-databases': {},
  'create-database': { engine: 'postgres', name: 'notes' },
  'drop-database': { engine: 'postgres', name: 'recipes' },
  'database-size': { engine: 'postgres', name: 'recipes' },
  'adopt-database': { engine: 'postgres', name: 'recipes' },
  'list-users': {},
  'create-user': { engine: 'postgres', user: 'zz_reader', password: 'VerifyVerifyVerify12' },
  'drop-user': { engine: 'postgres', user: 'zz_reader' },
  'reset-password': { engine: 'postgres', user: 'zz_reader', password: 'VerifyVerifyVerify12' },
  'user-access': { engine: 'postgres', user: 'zz_reader', databases: ['recipes'] },
  'grant-access': { engine: 'postgres', user: 'zz_reader', database: 'recipes', role: 'admin' },
  'revoke-access': { engine: 'postgres', user: 'zz_reader', database: 'recipes' },
  'project-database': { engine: 'postgres', name: 'proj_x', owner: 'proj_x_owner', ownerPassword: 'VerifyVerifyVerify12', app: 'proj_x_app', appPassword: 'VerifyVerifyVerify12' },
  'introspect': { engine: 'postgres', name: 'recipes' },
  'preview-schema': { engine: 'postgres', name: 'recipes', patch: [] },
  'apply-schema': { engine: 'postgres', name: 'recipes', patch: [], expect: null },
  'list-rows': { engine: 'postgres', name: 'recipes', query: { table: 'recipes', columns: ['id'], limit: 1, offset: 0 } },
  'get-row': { engine: 'postgres', name: 'recipes', table: 'recipes', columns: ['id'], where: { id: 1 } },
  'insert-row': { engine: 'postgres', name: 'recipes', table: 'recipes', values: { title: 'x' }, back: ['id'] },
  'update-row': { engine: 'postgres', name: 'recipes', table: 'recipes', values: { title: 'x' }, where: { id: 1 }, back: ['id'] },
  'delete-row': { engine: 'postgres', name: 'recipes', table: 'recipes', where: { id: 1 } },
  'set-links': { engine: 'postgres', name: 'recipes', table: 'recipe_tags', here: 'recipe_id', id: 1, there: 'tag_id', ids: [1] },
};

const errorCode = async (p: Promise<unknown>) => {
  try { await p; return 'answered'; } catch (e) { if (e instanceof PammyDbCallError) return e.code; throw e; }
};
// the door's own refusal, as against the op layer's (pammy.org has no projects, say)
const DOOR = /gate's door to the database helper answers row requests only/;
const doorRefused = async (p: Promise<unknown>) => {
  try { await p; return false; } catch (e) { if (e instanceof PammyDbCallError) return e.code === 'not-allowed' && DOOR.test(e.message); throw e; }
};

describe("the gate's door to the database helper (S2)", () => {
  let dir: string;
  const calls: string[] = [];
  let gateSock: string;
  let panelSock: string;
  let gateServer: ReturnType<typeof createPammyDbServer>;
  let panelServer: ReturnType<typeof createPammyDbServer>;
  const logged: string[] = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pammydb-gate-door-'));
    gateSock = join(dir, 'gate.sock');
    panelSock = join(dir, 'panel.sock');
    const drivers = { postgres: spyDriver('postgres', calls), mariadb: spyDriver('mariadb', calls) };
    gateServer = createPammyDbServer(drivers, (l) => logged.push(l), 'gate');
    panelServer = createPammyDbServer(drivers, () => {});
    await new Promise<void>((r) => gateServer.listen(gateSock, r));
    await new Promise<void>((r) => panelServer.listen(panelSock, r));
  });
  after(async () => {
    await new Promise<void>((r) => gateServer.close(() => r()));
    await new Promise<void>((r) => panelServer.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('knows every op the helper has, and the gate gets only row ops', () => {
    assert.deepEqual([...ALL_OPS].sort(), Object.keys(REQUESTS).sort(), 'a request above for every op');
    assert.deepEqual([...GATE_OPS].sort(), ['delete-row', 'get-row', 'insert-row', 'list-rows', 'update-row']);
    for (const op of GATE_OPS) assert.ok(ALL_OPS.includes(op), op);
    // ALL_OPS is what handle() really answers: an op added there is added here too
    const src = readFileSync(join(ROOT, 'packages/studio/src/pammydb/service.ts'), 'utf8');
    assert.deepEqual([...src.matchAll(/^\s+case '([a-z-]+)':/gm)].map((m) => m[1]).sort(), [...ALL_OPS].sort());
  });

  it('refuses everything else at the door, before any engine is asked', async () => {
    for (const op of ALL_OPS.filter((o) => !GATE_OPS.includes(o))) {
      calls.length = 0;
      assert.equal(await doorRefused(callPammyDb(gateSock, { op, actor: 'api', ...REQUESTS[op] })), true, op);
      assert.deepEqual(calls, [], `${op} reached an engine`);
    }
    // ...and an op nobody has, the same as on the panel's door
    assert.equal(await errorCode(callPammyDb(gateSock, { op: 'drop-everything' })), 'invalid');
    // the journal says which door refused it
    assert.ok(logged.some((l) => /op=drop-database .*refused=not-allowed/.test(l)), logged.join('\n'));
  });

  it("answers the gate's row ops as before", async () => {
    for (const op of GATE_OPS) {
      calls.length = 0;
      assert.equal(await errorCode(callPammyDb(gateSock, { op, actor: 'api', ...REQUESTS[op] })), 'answered', op);
      assert.equal(calls.length, 1, `${op}: ${calls.join(', ')}`);
    }
  });

  it("the panel's door is unchanged: every op", async () => {
    for (const op of ALL_OPS) {
      calls.length = 0;
      assert.equal(await doorRefused(callPammyDb(panelSock, { op, actor: 'panel', ...REQUESTS[op] })), false, op);
    }
    // ...and the ones the gate is refused do reach an engine there
    calls.length = 0;
    assert.equal(await errorCode(callPammyDb(panelSock, { op: 'drop-database', actor: 'panel', ...REQUESTS['drop-database'] })), 'answered');
    assert.deepEqual(calls, ['postgres.drop']);
  });
});

// Rule 5 (runtime dependencies declared): what the gate's code sends the helper is exactly
// GATE_OPS. A new op in the gate fails here until it is added there (and so reviewed);
// an op the gate stops sending fails here until it is taken out.
describe('what the gate sends the helper', () => {
  const gateFiles = (): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) out.push(p);
      }
    };
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      if (existsSync(join(ROOT, 'packages', pkg, 'src', 'gate'))) walk(join(ROOT, 'packages', pkg, 'src', 'gate'));
    }
    walk(join(ROOT, 'packages', 'gate', 'src'));
    return out;
  };

  it('is GATE_OPS, no more and no less', () => {
    const sent = new Set<string>();
    const askers: string[] = [];
    for (const f of gateFiles()) {
      const text = readFileSync(f, 'utf8');
      if (!/pammydb\/client/.test(text)) continue;
      askers.push(f.replace(`${ROOT}/`, ''));
      for (const m of text.matchAll(/\bop: '([a-z-]+)'/g)) sent.add(m[1]!);
    }
    assert.ok(askers.length >= 3, `found the gate's callers: ${askers.join(', ')}`);
    assert.deepEqual([...sent].sort(), [...GATE_OPS].sort(), askers.join(', '));
  });
});

// The units and the profiles: two doors, each its own group, the gate pointed at its own.
describe("the gate's door in the units", () => {
  const unit = (p: string) => readFileSync(join(DEPLOY, p), 'utf8');
  const key = (text: string, k: string) => [...text.matchAll(new RegExp(`^${k}=(.*)$`, 'gm'))].map((m) => m[1]);
  const sites = [
    { name: 'pammy.org', profile: PROFILE, dir: '', unit: 'pammy', gateUser: 'svc-pammygate', panelUser: 'svc-pammypanel', clients: 'pammydb-clients', app: '/opt/pammy-panel/' },
    { name: 'lfdln', profile: LFDLN, dir: 'lfdln/', unit: 'lfdln', gateUser: 'svc-lfdlngate', panelUser: 'svc-lfdlnpanel', clients: 'lfdln-pammydb-clients', app: '/opt/lfdln-panel/' },
  ] as const;

  for (const s of sites) {
    it(`${s.name}: the gate's socket is the gate's alone, served by a helper of its own`, () => {
      const sockets = s.profile.services.sockets as Record<string, string | undefined>;
      assert.ok(sockets.pammydbGate, 'the profile names the gate\'s door');
      assert.notEqual(sockets.pammydbGate, sockets.pammydb);
      const sock = unit(`${s.dir}${s.unit}-pammydb-gate.socket`);
      assert.deepEqual(key(sock, 'ListenStream'), [sockets.pammydbGate]);
      assert.deepEqual(key(sock, 'SocketUser'), ['root']);
      assert.deepEqual(key(sock, 'SocketGroup'), [s.gateUser], 'only the gate\'s own group');
      assert.deepEqual(key(sock, 'SocketMode'), ['0660']);
      assert.deepEqual(key(sock, 'Service'), [`${s.unit}-pammydb-gate.service`]);
      // the panel's door is still the clients group's
      assert.deepEqual(key(unit(`${s.dir}${s.unit}-pammydb.socket`), 'SocketGroup'), [s.clients]);

      const svc = unit(`${s.dir}${s.unit}-pammydb-gate.service`);
      const full = unit(`${s.dir}${s.unit}-pammydb.service`);
      // the same user, sandbox and passwords as the full helper: every setting line the same
      // but these four (review L2)
      const settings = (t: string) => t.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !/^(Description|Requires|After|ExecStart)=/.test(l));
      assert.deepEqual(settings(svc), settings(full));
      assert.ok(settings(svc).includes('User=' + key(full, 'User')[0]) && key(full, 'User')[0]!.startsWith('svc-'), 'runs as the studio user');
      assert.deepEqual(key(svc, 'Requires'), [`${s.unit}-pammydb-gate.socket`]);
      const exec = /^ExecStart=\S+ \S+ (\S+)$/m.exec(svc)?.[1] ?? '';
      assert.ok(exec.startsWith(s.app), exec);
      const entry = join(ROOT, exec.slice(s.app.length));
      assert.ok(existsSync(entry), `${exec} is in the release`);
      // a stable path in src/ re-exports the package's file (docs/packaging-plan.md step 2)
      const text = readFileSync(entry, 'utf8');
      const moved = /^export \* from '@panel\/studio\/(.+)';$/m.exec(text)?.[1];
      const code = moved ? readFileSync(join(ROOT, 'packages/studio/src', `${moved}.ts`), 'utf8') : text;
      assert.match(code, /startPammyDb\([A-Z_]+, process\.env, 'gate'\)/, 'the entry starts the gate\'s door');
      assert.notEqual(exec, /^ExecStart=\S+ \S+ (\S+)$/m.exec(full)?.[1]);
    });

    it(`${s.name}: the gate asks its own door, and is no longer in the panel's group`, () => {
      const gate = unit(`${s.dir}${s.unit}-gate.service`);
      assert.ok(gate.includes(`Environment=GATE_PAMMYDB_SOCKET=${(s.profile.services.sockets as Record<string, string>).pammydbGate}\n`));
      const sh = unit(s.dir ? 'lfdln/install-lfdln.sh' : 'install-panel.sh');
      // every loop that adds users to the clients group names the panel's user only
      const adds = [...sh.matchAll(/for u in ([^;]+); do\n\s+if ! id -nG "\$u" \| tr ' ' '\\n' \| grep -qx "\$PAMMYDB_CLIENTS"/g)].map((m) => m[1]);
      assert.equal(adds.length, 1, 'one place adds to the clients group');
      assert.ok(!/GATE/.test(adds[0]!), `the clients group loop: ${adds[0]}`);
      // ...and the gate's user is taken out of it, before the gate restarts onto its own door
      assert.match(sh, /gpasswd -d "\$GATEU?" "\$PAMMYDB_CLIENTS"/);
      assert.ok(sh.includes(`${s.unit}-pammydb-gate.socket`), 'the installer installs the gate\'s door');
    });
  }
});

// The file systemd runs, for real: the gate's entry refuses a non-row op even with nothing
// behind it, and gets as far as the engine with a row op. Ports nothing listens on.
describe("the gate's helper process", () => {
  const entries = [
    { site: 'pammy.org', file: join(ROOT, 'src', 'pammydb', 'main-gate.ts'), name: 'pammy-pammydb' },
    { site: 'lfdln', file: join(ROOT, 'sites', 'lfdln', 'src', 'helpers', 'pammydb-gate.ts'), name: 'lfdln-pammydb' },
  ];
  for (const en of entries) {
    it(`${en.site}: refuses drop-database and list-databases, passes list-rows on to the engine`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pammydb-gate-main-'));
      const sock = join(dir, 'gate.sock');
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', en.file], {
        env: {
          ...process.env, PAMMYDB_SOCKET: sock,
          PAMMYDB_POSTGRES_PORT: '5399', PAMMYDB_MARIADB_PORT: '3399',
          PAMMYDB_POSTGRES_PASSWORD: 'x', PAMMYDB_MARIADB_PASSWORD: 'x',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
      child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
      try {
        for (let i = 0; !existsSync(sock); i++) {
          assert.ok(i < 400, `it never listened: ${out}`);
          await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal((statSync(sock).mode & 0o777), 0o600);
        assert.equal(await errorCode(callPammyDb(sock, { op: 'drop-database', engine: 'postgres', name: 'recipes', actor: 'test' })), 'not-allowed');
        assert.equal(await errorCode(callPammyDb(sock, { op: 'list-databases', actor: 'test' })), 'not-allowed');
        assert.equal(await errorCode(callPammyDb(sock, { op: 'reset-password', engine: 'postgres', user: 'zz', password: 'VerifyVerifyVerify12', actor: 'test' })), 'not-allowed');
        // a row op is let through: it fails only because no engine listens on 5399
        assert.equal(await errorCode(callPammyDb(sock, { op: 'list-rows', engine: 'postgres', name: 'recipes', actor: 'test', query: { table: 'recipes', columns: ['id'], limit: 1, offset: 0 } })), 'unavailable');
        assert.match(out, new RegExp(`${en.name}.*the gate's door: row ops only`));
        child.kill('SIGTERM');
        const [status] = await once(child, 'exit') as [number | null];
        assert.equal(status, 0);
      } finally {
        child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// Review HIGH-1: the installers' door check must work under `set -euo pipefail`, where the
// command's exit 1 (it was refused, which is the answer wanted) used to fail the check.
describe("the installers' door check (gate_door_refuses)", () => {
  const run = (body: string) => spawnSync('bash', ['-c', `set -euo pipefail\nsource ${join(DEPLOY, 'gate-door.sh')}\n${body}`], { encoding: 'utf8' }).status;
  const REFUSED = `echo "not-allowed: The gate's door to the database helper answers row requests only."; exit 1`;

  it('is true for the door\'s refusal (exit 1), under pipefail', () => {
    assert.equal(run(`stub() { ${REFUSED}; }\ngate_door_refuses stub && echo yes`), 0);
    // what it replaces fails the same stub: the review's finding, kept as proof
    assert.equal(run(`stub() { ${REFUSED}; }\nstub 2>&1 | grep -q "^not-allowed: The gate's door"`), 1);
  });

  it('is false for an answer, another refusal or nothing at all', () => {
    assert.equal(run(`stub() { echo '{"databases":[]}'; }\ngate_door_refuses stub`), 1);
    assert.equal(run(`stub() { echo "not-allowed: That database is protected."; exit 1; }\ngate_door_refuses stub`), 1);
    assert.equal(run(`stub() { echo "unavailable: The database helper isn't answering."; exit 2; }\ngate_door_refuses stub`), 1);
    assert.equal(run('gate_door_refuses false'), 1);
  });

  it('is what both installers use, and no door check is piped', () => {
    for (const f of ['install-panel.sh', 'lfdln/install-lfdln.sh']) {
      const sh = readFileSync(join(DEPLOY, f), 'utf8');
      assert.match(sh, /^source "\$(D|P\/deploy)\/gate-door\.sh"/m, f);
      assert.match(sh, /gate_door_refuses runuser -u "\$GATEU?"/, f);
      assert.doesNotMatch(sh, /\| *grep -q "\^not-allowed/, f);
    }
  });
});

// Review MEDIUM-1: the probes verify sends the gate's door are refused by the op layer even at
// the panel's door, so a door wrongly open would still change nothing.
describe("verify's probes of the gate's door", () => {
  const probes = (file: string) => {
    const sh = readFileSync(join(DEPLOY, file), 'utf8');
    const block = /for req in ('\{"op":"drop-database".*?); do/s.exec(sh)?.[1] ?? '';
    return [...block.matchAll(/'(\{[^']*\})'/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
  };
  for (const [file, rules] of [['verify-panel.sh', undefined], ['lfdln/verify-lfdln.sh', LFDLN_HELPER.rules]] as const) {
    it(`${file}: every one but the list is refused at the panel's door too, and nothing reaches an engine but a read`, async () => {
      const reqs = probes(file);
      assert.ok(reqs.length >= 6, `${reqs.length} probes`);
      const calls: string[] = [];
      const drivers = {
        postgres: { ...spyDriver('postgres', calls), ...(rules?.postgres ? { rules: rules.postgres } : {}) },
        mariadb: { ...spyDriver('mariadb', calls), ...(rules?.mariadb ? { rules: rules.mariadb } : {}) },
      };
      const dir = mkdtempSync(join(tmpdir(), 'pammydb-probes-'));
      const sock = join(dir, 'panel.sock');
      const server = createPammyDbServer(drivers, () => {});
      await new Promise<void>((r) => server.listen(sock, r));
      try {
        for (const req of reqs) {
          const got = await errorCode(callPammyDb(sock, req));
          if (req.op === 'list-databases') assert.equal(got, 'answered');
          else assert.notEqual(got, 'answered', JSON.stringify(req));
        }
        assert.deepEqual(calls.filter((c) => !/\.(list|state)$/.test(c)), [], 'only reads reached an engine');
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
