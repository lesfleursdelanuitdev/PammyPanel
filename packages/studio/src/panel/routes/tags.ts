// Tags and categories on her records (docs/catalog-plan.md step 4): the switch on a
// table's settings, "Read again", the table's own labels, and a record's labels.
// Only with the catalog on (the site hands in the keeper); the databases right, as
// editing records needs.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { studioFor } from '../studio.ts';
import { AccountError, logActivity } from '@panel/core/accounts';
import { NAME_RE } from '../../pammydb/ident.ts';
import {
  allScopeId, createScopeLabel, deleteScopeLabel, renameScopeLabel, scopeLabels, setItemLabels, setScopeLabelPublic, sourceCounts,
} from '@panel/catalog/items';
import type { LabelType } from '@panel/catalog/labels';
import { plural } from '@panel/core/util';
import { RECENT_AUTH } from '@panel/core/config';
import { type Authed } from '@panel/core/sessions';
import { keyOf, whereFor } from '../../studio/records.ts';
import { MAX_TAGGED, recordKey } from '../../studio/tagging.ts';
import { type ResourceView } from '../../studio/resources.ts';
import type { RecordKeeper } from '../tagging.ts';
import type { StudioCtx } from '../studio-ctx.ts';

const typeParam = (v: unknown): LabelType => {
  if (v === 'tag' || v === 'category') return v;
  throw new AccountError('Not found.', 404);
};

// fields that can hold a picture's address: text
const pictureChoices = (r: ResourceView) => r.fields.filter((f) => f.type === 'text' || f.type === 'short_text').map((f) => ({ name: f.name, label: f.label }));

export function routes(app: FastifyInstance, ctx: StudioCtx, keeper: RecordKeeper) {
  const { db, now, need, limited, body, idParam, actorOf, engineParam, dbNameParam, tableParam } = ctx;
  const { changeable, appFor, resourceOf, refreshCatalog } = studioFor(ctx);

  const tableOf = async (a: Authed, req: FastifyRequest) => {
    const engine = engineParam(req);
    const name = dbNameParam(req);
    const { row } = await changeable(a, engine, name);
    const r = resourceOf(await appFor(a, engine, name), tableParam(req));
    if (!r.enabled) throw new AccountError(`That is not one of the tables this ${ctx.config.site.words.app.one} manages.`, 404);
    return { engine, name, d: { id: Number(row.id), engine, name }, r };
  };
  const refsOf = async (r: ResourceView) => {
    const refs = await keeper.refs(r);
    if (!refs) throw new AccountError(`Tags aren't switched on for ${r.plural}. Switch them on in the table's settings first.`, 400);
    return refs;
  };

  // What the table's Tags part shows: on or off, the picture field, the counts, the last
  // listing, and its labels (with Everywhere's, which its records can have too).
  const tagsOf = async (r: ResourceView) => {
    const refs = await keeper.refs(r);
    const everywhere = await allScopeId(db);
    return {
      on: !!refs,
      pictureField: r.pictureField,
      titleField: r.titleField,
      pictureChoices: pictureChoices(r),
      max: MAX_TAGGED,
      hasKey: r.fields.some((f) => f.primaryKey),
      counts: refs ? await sourceCounts(db, refs.source) : null,
      state: refs ? await keeper.state(refs.source) : null,
      labels: await scopeLabels(db, refs ? [refs.scope, everywhere] : [everywhere]),
    };
  };

  app.get('/api/databases/:engine/:name/app/:table/tags', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const { r } = await tableOf(a, req);
    return await tagsOf(r);
  });

  // {on: true, pictureField?} / {on: false} / {pictureField} alone
  app.post('/api/databases/:engine/:name/app/:table/tags', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    // each reads the whole table through the helper
    if (limited(req, reply, 'record-tags-read', 30, 600)) return reply;
    const b = body(req);
    const { engine, name, d, r } = await tableOf(a, req);
    const pic = b.pictureField;
    if (pic !== undefined && pic !== null && pic !== '' && (typeof pic !== 'string' || !NAME_RE.test(pic) || !pictureChoices(r).some((f) => f.name === pic))) {
      throw new AccountError('A picture field has to be one of the table\'s text fields.', 400);
    }
    const picture = typeof pic === 'string' && pic ? pic : null;
    if (b.on === true) {
      const res = await keeper.switchOn(d.id, r, a.user.username, pic === undefined ? r.pictureField : picture);
      await logActivity(db, now(), actorOf(a, req), 'record-tags-on', `${r.plural} in ${name}`, plural(res.items, 'record'));
      await refreshCatalog(a, engine, name);
    } else if (b.on === false) {
      const had = await keeper.switchOff(d.id, r);
      if (had) {
        await logActivity(db, now(), actorOf(a, req), 'record-tags-off', `${r.plural} in ${name}`,
          had.links ? `their labels came off ${plural(had.labelled, 'record')}` : null);
      }
      await refreshCatalog(a, engine, name);
    } else if (pic !== undefined) {
      await refsOf(r);
      await keeper.setPicture(d.id, r.table, picture);
      await keeper.readNow(d, resourceOf(await appFor(a, engine, name), r.table), a.user.username);
    } else throw new AccountError('Nothing to change.', 400);
    return { ok: true, ...await tagsOf(resourceOf(await appFor(a, engine, name), r.table)) };
  });

  // "Read again"
  app.post('/api/databases/:engine/:name/app/:table/tags/read', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    if (limited(req, reply, 'record-tags-read', 30, 600)) return reply;
    const { d, r } = await tableOf(a, req);
    await refsOf(r);
    const res = await keeper.readNow(d, r, a.user.username);
    if (res.error) throw new AccountError(res.error, 400);
    return { ok: true, read: res, ...await tagsOf(r) };
  });

  // ---- the table's own labels (Everywhere's are on the Tags page: @panel/catalog)
  app.post('/api/databases/:engine/:name/app/:table/tags/labels', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const { r } = await tableOf(a, req);
    const refs = await refsOf(r);
    const b = body(req);
    const l = await createScopeLabel(db, now(), a.user.username, refs.scope, typeParam(b.type), b.name);
    await logActivity(db, now(), actorOf(a, req), `media-${l.type}-made`, l.address, null);
    return { ok: true, label: l };
  });

  // {name}: rename it; {delete: true}: take it off every record and remove it;
  // {public}: whether readers of the data API without a key see it (step 4b, B4: a passkey)
  app.post('/api/databases/:engine/:name/app/:table/tags/labels/:type/:id', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const { r } = await tableOf(a, req);
    const refs = await refsOf(r);
    const type = typeParam((req.params as Record<string, string>).type);
    const id = idParam(req, 'id');
    const b = body(req);
    if (typeof b.public === 'boolean') {
      if (b.public && now() - a.session.auth_at >= RECENT_AUTH) return reply.code(403).send({ error: 'reauth-required', message: 'Please confirm with your passkey.' });
      const l = await setScopeLabelPublic(db, refs.scope, type, id, b.public);
      keeper.labelsChanged(refs.source);
      await logActivity(db, now(), actorOf(a, req), b.public ? 'media-label-public' : 'media-label-private', l.address,
        b.public ? 'anyone can see it on the records' : 'only the panel and keys can see it');
      return { ok: true, label: l };
    }
    if (b.delete === true) {
      const l = await deleteScopeLabel(db, refs.scope, type, id);
      keeper.labelsChanged(refs.source);
      await logActivity(db, now(), actorOf(a, req), `media-${type}-deleted`, l.address, l.count ? `taken off ${plural(l.count, 'record')}` : null);
      return { ok: true, removedFrom: l.count };
    }
    const x = await renameScopeLabel(db, refs.scope, type, id, b.name);
    keeper.labelsChanged(refs.source);
    if (x.from !== x.to.address) await logActivity(db, now(), actorOf(a, req), `media-${type}-renamed`, x.from, `now ${x.to.address}`);
    return { ok: true, label: x.to };
  });

  // ---- one record's labels: {where, set: {tags, categories}}
  app.post('/api/app/:engine/:name/:table/labels', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const { d, r } = await tableOf(a, req);
    const refs = await refsOf(r);
    if (!r.can.view) throw new AccountError(`${r.plural} are set up so that they can't be looked at here.`, 403);
    const b = body(req);
    const where = whereFor(r, (b.where ?? {}) as Record<string, unknown>);
    const key = recordKey(r, where);
    if (!key) throw new AccountError('The panel could not tell which record you meant.', 400);
    // put it in the catalog first if the listing hasn't seen it yet (made a moment ago elsewhere)
    const { row } = await ctx.studio<{ row: Record<string, unknown> | null }>({
      op: 'get-row', engine: d.engine, name: d.name, table: r.table, columns: [...new Set([...keyOf(r), ...(r.titleField ? [r.titleField] : []), ...(r.pictureField ? [r.pictureField] : [])])],
      where, actor: a.user.username,
    });
    if (!row) throw new AccountError(`That ${r.singular} is not there any more.`, 404);
    const item = await keeper.recordSaved(d, r, row, a.user.username);
    if (!item) throw new AccountError('The panel could not put that record in its list of tagged things just now. Try again in a moment.', 503);
    const res = await setItemLabels(db, now(), a.user.username, item, refs.scope, (b.set ?? {}) as { tags?: unknown; categories?: unknown });
    if (res.changed) keeper.labelsChanged(refs.source);
    if (res.changed) {
      const title = r.titleField && row[r.titleField] != null ? String(row[r.titleField]) : key;
      const detail = [`now ${[...res.names.categories.map((x) => `c/${x}`), ...res.names.tags.map((t) => `t/${t}`)].join(', ') || 'none'}`,
        res.created.length ? `made ${res.created.join(', ')}` : null].filter(Boolean).join('; ');
      await logActivity(db, now(), actorOf(a, req), 'media-labels-changed', `${r.singular} "${title.slice(0, 80)}" in ${d.name}`, detail);
    }
    return { ok: true, ...res };
  });
}
