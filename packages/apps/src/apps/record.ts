// The software helper's own record of what is installed (docs/apps-plan.md G2):
// /var/lib/pammy-apps/apps.json, root 600. The panel shows what the helper says,
// and the helper is the truth about what is installed.
//
// In phase 1 only `adopt.ts` writes it (run by the installer, never through the
// socket), and it only ever writes this file: adopting changes no file, unit,
// container, database or nginx line of the software itself (A1).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { isKind, type Kind } from './catalog.ts';

export class AppsError extends Error {
  code: 'invalid' | 'not-found' | 'exists' | 'busy' | 'conflict' | 'unavailable' | 'internal';
  constructor(code: AppsError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// An id is a name for the helper and the panel's addresses, never shown as
// her words: one DNS label, like a subdomain.
export const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// system users the software runs as (svc-pammywp, and svc-app-<id> for new ones)
const USER_RE = /^svc-[a-z0-9-]{1,28}$/;
// a systemd unit in that user's manager, without ".service"
const UNIT_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

// `adopted-wordpress`: the WordPress momolig installed by hand in 2026-09
// (~/pamela-setup/wordpress), whose files, settings and nginx placement are
// where those scripts put them. New installs (phase 4) get `standard`.
export type Layout = 'adopted-wordpress' | 'standard';

export type AppRecord = {
  id: string;
  kind: Kind;
  layout: Layout;
  user: string;                 // the system user its containers run as
  units: { web: string; db: string };
  port: number;                 // the web container, on 127.0.0.1
  files: string;                // its files on the host
  filesLink: string | null;     // where she reaches them (/pamela/wordpress), if not the same
  config: string;               // its settings folder (content-url lives here)
  backups: string;              // where its backups go
  dbVolume: string;             // the database volume's data, for its size
  placementFile: string;        // where nginx's placement for it is written
  installedAt: number;          // unix seconds
  adoptedAt: number | null;     // set when it was installed before the panel knew it
  // her login for its admin pages, rewritten by "Make a new admin password"
  // (phase 2, P2c). Null: none is kept.
  loginFile: string | null;
  // Offline (A4): containers stopped and served nowhere, and the placement line to
  // put back when it comes online again. Null while it is online.
  offline: { from: string; at: number } | null;
  // An install from the panel that hasn't finished (4b): still going, or
  // stopped at a step, with why. Null once it works. What it made stays, and
  // Delete (4c) clears it.
  setup: { state: 'installing' | 'failed'; step: string; message: string | null } | null;
  // Deleted (4c): offline, her link gone, everything else kept until `at` + 30
  // days, when it is deleted for good. Restore brings it back, offline.
  deleted: { at: number; by: string } | null;
};

export const KEEP_DELETED = 30 * 86400;

export type AppsState = { version: 1; apps: AppRecord[] };

export const STATE_FILE = 'apps.json';

// a placement line (ops.ts parsePlacement), kept to come back to after offline
const PLACEMENT_RE = /^(off|root|(subdomain|path) [a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;

const path = (v: unknown): v is string => typeof v === 'string' && isAbsolute(v) && normalize(v) === v && !v.includes('\0') && v.length < 300;
const unix = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

// Everything read back is checked as if a stranger wrote it: a hand edit that
// went wrong stops the helper with a plain reason rather than steering it.
export function checkRecord(r: unknown): AppRecord {
  const bad = (what: string) => new AppsError('unavailable', `The record of installed software is damaged (${what}).`);
  if (!r || typeof r !== 'object') throw bad('not an object');
  const a = r as Record<string, unknown>;
  if (typeof a.id !== 'string' || !ID_RE.test(a.id)) throw bad('id');
  if (!isKind(a.kind)) throw bad(`kind of ${a.id}`);
  if (a.layout !== 'adopted-wordpress' && a.layout !== 'standard') throw bad(`layout of ${a.id}`);
  if (typeof a.user !== 'string' || !USER_RE.test(a.user)) throw bad(`user of ${a.id}`);
  const u = a.units as Record<string, unknown> | undefined;
  if (!u || typeof u.web !== 'string' || !UNIT_RE.test(u.web) || typeof u.db !== 'string' || !UNIT_RE.test(u.db)) throw bad(`units of ${a.id}`);
  if (!Number.isSafeInteger(a.port) || (a.port as number) < 1024 || (a.port as number) > 65535) throw bad(`port of ${a.id}`);
  for (const k of ['files', 'config', 'backups', 'dbVolume', 'placementFile'] as const) if (!path(a[k])) throw bad(`${k} of ${a.id}`);
  if (a.filesLink !== null && !path(a.filesLink)) throw bad(`filesLink of ${a.id}`);
  if (!unix(a.installedAt)) throw bad(`installedAt of ${a.id}`);
  if (a.adoptedAt !== null && !unix(a.adoptedAt)) throw bad(`adoptedAt of ${a.id}`);
  // phase 1 records have neither: online, and the adopted WordPress's login file
  // is where install-wordpress.sh wrote it
  const loginFile = a.loginFile === undefined ? (a.layout === 'adopted-wordpress' ? '/home/pamela/wordpress-login.txt' : null) : a.loginFile;
  if (loginFile !== null && !(path(loginFile) && /^\/home\/pamela\/(?:apps\/)?[^/]+$/.test(loginFile))) throw bad(`loginFile of ${a.id}`);
  const off = (a.offline ?? null) as { from?: unknown; at?: unknown } | null;
  const su = (a.setup ?? null) as { state?: unknown; step?: unknown; message?: unknown } | null;
  if (su !== null && (typeof su !== 'object' || (su.state !== 'installing' && su.state !== 'failed') || typeof su.step !== 'string' || su.step.length > 200
    || (su.message !== null && (typeof su.message !== 'string' || su.message.length > 1000)))) throw bad(`setup of ${a.id}`);
  const del = (a.deleted ?? null) as { at?: unknown; by?: unknown } | null;
  if (del !== null && (typeof del !== 'object' || !unix(del.at) || typeof del.by !== 'string' || !/^[\w.-]{1,40}$/.test(del.by))) throw bad(`deleted of ${a.id}`);
  if (del !== null && off === null) throw bad(`deleted of ${a.id} (not offline)`);
  if (off !== null && (typeof off !== 'object' || typeof off.from !== 'string' || !PLACEMENT_RE.test(off.from) || !unix(off.at))) throw bad(`offline of ${a.id}`);
  return {
    id: a.id, kind: a.kind, layout: a.layout, user: a.user, units: { web: u.web, db: u.db }, port: a.port as number,
    files: a.files as string, filesLink: a.filesLink as string | null, config: a.config as string, backups: a.backups as string,
    dbVolume: a.dbVolume as string, placementFile: a.placementFile as string, installedAt: a.installedAt, adoptedAt: a.adoptedAt as number | null,
    loginFile, offline: off === null ? null : { from: off.from as string, at: off.at as number },
    setup: su === null ? null : { state: su.state as 'installing' | 'failed', step: su.step as string, message: (su.message ?? null) as string | null },
    deleted: del === null ? null : { at: del.at as number, by: del.by as string },
  };
}

export function readState(dir: string): AppsState {
  let text: string;
  try {
    text = readFileSync(join(dir, STATE_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, apps: [] };
    throw new AppsError('unavailable', 'The record of installed software could not be read.');
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new AppsError('unavailable', 'The record of installed software is damaged (not JSON).'); }
  const s = raw as { version?: unknown; apps?: unknown };
  if (!s || s.version !== 1 || !Array.isArray(s.apps)) throw new AppsError('unavailable', 'The record of installed software is damaged (its shape).');
  const apps = s.apps.map(checkRecord);
  const ids = new Set(apps.map((a) => a.id));
  if (ids.size !== apps.length) throw new AppsError('unavailable', 'The record of installed software is damaged (an id twice).');
  return { version: 1, apps };
}

// A new file beside the old one, then a rename: a crash leaves one or the other,
// never half of each. Root's, 600 -- nothing else on the machine reads it.
export function writeState(dir: string, state: AppsState): void {
  for (const a of state.apps) checkRecord(a);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, STATE_FILE);
  const tmp = join(dirname(file), `.${STATE_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function findApp(state: AppsState, id: unknown): AppRecord {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new AppsError('not-found', 'There is no such software.');
  const a = state.apps.find((x) => x.id === id);
  if (!a) throw new AppsError('not-found', 'There is no such software.');
  return a;
}

// Take one app out of the record (deleted for good, 4c).
export function removeApp(dir: string, id: string): void {
  const state = readState(dir);
  writeState(dir, { version: 1, apps: state.apps.filter((a) => a.id !== id) });
}

// Change one app's record: read, change, check, write -- the helper is the only
// writer, and one change at a time (jobs.ts), so there is no one to race.
export function updateApp(dir: string, id: string, change: (a: AppRecord) => AppRecord): AppRecord {
  const state = readState(dir);
  const i = state.apps.findIndex((a) => a.id === id);
  if (i < 0) throw new AppsError('not-found', 'There is no such software.');
  const next = checkRecord(change(state.apps[i]!));
  state.apps[i] = next;
  writeState(dir, state);
  return next;
}

// A new install's names and places (4b, P4b), from its id alone.
export function standardRecord(id: string, port: number, now: number): AppRecord {
  const user = `svc-app-${id}`;
  const home = `/var/lib/${user}`;
  return checkRecord({
    id, kind: 'wordpress', layout: 'standard', user,
    units: { web: `app-${id}-web`, db: `app-${id}-db` }, port,
    files: `/srv/pamela-apps/${id}`, filesLink: `/pamela/apps/${id}`,
    config: `${home}/config`, backups: `${home}/backups`,
    dbVolume: `${home}/.local/share/containers/storage/volumes/app-${id}-db/_data`,
    placementFile: `/etc/nginx/pammy-wordpress/placement-${id}`,
    installedAt: now, adoptedAt: null,
    loginFile: `/home/pamela/apps/${id}-login.txt`,
    offline: null, setup: { state: 'installing', step: 'Starting', message: null }, deleted: null,
  });
}
