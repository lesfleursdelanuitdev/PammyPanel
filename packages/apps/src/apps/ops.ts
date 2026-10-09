// The software helper's operations (docs/apps-plan.md G2), each one on the
// allow-list in service.ts.
//   phase 1, reads: `list` (what is installed, quickly) and `status` (one of
//     them in full: containers, memory, whether it answers, disk, backups,
//     version, and now what is being done to it and what was done)
//   phase 2, changes (wordpress.ts): backups (list, now, put back, download),
//     offline and online again, a new admin password, its recent complaints
import type { Readable } from 'node:stream';
import { CATALOG } from './catalog.ts';
import { Jobs, type Job } from './jobs.ts';
import { realExec, realExecStream, systemdRun, type Exec, type ExecStream, type Runner } from './runner.ts';
import { STAMP_RE, wordpress, type Backup as BackupFile } from './wordpress.ts';
import { mail, type MailView } from './mail.ts';
import { listDir, memory, readText, treeSize, uidOf, unitState, wholeSiteServed, type Host } from './host.ts';
import { AppsError, findApp, KEEP_DELETED, readState, removeApp, standardRecord, updateApp, writeState, type AppRecord } from './record.ts';
import { checkRequest, installer, preflight } from './install.ts';
import { remover } from './remove.ts';
import { rootfs } from './rootfs.ts';
import { clash } from './nginx.ts';
import { addressOf, parsePlacement, RESERVED, stampToUnix, type Placement } from './placement.ts';
import { appPath } from '@panel/core/paths';

export { addressOf, parsePlacement, stampToUnix, type Placement };

export type Container = { role: 'web' | 'db'; unit: string; running: boolean; memory: number | null };
export type Backup = { at: number; bytes: number };

export type Summary = {
  id: string;
  kind: string;
  kindName: string;
  placement: Placement | null;
  address: string | null;
  adminAddress: string | null;    // its own admin pages, when it is served somewhere
  version: string | null;
  running: boolean;               // every container is up
  setup: AppRecord['setup'];      // an install that hasn't finished (4b)
  deleted: { at: number; by: string; until: number } | null;   // in the trash (4c), until it goes for good
};

export type Status = Summary & {
  // running: up and answering at its address. offline: up, but served nowhere.
  // stopped: no container is up. trouble: anything in between (see problems).
  // installing / failed: an install from the panel still going, or stopped at a step.
  // deleted: in the trash (4c), kept until `deleted.until`.
  state: 'running' | 'offline' | 'stopped' | 'trouble' | 'installing' | 'failed' | 'deleted';
  problems: string[];             // in her words, for the page
  siteAddress: string | null;     // the address its own settings (and links) use
  filesPath: string;              // where she finds its files
  installedAt: number;
  adoptedAt: number | null;
  containers: Container[];
  answering: { ok: boolean; status: number | null; ms: number | null; url: string | null; error: string | null; checkedAt: number } | null;
  disk: { files: number | null; database: number | null; backups: number | null; measuredAt: number };
  backups: { count: number; last: Backup | null };
  server: { memoryTotal: number | null; memoryAvailable: number | null };
  offline: { at: number } | null;   // taken offline from the panel (A4), and when
  job: Job | null;                  // what is being done to it now
  recent: Job[];                    // what was done to it, newest first
};

// Sizes are a walk through thousands of files: kept for ten minutes, so opening
// the page twice doesn't walk them twice.
const DISK_FOR = 600;

export type Ops = {
  // wholeSite: can software be the whole website now (Host.wholeSite; the page's choice)
  list: () => Promise<{ apps: Summary[]; wholeSite: boolean }>;
  status: (id: unknown) => Promise<Status>;
  backups: (id: unknown) => Promise<{ backups: BackupFile[] }>;
  backup: (id: unknown, actor: unknown) => Promise<{ job: Job }>;
  restore: (id: unknown, stamp: unknown, actor: unknown) => Promise<{ job: Job }>;
  offline: (id: unknown, actor: unknown) => Promise<{ job: Job }>;
  online: (id: unknown, actor: unknown) => Promise<{ job: Job }>;
  admins: (id: unknown) => Promise<{ admins: string[] }>;
  resetAdmin: (id: unknown, user: unknown, actor: unknown) => Promise<{ user: string; password: string; savedTo: string | null }>;
  logs: (id: unknown) => Promise<{ web: string[]; db: string[] }>;
  download: (id: unknown, stamp: unknown) => Promise<{ name: string; bytes: Readable }>;
  // phase 3
  mailGet: () => Promise<MailView>;
  mailSet: (req: { key?: unknown; from?: unknown; replyTo?: unknown; notifyTo?: unknown }, actor: unknown) => Promise<MailView>;
  mailTest: (id: unknown, actor: unknown) => Promise<{ sent: true; to: string }>;
  // phase 4a
  move: (id: unknown, to: unknown, actor: unknown) => Promise<{ job: Job }>;
  // phase 4b
  install: (req: Record<string, unknown>, actor: unknown) => Promise<{ job: Job; id: string }>;
  installLogin: (id: unknown) => Promise<{ user: string; password: string } | null>;
  // phase 4c
  remove: (id: unknown, actor: unknown) => Promise<{ job: Job }>;
  // File Explorer's roots for installed software (docs/catalog-plan.md step 3)
  rootfsSync: () => Promise<{ roots: string[]; removed: string[] }>;
  undelete: (id: unknown, actor: unknown) => Promise<{ job: Job }>;
  purge: (id: unknown, actor: unknown) => Promise<{ job: Job }>;
  purgeDue: () => Promise<{ started: string[] }>;
};

export type OpsDeps = {
  wpConfig: string;                // php.ini, wp-cli.yml, auto-updates.php for new installs (4b)
  run: Runner;
  exec: Exec;
  execStream: ExecStream;
  templates: string;               // WordPress's nginx templates (nginx.ts)
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
};

// beside the code in a release (build.sh copies them there, and checks)
export const TEMPLATES = `${appPath('apps', 'wordpress-nginx')}/`;
export const WP_CONFIG = `${appPath('apps', 'wordpress-config')}/`;

// who asked, as the panel says it: an account name, for the history
const actorOf = (v: unknown) => (typeof v === 'string' && /^[\w.-]{1,40}$/.test(v) ? v : 'someone');

export function createOps(h: Host, stateDir: string, deps: Partial<OpsDeps> = {}): Ops {
  const disk = new Map<string, Status['disk']>();
  const d: OpsDeps = {
    run: systemdRun, exec: realExec, execStream: realExecStream,
    templates: TEMPLATES, wpConfig: WP_CONFIG,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: () => {},
    ...deps,
  };
  const jobs = new Jobs(stateDir, h.now, d.log);
  const wp = wordpress({ host: h, run: d.run, exec: d.exec, templates: d.templates, sleep: d.sleep, apps: () => load().apps });
  const mailer = mail(h, d.run);
  const iDeps = { host: h, run: d.run, wpConfig: d.wpConfig, templates: d.templates, sleep: d.sleep };
  const inst = installer(iDeps, { ...wp, mailFor: (a) => mailer.forNewInstall(a) });
  // a new install's admin password, for the page to show once, for an hour at most
  const logins = new Map<string, { user: string; password: string; until: number }>();
  const rm = remover({ host: h, run: d.run }, wp);
  const roots = rootfs(d.run);
  // after a change to what is installed: File Explorer's roots follow (a failure is
  // logged, never the change's: its files are fine, only the panel can't reach them yet)
  const rootsFollow = async () => {
    try { await roots.sync(load().apps); } catch (e) { d.log(`rootfs-sync: ${(e as Error).message}`); }
  };
  // a change reads the record again when it starts, never a copy from before
  const fresh = (id: string) => findApp(load(), id);
  // an install that didn't finish: stopped at a step, or cut off (the helper
  // restarted while it ran, so no job will ever end it)
  const unfinished = (a: AppRecord) => a.setup !== null && (a.setup.state === 'failed' || !jobs.running.has(a.id));
  const inTrash = (a: AppRecord) => (a.deleted ? { ...a.deleted, until: a.deleted.at + KEEP_DELETED } : null);
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  // for good: its job ends with it gone from the record
  const purgeJob = (a: AppRecord, by: string) => jobs.start(a.id, 'purge', by, async (step) => {
    await rm.purge(fresh(a.id), step);
    removeApp(stateDir, a.id);
    disk.delete(a.id);
    logins.delete(a.id);
    await rootsFollow();
    return `Deleted for good: its files, database, backups and its user are gone.`;
  });

  const load = () => readState(stateDir);

  const versionOf = async (a: AppRecord) => {
    const v = CATALOG[a.kind].version;
    const text = await readText(h, `${a.files}/${v.file}`);
    return text?.match(v.pattern)?.[1] ?? null;
  };

  const containersOf = async (a: AppRecord): Promise<Container[]> => {
    const uid = await uidOf(h, a.user);
    return Promise.all((['web', 'db'] as const).map(async (role) => {
      const unit = a.units[role];
      if (uid === null) return { role, unit, running: false, memory: null };
      return { role, unit, ...await unitState(h, uid, unit) };
    }));
  };

  const summaryOf = async (a: AppRecord): Promise<Summary & { containers: Container[] }> => {
    const placement = parsePlacement(await readText(h, a.placementFile));
    const containers = await containersOf(a);
    const address = placement ? addressOf(placement, h.domain) : null;
    return {
      id: a.id, kind: a.kind, kindName: CATALOG[a.kind].name,
      placement, address, adminAddress: address && `${address}${CATALOG[a.kind].admin}`,
      version: await versionOf(a),
      running: containers.every((c) => c.running),
      setup: a.setup && !jobs.running.has(a.id) && a.setup.state === 'installing' ? { ...a.setup, state: 'failed' as const, message: a.setup.message ?? 'It was cut off (the helper restarted).' } : a.setup,
      deleted: inTrash(a),
      containers,
    };
  };

  // Backups are files named by their moment: db-<stamp>.sql.gz and
  // files-<stamp>.tar.gz (~/pamela-setup/wordpress/backup-wordpress.sh). A
  // backup is one moment with both halves.
  const backupsOf = async (a: AppRecord) => {
    const files = await listDir(h, a.backups);
    const halves = new Map<string, { db: boolean; files: boolean; bytes: number }>();
    let bytes = 0;
    for (const f of files ?? []) {
      bytes += f.bytes;
      const m = f.name.match(/^(db|files)-(\d{8}T\d{6}Z)\.(?:sql|tar)\.gz$/);
      if (!m) continue;
      const b = halves.get(m[2]!) ?? { db: false, files: false, bytes: 0 };
      b[m[1] as 'db' | 'files'] = true;
      b.bytes += f.bytes;
      halves.set(m[2]!, b);
    }
    const whole = [...halves].filter(([, b]) => b.db && b.files).map(([stamp, b]) => ({ at: stampToUnix(stamp), bytes: b.bytes })).sort((x, y) => y.at - x.at);
    return { count: whole.length, last: whole[0] ?? null, bytes: files ? bytes : null };
  };

  const diskOf = async (a: AppRecord, backupBytes: number | null): Promise<Status['disk']> => {
    const kept = disk.get(a.id);
    if (kept && h.now() - kept.measuredAt < DISK_FOR) return { ...kept, backups: backupBytes };
    const d = { files: await treeSize(h, a.files), database: await treeSize(h, a.dbVolume), backups: backupBytes, measuredAt: h.now() };
    disk.set(a.id, d);
    return d;
  };

  const answeringOf = async (a: AppRecord, placement: Placement | null, siteAddress: string | null): Promise<Status['answering']> => {
    if (!placement) return null;
    const address = addressOf(placement, h.domain);
    // served somewhere: ask nginx, as a visitor would. Served nowhere: ask the
    // container itself, as its own address, so "offline" and "broken" differ.
    const url = address ?? (siteAddress ? `${siteAddress.replace(/\/$/, '')}/` : `http://localhost/`);
    const connect = address ? { ...h.nginx, tls: true } : { host: '127.0.0.1', port: a.port, tls: false };
    const r = await h.probe({ url, connect, timeoutMs: 8000 });
    return { ok: r.status !== null && CATALOG[a.kind].answers(r.status), status: r.status, ms: r.ms, url: address, error: r.error, checkedAt: h.now() };
  };

  // The whole website isn't a place for software while nginx doesn't read WordPress's
  // main.conf there (pammy.org on its hosts, docs/phase8-plan.md 8-7d): a move would say it
  // worked and change nothing.
  const refuseWholeSite = async () => {
    if (!await wholeSiteServed(h)) throw new AppsError('invalid', `${h.domain} is served from its hosts now, so software can't be the whole of it. Choose a subdomain or a folder of ${h.domain}.`);
  };

  return {
    async list() {
      const apps = await Promise.all(load().apps.map(async (a) => {
        const { containers: _, ...s } = await summaryOf(a);
        return s;
      }));
      return { apps, wholeSite: await wholeSiteServed(h) };
    },

    async status(id) {
      const a = findApp(load(), id);
      const s = await summaryOf(a);
      const siteAddress = (await readText(h, `${a.config}/content-url`))?.trim() || null;
      // offline on purpose, or not installed yet: nothing to ask, and nothing wrong
      const setup = s.setup;
      const [answering, backups, mem] = await Promise.all([a.offline || setup ? null : answeringOf(a, s.placement, siteAddress), backupsOf(a), memory(h)]);
      const job = jobs.running.get(a.id) ?? null;
      const extra = { offline: a.offline ? { at: a.offline.at } : null, job: job && { ...job }, recent: jobs.recent(a.id) };
      const up = s.containers.filter((c) => c.running).length;
      const problems: string[] = [];
      if (setup) {
        if (setup.state === 'failed') problems.push(`Installing it stopped at "${setup.step}": ${setup.message ?? 'something went wrong'}`);
      } else if (!s.placement) problems.push('Its address setting could not be read, so the panel does not know where it is served.');
      if (setup) { /* nothing more to say until it is installed */ } else if (a.offline) {
        if (up > 0) problems.push('It was taken offline, but something is still running.');
      } else if (up === 0) problems.push(`${s.kindName} is not running.`);
      else if (up < s.containers.length) {
        for (const c of s.containers) if (!c.running) problems.push(c.role === 'db' ? 'Its database is not running.' : 'Its web server is not running.');
      }
      if (up > 0 && answering && !answering.ok) {
        problems.push(answering.status
          ? `It answered with an error (${answering.status}) when the panel opened it.`
          : 'It did not answer when the panel opened it.');
      }
      if (!s.version && !setup) problems.push(`Its ${s.kindName} version could not be read.`);
      const state: Status['state'] = setup ? setup.state
        : a.deleted ? 'deleted'
        : a.offline && problems.length === 0 ? 'offline'
        : up === 0 && !a.offline ? 'stopped'
        : problems.length > 0 ? 'trouble'
        : s.placement?.mode === 'off' ? 'offline' : 'running';
      return {
        ...s, state, problems, siteAddress,
        filesPath: a.filesLink ?? a.files,
        installedAt: a.installedAt, adoptedAt: a.adoptedAt,
        answering,
        disk: await diskOf(a, backups.bytes),
        backups: { count: backups.count, last: backups.last },
        server: { memoryTotal: mem.total, memoryAvailable: mem.available },
        ...extra,
      };
    },

    // ---------------------------------------------------------------- phase 2
    async backups(id) {
      return { backups: await wp.backups(findApp(load(), id)) };
    },

    async backup(id, actor) {
      const a = findApp(load(), id);
      return { job: jobs.start(a.id, 'backup', actorOf(actor), (step) => wp.backup(fresh(a.id), step)) };
    },

    async restore(id, stamp, actor) {
      const a = findApp(load(), id);
      if (typeof stamp !== 'string' || !STAMP_RE.test(stamp)) throw new AppsError('not-found', 'That backup is not there any more.');
      if (!(await wp.backups(a)).some((b) => b.stamp === stamp)) throw new AppsError('not-found', 'That backup is not there any more.');
      return { job: jobs.start(a.id, 'restore', actorOf(actor), (step) => wp.restore(fresh(a.id), stamp, step)) };
    },

    async offline(id, actor) {
      const a = findApp(load(), id);
      if (a.offline) throw new AppsError('conflict', 'It is already offline.');
      return { job: jobs.start(a.id, 'offline', actorOf(actor), (step) => wp.offline(fresh(a.id), step,
        (from) => { updateApp(stateDir, a.id, (r) => ({ ...r, offline: { from, at: h.now() } })); disk.delete(a.id); })) };
    },

    async online(id, actor) {
      const a = findApp(load(), id);
      if (!a.offline) throw new AppsError('conflict', 'It is already online.');
      if (a.deleted) throw new AppsError('conflict', 'It is deleted. Restore it first.');
      return { job: jobs.start(a.id, 'online', actorOf(actor), (step) => wp.online(fresh(a.id), step,
        () => { updateApp(stateDir, a.id, (r) => ({ ...r, offline: null })); })) };
    },

    async admins(id) {
      return { admins: await wp.admins(findApp(load(), id)) };
    },

    async resetAdmin(id, user, actor) {
      const a = findApp(load(), id);
      if (typeof user !== 'string' || !/^[\w.@ +-]{1,60}$/.test(user)) throw new AppsError('not-found', 'There is no administrator by that name.');
      if (jobs.running.has(a.id)) throw new AppsError('busy', 'Something else is being done to it just now. Wait until that has finished.');
      const r = await wp.resetAdmin(a, user, await wp.admins(a));
      jobs.note(a.id, 'admin-password', actorOf(actor), true, `A new password for ${r.user}${r.savedTo ? ', also in your wordpress-login.txt' : ''}.`);
      return r;
    },

    async logs(id) {
      return wp.logs(findApp(load(), id));
    },

    // A backup as one file: a .tar holding its two halves (both already
    // compressed) and the address its links use, streamed as it is read.
    async download(id, stamp) {
      const a = findApp(load(), id);
      if (typeof stamp !== 'string' || !STAMP_RE.test(stamp) || !(await wp.backups(a)).some((b) => b.stamp === stamp)) {
        throw new AppsError('not-found', 'That backup is not there any more.');
      }
      const names = [`db-${stamp}.sql.gz`, `files-${stamp}.tar.gz`];
      if (await readText(h, `${a.backups}/url-${stamp}.txt`) !== null) names.push(`url-${stamp}.txt`);
      const when = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}-${stamp.slice(9, 13)}`;
      return { name: `${a.kind}-${a.id}-backup-${when}.tar`, bytes: d.execStream(['tar', '-C', `${h.root.replace(/\/$/, '')}${a.backups}`, '-cf', '-', '--', ...names]) };
    },

    // ---------------------------------------------------------------- phase 4a: move
    async move(id, to, actor) {
      const a = findApp(load(), id);
      const t = to as { mode?: unknown; name?: unknown } | null;
      const p = t && typeof t === 'object' ? parsePlacement(t.mode === 'root' ? 'root' : `${String(t.mode)} ${String(t.name)}`) : null;
      if (!p || p.mode === 'off') throw new AppsError('invalid', `Choose a subdomain, a folder of ${h.domain}, or the whole site.`);
      if (p.name && RESERVED.includes(p.name)) throw new AppsError('invalid', `"${p.name}" is kept for the server itself. Pick another name.`);
      if (p.mode === 'root') await refuseWholeSite();
      if (a.offline) throw new AppsError('conflict', 'Bring it online first, then move it.');
      return { job: jobs.start(a.id, 'move', actorOf(actor), (step) => wp.move(fresh(a.id), p, step)) };
    },

    // ---------------------------------------------------------------- phase 4b: install
    async install(raw, actor) {
      const req = checkRequest(raw, h.domain);
      if (req.placement.mode === 'root') await refuseWholeSite();
      let all = load().apps;
      // An install that didn't finish may be tried again under its name: every
      // step is safe to repeat, so it picks up what is missing (install.ts).
      const had = all.find((x) => x.id === req.id);
      const again = had && unfinished(had) ? had : null;
      if (again) all = all.filter((x) => x.id !== again.id);
      if (had?.deleted) throw new AppsError('exists', `"${had.id}" is in your deleted software until ${day(had.deleted.at + KEEP_DELETED)}. Restore it, or delete it for good, to use the name again.`);
      if (req.placement.mode !== 'off') {
        const others = await Promise.all(all.map(async (x) => ({ id: x.id, port: x.port, placementFile: x.placementFile, adopted: x.layout === 'adopted-wordpress',
          placement: parsePlacement(await readText(h, x.placementFile)) ?? { mode: 'off' as const, name: null } })));
        const why = clash([...others, { id: req.id, port: 0, placementFile: '', adopted: false, placement: req.placement }]);
        if (why) throw new AppsError('conflict', why);
      }
      const port = await preflight(iDeps, all, req, again);
      const a = again ? { ...again, setup: { state: 'installing' as const, step: 'Starting', message: null } } : standardRecord(req.id, port, h.now());
      writeState(stateDir, { version: 1, apps: [...all, a] });
      let at = 'Starting';
      const job = jobs.start(a.id, 'install', actorOf(actor), async (step) => {
        const say = (s: string) => { at = s; step(s); updateApp(stateDir, a.id, (r) => ({ ...r, setup: { state: 'installing', step: s, message: null } })); };
        try {
          const r = await inst(fresh(a.id), req, say);
          logins.set(a.id, { user: req.adminUser, password: r.password, until: h.now() + 3600 });
          updateApp(stateDir, a.id, (x) => ({ ...x, setup: null }));
          await rootsFollow();
          return r.message;
        } catch (e) {
          updateApp(stateDir, a.id, (x) => ({ ...x, setup: { state: 'failed', step: at, message: (e as Error).message.slice(0, 900) } }));
          throw e;
        }
      });
      return { job, id: a.id };
    },

    // ---------------------------------------------------------------- phase 4c: delete
    // To the trash: a last backup if it runs, offline (A4), her link removed.
    // An install that didn't finish has nothing worth keeping: it goes for good.
    async remove(id, actor) {
      const a = findApp(load(), id);
      if (a.deleted) throw new AppsError('conflict', 'It is deleted already.');
      if (a.setup) {
        if (!unfinished(a)) throw new AppsError('busy', 'It is being installed just now. Wait until that has finished.');
        return { job: purgeJob(a, actorOf(actor)) };
      }
      return { job: jobs.start(a.id, 'delete', actorOf(actor), async (step) => {
        if (!fresh(a.id).offline) {
          step('Making a last backup');
          try { await wp.backupNow(fresh(a.id)); } catch (e) {
            throw new AppsError('conflict', `The last backup didn't work, so nothing was deleted. To delete it without one, take it offline first. ${(e as Error).message}`);
          }
          await wp.offline(fresh(a.id), step, (from) => { updateApp(stateDir, a.id, (r) => ({ ...r, offline: { from, at: h.now() } })); });
        }
        step('Taking it out of your folders');
        await rm.hide(fresh(a.id));
        const at = h.now();
        updateApp(stateDir, a.id, (r) => ({ ...r, deleted: { at, by: actorOf(actor) } }));
        disk.delete(a.id);
        await rootsFollow();
        return `Deleted. It is kept until ${day(at + KEEP_DELETED)}, and "Restore" brings it back until then.`;
      }) };
    },

    // Back from the trash, offline: "Bring it back online" puts it at its address.
    async undelete(id, actor) {
      const a = findApp(load(), id);
      if (!a.deleted) throw new AppsError('conflict', 'It isn\'t deleted.');
      return { job: jobs.start(a.id, 'undelete', actorOf(actor), async (step) => {
        step('Putting it back in your folders');
        await rm.unhide(fresh(a.id));
        updateApp(stateDir, a.id, (r) => ({ ...r, deleted: null }));
        await rootsFollow();
        const from = parsePlacement(fresh(a.id).offline?.from ?? null);
        const where = from && addressOf(from, h.domain);
        return `It is back, offline. ${where ? `"Bring it back online" puts it at ${where} again.` : '"Bring it back online" starts it again.'}`;
      }) };
    },

    // For good, now: only from the trash, or an install that didn't finish.
    async purge(id, actor) {
      const a = findApp(load(), id);
      if (!a.deleted && !(a.setup && unfinished(a))) throw new AppsError('conflict', 'Delete it first: it goes to the deleted software, and can be deleted for good from there.');
      return { job: purgeJob(a, actorOf(actor)) };
    },

    async rootfsSync() {
      return roots.sync(load().apps);
    },

    // Once a day (pammy-apps-purge.timer): what has been in the trash 30 days.
    async purgeDue() {
      const started: string[] = [];
      for (const a of load().apps) {
        if (!a.deleted || a.deleted.at + KEEP_DELETED > h.now() || jobs.running.has(a.id)) continue;
        purgeJob(a, 'after 30 days');
        started.push(a.id);
      }
      if (started.length) d.log(`purge-due: ${started.join(', ')}`);
      return { started };
    },

    // Once: the page asks for it after the install ends, and it is gone.
    async installLogin(id) {
      const a = findApp(load(), id);
      const l = logins.get(a.id);
      logins.delete(a.id);
      return l && l.until > h.now() ? { user: l.user, password: l.password } : null;
    },

    // ---------------------------------------------------------------- phase 3: mail
    async mailGet() {
      return mailer.view(load().apps);
    },

    async mailSet(req, actor) {
      const apps = load().apps;
      for (const a of apps) if (jobs.running.has(a.id)) throw new AppsError('busy', 'Something is being done to WordPress just now. Try again when it has finished.');
      const v = await mailer.set(apps, req);
      d.log(`mail settings saved by ${actorOf(actor)} (key ...${v.keyEnds})`);
      return v;
    },

    async mailTest(id, actor) {
      const a = findApp(load(), id);
      if (jobs.running.has(a.id)) throw new AppsError('busy', 'Something else is being done to it just now. Wait until that has finished.');
      const t = await mailer.testScript();
      await wp.mailTest(a, t.php);
      jobs.note(a.id, 'mail-test', actorOf(actor), true, `A test email went to ${t.to}.`);
      return { sent: true as const, to: t.to };
    },
  };
}
