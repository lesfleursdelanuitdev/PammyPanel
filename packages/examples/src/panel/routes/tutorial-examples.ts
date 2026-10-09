// The tutorial examples on panel.pammy.org (docs/tutorial-examples-plan.md):
// the journal and the to-do list from guides 15-18, running for real behind the
// panel's own sign-in, in her own two example databases.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { studioFor } from '@panel/studio/panel/studio';
import { commentAreas } from '@panel/comments/panel/comment-areas';
import { gateHttp } from '@panel/core/panel/gate-http';
import { examples, EXAMPLES_DIR, kindParam } from '../examples.ts';
import { AccountError, logActivity } from '@panel/core/accounts';
import { dataApiUrl, dbExampleForHer, dbFilesDirFor, herPicturePrefix } from '../../gate/db-examples.ts';
import { CallError } from '@panel/core/jsonline';
import { ENGINE_NAMES, isEngine, newNameProblem } from '@panel/studio/pammydb/ident';
import { type Scalar } from '@panel/studio/pammydb/rows';
import { HELPER_STATUS } from '@panel/core/panel/context';
import { type FormSummary, type FormsState } from '@panel/core/panel/gate-shapes';
import { ownsScope } from '@panel/files/panel/site-files';
import { all, one, run, tx } from '@panel/core/pg';
import { clientIp } from '@panel/core/security';
import { uploadToSiteFs } from '@panel/files/sitefs/client';
import { type ManagedRow, getManaged, listManaged, startManaging } from '@panel/studio/studio/databases';
import { DB_EXAMPLES } from '../../studio/db-examples.ts';
import { getDraftRow, schemaView } from '@panel/studio/studio/schema';
import { TUTORIAL_EXAMPLES, TUTORIAL_KINDS, type TutorialKind } from '../../studio/tutorial-examples.ts';
import { DEMO_FOLDERS, demoFiles, isDemoFolder, writeDemos } from '../../tutorial-demos.ts';
import { plural } from '@panel/core/util';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FilesCtx } from '@panel/files/panel/files-ctx';
import type { StudioParams } from '@panel/studio/panel/studio-ctx';

export function routes(app: FastifyInstance, ctx: FilesCtx & StudioParams) {
  const APP = ctx.config.site.words.app;   // the glossary (docs/adapters-plan.md A7)
  // the to-do examples' key once it is known (N6); '' means \"looked and there was none\"
  let heldKey: string | null = null;
  const { config, db, now, need, may, body, actorOf, authOf, gate, helper, studio, syncSoon, appNameOf } = ctx;
  const { liveSchema, refreshCatalog } = studioFor(ctx);
  const { linkCommentArea } = commentAreas(ctx);
  // as one of her pages would ask, over the gate's HTTP port (N4)
  const { siteDomain, ask: askGate, answer: gateAnswer, fetchBytes } = gateHttp(ctx);
  const { EXAMPLE_NAMES, titleTaken, fillDatabase, remakeExampleDatabase } = examples(ctx);

    // ---------------------------------------------------------------- the tutorial examples
    // (docs/tutorial-examples-plan.md) Finished copies of what guides 15-18 build,
    // here on panel.pammy.org and nowhere on her website: two databases the panel
    // owns, set up and put back like the database examples, and the four pages --
    // the tutorials' own files with only the database's name changed
    // (src/tutorial-demos.ts). The panel serves their HTML, CSS and JavaScript,
    // and answers their questions to /_pammy/ on this address; nginx hands their
    // PHP to pammy-php's second pool (deploy/nginx/panel-tutorial-examples.conf),
    // asking /api/tutorial-examples/who first. Account managers only, like the
    // Databases menu.
    const tutorialRowOf = (kind: TutorialKind) =>
      one<ManagedRow>(db, 'SELECT * FROM studio_databases WHERE example = ?', kind);
    const demosReady = () => DEMO_FOLDERS.every((f) => { try { return statSync(join(config.tutorialExamplesDir, f, 'index.' + (f.endsWith('-php') ? 'php' : 'html'))).isFile(); } catch { return false; } });
    // N6: the to-do lists' key. It is made at set-up and PHP reads it from the
    // example's settings.php, so that file is where it lives; the panel keeps
    // what it read rather than parsing the file again on every request.
    const demoKey = (): string | null => {
      if (heldKey === null) {
        try {
          heldKey = /return '([A-Za-z0-9_-]+)';/.exec(readFileSync(join(config.tutorialExamplesDir, 'todo-php', 'settings.php'), 'utf8'))?.[1] ?? '';
        } catch { heldKey = ''; }
      }
      return heldKey || null;
    };


    app.get('/api/tutorial-examples', { config: { needs: 'examples' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const examples = [];
      for (const kind of TUTORIAL_KINDS) {
        const ex = TUTORIAL_EXAMPLES[kind];
        const row = await tutorialRowOf(kind);
        examples.push({
          kind, heading: ex.heading, about: ex.about, database: ex.database, setUp: !!row && row.status === 'active',
          demos: ex.demos.map((d) => ({ ...d, href: `/tutorial-examples/${d.folder}/` })),
        });
      }
      return { examples, ready: examples.every((e) => e.setUp) && demosReady() };
    });

    // Set them both up, or put them back as they were: the same thing. What
    // anyone added to them goes, and so does every to-do list in the example.
    app.post('/api/tutorial-examples/setup', { config: { needs: 'examples' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      let again = false;
      let rows = 0;
      for (const kind of TUTORIAL_KINDS) {
        const ex = TUTORIAL_EXAMPLES[kind];
        again = await remakeExampleDatabase(a, ex) || again;
        const ids = new Map<string, Scalar>();
        rows += await fillDatabase(a, ex, ex.engine, ex.database, { rows: true, pictures: '', ids });
        if (ex.apiWrite) {
          await run(db, 'UPDATE studio_databases SET api_write = 1 WHERE engine = ? AND name = ?', ex.engine, ex.database);
          await refreshCatalog(a, ex.engine, ex.database);
        }
        // the journal's comment area, put back with its sample comments on their posts
        if (ex.comments) {
          const dayOf = (post: string) => {
            const on = ex.rows.find((r) => r.ref === `post:${post}`)?.values.published_on;
            return typeof on === 'string' ? Math.floor(Date.parse(`${on}T12:00:00Z`) / 1000) : now();
          };
          await gate({
            op: 'comments.example', ...ex.comments.area, page: ex.comments.page, actor: a.user.username,
            items: ex.comments.items.filter((c) => ids.has(`post:${c.post}`)).map((c) => ({
              contentId: String(ids.get(`post:${c.post}`)), author: c.author, body: c.body, at: dayOf(c.post) + c.daysAfter * 86400,
            })),
          });
        }
      }
      // N8: the two example databases are set up one after the other, each one
      // emptied and filled again. If the second fails, the first has already
      // been put back -- which is what "Put them back as they were" means, so it
      // is only worth saying, not worth a transaction across two databases.

      // the to-do lists' key (guide 18, PART 2), for the PHP example's settings.php
      // and the JavaScript example's questions (below). A new one each time: putting
      // the example back switched the old one off with its app.
      const todo = (await tutorialRowOf('tutorial-todo'))!;
      const made = await gate<{ key: string }>({
        op: 'appkey.create', databaseId: todo.id, label: 'The tutorial examples (made by the panel)', resources: 'all', canWrite: true, actor: a.user.username,
      });
      // made by the installer, the panel's and PHP's (deploy/install-panel.sh)
      if (!existsSync(config.tutorialExamplesDir)) {
        throw new AccountError(`The databases are ready, but the folder for the examples' pages (${config.tutorialExamplesDir}) is missing. That is for momolig: running the installer again makes it.`, 500);
      }
      writeDemos(config.tutorialExamplesDir, demoFiles(config.tutorialsDir, made.key));
      heldKey = made.key;                       // N6: written once, kept here
      await logActivity(db, now(), actorOf(a, req), again ? 'tutorial-examples-reset' : 'tutorial-examples-set-up',
        'the tutorial examples', `the journal and the to-do list, with ${plural(rows, 'sample record')}`);
      return { ok: true, rows };
    });

    // For nginx, before it hands one of the examples' PHP pages to PHP: who is
    // signed in to the panel. That is PAMMY_USER on the page (guide 18).
    app.get('/api/tutorial-examples/who', { config: { needs: 'examples' } }, async (req, reply) => {
      const a = await authOf(req);
      if (!a || !may(a, req)) return reply.code(401).send();
      return reply.code(204).header('X-Panel-User', a.user.username).send();
    });

    // Their HTML, CSS and JavaScript. Never a .php file: nginx sends those to PHP,
    // and if it ever didn't, the answer here is still "not found", never the code.
    const DEMO_TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8' };
    // inline styles: the comments component styles itself (as on the gate's own
    // example pages); scripts stay the panel's own files only
    const DEMO_POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'";
    app.get('/tutorial-examples/:folder', { config: { needs: 'examples' } }, async (req, reply) => reply.redirect(`/tutorial-examples/${encodeURIComponent((req.params as { folder: string }).folder)}/`));
    app.get('/tutorial-examples/:folder/*', { config: { needs: 'examples' } }, async (req, reply) => {
      // every answer here may show in the examples' frames, "not here yet" included
      reply.header('Content-Security-Policy', DEMO_POLICY);
      const a = await authOf(req);
      if (!a || !may(a, req)) return reply.code(401).type('text/plain').send('Sign in to the control panel to see the tutorial examples.');
      const { folder, '*': rest } = req.params as { folder: string; '*': string };
      const name = rest === '' ? 'index.html' : rest;
      const m = /^[a-z0-9-]+\.(html|css|js)$/.exec(name);
      if (!isDemoFolder(folder) || !m) return reply.code(404).type('text/plain').send('Not found');
      let content: Buffer;
      try { content = readFileSync(join(config.tutorialExamplesDir, folder, name)); } catch {
        return reply.code(404).type('text/plain').send('Not here yet: set up the tutorial examples first (Databases, then Tutorial examples).');
      }
      return reply.header('Cache-Control', 'private, no-store').type(DEMO_TYPES[m[1]!]!).send(content);
    });

    // What the examples' JavaScript asks on this address, as it would ask
    // pammy.org. "Who is signed in" is whoever is signed in to the panel.
    app.get('/_pammy/me', { config: { needs: 'examples' } }, async (req, reply) => {
      const a = await authOf(req);
      if (!a || !may(a, req)) return reply.code(401).send({ signedIn: false });
      return { signedIn: true, username: a.user.username };
    });
    // The journal's comments (guide 15 PART 10): the component, and its questions
    // to the example's own comment area, passed to the gate as coming from the
    // example's page there (_pammy/examples/tutorial-journal/) -- what a visitor
    // to her journal gets and sends. Only that area, and only for the panel's
    // managers; a comment still waits for an OK on the Comments tab.
    const EXAMPLE_COMMENTS = TUTORIAL_EXAMPLES['tutorial-journal'].comments!;
    const commentsPath = (rest: string) => `/_pammy/comments/${EXAMPLE_COMMENTS.area.name}${rest}`;
    const onExamplePage = (url: string) => {
      const q = new URLSearchParams(url.split('?')[1] ?? '');
      q.set('page', `/_pammy/examples/${EXAMPLE_COMMENTS.page}/`);
      return q.toString();
    };
    app.get('/_pammy/comments.js', { config: { needs: 'examples' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const got = await fetchBytes('/_pammy/comments.js');
      return reply.code(got.status).type('text/javascript; charset=utf-8').header('Cache-Control', 'no-store').send(got.bytes);
    });
    for (const rest of ['', '/form', '/counts']) {
      app.get(commentsPath(rest), { config: { needs: 'examples' } }, async (req, reply) => {
        const a = await need(req, reply);
        if (!a) return reply;
        return gateAnswer(reply, askGate('GET', `${commentsPath(rest)}?${onExamplePage(req.url)}`));
      });
    }
    app.post(commentsPath(''), { config: { needs: 'examples' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const sent = body(req);
      return gateAnswer(reply, askGate('POST', commentsPath(''), {
        body: { ...sent, page: `/_pammy/examples/${EXAMPLE_COMMENTS.page}/` }, origin: `https://${siteDomain}`, ip: clientIp(req),
      }));
    });

    // The journal: straight to the gate, and only reading -- exactly what anyone reading her journal gets.
    app.get('/_pammy/api/data/postgres/example_journal/*', { config: { needs: 'examples' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return gateAnswer(reply, askGate('GET', req.url));
    });
    // The to-do list, with the example's key, and each account only ever
    // reaching its own tasks -- what the gate does for people signed in to her
    // folder (guide 17), done here the way guide 18's PHP does it: the owner
    // written in on every new one, the list asked for by owner, and a task
    // looked at before it is changed or deleted.
    const TASKS = '/_pammy/api/data/postgres/example_todo/tasks';
    const notHere = (reply: FastifyReply) => reply.code(404).send({ error: 'not-found', message: 'There is no record with that name here.' });

    // N5: every to-do route starts the same way -- a manager, a key, and (for
    // one row) "is it theirs?". The gate applies the same rule for a signed-in
    // visitor (V2); here the panel is the one signed in, so it applies it
    // itself, in one place rather than four.
    type Asker = { me: string; key: string; mine: (id: string) => Promise<boolean> };
    const asker = async (req: FastifyRequest, reply: FastifyReply): Promise<Asker | null> => {
      const a = await need(req, reply);
      if (!a) return null;
      const key = demoKey();
      if (!key) {
        void reply.code(503).send({ error: 'not-set-up', message: 'Set up the tutorial examples first.' });
        return null;
      }
      const me = a.user.username;
      return {
        me, key,
        mine: async (id: string) => {
          const got = await askGate('GET', `${TASKS}/${encodeURIComponent(id)}`, { key });
          return (got.json as { item?: { owner?: unknown } }).item?.owner === me;
        },
      };
    };
    // what a visitor may send: never the owner, which the panel fills in
    const sentValues = (req: FastifyRequest) => {
      const sent = (body(req).values ?? {}) as Record<string, unknown>;
      const values = typeof sent === 'object' && sent !== null && !Array.isArray(sent) ? { ...sent } : {};
      delete values.owner;
      return values;
    };
    app.get('/_pammy/api/data/postgres/example_todo/tasks', { config: { needs: 'examples' } }, async (req, reply) => {
      const who = await asker(req, reply);
      if (!who) return reply;
      const q = new URLSearchParams(req.url.split('?')[1] ?? '');
      q.delete('where.owner');
      q.set('where.owner', who.me);
      return gateAnswer(reply, askGate('GET', `${TASKS}?${q}`, { key: who.key }));
    });
    app.get('/_pammy/api/data/postgres/example_todo/tasks/:id', { config: { needs: 'examples' } }, async (req, reply) => {
      const who = await asker(req, reply);
      if (!who) return reply;
      const { id } = req.params as { id: string };
      if (!await who.mine(id)) return notHere(reply);
      return gateAnswer(reply, askGate('GET', `${TASKS}/${encodeURIComponent(id)}`, { key: who.key }));
    });
    app.post('/_pammy/api/data/postgres/example_todo/tasks/:id/:what', { config: { needs: 'examples' } }, async (req, reply) => {
      const who = await asker(req, reply);
      if (!who) return reply;
      const { id, what } = req.params as { id: string; what: string };
      if (what !== 'save' && what !== 'delete') return notHere(reply);
      const values = sentValues(req);
      if (!await who.mine(id)) return notHere(reply);
      return gateAnswer(reply, askGate('POST', `${TASKS}/${encodeURIComponent(id)}/${what}`, { key: who.key, body: what === 'save' ? { values } : {} }));
    });
    app.post('/_pammy/api/data/postgres/example_todo/tasks/new', { config: { needs: 'examples' } }, async (req, reply) => {
      const who = await asker(req, reply);
      if (!who) return reply;
      return gateAnswer(reply, askGate('POST', `${TASKS}/new`, { key: who.key, body: { values: { ...sentValues(req), owner: who.me } } }));
    });

    // "Make my own" (X3): a database of hers, the same tables and app, the rows
    // if she ticks it, and the page in a folder of her website. Everything is
    // checked before anything is made; after that, each step says what it did,
    // and a step that fails leaves the ones before it done.
    app.post('/api/databases/examples/:kind/copy', { config: { needs: 'examples' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const kind = kindParam(req);
      const ex = DB_EXAMPLES[kind];
      const b = body(req);
      if (!isEngine(b.engine)) throw new AccountError('Please choose which kind of database.', 400);
      const engine = b.engine;
      const problem = newNameProblem(b.name, engine);
      if (problem) throw new AccountError(problem, 400);
      const name = b.name as string;
      if (EXAMPLE_NAMES.has(name)) throw new AccountError(`${name} is kept for the panel's example. Choose another name.`, 400);
      const title = appNameOf(b.title);
      if (!title) throw new AccountError(`Give the ${APP.one} a name, like "Recipe book".`, 400);
      if (await titleTaken(title)) throw new AccountError(`${APP.a[0]!.toUpperCase()}${APP.a.slice(1)} called ${title} is already switched on. Give this one another name.`, 400);
      const folder = typeof b.folder === 'string' ? b.folder.trim().replace(/^\/+|\/+$/g, '') : '';
      if (!ownsScope(a, folder ? `/${folder}` : '/')) throw new AccountError('Not found.', 404);
      const pageName = typeof b.page === 'string' ? b.page.trim().toLowerCase() : '';
      if (!/^[a-z0-9][a-z0-9-]{0,60}\.html$/.test(pageName)) throw new AccountError('The page needs a name like recipes.html: lowercase letters, digits and hyphens.', 400);
      const rowsToo = b.rows === true;
      // the page and its files folder must be free before a database is made for them
      const there = await helper<{ buckets: { name: string }[]; files: { name: string }[] }>({ op: 'files-list', dir: folder, actor: a.user.username });
      const filesDir = dbFilesDirFor(pageName);
      if (there.files.some((f) => f.name === pageName) || there.buckets.some((d) => d.name === filesDir)) {
        throw new AccountError(`${folder || 'Your website'} already has ${pageName} or ${filesDir}. Choose another name for the page.`, 409);
      }

      // 1. her database
      await studio({ op: 'create-database', engine, name, actor: a.user.username });
      await tx(db, async (q) => {
        await startManaging(q, { engine, name, displayName: title, at: now() });
        // what Getting started looks for (docs/getting-started-plan.md G1)
        await run(q, 'UPDATE studio_databases SET copied_from = ?, page = ?, copied_rows = ? WHERE engine = ? AND name = ?',
          kind, `${folder ? `${folder}/` : ''}${pageName}`, rowsToo, engine, name);
      });
      const done = ['made the database'];
      let rows = 0;
      try {
        // 2-4. tables, the app's settings, the rows, switched on
        rows = await fillDatabase(a, ex, engine, name, { rows: rowsToo, pictures: herPicturePrefix(pageName) });
        done.push('made the tables', `switched the ${APP.one} on`);
        // 5. a comment area of her own, keeping its approved comments in her
        // database (docs/comments-plan.md) -- starting empty: the samples are the example's
        let area: string | undefined;
        if (ex.comments) {
          area = `${name.replace(/_/g, '-')}-comments`.slice(0, 64);
          const st = await gate<FormsState>({ op: 'forms.state' });
          const found = st.forms.find((f) => f.name === area);
          const f = found ?? await gate<FormSummary>({ op: 'form.create', name: area, title: `Comments (${title})`, kind: 'comments', contentType: ex.comments.area.contentType, actor: a.user.username });
          const row = (await getManaged(db, engine, name))!;
          await linkCommentArea(a, f.id, row.id, engine, name);
          done.push('made its comment area');
        }
        // 6. the page, pointed at her database (and her comment area)
        const her = dbExampleForHer(EXAMPLES_DIR, kind, dataApiUrl(engine, name), pageName, title, rowsToo && ex.pictures.length > 0, area);
        await helper({ op: 'install-pages', path: folder, files: her.files, actor: a.user.username });
        done.push('put the page on your website');
        for (const p of her.pictures) {
          const dir = folder ? `${folder}/${p.dir}` : p.dir;
          try {
            await uploadToSiteFs(config.sitefsSocket, { op: 'files-upload', dir, name: p.name, size: p.bytes.length, actor: a.user.username }, Readable.from(p.bytes));
          } catch (e) {
            if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
            throw e;
          }
        }
        // the Files page learns about them at once rather than at the next sync
        if (her.pictures.length) syncSoon();
      } catch (e) {
        const said = e instanceof AccountError ? e.message : 'Something went wrong.';
        throw new AccountError(`The panel ${done.join(', then ')}, and then stopped: ${said} The database ${name} is yours either way — it is in the Database Manager.`, e instanceof AccountError ? e.status : 500);
      }
      await logActivity(db, now(), actorOf(a, req), 'database-example-copied', `${ENGINE_NAMES[engine]}: ${name}`,
        `from the ${ex.heading.toLowerCase()} example${rowsToo ? `, with ${plural(rows, 'sample record')}` : ''}; the page is ${folder ? `${folder}/` : ''}${pageName}`);
      const domain = config.rpID.replace(/^panel\./, '');
      return {
        ok: true, engine, name, title, folder, rows,
        address: `https://${domain}/${folder ? `${encodeURIComponent(folder)}/` : ''}${pageName}`,
        subdomainAddress: config.site.folderSubdomains && folder && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(folder) ? `https://${folder}.${domain}/${pageName}` : null,
      };
    });

    // Home's quiet card (docs/databases-plan.md 16): whether she has any
    // databases yet, and which have changes drawn and not applied. The apps she
    // has switched on come from /api/apps, which the menu has already fetched.
    //
    // A drawing is only "waiting" if it really differs from the database -- she
    // may have added a field and taken it away again, and Home must not tell her
    // something is waiting when the Review page would say "Nothing to apply". So
    // each database with a drawing is read, but briefly: Home is the first page
    // she sees, and a slow or sleeping engine gets "could not check" rather than
    // holding it up.
    const HOME_LOOK = 4_000;
    app.get('/api/databases/home', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const rows = await listManaged(db);
      const drawn = new Set((await all<{ database_id: number }>(db, 'SELECT database_id FROM studio_drafts')).map((r) => r.database_id));
      const waiting = await Promise.all(rows.filter((r) => drawn.has(r.id)).map(async (row) => {
        const said = { engine: row.engine, name: row.name, title: row.display_name || row.name, active: row.status === 'active' };
        try {
          const look = liveSchema(a, row.engine, row.name);
          look.catch(() => {});   // it may lose the race below, and still fail later
          let timer: NodeJS.Timeout | undefined;
          const current = await Promise.race([look, new Promise<null>((ok) => { timer = setTimeout(() => ok(null), HOME_LOOK); })])
            .finally(() => clearTimeout(timer));
          if (!current) return { ...said, changes: null };
          const { hash, ...snapshot } = current;
          const view = schemaView({ engine: row.engine, database: row.name, current: snapshot, currentHash: hash, row: await getDraftRow(db, row.id) });
          return view.plan.steps.length ? { ...said, changes: view.plan.changes.length } : null;
        } catch {
          return { ...said, changes: null };
        }
      }));
      return { managed: rows.length, waiting: waiting.filter((w) => w !== null) };
    });


}
