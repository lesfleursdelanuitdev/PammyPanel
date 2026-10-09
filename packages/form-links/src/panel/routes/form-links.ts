// Forms into a database (docs/form-to-database-plan.md), the panel's half: what
// fits where, what she picked, and what the gate has done with it since. The
// writing itself is the gate's (src/gate/saves/).
import type { FastifyInstance } from 'fastify';
import { studioFor } from '@panel/studio/panel/studio';
import { AccountError, logActivity } from '@panel/core/accounts';
import { isAnswerType } from '@panel/forms/shared/form-types';
import { type Engine, NAME_RE, isEngine } from '@panel/studio/pammydb/ident';
import { type FormFull } from '@panel/core/panel/gate-shapes';
import { all } from '@panel/core/pg';
import { type Authed } from '@panel/core/sessions';
import {
  checkLinkShape, fits as fitsField, linkProblems, suggestPairs, type FormLink, type Question as LinkQuestion, type TargetField,
} from '../../studio/form-links.ts';
import type { StudioCtx } from '@panel/studio/panel/studio-ctx';
import { isKept, keptTo } from '@panel/core/panel/rights';

export function routes(app: FastifyInstance, ctx: StudioCtx) {
  const APP = ctx.config.site.words.app;   // the glossary (docs/adapters-plan.md A7)
  const { db, now, need, body, idParam, actorOf, gate, engineParam, dbNameParam } = ctx;
  const { managed, appFor, refreshCatalog } = studioFor(ctx);

    // ---------------------------------------------------------------- forms into a database
    // (docs/form-to-database-plan.md). The link lives in the gate, which holds the
    // responses and writes the rows; the panel knows her tables, so it works out
    // what fits, refuses a link that is not complete (F7), and pushes it.
    const PRIVATE_TYPES = new Set(['email', 'phone', 'address', 'hidden']);
    const questionsOf = (f: FormFull): LinkQuestion[] => f.items.flatMap((i) => {
      if (!isAnswerType(i.type) || !i.key) return [];
      const parts = i.type === 'name' ? ['first', 'last', ...(i.parts?.title ? ['title'] : []), ...(i.parts?.middle ? ['middle'] : [])]
        : i.type === 'address' ? ['line1', 'town', ...Object.entries(i.parts ?? {}).filter(([, on]) => on).map(([k]) => k)]
          : undefined;
      return [{ key: i.key, label: i.label ?? i.key, type: i.type, required: i.required === true, ...(parts ? { parts } : {}) }];
    });
    // Only the account manager, for a form of hers (not an example), everywhere.
    const linkableForm = async (a: Authed, id: number): Promise<FormFull> => {
      if (isKept(a.user)) throw new AccountError('Not found.', 404);
      const f = await gate<FormFull>({ op: 'form.get', id });
      if (f.fixture) throw new AccountError("The examples' forms can't save into a database.", 400);
      return f;
    };
    // A table a form may write into: in the app, decided, with "Add new ones"
    // on -- what the app would not let her add by hand, a form cannot add (F2).
    // Its fields: what the window shows, minus the key and connections (Q3).
    const tablesFor = async (a: Authed, engine: Engine, name: string, questions: LinkQuestion[]) => {
      const { row } = await managed(a, engine, name);
      if (row.example) throw new AccountError("The examples' databases can't be filled in by your forms.", 400);
      if (row.status !== 'active') throw new AccountError(`Switch the ${APP.one} on first: a form can only save into a table of ${APP.a} that is on.`, 400);
      const view = await appFor(a, engine, name);
      return {
        row,
        tables: view.resources.filter((r) => r.enabled && r.decided && r.can.create).map((r) => {
          const fields = r.fields.filter((f) => f.exposed && !f.primaryKey && !f.reference);
          const types: Record<string, TargetField> = Object.fromEntries(fields.map((f) => [f.name, {
            type: f.type, ...(f.length ? { length: f.length } : {}), required: f.required, defaulted: f.defaulted, ...(f.control === 'rich' ? { rich: true } : {}),
          }]));
          const fitsFor = (type: LinkQuestion['type'], part?: string) => fields.filter((f) => fitsField(type, part, types[f.name]!)).map((f) => f.name);
          return {
            table: r.table, plural: r.plural, singular: r.singular, publicRead: r.publicRead,
            fields: fields.map((f) => ({ name: f.name, label: f.label, type: f.type, storedAs: f.storedAs, required: f.required && !f.defaulted })),
            types,
            // for each question (and each part of a name or address), the fields it may go into
            fits: Object.fromEntries(questions.flatMap((q) => [
              [q.key, fitsFor(q.type)],
              ...(q.parts ?? []).map((part) => [`${q.key}.${part}`, fitsFor(q.type, part)]),
            ])),
            suggested: suggestPairs(questions, types),
          };
        }),
      };
    };

    app.get('/api/forms/:id/database', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const f = await linkableForm(a, idParam(req, 'id'));
      const questions = questionsOf(f);
      const state = await gate<{ link: FormLink | null; saved: number; problems: number; notSaved: number }>({ op: 'formlink.get', id: f.id });
      const databases = (await all<{ engine: Engine; name: string; display_name: string; status: string }>(db,
        'SELECT engine, name, display_name, status FROM studio_databases WHERE example IS NULL ORDER BY display_name, name'))
        .map((d) => ({ engine: d.engine, name: d.name, title: d.display_name || d.name, active: d.status === 'active' }));
      // how the link stands against her tables now: a renamed field, a table
      // switched off -- said here before a response finds out
      let problems: string[] = [];
      if (state.link) {
        try {
          const t = (await tablesFor(a, state.link.engine, state.link.name, questions)).tables.find((x) => x.table === state.link!.table);
          problems = t ? linkProblems(state.link, questions, t.types) : [`${state.link.table} can't be filled in just now: it has to be in the ${APP.one} with "Add new ones" on.`];
        } catch (e) { problems = [e instanceof AccountError ? e.message : 'The database could not be looked at just now.']; }
      }
      return { form: { id: f.id, name: f.name, title: f.title, approvable: f.approvable, autoApprove: f.autoApprove }, questions, ...state, problems, databases };
    });

    app.get('/api/forms/:id/database/:engine/:name', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const f = await linkableForm(a, idParam(req, 'id'));
      const { tables } = await tablesFor(a, engineParam(req), dbNameParam(req), questionsOf(f));
      return { tables: tables.map(({ types: _, ...t }) => t) };
    });

    app.post('/api/forms/:id/database', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const f = await linkableForm(a, idParam(req, 'id'));
      const b = body(req);
      const questions = questionsOf(f);
      let shape;
      try { shape = checkLinkShape(b); } catch (e) { throw new AccountError((e as Error).message, 400); }
      if (!isEngine(b.engine) || typeof b.name !== 'string' || !NAME_RE.test(b.name)) throw new AccountError('Which database?', 400);
      const engine: Engine = b.engine;
      const name: string = b.name;
      const { row, tables } = await tablesFor(a, engine, name, questions);
      const t = tables.find((x) => x.table === shape.table);
      if (!t) throw new AccountError(`That table has to be in the ${APP.one} with "Add new ones" on before a form can save into it.`, 400);
      const problems = linkProblems(shape, questions, t.types);
      if (problems.length) throw new AccountError(problems.join(' '), 400);
      // F8: a private answer into a table anyone can read, only when she says so
      const exposing = shape.pairs.map((p) => questions.find((q) => q.key === p.key)!)
        .filter((q) => PRIVATE_TYPES.has(q.type) || f.items.find((i) => i.key === q.key)?.public === false);
      if (t.publicRead && exposing.length && b.confirmPublic !== true) {
        return reply.code(409).send({ error: 'confirm-public', message: `Anyone can read ${t.plural}, so ${exposing.map((q) => `"${q.label}"`).join(' and ')} would be public. Are you sure?` });
      }
      // the gate checks every row against the catalog, which now carries each
      // field's kind: push it first, so it is the one the link is checked against
      await refreshCatalog(a, engine, name);
      const link = await gate<FormLink>({ op: 'formlink.save', id: f.id, link: { ...shape, databaseId: row.id, engine, name }, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'form-linked', f.name, `${link.enabled ? 'saves answers in' : 'saving switched off for'} ${t.plural} (${name})`);
      return { ok: true, link };
    });

    app.post('/api/forms/:id/database/disconnect', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const f = await linkableForm(a, idParam(req, 'id'));
      await gate({ op: 'formlink.drop', id: f.id });
      await logActivity(db, now(), actorOf(a, req), 'form-unlinked', f.name, null);
      return { ok: true };
    });

    // Q2: the responses already there, saved once on her word.
    app.post('/api/forms/:id/database/earlier', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const f = await linkableForm(a, idParam(req, 'id'));
      const r = await gate<{ saved: number; problems: number }>({ op: 'formlink.save-earlier', id: f.id });
      await logActivity(db, now(), actorOf(a, req), 'form-earlier-saved', f.name, `${r.saved} saved${r.problems ? `, ${r.problems} could not be` : ''}`);
      return { ok: true, ...r };
    });

    // "Try again" on a response that could not be saved (F10).
    app.post('/api/responses/:id/save-again', { config: { needs: 'responses' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return { ok: true, result: await gate({ places: keptTo(a.user), op: 'response.save-again', id: idParam(req, 'id') }) };
    });

    // "Filled in by the form ...", for a table's own page.
    app.get('/api/databases/:engine/:name/form-links', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const { row } = await managed(a, engineParam(req), dbNameParam(req));
      return gate<{ links: unknown[] }>({ op: 'formlinks.for-database', databaseId: row.id });
    });


}
