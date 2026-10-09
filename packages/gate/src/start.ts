// A site's gate (pammy-gate.service, lfdln-gate.service): protected folders and
// visitor sign-in for the profile's website (docs/accounts-plan.md step 3). The
// same code for every site; sites/<name>/src/gate/main.ts starts it with its profile.
// HTTP for nginx on the profile's gate address (127.0.0.1:3045 for pammy.org); the admin
// socket arrives from systemd (<unit>-admin.socket), or GATE_ADMIN_SOCKET when run by hand.
//
// Its data is in the site's Postgres (schema gate, role pammy_gate). It starts
// without waiting for it -- at boot a system service can't wait for a user one --
// and answers from the areas it saved last time until Postgres is reached
// (live.ts, docs/postgres-plan.md P14).
import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { connectPg } from '@panel/core/pg';
import { createGateAdminServer } from './admin.ts';
import { buildGateApp } from './app.ts';
import { createPhpServer } from '@panel/php/gate/php-socket';
import { installExamples } from '@panel/examples/gate/examples';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import { SiteRoutes } from '@panel/core/gate/site-routes';
import { socketMailer } from '@panel/core/gate/context';
import { gateHousekeeping } from './housekeeping.ts';
import { retrySaves } from '@panel/form-links/gate/saves/save';
import { fact, isOn, type SiteProfile } from '@panel/core/profile';
import { privateKeyOf } from '@panel/core/identity-proof';
import { loadEdgeSecret } from '@panel/core/security';

// unit: the service's name (pammy-gate), which also names its sockets (<unit>-admin.socket,
// <unit>-php.socket) and its database connection; passwordFile: where the password is
// when systemd doesn't hand it over (run by hand)
export async function startGate(profile: SiteProfile, site: { unit: string; passwordFile: string }) {
  const PROFILE = profile;
  const env = process.env;
  const sv = PROFILE.services;
  const gate = fact(sv.gate, 'services.gate');
  const now = () => Math.floor(Date.now() / 1000);
  // the password: systemd's LoadCredential= (db.pass), or a file named here
  const passwordFile = env.GATE_PG_PASSWORD_FILE
    ?? (env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, 'db.pass') : site.passwordFile);
  const sql = connectPg({
    role: 'gate', passwordFile, app: site.unit,
    host: env.GATE_PG_HOST ?? sv.pg.host, port: Number(env.GATE_PG_PORT ?? sv.pg.port), database: env.GATE_PG_DATABASE ?? sv.pg.database,
    max: 8,
  });
  const publicRoot = env.GATE_PUBLIC ?? PROFILE.website.public;
  const domain = env.GATE_DOMAIN ?? PROFILE.domain;
  let log: (line: string) => void = (line) => console.error(line);
  // the routes, on a site with hosts (docs/phase8-plan.md 8-2): the routing helper's
  // gate-routes.json beside the host files; GATE_ROUTES when run by hand
  const routesFile = env.GATE_ROUTES ?? (isOn(PROFILE, 'hosts') && PROFILE.hosts ? join(PROFILE.hosts.dir, 'gate-routes.json') : null);
  const routes = routesFile ? new SiteRoutes(routesFile, (line) => log(line)) : null;
  const live = new GateLive(sql, { sessions: visitorSessions, now, snapshot: env.GATE_AREAS_SNAPSHOT ?? gate.snapshot, log: (line) => log(line), routes });
  // the media API (docs/media-api-plan.md M2): the panel's published index and thumbnails
  // the database helper, for the data API, forms and comments: the gate's own door
  // (<site>-pammydb-gate.socket, only the gate's user may open it), which answers row ops
  // only (S2, docs/s2-plan.md). The panel's door is no longer the gate's.
  const pammydbSocket = env.GATE_PAMMYDB_SOCKET ?? sv.sockets.pammydbGate;
  // the gate's door to the mail service, where the site has one (docs/accounts-plan.md step 4)
  const mailVisitor = env.GATE_MAIL_SOCKET ?? sv.sockets.mailVisitor;
  const visitorMail = isOn(PROFILE, 'mail') && mailVisitor ? socketMailer(mailVisitor) : null;
  // the key it signs what apps are told with (docs/s1-plan.md S1a): systemd's
  // LoadCredential identity.key, or GATE_IDENTITY_KEY when run by hand; a site without
  // one (pammy.org) makes no proofs. One that is there but unreadable stops it here.
  const keyFile = env.GATE_IDENTITY_KEY
    ?? (env.CREDENTIALS_DIRECTORY && existsSync(join(env.CREDENTIALS_DIRECTORY, 'identity.key')) ? join(env.CREDENTIALS_DIRECTORY, 'identity.key') : null);
  const identityKey = keyFile ? privateKeyOf(readFileSync(keyFile, 'utf8')) : null;
  // nginx's edge secret (docs/s1-plan.md S1c): X-Real-IP is believed only with it
  const edge = loadEdgeSecret(env, 'GATE');
  const app = buildGateApp(PROFILE, {
    publicRoot, domain, now, pammydbSocket, visitorMail, identityKey,
    mediaIndex: env.GATE_MEDIA_INDEX, mediaThumbs: env.GATE_MEDIA_THUMBS,
  }, live, { logger: true });
  log = (line) => app.log.info(line);
  log(edge.says);
  log(identityKey ? 'signing what apps are told (identity key loaded)' : 'no identity key: apps behind routes with accounts get no proof');
  const admin = createGateAdminServer(live, now, (line) => app.log.info(line), { publicRoot, domain, pammydbSocket, modules: PROFILE.modules, visitorMail });

  // Sockets from systemd, by name: the admin door, and PHP's door to the API
  // (pammy-gate-php.socket, docs/tutorials-plan.md P3) when it is installed.
  const fds = new Map<string, number>();
  if (env.LISTEN_PID === String(process.pid)) {
    const names = (env.LISTEN_FDNAMES ?? '').split(':');
    // each is named after its socket unit (LISTEN_FDNAMES); a lone unnamed one is the admin door, as before
    const kind = (n: string | undefined, i: number) => (n === `${site.unit}-php.socket` ? 'php' : n === `${site.unit}-admin.socket` || (!n && i === 0) ? 'admin' : `fd${i}`);
    for (let i = 0; i < Number(env.LISTEN_FDS ?? 0); i++) fds.set(kind(names[i], i), 3 + i);
  }
  const php = createPhpServer((req, res) => app.routing(req, res), domain);
  if (fds.has('admin')) {
    admin.listen({ fd: fds.get('admin')! });
  } else if (env.GATE_ADMIN_SOCKET) {
    try { unlinkSync(env.GATE_ADMIN_SOCKET); } catch { /* not there */ }
    admin.listen(env.GATE_ADMIN_SOCKET, () => chmodSync(env.GATE_ADMIN_SOCKET!, 0o600));
  } else {
    console.error(`${site.unit}: no admin socket (expected systemd socket activation or GATE_ADMIN_SOCKET)`);
    process.exit(2);
  }

  // The worked examples (examples.ts): a new database has none; one moved from SQLite already has them.
  live.start(() => (isOn(PROFILE, 'examples') ? installExamples(sql, now(), domain) : Promise.resolve()));
  // Only before the very first start: nothing is let through on a guess
  if (!live.areasKnown) app.log.warn('no saved areas yet: pages in folders get 503 until the database is reached');
  setInterval(() => {
    if (live.ready) gateHousekeeping(sql, now(), PROFILE.modules).catch((e: unknown) => app.log.warn({ err: e }, 'housekeeping failed'));
  }, 3600_000).unref();
  // forms that save into a database: responses whose database was asleep, tried
  // again every 15 minutes, for about a day (docs/form-to-database-plan.md F10)
  if (isOn(PROFILE, 'form-links')) setInterval(() => {
    if (live.ready) retrySaves(sql, now(), pammydbSocket ?? '').catch((e: unknown) => app.log.warn({ err: e }, 'saving responses again failed'));
  }, 900_000).unref();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      admin.close();
      php.close();
      live.stop();
      void app.close().then(() => sql.end({ timeout: 5 })).then(() => process.exit(0));
    });
  }
  await app.listen({ host: env.GATE_HOST ?? gate.host, port: Number(env.GATE_PORT ?? gate.port) });
  // only once the app is ready: app.routing needs its routes
  if (fds.has('php')) php.listen({ fd: fds.get('php')! });
  else if (env.GATE_PHP_SOCKET) {
    try { unlinkSync(env.GATE_PHP_SOCKET); } catch { /* not there */ }
    php.listen(env.GATE_PHP_SOCKET, () => chmodSync(env.GATE_PHP_SOCKET!, 0o660));
  }
}
