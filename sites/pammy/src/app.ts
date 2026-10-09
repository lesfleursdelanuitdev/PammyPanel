// The panel's API: one Fastify app, one process, put together here and nowhere
// else (docs/refactor-plan.md phase 3).
//
// This file only assembles it: the plumbing every route shares is in
// src/panel/context.ts, and each area of the panel is one file in
// src/panel/routes/. The order the areas are added in is the order their
// addresses appear in test/routes.snapshot.txt, so a route lost or quietly
// un-limited while code moves fails the build.
import { type FastifyInstance, type RouteOptions } from 'fastify';
import { AccountError, logActivity } from '@panel/core/accounts';
import { type Config } from '@panel/core/config';
import { isOn, type Module } from '@panel/core/profile';
import { type Sql } from '@panel/core/pg';
import { loadGuides } from '@panel/help/help';
import { describeSync, MediaSync } from '@panel/files/media-sync';
import { Publisher } from '@panel/media/media-public';
import { Thumbnailer } from '@panel/thumbs/media-thumbs';
import { LabelError } from '@panel/catalog/labels';
import { panelShell } from '@panel/core/panel/shell';
import { PammyDbError } from '@panel/studio/pammydb/ident';
import { ScopeError } from '@panel/catalog/scopes';
import { panelContext, HELPER_STATUS } from '@panel/core/panel/context';
import { filesParts } from '@panel/files/panel/files-ctx';
import { studioParams } from '@panel/studio/panel/studio-ctx';
import { exampleGuard } from '@panel/examples/panel/examples';
import { callSiteFs } from '@panel/files/sitefs/client';
import { callPammyDb } from '@panel/studio/pammydb/client';
import { callApps } from '@panel/apps/apps/client';
import { callMail } from '@panel/mail/mail/client';
import { nextPage, PAGE_PATHS } from '@panel/files/panel/pages-list';
import { routes as pagesRoutes } from '@panel/files/panel/routes/pages';
import { routes as signInRoutes } from '@panel/core/panel/routes/sign-in';
import { routes as activityRoutes } from '@panel/core/panel/routes/activity';
import { routes as folderRoutes } from '@panel/files/panel/routes/folders';
import { routes as protectedRoutes } from '@panel/areas/panel/routes/protected';
import { routes as accessRoutes } from '@panel/areas/panel/routes/access';
import { routes as peopleRoutes } from '@panel/people/panel/routes/people';
import { routes as requestRoutes } from '@panel/requests/panel/routes/requests';
import { routes as visitorSettingsRoutes } from '@panel/settings/panel/routes/visitor-settings';
import { routes as formsRoutes } from '@panel/forms/panel/routes/forms';
import { routes as apiKeyRoutes } from '@panel/api-keys/panel/routes/api-keys';
import { formsCover } from '@panel/forms/panel/api-key-cover';
import { mediaCover } from '@panel/media/panel/api-key-cover';
import { routes as databaseRoutes } from '@panel/studio/panel/routes/databases';
import { routes as dbUserRoutes } from '@panel/studio/panel/routes/db-users';
import { routes as shapeRoutes } from '@panel/studio/panel/routes/shape';
import { routes as appRoutes, switchRoutes as appSwitchRoutes } from '@panel/studio/panel/routes/apps';
import { routes as formLinkRoutes } from '@panel/form-links/panel/routes/form-links';
import { routes as commentRoutes } from '@panel/comments/panel/routes/comments';
import { routes as dbExampleRoutes } from '@panel/examples/panel/routes/db-examples';
import { routes as tutorialExampleRoutes } from '@panel/examples/panel/routes/tutorial-examples';
import { routes as recordRoutes } from '@panel/studio/panel/routes/records';
import { routes as recordTagRoutes } from '@panel/studio/panel/routes/tags';
import { RecordKeeper } from '@panel/studio/panel/tagging';
import { routes as everywhereRoutes } from '@panel/catalog/panel/routes/everywhere';
import { CallError, callJsonLine } from '@panel/core/jsonline';
import { routes as labelRoutes } from '@panel/files/panel/routes/labels';
import { routes as mediaRoutes } from '@panel/media/panel/routes/media';
import { routes as filesRoutes } from '@panel/files/panel/routes/files';
import { routes as editorRoutes } from '@panel/files/panel/routes/editor';
import { routes as helpRoutes } from '@panel/help/panel/routes/help';
import { routes as gettingStartedRoutes } from '@panel/getting-started/panel/routes/getting-started';
import { routes as softwareRoutes } from '@panel/apps/panel/routes/software';
import { routes as mailRoutes } from '@panel/settings/panel/routes/mail';
import { routes as accountRoutes } from '@panel/core/panel/routes/accounts';
import { routes as hostsRoutes } from '@panel/hosts/panel/routes/hosts';

// what the tests, web/ and the route list ask the panel for
export { nextPage, PAGE_PATHS };

// opts.media: the media records' sync (server.ts shares it with housekeeping);
// made on the same Postgres pool when not given.
// opts.onRoute: told about every route as it is registered (test/routes.test.ts
// keeps the list, so a route can't be lost or quietly un-limited while code moves).
// opts.keeper: her records in the catalog (server.ts shares it with its timers).
export function buildApp(config: Config, db: Sql, opts: { logger?: boolean; media?: MediaSync; thumbs?: Thumbnailer; publisher?: Publisher; keeper?: RecordKeeper; onRoute?: (route: RouteOptions) => void } = {}): FastifyInstance {
  // the plumbing every site's panel has (@panel/core/panel/shell), and how this one's
  // modules' own refusals are said
  const { app, page, assets } = panelShell(config, {
    logger: opts.logger, onRoute: opts.onRoute,
    refusals: [
      (err) => (err instanceof LabelError || err instanceof ScopeError ? { status: err.status, message: err.message } : undefined),
      // The studio's model (src/pammydb/ir.ts, patch.ts) is shared with the
      // helper, so the panel raises its errors too when it reads a drawing a
      // browser sent. It carries the same codes a refusal over the socket does,
      // and gets the same statuses -- otherwise "that name has characters the
      // database will not take" would reach her as "something went wrong".
      (err) => (err instanceof PammyDbError ? { status: HELPER_STATUS[err.code] ?? 500, message: err.message } : undefined),
    ],
  });
  const media = opts.media ?? new MediaSync(db, config.sitefsSocket, config.now);
  media.onChange ??= (s, actor) => {
    logActivity(db, config.now(), { id: null, label: actor }, 'media-synced', 'media folders', describeSync(s))
      .catch((e: unknown) => app.log.warn({ err: e }, 'recording a media sync in the activity failed'));
  };
  // thumbnails (D18): made by pammy-thumbs once a file's hash is known
  const thumbs = opts.thumbs ?? new Thumbnailer(db, config.thumbsSocket, config.thumbsDir, config.now);
  thumbs.log = (msg, err) => app.log.warn({ err }, msg);
  media.onHashed ??= () => { void thumbs.kick(); };
  // the media API's index (M2): rewritten a moment after anything about media changes
  // (only with the media folders module on: @panel/media)
  if (isOn(config.site, 'media')) {
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
  const guides = loadGuides(config.helpDir);
  // her tagged tables' records (docs/catalog-plan.md step 4): with the Studio and the catalog on
  const keeper = isOn(config.site, 'studio') && isOn(config.site, 'catalog')
    ? opts.keeper ?? recordKeeper(config, db) : undefined;
  if (keeper) keeper.log = (msg, err) => app.log.warn({ err }, msg);

  // Everything the routes share (docs/refactor-plan.md phase 3): the clock, who
  // is asking, what was sent, and the helper sockets; then what the files and
  // studio packages add (docs/packaging-plan.md step 1a).
  const ctx = {
    ...panelContext(app, config, db, {
      // pammy-sitefs (running as pamela, sandboxed to /pamela/public and
      // /pamela/trash) touches her files, and re-checks every name
      helper: (req) => callSiteFs(config.sitefsSocket, req),
      // her own engines, through the database helper (src/pammydb/)
      studio: (req) => callPammyDb(config.pammydbSocket, req),
      // the software helper (src/apps/, root, docs/apps-plan.md G2)
      software: (req) => callApps(config.appsSocket, req),
      // the panel's own emails (docs/apps-plan.md phase 3)
      mailer: (req) => callMail(config.mailSocket, req),
    }),
    ...studioParams(exampleGuard(db), config.site.words),
    ...filesParts(app, { media, thumbs }),
    keeper,
  };

  // A module the site's profile has switched off adds no routes (docs/packaging-plan.md P5.5).
  // The core's are always there: the pages, signing in, activity, accounts.
  const on = (m: Module) => isOn(config.site, m);

  // ---------------------------------------------------------------- pages
  pagesRoutes(app, ctx, { page, assets });

  // ---------------------------------------------------------------- sign in and out, setup links, My account
  signInRoutes(app, ctx);

  // ---------------------------------------------------------------- activity
  activityRoutes(app, ctx);

  // ---------------------------------------------------------------- subdomains (website folders)
  if (on('files')) folderRoutes(app, ctx);

  // ---------------------------------------------------------------- protected folders, the people who can open them, and their requests
  // (three modules since docs/roles-plan.md step 1)
  if (on('areas')) { protectedRoutes(app, ctx); accessRoutes(app, ctx); }
  if (on('people')) peopleRoutes(app, ctx);
  if (on('requests')) requestRoutes(app, ctx);
  // Settings: what visitors may do for themselves (docs/accounts-plan.md A5)
  if (on('settings') && on('areas')) visitorSettingsRoutes(app, ctx);

  // ---------------------------------------------------------------- hosts, routes and site folders (lfdln, docs/hosts-plan.md)
  if (on('hosts')) hostsRoutes(app, ctx);

  // ---------------------------------------------------------------- forms and responses
  if (on('forms')) formsRoutes(app, ctx);

  // ---------------------------------------------------------------- API keys: for what the modules on let a key read (docs/catalog-plan.md step 3c)
  const keyCovers = [...(on('forms') ? [formsCover] : []), ...(on('media') ? [mediaCover] : [])];
  if (on('api-keys') && keyCovers.length) apiKeyRoutes(app, ctx, keyCovers);

  // ---------------------------------------------------------------- her databases (the studio)
  if (on('studio')) databaseRoutes(app, ctx);

  // ---------------------------------------------------------------- database users
  if (on('studio')) dbUserRoutes(app, ctx);

  // ---------------------------------------------------------------- the shape of a database
  if (on('studio')) shapeRoutes(app, ctx);

  // ------------------------------------------------------------ the Application tab and the data API
  if (on('studio')) appRoutes(app, ctx);

  // ---------------------------------------------------------------- forms into a database
  if (on('form-links')) formLinkRoutes(app, ctx);

  // ---------------------------------------------------------------- comments in her apps
  if (on('comments')) commentRoutes(app, ctx);

  // ------------------------------------------------------- switching the app on
  if (on('studio')) appSwitchRoutes(app, ctx);

  // ---------------------------------------------------------------- the database examples
  if (on('examples')) dbExampleRoutes(app, ctx);

  // ---------------------------------------------------------------- the tutorial examples
  if (on('examples')) tutorialExampleRoutes(app, ctx);

  // ------------------------------------------------------------ her records
  if (on('studio')) recordRoutes(app, ctx);
  // ...and their tags and categories (docs/catalog-plan.md step 4)
  if (keeper) recordTagRoutes(app, ctx, keeper);
  // labels that go on anything: the website's files and her records (C5)
  if (on('catalog') && on('files')) everywhereRoutes(app, ctx, { alsoNeeds: on('studio') ? ['databases'] : [], onChange: () => keeper?.allChanged() });

  // ---------------------------------------------------------------- tags, scopes, details, the sync, thumbnails (File Explorer's until the catalog's, docs/catalog-plan.md)
  // (also the raw-upload body parser the uploads below use)
  if (on('files')) labelRoutes(app, ctx);

  // ---------------------------------------------------------------- media folders (docs/catalog-plan.md C1)
  if (on('media')) mediaRoutes(app, ctx);

  // ---------------------------------------------------------------- file explorer (the whole website; Media is the media/ filter)
  if (on('files')) filesRoutes(app, ctx);

  // ---------------------------------------------------------------- the editor (docs/editor-plan.md)
  if (on('files')) editorRoutes(app, ctx);

  // ---------------------------------------------------------------- help
  if (on('help')) helpRoutes(app, ctx, guides);

  // ---------------------------------------------------------------- getting started (docs/getting-started-plan.md)
  if (on('getting-started')) gettingStartedRoutes(app, ctx);

  // ---------------------------------------------------------------- installed software (docs/apps-plan.md)
  if (on('apps')) softwareRoutes(app, ctx);

  // ---------------------------------------------------------------- Settings: email (docs/apps-plan.md phase 3)
  if (on('settings') && on('mail')) mailRoutes(app, ctx);

  // ---------------------------------------------------------------- accounts (manager only)
  accountRoutes(app, ctx);

  return app;
}

// The keeper, on the helpers' sockets: her engines, and the gate's admin door for its touches.
export function recordKeeper(config: Config, db: Sql): RecordKeeper {
  return new RecordKeeper(db,
    // the helper's refusals in her words, as the routes' own calls give them
    async (req) => {
      try {
        return await callPammyDb(config.pammydbSocket, req, 30_000);
      } catch (e) {
        if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
        throw e;
      }
    },
    (req) => callJsonLine(config.gateSocket, req, 'protected-folder service'),
    config.now);
}
