// The gate's HTTP side, on 127.0.0.1 only:
//   GET  /check                 nginx's auth_request for every static request on pammy.org
//   GET  /check/<token>         nginx's auth_request for a route with accounts (docs/roles-plan.md step 5)
//   GET  /_pammy/login.js       the <pammy-*> components for her sign-in pages
//   GET  /_pammy/<kind>         built-in pages (login, forgot, invite, request, logout) for folders without their own
//   GET  /_pammy/about          which pages a folder has, for the components' links
//   GET  /_pammy/welcome        built-in page for a protected folder with no index.html
//   GET  /_pammy/folder         what a signed-in visitor can open in such a folder
//   GET  /_pammy/me             who is signed in on this hostname
//   POST /_pammy/login          sign in
//   POST /_pammy/logout         sign out (answers with the folder's signed-out page, when it knows the folder)
//   POST /_pammy/forgot         "I forgot my password": a request for Pamela
//   POST /_pammy/request        "please let me in": a request for Pamela
//   POST /_pammy/invite/check   what a setup link is for (their username)
//   POST /_pammy/invite         choose a password with a setup link, and sign in
//   GET  /_pammy/forms.js       the <pammy-form> component, for any page of her site
//   GET  /_pammy/forms/<name>   what that form asks (for the component)
//   POST /_pammy/forms/<name>   send a response
//   GET  /_pammy/form-preview   the panel's preview of a form it hasn't saved yet (in a frame)
//   GET  /_pammy/comments.js    the <pammy-comments> component (docs/comments-plan.md)
//   GET  /_pammy/comments/<area>?page=&content=   one thread's approved comments
//   GET  /_pammy/comments/<area>/form?page=        what the comment box asks
//   POST /_pammy/comments/<area>                  send a comment { page, content, answers }
//   GET  /_pammy/comments/<area>/counts?page=&content=1,2,3   how many, for several at once
//   GET  /_pammy/api/forms/<id>/all|approved[/filterby/<field>/<value>]
//   GET  /_pammy/api/forms/by-name/<name>/all|approved[/filterby/<field>/<value>]
//                               responses, for programs (Bearer key), and for anyone when the
//                               form's "anyone can read approved responses" is on. The same form
//                               either way: <id> never changes, <name> reads better on her pages.
//   GET  /_pammy/examples/<look>/<page>  the example looks of 09-protected-folders.txt (PART 9 to 11),
//                               as previews: nothing on them signs anyone in (login.js knows)
//   GET  /_pammy/examples/<kind>/        the worked examples of 10-forms.txt (PART 12 and 13):
//                               a guest book, who's coming, a pinboard. Real forms, framed by
//                               the panel; unlisted, and never indexed (docs/examples-plan.md)
//
// This file puts the app together and keeps /check, the component files, the
// built-in pages, the examples and the form preview. The rest is one file per
// area (docs/refactor-plan.md phase 4): routes/visitors.ts (me, folder, about,
// sign in and out, forgot, request, invite), routes/forms.ts, routes/comments.ts,
// routes/responses-api.ts; what they share is context.ts and form-use.ts.
import { loadDbExamples } from '@panel/examples/gate/db-examples';
import { isDbExampleKind } from '@panel/examples/studio/db-examples';
import { createHash } from 'node:crypto';
import { AUDIENCE_RE, makeProof, type Told } from '@panel/core/identity-proof';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type RouteOptions } from 'fastify';
import { isPgUnavailable, PgUnavailable } from '@panel/core/pg';
import { socketMailer } from '@panel/core/gate/context';
import { readCookie } from '@panel/core/sessions';
import { API_LIMIT, gateCtx, type GateConfig } from '@panel/core/gate/context';
import type { Access, GateLive } from '@panel/core/gate/live';
import { EXAMPLE_KINDS, EXAMPLES, examplePage, isExampleKind } from '@panel/examples/gate/examples';
import { formPages } from '@panel/forms/gate/form-use';
import { apiKeyFor } from '@panel/api-keys/gate/forms/api-keys';
import { EXAMPLE_FILES_URL, exampleIndex, MediaIndex, registerMediaApi } from '@panel/media/gate/media-api';
import { registerDataApi } from '@panel/studio/gate/data-api';
import { isMediaExampleKind, MEDIA_EXAMPLE_KINDS, mediaExamplePage } from '@panel/media/gate/media-examples';
import { decide, HOMES, loginUrl, needsVisitor, PAGE_KINDS, PAGES, resolve, safeNext, type PageKind, type Resolved } from '@panel/areas/gate/policy';
import { registerComments } from '@panel/comments/gate/routes/comments';
import { registerForms } from '@panel/forms/gate/routes/forms';
import { saveResponse } from '@panel/form-links/gate/saves/save';
import { registerResponsesApi } from '@panel/forms/gate/routes/responses-api';
import { registerFolders } from '@panel/areas/gate/routes/folders';
import { registerSignIn } from '@panel/people/gate/routes/sign-in';
import { accountSwitches, ACCOUNT_PAGES, registerAccounts } from '@panel/people/gate/routes/accounts';
import { registerRequests } from '@panel/requests/gate/routes/requests';
import { addResetRequest, AREA_TOKEN_RE, closeResetRequests, guestPrivileges, PAGES_READ, type Area } from '@panel/core/gate/store';
import { NO_RESET_REQUESTS, type PeopleSockets } from '@panel/people/gate/reset-requests';
import { appPath } from '@panel/core/paths';
import { isOn, type Module, type SiteProfile } from '@panel/core/profile';

const PRIVATE = 'private, no-store';

// Built-in pages: title, and the component with its default wording.
const BUILTIN: Record<PageKind | 'welcome', { title: string; element: string }> = {
  welcome: { title: 'Signed in', element: '<pammy-welcome area="@AREA@"></pammy-welcome>' },
  login: { title: 'Sign in', element: '<pammy-login area="@AREA@" heading="This folder is private"></pammy-login>' },
  forgot: { title: 'Forgot your password', element: '<pammy-forgot area="@AREA@"></pammy-forgot>' },
  invite: { title: 'Choose your password', element: '<pammy-invite></pammy-invite>' },
  request: { title: 'Ask for access', element: '<pammy-request area="@AREA@"></pammy-request>' },
  logout: { title: 'Signed out', element: '<pammy-signed-out area="@AREA@"></pammy-signed-out>' },
};

// What works while Postgres can't be reached (live.ts): the check itself, from
// memory, and the gate's own files and built-in pages. Everything else answers
// 503 "try again in a minute" until it's back.
const WITHOUT_DB = /^\/(?:check(?:\/[A-Za-z0-9_-]{32})?|_pammy\/(?:login\.js|forms\.js|form-preview|examples\/.*|login|forgot|invite|request|logout|welcome|about|register|confirm|reset|account|accounts))(?:\?.*)?$/;

// opts.onRoute: as in the panel's buildApp -- every route as it is registered.
// What the gate may be built with: the media API's files, the database helper's
// socket and the visitor cookie's name are the profile's unless given (the tests
// give their own). A site with files or studio off has no such files or socket.
export type GateOptions = Omit<GateConfig, 'mediaIndex' | 'mediaThumbs' | 'pammydbSocket'> & Partial<Pick<GateConfig, 'mediaIndex' | 'mediaThumbs' | 'pammydbSocket'>>;

// The site's gate (docs/accounts-plan.md step 3): the same app for every site, with
// what its profile switches on. sites/<name>/src/gate/ binds it to its profile.
export function buildGateApp(profile: SiteProfile, given: GateOptions, live: GateLive, opts: { logger?: boolean; onRoute?: (route: RouteOptions) => void } = {}): FastifyInstance {
  const media = profile.services.mediaPublic;
  const cfg: GateConfig = {
    ...given,
    mediaIndex: given.mediaIndex ?? (media ? join(media, 'index.db') : ''),
    mediaThumbs: given.mediaThumbs ?? (media ? join(media, 'thumbs') : ''),
    // its own door to the database helper, row ops only (S2, docs/s2-plan.md)
    pammydbSocket: given.pammydbSocket ?? profile.services.sockets.pammydbGate ?? '',
    visitorCookie: given.visitorCookie ?? profile.services.gate?.cookie,
    // the gate's door to the mail service (docs/accounts-plan.md step 4), where the site has one
    visitorMail: given.visitorMail !== undefined ? given.visitorMail
      : isOn(profile, 'mail') && profile.services.sockets.mailVisitor ? socketMailer(profile.services.sockets.mailVisitor) : null,
    modules: given.modules ?? profile.modules,
  };
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 8 * 1024 });
  if (opts.onRoute) app.addHook('onRoute', opts.onRoute);
  const assetDir = `${appPath('public-gate')}/`;
  const loginJs = readFileSync(join(assetDir, 'login.js'));
  const formsJs = readFileSync(join(assetDir, 'forms.js'));
  const commentsJs = readFileSync(join(assetDir, 'comments.js'));
  // Built-in pages load the script by a versioned address, so no cache anywhere
  // (a Cloudflare edge that stored an older copy, a browser) can hand them an old one.
  const loginJsVersion = createHash('sha256').update(loginJs).digest('hex').slice(0, 12);
  // the built-in pages' title names the site (the profile's name: "pammy.org")
  const pageHtml = readFileSync(join(assetDir, 'page.html'), 'utf8').replace('@SITE@', profile.name)
    .replace('src="/_pammy/login.js"', `src="/_pammy/login.js?v=${loginJsVersion}"`);
  const formsJsVersion = createHash('sha256').update(formsJs).digest('hex').slice(0, 12);
  const formPageHtml = readFileSync(join(assetDir, 'page.html'), 'utf8').replace('@SITE@', profile.name)
    .replace('src="/_pammy/login.js"', `src="/_pammy/forms.js?v=${formsJsVersion}"`);
  const examples = new Map([...loadExamples(join(assetDir, 'examples')), ...loadFormExamples(join(assetDir, 'examples')), ...loadMediaExamples(join(assetDir, 'examples')), ...loadDbExamples(join(assetDir, 'examples'))]);
  const ctx = gateCtx(app, cfg, live);
  const { db, now, limiter, hostOf, ipOf, baseOf, visitorOf } = ctx;

  app.addHook('onRequest', async (req, reply) => {
    reply.headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    if (!live.ready && !WITHOUT_DB.test(req.url)) throw new PgUnavailable();
  });

  // ---------------------------------------------------------------- the check
  app.get('/check', async (req, reply) => {
    const host = hostOf(req);
    const base = baseOf(req);
    const uri = req.headers['x-pammy-uri'];
    // Anything missing means nginx isn't configured the way we expect: refuse.
    if (!host || base === null || typeof uri !== 'string' || uri === '') return reply.code(403).send();
    const next = typeof req.headers['x-pammy-next'] === 'string' ? req.headers['x-pammy-next'] : '/';
    const resolved = resolve(live, cfg.publicRoot, `${base}${uri}`);
    // Only a protected request asks who is signed in: the rest of her site never waits for Postgres.
    const signedIn = needsVisitor(resolved) ? await visitorOf(req, host) : null;
    const d = decide(resolved, signedIn);
    if (d.allow) {
      if (d.protectedContent) reply.header('X-Pammy-Cache', PRIVATE);
      // a PHP page inside a protected folder is told who is signed in
      // (docs/tutorials-plan.md P4): nginx hands it on as PAMMY_USER
      if (d.protectedContent && signedIn) reply.header('X-Pammy-User', signedIn.visitor.username).header('X-Pammy-Account', String(signedIn.visitor.id));
      if (d.protectedContent && d.area) {
        // ... and, as PAMMY_ACCOUNT, PAMMY_ROLE and PAMMY_PRIVILEGES, their
        // account's number and their role there (docs/roles-plan.md step 3).
        // Apps check the privileges, never the role's name. Anyone may do what
        // the "not signed in" slot allows; someone signed in, that and their role's.
        const guest = guestPrivileges(d.area);
        const role = signedIn?.roles.get(d.area.id);
        const privileges = new Set([...guest, ...(role?.privileges ?? [])]);
        const name = role?.role ?? (signedIn ? '' : 'Not signed in');
        if (name) reply.header('X-Pammy-Role', name);
        if (privileges.size) reply.header('X-Pammy-Privileges', [...privileges].sort().join(' '));
      }
      // A protected folder with no index.html: nginx would answer "403 Forbidden"
      // (listings are off). Send the signed-in visitor to a page that says they're
      // in and links to what's inside, instead. (Not signed in, in a folder open
      // to anyone: as any open folder, nginx's answer.)
      const bare = d.protectedContent && signedIn ? folderWithoutHome(resolved) : null;
      if (bare) {
        reply.header('X-Pammy-Login', `/_pammy/welcome?${new URLSearchParams({ area: bare, path: uri.endsWith('/') ? uri : `${uri}/` })}`);
        return reply.code(401).send();
      }
      return reply.code(204).send();
    }
    if (d.reason === 'unreadable') return reply.code(403).send();
    reply.header('X-Pammy-Cache', PRIVATE);
    reply.header('X-Pammy-Login', loginUrl(d.protection, base, safeNext(next) ?? '/', d.reason));
    return reply.code(401).send();
  });

  // A route with accounts (docs/roles-plan.md step 5, S5-5): nginx names the
  // route's area in the address, from the file the routing helper wrote. No
  // folder is looked at: the area decides. Anyone may use one open to all, and
  // is told who is signed in (without asking Postgres when nobody is); otherwise
  // the role their account has there, as in a folder. A token the gate doesn't
  // know is refused outright: nothing is let through on a guess.
  //
  // /check/<token>/<audience> (docs/s1-plan.md S1a): the same, for a route to an app,
  // named by the routing helper ("service.examprep.web"): what the app is told is signed
  // for that app (X-Pammy-Proof, which nginx hands on as X-Lfdln-Proof).
  const check = async (req: FastifyRequest, reply: FastifyReply) => {
    const host = hostOf(req);
    const { token, audience } = req.params as { token: string; audience?: string };
    if (!host || !AREA_TOKEN_RE.test(token)) return reply.code(403).send();
    // a proof only for an app this host's route with this area sends to (B1 of the review):
    // nobody can ask for exam prep's proof with another area's token, or on another host
    if (audience !== undefined && (!AUDIENCE_RE.test(audience) || !live.siteRoutes?.hasAudience(host, token, audience))) return reply.code(403).send();
    const area = live.byToken(token);
    if (!area || area.kind !== 'route') return reply.code(403).send();
    const next = typeof req.headers['x-pammy-next'] === 'string' ? req.headers['x-pammy-next'] : '/';
    const open = guestPrivileges(area).has(PAGES_READ);
    // Postgres away and this session not checked lately: on a route open to all
    // they go on as not signed in; anywhere else, nginx's error page
    const signedIn = !readCookie(req.headers.cookie, ctx.cookie) ? null
      : await visitorOf(req, host).catch((e: unknown) => { if (open && isPgUnavailable(e)) return null; throw e; });
    if (!open && !signedIn?.opens.has(area.id)) {
      const q = new URLSearchParams({ next: safeNext(next) ?? '/', area: area.token });
      if (signedIn) q.set('denied', '1');
      reply.header('X-Pammy-Cache', PRIVATE).header('X-Pammy-Login', `/_pammy/login?${q}`);
      return reply.code(401).send();
    }
    if (!open) reply.header('X-Pammy-Cache', PRIVATE);
    const told = identity(reply, area, signedIn);
    if (audience && cfg.identityKey) reply.header('X-Pammy-Proof', makeProof(cfg.identityKey, audience, host, told, Date.now()));
    return reply.code(204).send();
  };
  app.get('/check/:token', check);
  app.get('/check/:token/:audience', check);

  // Who is signed in and what they may do in the area, for the app behind it:
  // their account's number and username, their role there, and their privileges
  // (the "not signed in" slot's, and their role's). Apps check privileges, never
  // the role's name (docs/roles-plan.md step 3).
  // Returns what it told, as the app will read it (for the proof).
  function identity(reply: FastifyReply, area: Area, signedIn: Access | null): Told {
    if (signedIn) reply.header('X-Pammy-User', signedIn.visitor.username).header('X-Pammy-Account', String(signedIn.visitor.id));
    const role = signedIn?.roles.get(area.id);
    const privileges = new Set([...guestPrivileges(area), ...(role?.privileges ?? [])]);
    const name = role?.role ?? (signedIn ? '' : 'Not signed in');
    if (name) reply.header('X-Pammy-Role', name);
    if (privileges.size) reply.header('X-Pammy-Privileges', [...privileges].sort().join(' '));
    return {
      account: signedIn ? String(signedIn.visitor.id) : '', username: signedIn?.visitor.username ?? '',
      role: name, privileges: [...privileges].sort().join(' '),
    };
  }

  // ---------------------------------------------------------------- pages and the component
  // no-store, not no-cache: Cloudflare's Browser Cache TTL rewrites no-cache on .js
  // to max-age=14400, so visitors kept a 4-hour-old copy after every update.
  // no-store is passed through untouched (BYPASS). It's small; fetching it each time is fine.
  app.get('/_pammy/login.js', async (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').header('Cache-Control', 'no-store').send(loginJs));
  app.get('/_pammy/forms.js', async (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').header('Cache-Control', 'no-store').send(formsJs));
  app.get('/_pammy/comments.js', async (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').header('Cache-Control', 'no-store').send(commentsJs));

  // The innermost area's token, if this is an existing folder with no index.html.
  // A folder's home page: index.html, or index.php (docs/tutorials-plan.md P1 --
  function folderWithoutHome(r: Resolved): string | null {
    if (r.kind !== 'ok' || !r.exists) return null;
    try {
      if (!statSync(r.real).isDirectory()) return null;
    } catch {
      return null;
    }
    for (const home of HOMES) {
      try {
        if (statSync(join(r.real, home)).isFile()) return null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null;     // unreadable: leave it to nginx
      }
    }
    const inner = [...r.protections].reverse().find((p) => p.area);
    return inner?.area?.token ?? null;
  }

  const builtInPage = (reply: FastifyReply, title: string, element: string) => {
    reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('X-Frame-Options', 'DENY');
    return reply.type('text/html; charset=utf-8').send(pageHtml.replace('@TITLE@', title).replace('@ELEMENT@', element));
  };
  // A route's sign-in (docs/roles-plan.md step 5) isn't a folder's: "Open with
  // accounts" lets anyone in, so signing in is only asked, and people may make an
  // account there; "Only people let in" is a private part of the site, not a folder.
  // A folder's page stays word for word as it was.
  const routeLogin = (element: string, token: string): string => {
    let a: Area | undefined;
    try {
      a = token ? live.byToken(token) : undefined;
    } catch {
      return element;       // areas not loaded yet: the folder wording, as before
    }
    if (a?.kind !== 'route') return element;
    return guestPrivileges(a).has(PAGES_READ)
      ? element.replace('heading="This folder is private"', 'heading="Sign in" accounts="open"')
      : element.replace('heading="This folder is private"', 'heading="This part of the site is private"');
  };
  for (const kind of [...PAGE_KINDS, 'welcome' as const]) {
    app.get(`/_pammy/${kind}`, async (req, reply) => {
      const area = String((req.query as Record<string, string>).area ?? '');
      const page = BUILTIN[kind];
      const token = AREA_TOKEN_RE.test(area) ? area : '';
      let element = page.element.replace('@AREA@', token);
      if (kind === 'login') element = routeLogin(element, token);
      return builtInPage(reply, page.title, element);
    });
  }

  // A module the profile has switched off adds nothing here (docs/packaging-plan.md P5.5).
  const on = (m: Module) => isOn(profile, m);

  // The example looks, exactly as the guide prints them. The panel's Help page shows
  // them in a frame, so they (only) may be framed by the panel.
  if (on('examples')) app.get('/_pammy/examples/*', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    // The pages of a worked example sit beside their two files, so the address
    // has to end in a slash or "style.css" would be looked for a folder up.
    const kind = /^\/_pammy\/examples\/([a-z-]+)$/.exec(path)?.[1];
    if (kind && (isExampleKind(kind) || isMediaExampleKind(kind) || isDbExampleKind(kind))) return reply.redirect(`${path}/`, 301);
    const file = examples.get(path);
    if (!file) return reply.code(404).type('text/plain').send('Not found');
    // Unlisted, and never in anybody's search results (docs/examples-plan.md, D5).
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors https://panel.${cfg.domain}; base-uri 'none'`);
    if (path.startsWith(EXAMPLE_FILES_URL)) reply.header('Cache-Control', 'public, max-age=86400');
    return reply.type(file.type).send(file.body);
  });

  if (on('areas')) registerFolders(ctx);
  if (on('people')) {
    // requests' reset requests, through people's socket (docs/k-a-plan.md KA-Q2)
    const people: PeopleSockets = {
      resetRequests: on('requests') ? { close: closeResetRequests, add: addResetRequest } : NO_RESET_REQUESTS,
    };
    registerSignIn(ctx, people);
    registerAccounts(ctx, people);
    // the accounts' built-in pages (docs/accounts-plan.md step 4), each there only
    // while its switch is on: with every switch off, a 404 as before
    for (const [kind, page] of Object.entries(ACCOUNT_PAGES)) {
      app.get(`/_pammy/${kind}`, async (_req, reply) => {
        if (!page.shown(accountSwitches(live.visitorSettings, ctx.visitorMail !== null))) return reply.code(404).send();
        return builtInPage(reply, page.title, page.element);
      });
    }
  }
  if (on('requests')) registerRequests(ctx);
  const forms = formPages(ctx);
  if (on('forms')) registerForms(ctx, forms, {
    // a form that saves its answers in a database (docs/form-to-database-plan.md):
    // after the response is kept, and without the visitor waiting for it -- a
    // database that is asleep must not keep their "Thank you" from them
    responseKept: on('form-links')
      ? (responseId) => void saveResponse(ctx.db, ctx.now(), cfg.pammydbSocket, responseId)
        .catch((e: unknown) => ctx.app.log.warn({ err: e }, 'saving a response in a database failed'))
      : () => {},
  });
  if (on('comments')) registerComments(ctx, forms);

  // The panel's preview: an empty page holding <pammy-form preview>, which takes
  // the form it should show from the panel by postMessage. Nothing is sent from it.
  if (on('forms')) app.get('/_pammy/form-preview', async (_req, reply) => {
    reply.header('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://${cfg.domain}; connect-src 'none'; form-action 'none'; frame-ancestors https://panel.${cfg.domain}; base-uri 'none'`);
    return reply.type('text/html; charset=utf-8').send(
      formPageHtml.replace('@TITLE@', 'Preview').replace('@ELEMENT@', `<pammy-form preview panel="https://panel.${cfg.domain}"></pammy-form>`));
  });

  if (on('forms')) registerResponsesApi(ctx);

  if (on('media')) registerMediaApi(app, {
    areas: live, publicRoot: cfg.publicRoot, domain: cfg.domain, folderSubdomains: profile.folderSubdomains, now,
    index: new MediaIndex(cfg.mediaIndex),
    thumbsDir: cfg.mediaThumbs,
    example: exampleIndex(join(assetDir, 'examples', 'media-demo')), exampleDir: join(assetDir, 'examples', 'media-demo'),
    limiter, limits: API_LIMIT, ipOf, hostOf, baseOf, visitorOf, keyFor: (token) => apiKeyFor(db, now(), token), apiError: ctx.apiError,
    routes: live.siteRoutes, examples: on('examples'),
  });

  // Her records, for programs (slice 9). Only reachable for a database whose
  // catalog the panel has pushed AND whose API switch she has turned on.
  if (on('studio')) registerDataApi(app, {
    db, now, pammydbSocket: cfg.pammydbSocket,
    limiter, limits: API_LIMIT, ipOf, apiError: ctx.apiError, hostOf,
    visitorOf: async (req) => {
      const host = hostOf(req);
      if (!host || !readCookie(req.headers.cookie, ctx.cookie)) return null;
      const s = await visitorOf(req, host);
      return s ? { username: s.visitor.username, opens: s.opens } : null;
    },
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send());
  app.setErrorHandler((err, req, reply) => {
    // Postgres down, restarting, or not reached yet: say so, and nginx's error page
    // for /check (a protected page nobody can check just now)
    if (isPgUnavailable(err)) {
      req.log.warn(`database unavailable: ${(err as Error).message}`);
      return reply.code(503).header('Retry-After', '30').send({ error: 'unavailable', message: 'This is taking a short break. Please try again in a minute.' });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: 'bad-request', message: 'Request refused.' });
    req.log.error(err);
    return reply.code(500).send({ error: 'server', message: 'Something went wrong.' });
  });
  return app;
}

// public-gate/examples/<kind>/{page.html,style.css,entries.js}: the worked examples
// (docs/examples-plan.md), read once, each pointed at its own example form. The
// panel writes the very same files into her website, pointed at a form of hers.
function loadFormExamples(dir: string): Map<string, { body: Buffer; type: string }> {
  const out = new Map<string, { body: Buffer; type: string }>();
  for (const kind of EXAMPLE_KINDS) {
    let page: { html: string; css: string; js: string };
    try { page = examplePage(dir, kind, EXAMPLES[kind].formName, '.'); } catch { continue; }
    const at = (file: string, body: string, type: string) =>
      out.set(`/_pammy/examples/${kind}/${file}`, { body: Buffer.from(body), type });
    at('', page.html, 'text/html; charset=utf-8');
    at('index.html', page.html, 'text/html; charset=utf-8');
    at('style.css', page.css, 'text/css; charset=utf-8');
    at('entries.js', page.js, 'text/javascript; charset=utf-8');
  }
  return out;
}

// public-gate/examples/<kind>/{page.html,style.css,<kind>.js} for the media examples
// (docs/media-api-plan.md M10), pointed at the built-in example folder, and the
// example folder's own files (media-demo/).
function loadMediaExamples(dir: string): Map<string, { body: Buffer; type: string }> {
  const out = new Map<string, { body: Buffer; type: string }>();
  for (const kind of MEDIA_EXAMPLE_KINDS) {
    let page: { html: string; css: string; js: string };
    try { page = mediaExamplePage(dir, kind, null, '.'); } catch { continue; }
    const at = (file: string, body: string, type: string) => out.set(`/_pammy/examples/${kind}/${file}`, { body: Buffer.from(body), type });
    at('', page.html, 'text/html; charset=utf-8');
    at('index.html', page.html, 'text/html; charset=utf-8');
    at('style.css', page.css, 'text/css; charset=utf-8');
    at(`${kind}.js`, page.js, 'text/javascript; charset=utf-8');
  }
  const TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', ogg: 'audio/ogg', pdf: 'application/pdf', csv: 'text/csv; charset=utf-8', txt: 'text/plain; charset=utf-8' };
  const walk = (d: string, rel: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(d, n)).isDirectory()) walk(join(d, n), r);
      else if (TYPES[n.split('.').pop()!]) out.set(`${EXAMPLE_FILES_URL}${r.split('/').map(encodeURIComponent).join('/')}`, { body: readFileSync(join(d, n)), type: TYPES[n.split('.').pop()!]! });
    }
  };
  walk(join(dir, 'media-demo'), '');
  return out;
}

// public-gate/examples/<look>/<the five pages and login-files/style.css>, read once.
export const EXAMPLE_LOOKS = ['garden', 'evening', 'postcard'] as const;
export const EXAMPLE_FILES = [...PAGE_KINDS.map((k) => PAGES[k]), 'login-files/style.css'];
function loadExamples(dir: string): Map<string, { body: Buffer; type: string }> {
  const out = new Map<string, { body: Buffer; type: string }>();
  for (const look of EXAMPLE_LOOKS) {
    for (const file of EXAMPLE_FILES) {
      let body: Buffer;
      try { body = readFileSync(join(dir, look, file)); } catch { continue; }
      out.set(`/_pammy/examples/${look}/${file}`, { body, type: file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' });
    }
  }
  return out;
}
