// lfdln's panel API (docs/lfdln-standup-plan.md L1): the shell every panel has, and
// the routes of the modules its profile switches on. Phase 5: the core (pages,
// signing in, Activity, Accounts) and hosts (hosts, routes and site folders);
// phase 6: services (docs/adopt-plan.md); visitors' accounts on routes: People, Access,
// Requests and Settings > Visitors (docs/roles-plan.md step 6); phase 8 (docs/phase8-plan.md):
// File Explorer over the site folders, with thumbnails (step 8-1); media folders and
// API keys (step 8-3); the Studio on lfdln-appdb, the apps' databases read-only (step 8-4).
import { rename, writeFile } from 'node:fs/promises';
import { type FastifyInstance, type RouteOptions } from 'fastify';
import { type Config } from '@panel/core/config';
import { type Sql } from '@panel/core/pg';
import { panelContext } from '@panel/core/panel/context';
import { notHere, panelShell } from '@panel/core/panel/shell';
import { routes as signInRoutes } from '@panel/core/panel/routes/sign-in';
import { routes as activityRoutes } from '@panel/core/panel/routes/activity';
import { routes as accountRoutes } from '@panel/core/panel/routes/accounts';
import { callSiteFs } from '@panel/files/sitefs/client';
import { nextPage, PAGE_PATHS } from '@panel/files/panel/pages-list';
import { routes as pagesRoutes } from '@panel/files/panel/routes/pages';
import { routes as hostsRoutes } from '@panel/hosts/panel/routes/hosts';
import { folderAddresses, foldersShownOn, routeTarget } from '@panel/hosts/panel/folders-shown';
import { callServices, type PortOf } from '@panel/services/client';
import { AccountError } from '@panel/core/accounts';
import { CallError } from '@panel/core/jsonline';
import { HELPER_STATUS } from '@panel/core/panel/context';
import { one } from '@panel/core/pg';
import { isOn, type Module } from '@panel/core/profile';
import { callMail } from '@panel/mail/mail/client';
import { folderManifest, routes as accessRoutes } from '@panel/areas/panel/routes/access';
import { routes as peopleRoutes } from '@panel/people/panel/routes/people';
import { routes as requestRoutes } from '@panel/requests/panel/routes/requests';
import { routes as visitorSettingsRoutes } from '@panel/settings/panel/routes/visitor-settings';
import { routes as servicesRoutes } from '@panel/services/panel/routes/services';
import { routes as projectsRoutes } from '@panel/projects/panel/routes/projects';
import { routes as gitRoutes } from '@panel/projects/panel/routes/git';
import { projectRouteKind, projectsAndMaking, type ProjectsList } from '@panel/projects/panel/route-kind';
import { callProjects } from '@panel/projects/client';
import { routes as backupsRoutes } from '@panel/services/panel/routes/backups';
import { serviceRouteKind } from '@panel/services/panel/route-kind';
import { callJsonLine } from '@panel/core/jsonline';
import { all, run } from '@panel/core/pg';
import { homeDomain } from '@panel/hosts/domains';
import { collect, type HostCheckLike, type ProjectServerLike, type RecordGot, type RecordWant, type RegistrationLike, type ServiceLike, type StorageLike, type UrlGot, type UrlWant } from '@panel/monitoring/panel/collect';
import { routes as monitoringRoutes } from '@panel/monitoring/panel/routes/monitoring';
import { connect } from 'node:net';
import { AppKeeper, type AppDeps } from '@panel/catalog/apps';
import { LabelError } from '@panel/catalog/labels';
import { routes as appTagRoutes } from '@panel/catalog/panel/routes/apps';
import { routes as everywhereRoutes } from '@panel/catalog/panel/routes/everywhere';
import { hookKey } from './hook-keys.ts';
import { logActivity } from '@panel/core/accounts';
import { describeSync, MediaSync } from '@panel/files/media-sync';
import { Thumbnailer } from '@panel/thumbs/media-thumbs';
import { filesParts, withFolderPlaces } from '@panel/files/panel/files-ctx';
import { routes as labelRoutes } from '@panel/files/panel/routes/labels';
import { routes as filesRoutes } from '@panel/files/panel/routes/files';
import { routes as editorRoutes } from '@panel/files/panel/routes/editor';
import { Publisher } from '@panel/media/media-public';
import { routes as mediaRoutes } from '@panel/media/panel/routes/media';
import { mediaCover } from '@panel/media/panel/api-key-cover';
import { routes as apiKeyRoutes } from '@panel/api-keys/panel/routes/api-keys';
import { routes as formsRoutes } from '@panel/forms/panel/routes/forms';
import { formsCover } from '@panel/forms/panel/api-key-cover';
import { routes as mailRoutes } from '@panel/settings/panel/routes/mail';
import { routes as formLinkRoutes } from '@panel/form-links/panel/routes/form-links';
import { routes as commentRoutes } from '@panel/comments/panel/routes/comments';
import { callPammyDb } from '@panel/studio/pammydb/client';
import { PammyDbError } from '@panel/studio/pammydb/ident';
import { studioParams } from '@panel/studio/panel/studio-ctx';
import { routes as databaseRoutes } from '@panel/studio/panel/routes/databases';
import { routes as dbUserRoutes } from '@panel/studio/panel/routes/db-users';
import { routes as shapeRoutes } from '@panel/studio/panel/routes/shape';
import { routes as studioAppRoutes, switchRoutes as studioSwitchRoutes } from '@panel/studio/panel/routes/apps';
import { routes as recordRoutes } from '@panel/studio/panel/routes/records';
import { routes as recordTagRoutes } from '@panel/studio/panel/routes/tags';
import { RecordKeeper } from '@panel/studio/panel/tagging';
import { loadGuides } from '@panel/help/help';
import { routes as helpRoutes } from '@panel/help/panel/routes/help';
import { routes as firstStepsRoutes } from '@panel/help/panel/routes/first-steps';

// the monitoring round of an app (docs/monitoring-plan.md): server.ts runs it every 5 minutes
export const monitorOf = new WeakMap<FastifyInstance, { round: (opts?: { all?: boolean }) => Promise<unknown> }>();
// the services' things in the catalog (docs/catalog-plan.md step 5): server.ts reads their
// lists every 15 minutes and opens the app's door with it
export const appKeeperOf = new WeakMap<FastifyInstance, AppKeeper>();

// does something listen on this port? (the apps' database: the panel has no login there)
const listening = (port: number) => () => new Promise<string | null>((resolve) => {
  const s = connect({ host: '127.0.0.1', port, timeout: 5000 });
  s.once('connect', () => { s.destroy(); resolve(null); });
  s.once('timeout', () => { s.destroy(); resolve(`no answer on 127.0.0.1:${port}`); });
  s.once('error', (e) => resolve(`127.0.0.1:${port}: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
});

export { nextPage, PAGE_PATHS };

// opts.apps: in place of the services helper and the key files, for the catalog's apps (tests)
// opts.media, opts.thumbs: the file records' sync and the thumbnails (server.ts shares them
// with its timers); made here when not given
// opts.records: the apps' and the Studio's tagged tables in the catalog (server.ts shares it)
export function buildApp(config: Config, db: Sql, opts: { logger?: boolean; onRoute?: (route: RouteOptions) => void; apps?: Partial<AppDeps>; media?: MediaSync; thumbs?: Thumbnailer; publisher?: Publisher; records?: RecordKeeper } = {}): FastifyInstance {
  const { app, page, assets } = panelShell(config, {
    ...opts,
    refusals: [
      (err) => (err instanceof LabelError ? { status: err.status, message: err.message } : undefined),
      // the Studio's model is shared with its helper (as pammy.org's app.ts says)
      (err) => (err instanceof PammyDbError ? { status: HELPER_STATUS[err.code] ?? 500, message: err.message } : undefined),
    ],
  });
  // tagged tables' records in the catalog (docs/catalog-plan.md step 4), with the Studio on (8-4)
  const records = isOn(config.site, 'studio') && isOn(config.site, 'catalog') ? opts.records ?? recordKeeper(config, db) : undefined;
  if (records) records.log = (msg, err) => app.log.warn({ err }, msg);
  const base = panelContext(app, config, db, {
    // lfdln-sitefs (running as svc-lfdlnsites, sandboxed to the site folders and
    // their trash) makes, lists and trashes site folders, and re-checks every name
    helper: (req) => callSiteFs(config.sitefsSocket, req),
    // what later phases bring (docs/platform-plan.md phases 6-8)
    // lfdln-pammydb (docs/phase8-plan.md 8-4): lfdln-appdb, the apps' databases read-only
    studio: isOn(config.site, 'studio') ? (req) => callPammyDb(config.pammydbSocket, req) : notHere('database helper'),
    software: notHere('software helper'),
    // lfdln-mail (docs/accounts-plan.md step 2): Settings > Visitors asks whether it is set up
    mailer: isOn(config.site, 'mail') ? (req) => callMail(config.mailSocket, req) : notHere('mail service'),
  });
  // the Studio's part of the context: no example databases here (examples are off, P8-12)
  const ctx = { ...base, ...studioParams({ exampleNames: new Set(), refuseExample: async () => {} }, config.site.words), keeper: records };
  const on = (m: Module) => isOn(config.site, m);
  // a person kept to places (hosts, "/tutor") is kept to the site folders those hosts show
  // (P8-2): File Explorer's, media's and forms' places are folders
  const folderPlaces = (places: readonly string[]) => foldersShownOn(db, places.map((p) => p.slice(1)));
  const folderCtx = withFolderPlaces(ctx, folderPlaces);
  // File Explorer (docs/phase8-plan.md step 8-1): the site folders' files, their records
  // (the 15-minute sync, server.ts) and their thumbnails (lfdln-thumbs)
  const media = opts.media ?? new MediaSync(db, config.sitefsSocket, config.now);
  const thumbs = opts.thumbs ?? new Thumbnailer(db, config.thumbsSocket, config.thumbsDir, config.now);
  if (on('files')) {
    media.onChange ??= (s, actor) => {
      logActivity(db, config.now(), { id: null, label: actor }, 'media-synced', 'site folders', describeSync(s))
        .catch((e: unknown) => app.log.warn({ err: e }, 'recording a file sync in the activity failed'));
    };
    thumbs.log = (msg, err) => app.log.warn({ err }, msg);
    media.onHashed ??= () => { void thumbs.kick(); };
  }
  // the media API's index (step 8-3, as pammy.org's): written again a moment after anything
  // about the files changes, into /var/lib/lfdln-media-public for the gate
  if (on('media')) {
    const publisher = opts.publisher ?? new Publisher(db, config.mediaPublicDir, config.now);
    publisher.log = (msg, err) => app.log.warn({ err }, msg);
    const logSync = media.onChange;
    media.onChange = (s, actor) => { logSync?.(s, actor); publisher.kick(); };
    thumbs.onMade = () => publisher.kick();
    app.addHook('onResponse', async (req, reply) => {
      if (req.method === 'POST' && (req.url.startsWith('/api/media') || req.url.startsWith('/api/files')) && reply.statusCode < 400) publisher.kick();
    });
    publisher.kick();
  }
  pagesRoutes(app, ctx, { page, assets });
  signInRoutes(app, ctx);
  activityRoutes(app, ctx);
  // hosts may send visitors to a service's part (docs/adopt-plan.md V3), where the services helper says it answers
  // and a route may have accounts (docs/roles-plan.md step 5): the gate keeps them
  hostsRoutes(app, ctx, {
    kinds: [serviceRouteKind({ ports: async () => (await callServices<{ parts: PortOf[] }>(config.servicesSocket!, { op: 'ports' })).parts }),
      // and to a project's live release (docs/phase8b-plan.md 8b-2)
      ...(on('projects') ? [projectRouteKind({ list: async () => projectsAndMaking(await callProjects<ProjectsList>(config.projectsSocket!, { op: 'list' })) })] : [])],
    accounts: async () => ({ open: (await ctx.gate<{ switches: { openAreas: boolean } }>({ op: 'visitor-settings.get' })).switches.openAreas }),
  });
  servicesRoutes(app, ctx);
  // projects (docs/phase8b-plan.md): the projects helper builds and runs them
  if (on('projects')) {
    projectsRoutes(app, ctx);
    // git over HTTPS (8b-7): people's tokens, and nginx's check on git.<domain>
    gitRoutes(app, ctx, async () => (await callProjects<{ projects: { id: string; owners: string[] }[] }>(config.projectsSocket!, { op: 'list' })).projects);
  }
  // Settings > Backups (docs/lfdln-mariadb-plan.md B): how long the database copies are kept
  backupsRoutes(app, ctx);
  // Tags & categories on what the services offer (docs/catalog-plan.md step 5): with the
  // services right; Everywhere's labels on the same page
  if (on('catalog') && on('services')) {
    const services = () => callServices<{ services: { id: string; title: string }[] }>(config.servicesSocket!, { op: 'names' });
    const keeper = new AppKeeper({
      db, now: ctx.now,
      services: async () => (await services()).services,
      manifest: async (id) => {
        try {
          return (await callServices<{ text: string }>(config.servicesSocket!, { op: 'manifest', id })).text;
        } catch (e) {
          throw new Error(e instanceof CallError ? e.message : 'The services helper did not answer.');
        }
      },
      port: async (id) => (await callServices<{ parts: PortOf[] }>(config.servicesSocket!, { op: 'ports' })).parts.find((p) => p.service === id)?.port ?? null,
      key: hookKey,
      log: (m, e) => app.log.warn({ err: e }, m),
      ...opts.apps,
    });
    appKeeperOf.set(app, keeper);
    appTagRoutes(app, ctx, keeper);
  }
  // Everywhere's labels (catalog C5): on the services' things and the site folders' files
  // alike; seen with the services right (the Tags & categories page), changed with both
  if (on('catalog') && (on('files') || on('services'))) {
    everywhereRoutes(app, ctx, on('services')
      ? { needs: 'services', alsoNeeds: on('files') ? ['files'] : [] }
      : { needs: 'files', alsoNeeds: [] });
  }
  // File Explorer, its tags and its editor (step 8-1). A person kept to places is kept to
  // the folders their hosts show (P8-2); the top is Hosts' (P8-1, in the folder helper).
  if (on('files')) {
    const filesCtx = withFolderPlaces({ ...ctx, ...filesParts(app, { media, thumbs }) }, folderPlaces);
    labelRoutes(app, filesCtx);
    // a file's address: through each enabled route that shows its folder
    filesRoutes(app, filesCtx, { shown: () => folderAddresses(db, config.site.domain) });
    editorRoutes(app, filesCtx);
    // media folders (step 8-3): <site folder>/media, a person kept to places in their hosts' folders
    if (on('media')) mediaRoutes(app, filesCtx);
  }
  // the Studio (step 8-4): databases on lfdln-appdb, their logins, their shape, the app and
  // the data API, their records and those records' tags
  if (on('studio')) {
    databaseRoutes(app, ctx);
    dbUserRoutes(app, ctx);
    shapeRoutes(app, ctx);
    studioAppRoutes(app, ctx);
    studioSwitchRoutes(app, ctx);
    recordRoutes(app, ctx);
  }
  if (records) recordTagRoutes(app, ctx, records);
  // Forms and their responses (step 8-5): a form works everywhere or in one site folder (P8-10);
  // a person kept to places, in the folders their hosts show (as File Explorer, P8-2)
  if (on('forms')) formsRoutes(app, folderCtx);
  // Form links and Comments (step 8-6): a form's answers into a table of a Studio database, and
  // comment areas kept in one; with them the data API's switches and keys (in the comments
  // routes, as on pammy.org). The apps' own databases are never among them (the Studio manages
  // none of them, P8-9). Kept to places as forms are.
  if (on('form-links')) formLinkRoutes(app, folderCtx);
  if (on('comments')) commentRoutes(app, folderCtx);
  // Settings > Email: which notices go out; the key and the addresses are the installer's here
  if (on('settings') && on('mail')) mailRoutes(app, ctx, { sending: false });
  // API keys (step 8-3): what a key reads -- media folders, and forms' responses (8-5)
  const keyCovers = [...(on('forms') ? [formsCover] : []), ...(on('media') ? [mediaCover] : [])];
  if (on('api-keys') && keyCovers.length) apiKeyRoutes(app, ctx, keyCovers);
  accountRoutes(app, ctx);
  // Help (docs/phase9-plan.md 9-1): lfdln's own guides, as build.sh copied them into help/
  // and the first-steps card on Home (9-3)
  if (on('help')) {
    const guides = loadGuides(config.helpDir);
    helpRoutes(app, ctx, guides);
    const first = config.site.help?.firstSteps;
    if (first) firstStepsRoutes(app, ctx, guides, first.read);
  }
  // visitors (docs/roles-plan.md step 6): their accounts, what each route lets them do,
  // their requests, and what they may do for themselves. No protected folders here:
  // lfdln's accounts are on routes (Hosts).
  if (on('areas')) accessRoutes(app, ctx, { manifestOf: (area, actor) => routeManifest(area.routeId, actor) });
  if (on('people')) peopleRoutes(app, ctx);
  if (on('requests')) requestRoutes(app, ctx);
  if (on('settings') && on('areas')) visitorSettingsRoutes(app, ctx);
  // Monitoring (docs/monitoring-plan.md step 1): every host, every service part and the
  // panel's own pieces, through the helpers (the panel has no network of its own)
  if (on('monitoring') && on('hosts')) {
    const monitor = monitoringRoutes(app, ctx, {
      site: config.site.domain,
      origin: config.origin,
      mail: on('mail') ? (n) => callMail(config.mailSocket, { op: 'notice', subject: n.subject, lines: n.lines, link: n.link, key: n.key }) : null,
      log: (m, e) => app.log.warn({ err: e }, m),
      // step 3: the watchdog (lfdln-watchdog.timer) reads that rounds still run
      ...process.env.PANEL_MONITOR_BEAT ? { beat: async (r) => {
        const f = process.env.PANEL_MONITOR_BEAT!;
        await writeFile(`${f}.new`, `${JSON.stringify({ at: r.at, checks: r.checks, down: r.down })}\n`, { mode: 0o600 });
        await rename(`${f}.new`, f);
      } } : {},
      collect: (opts) => collect({
        domain: async () => { const d = await homeDomain(db); return { name: d?.name ?? config.site.domain, front: d?.front ?? config.site.front }; },
        // (a host on another domain says which, and what is in front of it: docs/domains-hosts-plan.md step 7)
        hosts: () => all(db, `SELECT h.name, h.with_www, h.enabled, CASE WHEN d.home THEN NULL ELSE d.name END AS domain,
                                     CASE WHEN d.home THEN NULL ELSE d.front END AS front
                                FROM hosts h LEFT JOIN domains d ON d.id = h.domain_id ORDER BY h.name, d.name`),
        check: async (d, hosts) => (await callJsonLine<{ checks: HostCheckLike[] }>(config.routesSocket!, {
          op: 'check', domain: d.name, front: d.front, again: true, hosts: hosts.map((h) => ({ name: h.name, withWww: h.with_www })),
        }, 'the routing helper', 150_000)).checks,
        services: on('services') ? async () => (await callServices<{ services: ServiceLike[] }>(config.servicesSocket!, { op: 'list' })).services : null,
        // each project's server (docs/phase8b-plan.md D4-12)
        ...on('projects') && config.projectsSocket ? { projects: () => callProjects<{ servers: ProjectServerLike[]; proxy: boolean | null }>(config.projectsSocket!, { op: 'health' }) } : {},
        pieces: [
          { id: 'database', label: "The panel's database (lfdln-pg)", ask: async () => { await one(db, 'SELECT 1'); return null; } },
          { id: 'appdb', label: "The apps' database (lfdln-appdb)", ask: listening(Number(process.env.PANEL_APPDB_PORT ?? 5436)) },
          { id: 'appmaria', label: "The Studio's MariaDB (lfdln-appmaria)", ask: listening(Number(process.env.PANEL_APPMARIA_PORT ?? 3308)) },
          { id: 'gate', label: 'The gate (visitor accounts)', ask: async () => { await ctx.gate({ op: 'visitor-settings.get' }); return null; } },
          ...!on('mail') ? [] : [{ id: 'mail', label: 'The mail service', ask: async () => { const s = await callMail<{ ready: boolean; why: string | null }>(config.mailSocket, { op: 'status' }); return s.ready ? null : s.why ?? 'not ready'; } }],
          { id: 'sitefs', label: 'The folder helper', ask: async () => { await callSiteFs(config.sitefsSocket, { op: 'list' }); return null; } },
        ],
        // hourly (docs/monitoring-plan.md step 2): the nightly backups and the disk, and
        // the mail DNS records and nameservers
        ...on('services') ? { storage: () => callServices<StorageLike>(config.servicesSocket!, { op: 'storage' }) } : {},
        // step 3: addresses outside lfdln's hosts (Q5), and when the domain runs out (Q4)
        urls: {
          want: OTHER_ADDRESSES,
          check: async (want) => (await callJsonLine<{ urls: UrlGot[] }>(config.routesSocket!, {
            op: 'urls', urls: want.map(({ name, path }) => ({ name, path })),
          }, 'the routing helper', 150_000)).urls,
        },
        registration: () => callJsonLine<RegistrationLike>(config.routesSocket!, { op: 'registration', domain: config.site.domain }, 'the routing helper', 150_000),
        records: {
          want: watchedRecords(config.site.domain, config.site.mail?.from),
          read: async (want) => (await callJsonLine<{ records: RecordGot[] }>(config.routesSocket!, {
            op: 'records', domain: config.site.domain, records: want.map(({ name, type }) => ({ name, type })),
          }, 'the routing helper', 150_000)).records,
          baseline: async () => new Map((await all<{ key: string; value: string }>(db, 'SELECT key, value FROM monitor_baseline')).map((r) => [r.key, r.value])),
          keep: async (key, value) => { await run(db, 'INSERT INTO monitor_baseline (key, value, since) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING', key, value, ctx.now()); },
        },
      }, opts),
    });
    monitorOf.set(app, monitor);
  }

  // The addresses outside lfdln's hosts monitoring watches (step 3, Q5): the Gonsalves
  // sites (their nginx is hand-written until they are taken over, docs/domains-hosts-plan.md
  // step 7; from then on they are hosts, and collect() leaves them out here) and pammy.org's
  // (another panel, behind Cloudflare: asked through it)
  const OTHER_ADDRESSES: UrlWant[] = [
    { key: 'gonsalves', name: 'gonsalvesfamily.com', path: '/' },
    { key: 'gonsalves-admin', name: 'admin.gonsalvesfamily.com', path: '/api/health' },
    { key: 'pammy', name: 'pammy.org', path: '/' },
    { key: 'pammy-panel', name: 'panel.pammy.org', path: '/login' },
  ];

  // The DNS records monitoring watches (step 2): the mail service's, as Resend has them
  // (DKIM at resend._domainkey.<mail domain>, SPF and MX at send.<mail domain>), the
  // domain's DMARC policy, and its nameservers.
  function watchedRecords(domain: string, from: string | undefined): RecordWant[] {
    const mail = from?.split('@')[1];
    return [
      ...mail ? [
        { key: 'dkim', label: `Mail signing (DKIM): resend._domainkey.${mail}`, name: `resend._domainkey.${mail}`, type: 'TXT' as const },
        { key: 'spf', label: `Mail senders (SPF): send.${mail}`, name: `send.${mail}`, type: 'TXT' as const },
        { key: 'mx', label: `Mail bounces (MX): send.${mail}`, name: `send.${mail}`, type: 'MX' as const },
      ] : [],
      { key: 'dmarc', label: `Mail policy (DMARC): _dmarc.${domain}`, name: `_dmarc.${domain}`, type: 'TXT' },
      { key: 'ns', label: `Nameservers: ${domain}`, name: domain, type: 'NS' },
    ];
  }

  // A route's pammy-panel.json (S6-3): its site folder's top, or its service's file.
  async function routeManifest(routeId: number | null, actor: string): Promise<string> {
    const r = routeId === null ? undefined : await routeTarget(db, routeId);
    if (!r) throw new AccountError('That route no longer exists.', 404);
    if (r.kind === 'folder' && r.folder) return folderManifest(config.sitefsSocket, r.folder, actor);
    if (r.kind === 'service' && r.service) {
      try {
        return (await callServices<{ text: string }>(config.servicesSocket!, { op: 'manifest', id: r.service })).text;
      } catch (e) {
        if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
        throw e;
      }
    }
    throw new AccountError('A redirect has no pammy-panel.json.', 404);
  }
  return app;
}

// The record keeper, on lfdln's helpers' sockets: lfdln-pammydb, and the gate's admin door for
// the data API's touches (as pammy.org's app.ts recordKeeper).
export function recordKeeper(config: Config, db: Sql): RecordKeeper {
  return new RecordKeeper(db,
    async (req) => {
      try {
        return await callPammyDb(config.pammydbSocket, req, 30_000);
      } catch (e) {
        if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
        throw e;
      }
    },
    (req) => callJsonLine(config.gateSocket, req, 'the gate'),
    config.now);
}
