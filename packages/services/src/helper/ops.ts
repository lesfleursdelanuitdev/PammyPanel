// What the services helper does (docs/adopt-plan.md V7). Only what its record
// names, and only these: tell how each part is (list, status), start, stop and
// restart it, and read its log. It deletes nothing, ever (D2): there is no such
// operation.
//
// A part is a container in its service user's systemd manager (rootless Quadlet).
// Everything done to it is `systemctl --user` as that user, one named unit each
// through systemd (@panel/core/runner), so the helper itself never switches user.
//   stop:    stop, then mask -- so it stays stopped after a reboot (Q4)
//   start:   unmask, reload, start -- then wait until it answers
//   restart: restart (a stopped part is started, not restarted)
// A part that others Require= (Gonsalves's two APIs) takes them with it when it
// stops, and they are masked too; starting a part starts what it needs first.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Runner, RunResult } from '@panel/core/runner';
import { fileURLToPath } from 'node:url';
import { BACKUPS, DATABASES, DISKS, KNOWN, MANIFEST_MAX } from '../known.ts';
import { KEEP_MAX, KEEP_MIN, type PruneAnswer } from '../prune.ts';
import type { StorageAnswer } from '../storage.ts';
import { dependentsOf, findPart, findService, neededBy, ServicesError, type Part, type Service, type ServicesRecord } from '../record.ts';

// the backups and disks reader (storage.ts), run as a root unit of its own
export const STORAGE = fileURLToPath(new URL('../storage.ts', import.meta.url));
// ...and what deletes the copies older than the panel's setting (prune.ts, docs/lfdln-mariadb-plan.md B2)
export const PRUNE = fileURLToPath(new URL('../prune.ts', import.meta.url));

export type Probe = (port: number, path: string, timeoutMs: number) => Promise<{ status: number | null; ms: number }>;

// Where a service's data is, as move-db.sh wrote it down (M7): unknown or unreadable is :5432.
export type DataWhere = { database: string; engine: 'server' | 'lfdln-appdb'; port: number; since: number | null };
export type DatabasesFile = Record<string, { database?: unknown; engine?: unknown; port?: unknown; since?: unknown }>;

export type ServicesDeps = {
  record: () => ServicesRecord;
  run: Runner;
  probe: Probe;
  root?: string;                        // the tests' stand-in for "/"
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  waitMs?: number;                      // how long a start or restart waits for an answer (3 minutes)
  databases?: () => DatabasesFile;      // what move-db.sh wrote down (databases.json)
};

export type PartStatus = {
  id: string; title: string; unit: string; port: number | null; health: string | null; controls: boolean; requires: string[];
  // systemd's words: active, inactive, failed, activating, deactivating; masked: stopped from the panel
  active: string; sub: string; masked: boolean; since: number | null; restarts: number | null;
  memory: number | null;                // bytes its programs hold (anon), while it runs
  answering: { status: number | null; ms: number } | null;   // its health path, when it has one and runs
  well: boolean | null;                 // answering 2xx or 3xx (null: nothing to ask)
  changed: boolean | null;              // its Quadlet file isn't what it was when adopted (null: can't tell)
};
export type ServiceStatus = { id: string; title: string; user: string; about: string; adoptedAt: number; parts: PartStatus[]; database: DataWhere | null };

const firstLines = (r: RunResult) => (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 300);

export function createServicesOps(d: ServicesDeps) {
  const log = d.log ?? (() => {});
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const at = (p: string) => join(d.root ?? '/', p);
  const readText = async (p: string) => { try { return await readFile(at(p), 'utf8'); } catch { return null; } };

  const userOf = async (s: Service) => {
    const passwd = await readText('/etc/passwd');
    for (const line of passwd?.split('\n') ?? []) {
      const f = line.split(':');
      if (f[0] === s.user && /^\d+$/.test(f[2] ?? '')) return { user: s.user, uid: Number(f[2]), home: f[5] || `/var/lib/${s.user}` };
    }
    throw new ServicesError('unavailable', `${s.title}'s system user (${s.user}) is missing, so nothing can be done to it.`);
  };
  const asUser = async (s: Service, argv: string[], what: string, timeoutSec = 120) => d.run({ as: await userOf(s), argv, what, timeoutSec });
  const must = (r: RunResult, words: string) => {
    if (r.code !== 0) throw new ServicesError('internal', firstLines(r) ? `${words.replace(/\.$/, '')} (${firstLines(r)}).` : words);
    return r;
  };
  const units = (parts: Part[]) => parts.map((p) => `${p.unit}.service`);

  // One service at a time: a start can't cross a stop.
  const busy = new Set<string>();
  const exclusive = async <T>(s: Service, fn: () => Promise<T>): Promise<T> => {
    if (busy.has(s.id)) throw new ServicesError('busy', `Something is already being done to ${s.title}. Try again when it has finished.`);
    busy.add(s.id);
    try { return await fn(); } finally { busy.delete(s.id); }
  };

  // ------------------------------------------------------------------ how they are
  // systemd's view of every part, in one `systemctl --user show` as the service's user
  const shown = async (s: Service) => {
    const r = await asUser(s, ['systemctl', '--user', 'show', '--timestamp=unix',
      '-p', 'Id,LoadState,ActiveState,SubState,NRestarts,ActiveEnterTimestamp', ...units(s.parts)], 'show', 30);
    const out = new Map<string, Record<string, string>>();
    if (r.code !== 0) return out;
    for (const block of r.stdout.split(/\n\s*\n/)) {
      const kv: Record<string, string> = {};
      for (const line of block.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1); }
      if (kv.Id) out.set(kv.Id, kv);
    }
    return out;
  };
  // the Quadlet files' checksums now, read as the service's user (its folders are its own, 700)
  const sums = async (s: Service) => {
    const files = [...new Set(s.parts.map((p) => p.source).filter((x): x is string => !!x))];
    const out = new Map<string, string>();
    if (!files.length) return out;
    const r = await asUser(s, ['sha256sum', '--', ...files], 'checksum', 30);
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
      if (m) out.set(m[2]!, m[1]!);
    }
    return out;
  };
  const memoryOf = async (uid: number, unit: string) => {
    const stat = await readText(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}.service/memory.stat`);
    const m = stat?.match(/^anon (\d+)$/m);
    return m ? Number(m[1]) : null;
  };

  const dataOf = (id: string): DataWhere | null => {
    const name = DATABASES[id];
    if (!name) return null;
    let w: DatabasesFile[string] | undefined;
    try { w = d.databases?.()[id]; } catch { w = undefined; }
    if (w && w.database === name && (w.engine === 'server' || w.engine === 'lfdln-appdb') && Number.isInteger(w.port)) {
      return { database: name, engine: w.engine, port: w.port as number, since: Number.isInteger(w.since) ? w.since as number : null };
    }
    return { database: name, engine: 'server', port: 5432, since: null };
  };

  async function statusOf(s: Service): Promise<ServiceStatus> {
    const u = await userOf(s);
    const [show, now] = await Promise.all([shown(s), sums(s)]);
    const parts = await Promise.all(s.parts.map(async (p): Promise<PartStatus> => {
      const kv = show.get(`${p.unit}.service`) ?? {};
      const active = kv.ActiveState ?? 'unknown';
      const running = active === 'active' && kv.SubState !== 'exited';
      const since = /^@\d+$/.test(kv.ActiveEnterTimestamp ?? '') ? Number(kv.ActiveEnterTimestamp!.slice(1)) : null;
      const answering = running && p.port !== null && p.health !== null ? await d.probe(p.port, p.health, 5000) : null;
      return {
        id: p.id, title: p.title, unit: p.unit, port: p.port, health: p.health, controls: p.controls, requires: p.requires,
        active, sub: kv.SubState ?? '', masked: kv.LoadState === 'masked', since,
        restarts: /^\d+$/.test(kv.NRestarts ?? '') ? Number(kv.NRestarts) : null,
        memory: running ? await memoryOf(u.uid, p.unit) : null,
        answering, well: answering ? answering.status !== null && answering.status >= 200 && answering.status < 400 : null,
        changed: p.source && p.sha256 && now.has(p.source) ? now.get(p.source) !== p.sha256 : null,
      };
    }));
    return { id: s.id, title: s.title, user: s.user, about: s.about, adoptedAt: s.adoptedAt, parts, database: dataOf(s.id) };
  }

  // wait until every part with a health path answers well, up to a limit
  async function waitWell(s: Service, parts: Part[], limitMs = d.waitMs ?? 180_000) {
    const asked = parts.filter((p) => p.port !== null && p.health !== null);
    const started = Date.now();
    for (;;) {
      const r = await Promise.all(asked.map((p) => d.probe(p.port!, p.health!, 5000)));
      const bad = asked.filter((_, i) => !(r[i]!.status !== null && r[i]!.status! >= 200 && r[i]!.status! < 400));
      if (!bad.length) return;
      if (Date.now() - started > limitMs) {
        throw new ServicesError('internal', `${s.title}: ${bad.map((p) => p.title).join(', ')} didn't answer within ${Math.max(1, Math.round(limitMs / 60000))} minutes. Its log may say why.`);
      }
      await sleep(2000);
    }
  }

  // the parts asked for: the whole service's (those the panel may control), or one
  const partsOf = (s: Service, partId: unknown) => {
    if (partId === undefined || partId === null) return s.parts.filter((p) => p.controls);
    const p = findPart(s, partId);
    if (!p.controls) throw new ServicesError('invalid', `${p.title} isn't started or stopped from the panel.`);
    return [p];
  };

  return {
    async list() {
      return { services: await Promise.all(d.record().services.map(statusOf)) };
    },

    // each service's id and title, without asking systemd (the catalog's pages, docs/catalog-plan.md step 5)
    async names() {
      return { services: d.record().services.map((s) => ({ id: s.id, title: s.title })) };
    },

    async status(id: unknown) {
      return statusOf(findService(d.record(), id));
    },

    // what the routing helper and the panel may point a route at: every part with a port
    async ports() {
      return { parts: d.record().services.flatMap((s) => s.parts.filter((p) => p.port !== null).map((p) => ({ service: s.id, part: p.id, title: `${s.title}: ${p.title}`, port: p.port! }))) };
    },

    async start(id: unknown, partId: unknown, actor: string) {
      const s = findService(d.record(), id);
      const asked = partsOf(s, partId);
      // what they need comes up with them
      const all = s.parts.filter((p) => p.controls && asked.some((a) => neededBy(s, a.id).some((n) => n.id === p.id)));
      return exclusive(s, async () => {
        must(await asUser(s, ['systemctl', '--user', 'unmask', ...units(all)], 'unmask'), `${s.title} couldn't be unmasked.`);
        must(await asUser(s, ['systemctl', '--user', 'daemon-reload'], 'reload'), `${s.title}'s units couldn't be reloaded.`);
        must(await asUser(s, ['systemctl', '--user', 'start', ...units(all)], 'start', 600), `${s.title} couldn't be started.`);
        await waitWell(s, all);
        log(`${actor}: started ${s.id} (${all.map((p) => p.id).join(', ')})`);
        return statusOf(s);
      });
    },

    async stop(id: unknown, partId: unknown, actor: string) {
      const s = findService(d.record(), id);
      const asked = partsOf(s, partId);
      // what can't run without them stops with them, and stays stopped with them
      const all = s.parts.filter((p) => p.controls && asked.some((a) => dependentsOf(s, a.id).some((x) => x.id === p.id))).reverse();
      return exclusive(s, async () => {
        must(await asUser(s, ['systemctl', '--user', 'stop', ...units(all)], 'stop', 300), `${s.title} couldn't be stopped.`);
        must(await asUser(s, ['systemctl', '--user', 'mask', ...units(all)], 'mask'), `${s.title} stopped, but couldn't be kept stopped after a restart of the server.`);
        log(`${actor}: stopped ${s.id} (${all.map((p) => p.id).join(', ')})`);
        return statusOf(s);
      });
    },

    async restart(id: unknown, partId: unknown, actor: string) {
      const s = findService(d.record(), id);
      const asked = partsOf(s, partId);
      return exclusive(s, async () => {
        const show = await shown(s);
        const stopped = asked.filter((p) => show.get(`${p.unit}.service`)?.LoadState === 'masked');
        if (stopped.length) throw new ServicesError('conflict', `${stopped.map((p) => p.title).join(', ')} ${stopped.length > 1 ? 'are' : 'is'} stopped: start ${stopped.length > 1 ? 'them' : 'it'} instead.`);
        must(await asUser(s, ['systemctl', '--user', 'restart', ...units(asked)], 'restart', 600), `${s.title} couldn't be restarted.`);
        // (a part others Require= restarts them too)
        await waitWell(s, s.parts.filter((p) => asked.some((a) => dependentsOf(s, a.id).some((x) => x.id === p.id))));
        log(`${actor}: restarted ${s.id} (${asked.map((p) => p.id).join(', ')})`);
        return statusOf(s);
      });
    },

    // its last lines in the journal (what its container printed, and systemd about it)
    async logs(id: unknown, partId: unknown) {
      const s = findService(d.record(), id);
      const p = findPart(s, partId);
      const u = await userOf(s);
      const r = await d.run({ as: 'root', what: 'logs', timeoutSec: 30,
        argv: ['journalctl', `_SYSTEMD_USER_UNIT=${p.unit}.service`, `_UID=${u.uid}`, '-n', '200', '-o', 'short-iso', '--no-pager', '-q'] });
      if (r.code !== 0) throw new ServicesError('internal', `${p.title}'s log couldn't be read (${firstLines(r)}).`);
      return { lines: r.stdout.split('\n').filter(Boolean).slice(-200) };
    },

    // Its pammy-panel.json (docs/roles-plan.md step 6, S6-3): the privileges and roles it
    // declares, from the file the known services list names for it, for the Access
    // page's Read again. Only a service taken in; 64 KB at most; the text, unread.
    async manifest(id: unknown) {
      const s = findService(d.record(), id);
      const path = KNOWN.find((k) => k.id === s.id)?.manifest;
      if (!path) throw new ServicesError('not-found', `${s.title} has no pammy-panel.json.`);
      let text: string;
      try {
        const st = await stat(at(path));
        if (!st.isFile()) throw new Error('not a file');
        if (st.size > MANIFEST_MAX) throw new ServicesError('invalid', `${s.title}'s pammy-panel.json is larger than ${MANIFEST_MAX / 1024} KB.`);
        text = await readFile(at(path), 'utf8');
      } catch (e) {
        if (e instanceof ServicesError) throw e;
        throw new ServicesError('not-found', `${s.title}'s pammy-panel.json isn't at ${path} (its installer puts it there).`);
      }
      return { text, path };
    },

    // The nightly backups and the disks (docs/monitoring-plan.md step 2), for monitoring:
    // the folders and disks in known.ts only, read by a root unit (storage.ts) since this
    // helper's root has no capability to open another user's 700 folder.
    async storage() {
      const task = { backups: BACKUPS.map(({ id, dir, prefix }) => ({ id, dir, prefix })), disks: DISKS.map((path) => ({ path })) };
      const r = await d.run({ as: 'root', argv: ['/usr/bin/node', '--disable-warning=ExperimentalWarning', STORAGE], what: 'storage', stdin: JSON.stringify(task), timeoutSec: 60 });
      if (r.code !== 0) throw new ServicesError('unavailable', `The backups and disks couldn't be read (${firstLines(r) || `exit ${r.code}`}).`);
      let a: StorageAnswer;
      try { a = JSON.parse(r.stdout) as StorageAnswer; } catch { throw new ServicesError('internal', "The backups and disks answered with something that isn't JSON."); }
      return {
        backups: a.backups.map((b) => ({ ...b, title: BACKUPS.find((x) => x.id === b.id)?.title ?? b.id })),
        disks: a.disks,
      };
    },

    // The copies older than `days` (Settings > Backups, B2), in the folders known.ts marks
    // pruned only, by a root unit (prune.ts) as storage() reads them. The days are checked
    // here and again there; the folders never come from the request.
    async prune(days: unknown) {
      if (!Number.isInteger(days) || (days as number) < KEEP_MIN || (days as number) > KEEP_MAX) {
        throw new ServicesError('invalid', `Keep them for ${KEEP_MIN} to ${KEEP_MAX} days.`);
      }
      const task = { sets: BACKUPS.filter((b) => b.pruned).map(({ id, dir }) => ({ id, dir })), days };
      const r = await d.run({ as: 'root', argv: ['/usr/bin/node', '--disable-warning=ExperimentalWarning', PRUNE], what: 'prune', stdin: JSON.stringify(task), timeoutSec: 120 });
      if (r.code !== 0) throw new ServicesError('unavailable', `The old backups couldn't be deleted (${firstLines(r) || `exit ${r.code}`}).`);
      try { return JSON.parse(r.stdout) as PruneAnswer; } catch { throw new ServicesError('internal', "Pruning answered with something that isn't JSON."); }
    },
  };
}
export type ServicesOps = ReturnType<typeof createServicesOps>;
