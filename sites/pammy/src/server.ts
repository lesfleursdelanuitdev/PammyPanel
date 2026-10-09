import { logActivity } from '@panel/core/accounts';
import { buildApp, recordKeeper } from './app.ts';
import { loadConfig } from '@panel/core/config';
import { loadEdgeSecret } from '@panel/core/security';
import { REGISTRY } from '@panel/modules/index';
import { PROFILE } from './profile.ts';
import { isOn } from '@panel/core/profile';
import { MediaSync } from '@panel/files/media-sync';
import { Thumbnailer } from '@panel/thumbs/media-thumbs';
import { checkSchema, connectPg, run } from '@panel/core/pg';
import { callSiteFs } from '@panel/files/sitefs/client';
import { callJsonLine } from '@panel/core/jsonline';
import { existsSync } from 'node:fs';
import { followSoftware, type Install } from './nginx-hosts.ts';
import { callMail } from '@panel/mail/mail/client';
import { Notifier, NOTICE_EVERY } from '@panel/mail/panel/notices';

const config = loadConfig(PROFILE, REGISTRY);
// nginx's edge secret (docs/s1-plan.md S1c): X-Real-IP is believed only with it
const edge = loadEdgeSecret(process.env, 'PANEL');
console.error(`pammy-panel: ${edge.says}`);
// pammy-pg (docs/postgres-plan.md). Unlike the gate, the panel waits for it: every
// page needs a signed-in account, and at boot it starts after the gate anyway.
const db = connectPg({ role: 'panel', passwordFile: config.pgPasswordFile, passwordFd: config.pgPasswordFd, host: config.pgHost, port: config.pgPort, database: config.pgDatabase, max: 8, app: 'pammy-panel' });
for (let wait = 1; ; wait = Math.min(wait * 2, 30)) {
  try {
    await checkSchema(db);
    break;
  } catch (e) {
    console.error(`pammy-panel: database not ready (retrying in ${wait}s): ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}
const media = new MediaSync(db, config.sitefsSocket, config.now);
const thumbs = new Thumbnailer(db, config.thumbsSocket, config.thumbsDir, config.now);
const keeper = isOn(PROFILE, 'studio') && isOn(PROFILE, 'catalog') ? recordKeeper(config, db) : undefined;
const app = buildApp(config, db, { logger: true, media, thumbs, keeper });

// pammy.org's nginx from the hosts rows (docs/phase8-plan.md 8-7b): the software routes follow
// the installs' placements, every 20 seconds, once the routing helper is installed (a move or
// an install waits up to 90 seconds for its new address to answer, 8-7d)
if (config.routesSocket && isOn(PROFILE, 'apps')) {
  const routesSocket = config.routesSocket;
  const follow = async () => {
    if (!existsSync(routesSocket)) return;
    try {
      const { apps } = await callJsonLine<{ apps: Install[] }>(config.appsSocket, { op: 'list', actor: 'the panel' }, 'the software helper');
      const changed = await followSoftware(db, routesSocket, apps, config.now());
      if (changed.length) app.log.info({ changed }, "pammy.org's software routes follow the installs");
    } catch (e) {
      app.log.warn({ err: e }, "pammy.org's software routes not brought up to date");
    }
  };
  setInterval(() => void follow(), 20_000).unref();
  setTimeout(() => void follow(), 10_000).unref();
}

// Housekeeping, hourly: expired ceremonies, long-dead sessions, and folders
// that have been in the trash for 30 days. Activity is kept.
async function housekeeping() {
  const now = config.now();
  try {
    await run(db, 'DELETE FROM ceremonies WHERE expires_at <= ?', now);
    await run(db, 'DELETE FROM sessions WHERE expires_at <= ? OR revoked_at <= ?', now - 30 * 86400, now - 30 * 86400);
  } catch (e) {
    app.log.warn({ err: e }, 'session clean-up skipped');
  }
  if (isOn(PROFILE, 'files')) try {
    const r = await callSiteFs<{ purged: string[]; failed: string[] }>(config.sitefsSocket, { op: 'purge', actor: 'automatic cleanup' });
    const cleanup = { id: null, label: 'automatic cleanup' };
    for (const entry of r.purged) await logActivity(db, config.now(), cleanup, 'trash-purged', entry.replace(/--\d{8}T\d{6}Z$/, ''), 'deleted permanently after 30 days in the trash');
    if (r.failed.length) app.log.warn({ failed: r.failed }, 'could not purge some trash entries');
  } catch (e) {
    app.log.warn({ err: e }, 'trash purge skipped');
  }
  // thumbnails of files that are gone for good, or whose content changed
  if (isOn(PROFILE, 'files')) try { await thumbs.clean(); } catch (e) { app.log.warn({ err: e }, 'thumbnail clean-up skipped'); }
}
setInterval(() => void housekeeping(), 3600_000).unref();
setTimeout(() => void housekeeping(), 60_000).unref();

// Media records (docs/media-plan.md D16): a sync every 15 minutes, which also
// forgets files missing or trashed for 30 days and works out some hashes.
const mediaSync = () => media.sync('automatic check').catch((e: unknown) => app.log.warn({ err: e }, 'media sync skipped'));
if (isOn(PROFILE, 'files')) {
  setInterval(() => void mediaSync(), 15 * 60_000).unref();
  setTimeout(() => void mediaSync(), 90_000).unref();
}
// Email notices (docs/apps-plan.md phase 3): a look at the gate every minute
const notifier = new Notifier(db,
  (req) => callJsonLine(config.gateSocket, req, 'protected-folder service'),
  (req) => callMail(config.mailSocket, req),
  config.origin, config.now);
notifier.log = (msg, err) => app.log.warn({ err }, msg);
const notices = () => notifier.look().catch((e: unknown) => app.log.warn({ err: e }, 'email notices skipped'));
if (isOn(PROFILE, 'mail')) {
  setInterval(() => void notices(), NOTICE_EVERY).unref();
  setTimeout(() => void notices(), 20_000).unref();
}

// Her tagged tables (docs/catalog-plan.md step 4): the gate's writes every minute, and a
// full listing every 15 minutes (which also forgets records missing for 30 days).
if (keeper) {
  const touches = () => keeper.takeTouches().catch((e: unknown) => app.log.warn({ err: e }, 'taking the gate\'s record touches skipped'));
  const listing = () => keeper.readAll().catch((e: unknown) => app.log.warn({ err: e }, 'reading tagged tables skipped'));
  setInterval(() => void touches(), 60_000).unref();
  setInterval(() => void listing(), 15 * 60_000).unref();
  setTimeout(() => void listing(), 120_000).unref();
}

// thumbnails still waiting from before a restart (each sync's hashes start the rest)
if (isOn(PROFILE, 'files')) setTimeout(() => void thumbs.kick(), 30_000).unref();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void app.close().then(() => db.end({ timeout: 5 })).then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
