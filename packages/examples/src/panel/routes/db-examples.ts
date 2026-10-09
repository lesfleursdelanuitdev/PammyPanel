// The database examples (docs/db-examples-plan.md): the recipe book and the
// blog, made by the panel, hers to play with, put back by Reset.
import type { FastifyInstance } from 'fastify';
import { examples, EXAMPLES_DIR } from '../examples.ts';
import { AccountError, logActivity } from '@panel/core/accounts';
import { dataApiUrl, dbExamplePage, dbFilesDirFor, examplePicturePrefix } from '../../gate/db-examples.ts';
import { ENGINE_NAMES } from '@panel/studio/pammydb/ident';
import { type Scalar } from '@panel/studio/pammydb/rows';
import { getManaged } from '@panel/studio/studio/databases';
import { DB_EXAMPLES, DB_EXAMPLE_KINDS, type DbExampleKind, isDbExampleKind } from '../../studio/db-examples.ts';
import { plural } from '@panel/core/util';
import { type FastifyRequest } from 'fastify';
import type { PanelCtx } from '@panel/core/panel/context';

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { config, db, now, need, actorOf, gate } = ctx;
  const { exampleRowOf, fillDatabase, remakeExampleDatabase } = examples(ctx);

    // ---------------------------------------------------------------- the database examples
    // A recipe book on Postgres and a blog on MariaDB (docs/db-examples-plan.md):
    // real databases the panel owns, with sample rows, an app switched on, and a
    // public page that reads them without a key. "Make my own" builds the same
    // thing as a database of hers, with the page in a folder of her website.
    const kindParam = (req: FastifyRequest): DbExampleKind => {
      const kind = (req.params as { kind?: string }).kind;
      if (!isDbExampleKind(kind)) throw new AccountError('There is no example called that.', 404);
      return kind;
    };



    app.get('/api/databases/examples', { config: { needs: 'examples' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const examples = [];
      for (const kind of DB_EXAMPLE_KINDS) {
        const ex = DB_EXAMPLES[kind];
        const row = await exampleRowOf(kind);
        examples.push({
          kind, heading: ex.heading, about: ex.about, engine: ex.engine, database: ex.database, title: ex.title,
          suggested: ex.suggested, pictures: ex.pictures.length,
          // "set up" = the panel made it and still looks after it
          setUp: !!row, active: row?.status === 'active',
        });
      }
      return { examples, domain: config.rpID.replace(/^panel\./, '') };
    });

    // Its three files as her copy would have them, for "the code".
    app.get('/api/databases/examples/:kind', { config: { needs: 'examples' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const kind = kindParam(req);
      const ex = DB_EXAMPLES[kind];
      const page = dbExamplePage(EXAMPLES_DIR, kind, dataApiUrl(ex.engine, ex.suggested.name), dbFilesDirFor(ex.suggested.pageName), ex.suggested.title,
        ex.comments ? `${ex.suggested.name}-comments` : undefined);
      const files = dbFilesDirFor(ex.suggested.pageName);
      return {
        kind, heading: ex.heading,
        files: [
          { path: ex.suggested.pageName, content: page.html },
          { path: `${files}/style.css`, content: page.css },
          { path: `${files}/${kind}.js`, content: page.js },
        ],
      };
    });


    // Set it up, or put it back as it was shipped: the same thing. Her rows in it
    // go, which is what the button says. Only ever a database the panel made for
    // this example -- one of hers with the same name is never touched.
    app.post('/api/databases/examples/:kind/setup', { config: { needs: 'examples' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const kind = kindParam(req);
      const ex = DB_EXAMPLES[kind];
      const old = await remakeExampleDatabase(a, ex);
      const ids = new Map<string, Scalar>();
      const rows = await fillDatabase(a, ex, ex.engine, ex.database, { rows: true, pictures: examplePicturePrefix, ids });
      // its comment area, with its sample comments on their posts, kept in the
      // example database too (docs/comments-plan.md)
      if (ex.comments) {
        const row = (await getManaged(db, ex.engine, ex.database))!;
        const dayOf = (post: string) => {
          const on = ex.rows.find((r) => r.ref === `post:${post}`)?.values.published_on;
          return typeof on === 'string' ? Math.floor(Date.parse(`${on}T12:00:00Z`) / 1000) : now();
        };
        await gate({
          op: 'comments.example', ...ex.comments.area, actor: a.user.username,
          items: ex.comments.items.filter((c) => ids.has(`post:${c.post}`)).map((c) => ({
            contentId: String(ids.get(`post:${c.post}`)), author: c.author, body: c.body, at: dayOf(c.post) + c.daysAfter * 86400,
          })),
          link: { databaseId: row.id, engine: ex.engine, name: ex.database, table: 'comments', when: 'approved', fixed: [], enabled: true,
            pairs: [{ key: 'your-name', field: 'author' }, { key: 'your-comment', field: 'body' }] },
        });
      }
      await logActivity(db, now(), actorOf(a, req), old ? 'database-example-reset' : 'database-example-set-up',
        `${ENGINE_NAMES[ex.engine]}: ${ex.database}`, `the ${ex.heading.toLowerCase()} example, with ${plural(rows, 'sample record')}`);
      return { ok: true, rows };
    });


}
