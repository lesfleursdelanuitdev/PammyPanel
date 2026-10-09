// Runtime settings. In production they come from /etc/pammy-panel/panel.env
// (EnvironmentFile= in the unit, and sourced by the pammy-panel wrapper), so the
// service and the command-line tool always agree on the database and address;
// what panel.env doesn't say comes from the site's profile (sites/<name>/src/profile.ts).

import { join } from 'node:path';
import { appPath } from './paths.ts';
import { checkFacts, checkModules, type ModuleRegistry } from './module.ts';
import { siteFacts, type SiteFacts, type SiteProfile } from './profile.ts';

export type Config = {
  site: SiteFacts;         // the website this panel looks after: its domain, names, modules on
  origin: string;          // https://panel.<domain> -- also the WebAuthn origin
  rpID: string;            // panel.<domain> -- NOT the domain itself, so no page on her other hostnames can ask for these passkeys
  rpName: string;
  // the panel's Postgres (docs/postgres-plan.md): pammy-pg, schemas panel (accounts)
  // and media (a record per file, docs/media-plan.md D14), role pammy_panel
  pgPasswordFile: string;  // systemd's LoadCredential= (db.pass), else /etc/pammy-panel/db/panel.pass
  pgPasswordFd?: number;   // or an open fd, which is how /usr/local/sbin/pammy-panel hands it over
  pgHost?: string;         // 127.0.0.1
  pgPort?: number;         // 5434
  pgDatabase?: string;     // pammy
  host: string;
  port: number;
  publicDir: string;
  helpDir: string;         // the site's guides and their map, copied in by build.sh (the Help tab)
  sitefsSocket: string;    // the website folder helper (pammy-sitefs.socket)
  gateSocket: string;      // the gate's admin socket (pammy-gate-admin.socket)
  thumbsSocket: string;    // the thumbnail service (pammy-thumbs.socket)
  pammydbSocket: string;   // the database helper for her own engines (pammy-pammydb.socket)
  appsSocket: string;      // the software helper, WordPress (pammy-apps.socket, docs/apps-plan.md)
  rootfsSockets?: string;  // each installed software's files helper, "{id}" its id (pammy-rootfs@.socket, docs/catalog-plan.md step 3)
  mailSocket: string;      // the mail service, Resend (pammy-mail.socket, docs/apps-plan.md phase 3)
  routesSocket?: string;   // the routing helper, on a site with the hosts module (lfdln-routes.socket, docs/hosts-plan.md H7)
  projectsSocket?: string; // the projects helper, on a site with the projects module (lfdln-projects.socket, docs/phase8b-plan.md)
  servicesSocket?: string; // the services helper, on a site with the services module (lfdln-services.socket, docs/adopt-plan.md V7)
  thumbsDir: string;       // where the panel keeps the thumbnails it was given (the gate reads them too)
  mediaPublicDir: string;  // the media API's index.db, for the gate (docs/media-api-plan.md M2)
  // the tutorial examples (docs/tutorial-examples-plan.md): the tutorials' files as
  // shipped, where the panel writes the examples' copies (PHP reads them there),
  // and the gate's own address, which the examples' pages ask through the panel
  tutorialsDir: string;
  tutorialExamplesDir: string;
  gateUrl: string;
  now: () => number;       // unix seconds; tests replace it to move time forward
};

// Panel sessions. Visitor sessions for protected folders (phase 3) are separate
// and last 30 days; these guard the admin side, where a passkey tap is cheap.
export const SESSION_IDLE = 8 * 3600;
export const SESSION_MAX = 7 * 24 * 3600;
// Adding/removing passkeys and managing accounts needs a passkey check this recent.
export const RECENT_AUTH = 10 * 60;
export const CEREMONY_TTL = 5 * 60;
export const INVITE_TTL = 24 * 3600;

// modules: every module's definition (@panel/modules' REGISTRY), which the site hands in:
// the kernel names no module, so it can only check the profile against what it is given
export function loadConfig(profile: SiteProfile, modules: ModuleRegistry, env: NodeJS.ProcessEnv = process.env): Config {
  checkModules(profile.modules, modules);
  checkFacts(profile, modules);
  const origin = required(env, 'PANEL_ORIGIN');
  const url = new URL(origin);
  if (url.origin !== origin) throw new Error(`PANEL_ORIGIN must be a bare origin like ${profile.panelOrigin}, got ${origin}`);
  const sv = profile.services;
  // where the thumbnails and the media API's index live: the profile's folder, which the
  // gate reads too, unless a test gives the panel a data folder of its own
  // A helper or folder of a module the site has off is '' (checkFacts made sure every
  // module that is on has its own): nothing that runs on such a site asks for it.
  const mediaPublic = env.PANEL_DATA_DIR ? join(env.PANEL_DATA_DIR, 'media-public') : sv.mediaPublic ?? '';
  const gate = sv.gate;
  return {
    site: siteFacts(profile),
    origin,
    rpID: env.PANEL_RP_ID ?? url.hostname,
    rpName: env.PANEL_RP_NAME ?? profile.panelName,
    pgPasswordFile: env.PANEL_PG_PASSWORD_FILE
      ?? (env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, 'db.pass') : '/etc/pammy-panel/db/panel.pass'),
    pgPasswordFd: env.PANEL_PG_PASSWORD_FD ? Number(env.PANEL_PG_PASSWORD_FD) : undefined,
    pgHost: env.PANEL_PG_HOST || sv.pg.host,
    pgPort: env.PANEL_PG_PORT ? Number(env.PANEL_PG_PORT) : sv.pg.port,
    pgDatabase: env.PANEL_PG_DATABASE || sv.pg.database,
    host: env.PANEL_HOST ?? sv.panel.host,
    port: Number(env.PANEL_PORT ?? sv.panel.port),
    publicDir: env.PANEL_PUBLIC_DIR ?? `${appPath('public')}/`,
    helpDir: env.PANEL_HELP_DIR ?? `${appPath('help')}/`,
    sitefsSocket: env.PANEL_SITEFS_SOCKET ?? sv.sockets.sitefs,
    gateSocket: env.PANEL_GATE_SOCKET ?? sv.sockets.gateAdmin ?? '',
    thumbsSocket: env.PANEL_THUMBS_SOCKET ?? sv.sockets.thumbs ?? '',
    pammydbSocket: env.PANEL_PAMMYDB_SOCKET ?? sv.sockets.pammydb ?? '',
    appsSocket: env.PANEL_APPS_SOCKET ?? sv.sockets.apps ?? '',
    rootfsSockets: env.PANEL_ROOTFS_SOCKETS ?? '/run/pammy-rootfs-{id}.sock',
    mailSocket: env.PANEL_MAIL_SOCKET ?? sv.sockets.mail ?? '',
    routesSocket: env.PANEL_ROUTES_SOCKET ?? sv.sockets.routes,
    servicesSocket: env.PANEL_SERVICES_SOCKET ?? sv.sockets.services,
    projectsSocket: env.PANEL_PROJECTS_SOCKET ?? sv.sockets.projects,
    thumbsDir: env.PANEL_THUMBS_DIR ?? (mediaPublic && join(mediaPublic, 'thumbs')),
    mediaPublicDir: env.PANEL_MEDIA_PUBLIC ?? mediaPublic,
    tutorialsDir: env.PANEL_TUTORIALS_DIR ?? `${appPath('tutorials')}/`,
    tutorialExamplesDir: env.PANEL_TUTORIAL_EXAMPLES_DIR ?? sv.tutorialExamples ?? '',
    gateUrl: env.PANEL_GATE_URL ?? (gate ? `http://${gate.host}:${gate.port}` : ''),
    now: () => Math.floor(Date.now() / 1000),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
