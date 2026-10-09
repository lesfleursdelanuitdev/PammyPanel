// lfdln-panel.service: lfdln's panel on 127.0.0.1:3046, behind nginx.
import { logActivity } from '@panel/core/accounts';
import { loadConfig } from '@panel/core/config';
import { loadEdgeSecret } from '@panel/core/security';
import { REGISTRY } from '@panel/modules/index';
import { checkSchema, connectPg, run } from '@panel/core/pg';
import { callSiteFs } from '@panel/files/sitefs/client';
import { callJsonLine } from '@panel/core/jsonline';
import { isOn } from '@panel/core/profile';
import { callServices, type PortOf } from '@panel/services/client';
import { passOnDeletions } from '@panel/services/panel/account-deleted';
import { pruneBackups } from '@panel/services/panel/backups';
import { appKeeperOf, buildApp, monitorOf, recordKeeper } from './app.ts';
import { hookKey, hookKeyFile } from './hook-keys.ts';
import { doorApp } from '@panel/catalog/panel/door';
import { ROUND_EVERY } from '@panel/monitoring/panel/monitor';
import { Notifier, NOTICE_EVERY } from '@panel/mail/panel/notices';
import { callMail } from '@panel/mail/mail/client';
import { PROFILE } from './profile.ts';
import { MediaSync } from '@panel/files/media-sync';
import { Thumbnailer } from '@panel/thumbs/media-thumbs';

const config = loadConfig(PROFILE, REGISTRY);
// nginx's edge secret (docs/s1-plan.md S1c): X-Real-IP is believed only with it
const edge = loadEdgeSecret(process.env, 'PANEL');
console.error(`lfdln-panel: ${edge.says}`);
// its own Postgres (svc-lfdlnpanel-db, :5435): the panel waits for it, as pammy.org's does
const db = connectPg({ role: 'panel', passwordFile: config.pgPasswordFile, passwordFd: config.pgPasswordFd, host: config.pgHost, port: config.pgPort, database: config.pgDatabase, max: 8, app: 'lfdln-panel' });
for (let wait = 1; ; wait = Math.min(wait * 2, 30)) {
  try {
    await checkSchema(db);
    break;
  } catch (e) {
    console.error(`lfdln-panel: database not ready (retrying in ${wait}s): ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}
// the site folders' file records and thumbnails (docs/phase8-plan.md step 8-1)
const media = new MediaSync(db, config.sitefsSocket, config.now);
const thumbs = new Thumbnailer(db, config.thumbsSocket, config.thumbsDir, config.now);
// tagged tables' records in the catalog (docs/phase8-plan.md step 8-4, as pammy.org's)
const records = isOn(config.site, 'studio') && isOn(config.site, 'catalog') ? recordKeeper(config, db) : undefined;
const app = buildApp(config, db, { logger: true, media, thumbs, records });

// Housekeeping, hourly: expired ceremonies, long-dead sessions, and site folders
// that have been in the trash for 30 days. Activity is kept.
async function housekeeping() {
  const now = config.now();
  try {
    await run(db, 'DELETE FROM ceremonies WHERE expires_at <= ?', now);
    await run(db, 'DELETE FROM sessions WHERE expires_at <= ? OR revoked_at <= ?', now - 30 * 86400, now - 30 * 86400);
  } catch (e) {
    app.log.warn({ err: e }, 'session clean-up skipped');
  }
  try {
    const r = await callSiteFs<{ purged: string[]; failed: string[] }>(config.sitefsSocket, { op: 'purge', actor: 'automatic cleanup' });
    const cleanup = { id: null, label: 'automatic cleanup' };
    for (const entry of r.purged) await logActivity(db, config.now(), cleanup, 'trash-purged', entry.replace(/--\d{8}T\d{6}Z$/, ''), 'deleted permanently after 30 days in the trash');
    if (r.failed.length) app.log.warn({ failed: r.failed }, 'could not purge some trash entries');
  } catch (e) {
    app.log.warn({ err: e }, 'trash purge skipped');
  }
  // thumbnails of files that are gone for good, or whose content changed
  if (isOn(config.site, 'files')) try { await thumbs.clean(); } catch (e) { app.log.warn({ err: e }, 'thumbnail clean-up skipped'); }
}
setInterval(() => void housekeeping(), 3600_000).unref();
setTimeout(() => void housekeeping(), 60_000).unref();

// File records (docs/media-plan.md D16): a sync every 15 minutes, which also forgets files
// missing or trashed for 30 days and works out some hashes; thumbnails still waiting from
// before a restart
if (isOn(config.site, 'files')) {
  const sync = () => media.sync('automatic check').catch((e: unknown) => app.log.warn({ err: e }, 'file sync skipped'));
  setInterval(() => void sync(), 15 * 60_000).unref();
  setTimeout(() => void sync(), 90_000).unref();
  setTimeout(() => void thumbs.kick(), 30_000).unref();
}

// Email notices (step 8-5, as pammy.org's): a look at the gate every minute for new responses,
// comments waiting and access requests, as Settings > Email asks
if (isOn(config.site, 'mail') && isOn(config.site, 'forms')) {
  const notifier = new Notifier(db,
    (req) => callJsonLine(config.gateSocket, req, 'the gate'),
    (req) => callMail(config.mailSocket, req),
    config.origin, config.now);
  notifier.log = (msg, err) => app.log.warn({ err }, msg);
  const notices = () => notifier.look().catch((e: unknown) => app.log.warn({ err: e }, 'email notices skipped'));
  setInterval(() => void notices(), NOTICE_EVERY).unref();
  setTimeout(() => void notices(), 20_000).unref();
}

// Tagged tables (docs/catalog-plan.md step 4): the gate's writes every minute, and a full
// listing every 15 minutes (which also forgets records missing for 30 days)
if (records) {
  const touches = () => records.takeTouches().catch((e: unknown) => app.log.warn({ err: e }, 'taking the gate\'s record touches skipped'));
  const listing = () => records.readAll().catch((e: unknown) => app.log.warn({ err: e }, 'reading tagged tables skipped'));
  setInterval(() => void touches(), 60_000).unref();
  setInterval(() => void listing(), 15 * 60_000).unref();
  setTimeout(() => void listing(), 120_000).unref();
}

// Deleted accounts, passed on to the apps behind routes with accounts (docs/accounts-plan.md Q1,
// step 4b), every minute. Their keys are the credential hooks (lfdln-panel.service), one file each.
if (isOn(config.site, 'people') && isOn(config.site, 'services') && config.servicesSocket) {
  let busy = false;
  const round = async () => {
    if (busy) return;
    busy = true;
    try {
      await passOnDeletions({
        db, now: config.now, keyFile: hookKeyFile, log: (m) => app.log.warn(m),
        gate: (req) => callJsonLine(config.gateSocket, req, 'protected-folder service'),
        ports: async () => (await callServices<{ parts: PortOf[] }>(config.servicesSocket!, { op: 'ports' })).parts,
      });
    } catch (e) {
      app.log.warn({ err: e }, 'deleted accounts not passed on this round');
    } finally {
      busy = false;
    }
  };
  setInterval(() => void round(), 60_000).unref();
  setTimeout(() => void round(), 15_000).unref();
}

// The database copies older than Settings > Backups says (docs/lfdln-mariadb-plan.md B2): every
// hour, the first 10 minutes after start (after a night's backup at 05:00-05:25 UTC, the next hour)
if (isOn(config.site, 'services') && config.servicesSocket) {
  const prune = () => pruneBackups(db, config.servicesSocket!, config.now, { id: null, label: 'automatic cleanup' })
    .catch((e: unknown) => app.log.warn({ err: e }, 'pruning the database backups skipped'));
  setInterval(() => void prune(), 3600_000).unref();
  setTimeout(() => void prune(), 10 * 60_000).unref();
}

// Monitoring (docs/monitoring-plan.md M6): a round every 5 minutes, the first a minute after start
const monitor = monitorOf.get(app);
if (monitor) {
  const round = () => void monitor.round().catch((e) => app.log.warn({ err: e }, 'monitoring round failed'));
  setInterval(round, ROUND_EVERY).unref();
  setTimeout(round, 60_000).unref();
}

// The services' things in the catalog (docs/catalog-plan.md step 5): their lists read every
// 15 minutes, the first 2 minutes after start; and the app's door, on its own port on
// 127.0.0.1, which nginx never sends anything to (S5-4).
const keeper = appKeeperOf.get(app);
const door = keeper ? doorApp(keeper, { key: hookKey, logger: true }) : null;
if (keeper) {
  let busy = false;
  const round = async () => {
    if (busy) return;
    busy = true;
    try {
      await keeper.readAll();
    } catch (e) {
      app.log.warn({ err: e }, 'reading the services\' lists for the catalog failed');
    } finally {
      busy = false;
    }
  };
  setInterval(() => void round(), 15 * 60_000).unref();
  setTimeout(() => void round(), 120_000).unref();
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void Promise.all([app.close(), door?.close()]).then(() => db.end({ timeout: 5 })).then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
if (door) await door.listen({ host: '127.0.0.1', port: Number(process.env.PANEL_DOOR_PORT ?? 3048) });
