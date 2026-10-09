// Her records, for programs (docs/databases-plan.md 11.3, 13).
//
// The public half of the data API. It answers on the gate rather than the
// panel because this is the only part of the studio that anything on the
// internet may reach -- and because the gate already knows how to be reached:
// rate limits, Bearer keys, keys refused in the address, `private, no-store`.
//
// It holds no opinion of its own about what a Resource is. Every request is
// decided by `allow()` in src/gate/studio.ts against the catalog the panel
// pushed, and then handed to the same database helper the panel uses, with the
// same row ops. There is no second implementation of "which columns may be
// read" anywhere in this file -- the catalog is the only list.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '@panel/core/pg';
import { callPammyDb, PammyDbCallError } from '../pammydb/client.ts';
import { PAGE, type Filter, type RowPage, type Scalar } from '../pammydb/rows.ts';
import {
  allow, appKeyFor, catalogFor, keysWithAll, labelCounts, labelsOfKeys, mayRead, noteTouch, onlyPublicRows, ownerOf, touchKey,
  type AppKey, type CatalogRow, type Visitor,
} from './studio.ts';
import { readCatalog, type CatalogResource } from '../studio/catalog.ts';
import { linksOf } from '../studio/connect.ts';
import { asRich, MAX_RICH_SENT, RichTextError } from '../studio/rich-text.ts';

export type DataApiDeps = {
  db: Db;
  now: () => number;
  pammydbSocket: string;
  limiter: { take: (key: string, limit: number, seconds: number) => boolean };
  limits: { keyed: number; open: number; bad: number };
  ipOf: (req: FastifyRequest) => string;
  // docs/tutorials-plan.md V1, V4: who is signed in to her protected folders on
  // this hostname (null without the gate's cookie), and the hostname itself
  visitorOf: (req: FastifyRequest) => Promise<Visitor | null>;
  hostOf: (req: FastifyRequest) => string | null;
  apiError: (reply: FastifyReply, status: number, error: string, message: string) => unknown;
};

// The same cap the pages use. A program asking for more is given a page, not
// her whole table.
const MAX_PER_PAGE = 100;

export function registerDataApi(app: FastifyInstance, d: DataApiDeps) {
  const ask = <T>(req: Record<string, unknown>) => callPammyDb<T>(d.pammydbSocket, req, 30_000);

  // Keys belong in the header. In the address they end up in logs, in
  // referrers and in someone's browser history -- the same rule the forms API
  // has had since it shipped.
  const keyInAddress = (query: Record<string, unknown>) =>
    Object.entries(query).some(([k, v]) =>
      ['key', 'apikey', 'api_key', 'token', 'access_token'].includes(k.toLowerCase())
      || (typeof v === 'string' && v.startsWith('pammy_')));

  const tokenOf = (req: FastifyRequest): string => {
    const auth = req.headers.authorization;
    return typeof auth === 'string' && /^Bearer /i.test(auth) ? auth.slice(7).trim() : '';
  };

  // Who is asking: a key that exists, or someone really signed in. Worked out
  // once per request -- the 2 MB writes ask before their body is read, and
  // open() asks again after.
  type Caller = { token: string; key: AppKey | null; visitor: Visitor | null };
  const callers = new WeakMap<FastifyRequest, Caller>();
  async function callerOf(req: FastifyRequest): Promise<Caller> {
    const known = callers.get(req);
    if (known) return known;
    const token = tokenOf(req);
    // a key wins; without one, the gate's own sign-in cookie may stand in (V1)
    const caller = token
      ? { token, key: await appKeyFor(d.db, d.now(), token), visitor: null }
      : { token, key: null, visitor: await d.visitorOf(req) };
    callers.set(req, caller);
    return caller;
  }

  // A key that isn't one is charged to the small "you are guessing" allowance,
  // like the forms and media APIs do -- a made-up token earns nothing.
  const badKey = (req: FastifyRequest, reply: FastifyReply) => {
    if (!d.limiter.take(`data-bad:${d.ipOf(req)}`, d.limits.bad, 60)) return d.apiError(reply, 429, 'too-many', 'Too many requests just now. Wait a moment and try again.');
    return d.apiError(reply, 401, 'bad-key', 'That key is not accepted.');
  };

  // Everything a request needs decided before a single row is read.
  async function open(req: FastifyRequest, reply: FastifyReply, write: boolean, ability: Parameters<typeof allow>[4]) {
    const p = req.params as { engine?: string; name?: string; resource?: string };
    const query = (req.query ?? {}) as Record<string, unknown>;
    if (keyInAddress(query)) {
      d.apiError(reply, 400, 'key-in-query', 'Send the key in the Authorization header (Bearer ...), never in the address.');
      return null;
    }
    const { token, key, visitor } = await callerOf(req);
    const ip = d.ipOf(req);
    if (token && !key) { badKey(req, reply); return null; }
    // A key that exists gets the keyed allowance. Without one: the open
    // allowance, the one a public page's visitors share (docs/db-examples-plan.md
    // X1) -- and a request that turns out not to be for anything public is
    // charged to the small "you are guessing" allowance as well, as before.
    const tooMany = () => { d.apiError(reply, 429, 'too-many', 'Too many requests just now. Wait a moment and try again.'); return null; };
    // V5: someone signed in has their own allowance, like a key
    if (!d.limiter.take(key ? `data-key:${key.id}` : visitor ? `data-visitor:${visitor.username}` : `data-ip:${ip}`,
      key || visitor ? d.limits.keyed : d.limits.open, 60)) return tooMany();
    const row = await catalogFor(d.db, String(p.engine ?? ''), String(p.name ?? ''));
    const verdict = allow(row ?? undefined, key, String(p.resource ?? ''), write, ability, visitor);
    if (!verdict.ok) {
      if (!key && !d.limiter.take(`data-bad:${ip}`, d.limits.bad, 60)) return tooMany();
      d.apiError(reply, verdict.status, verdict.code, verdict.message);
      return null;
    }
    // V4: a change made with the sign-in cookie comes from a page of the site
    // itself -- never from another site's page the visitor happens to open
    if (write && verdict.visitor) {
      const host = d.hostOf(req);
      const site = req.headers['sec-fetch-site'];
      if (!host || req.headers.origin !== `https://${host}` || (site !== undefined && site !== 'same-origin')) {
        d.apiError(reply, 403, 'other-site', 'Changes can only be made from a page of this website.');
        return null;
      }
    }
    // A key's answer is never kept anywhere; a public one may be kept by the
    // browser, but only after asking whether it changed (the forms API does this).
    reply.header('Cache-Control', verdict.keyless ? 'no-cache' : 'private, no-store');
    return { row: row!, resource: verdict.resource, key, keyless: verdict.keyless, visitor: verdict.visitor, grants: visitor };
  }

  // A public answer carries an ETag, so a page polling it costs a 304.
  const send = (req: FastifyRequest, reply: FastifyReply, keyless: boolean, body: unknown) => {
    if (!keyless) return body;
    const tag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24)}"`;
    reply.header('ETag', tag);
    if (req.headers['if-none-match'] === tag) return reply.code(304).send();
    return body;
  };

  // X12: a table read only because anyone may is read through her rule --
  // decided per table, so a signed-in visitor's connections to a public table
  // get the rule too (not just requests with nothing at all).
  const publicRule = (r: CatalogResource, key: AppKey | null, visitor: Visitor | null): Filter[] =>
    (onlyPublicRows(key, r, visitor) && r.public?.only ? [{ kind: 'equals', column: r.public.only, value: true }] : []);

  // V2: each signed-in person only reaches the rows with their name on them.
  const ownerRule = (r: CatalogResource, visitor: string | null): Filter[] => {
    const o = ownerOf(r, visitor);
    return o ? [{ kind: 'equals', column: o.column, value: o.value }] : [];
  };

  // ?where.published=true on a yes/no field means yes, on both engines.
  const valueFor = (r: CatalogResource, column: string, v: unknown): Scalar => {
    if (v === '' || v === undefined) return null;
    const text = String(v);
    if (r.booleans?.includes(column)) {
      if (/^(true|1|yes)$/i.test(text)) return true;
      if (/^(false|0|no)$/i.test(text)) return false;
    }
    return text;
  };

  // ------------------------------------------------------------ connections (X7)
  // Each field pointing at another resource comes with { id, label }, and each
  // many-to-many as an array of those -- but only to a resource this request
  // could read by itself (src/studio/connect.ts, shared with the panel's pages).
  async function connect(row: CatalogRow, key: AppKey | null, r: CatalogResource, items: Record<string, unknown>[], visitor: Visitor | null) {
    const links = await linksOf({
      list: (query) => ask<RowPage>({ op: 'list-rows', engine: row.engine, name: row.name, actor: 'api', query }),
      resource: r,
      all: new Map(readCatalog(row.catalog_json).resources.map((x) => [x.slug, x])),
      readable: (t) => mayRead(row, key, t, visitor),
      // V6: a label from someone else's row is not given away either
      rule: (t) => [...publicRule(t, key, visitor), ...ownerRule(t, visitor?.username ?? null)],
      items,
    });
    items.forEach((item, n) => Object.assign(item, links[n]));
  }

  // Rich-text fields on the way out (docs/rich-text-plan.md T7): cleaned in
  // every answer, because what is stored may not have come through the
  // cleaner -- her own SQL, her WordPress, a program with an older catalog.
  // The promise to a page: a field listed in `rich` is safe to show as HTML.
  const richOut = (r: CatalogResource, items: Record<string, unknown>[]) => {
    for (const item of items) for (const c of r.rich ?? []) if (c in item) item[c] = asRich(item[c], { limits: false });
    return items;
  };

  // ------------------------------------------------------------ labels (docs/catalog-plan.md step 4b)
  // A table she tags: each record carries its labels, under `labels` (or `pammy_labels` if the
  // table has a field or connection by that name); a reader without a key, or signed in,
  // only ever sees the public ones (B4).
  const labelsField = (r: CatalogResource) =>
    [...r.columns, ...(r.refs ?? []).map((x) => x.name), ...(r.many ?? []).map((x) => x.name)].includes('labels') ? 'pammy_labels' : 'labels';
  const withLabels = async (row: CatalogRow, r: CatalogResource, key: AppKey | null, items: Record<string, unknown>[]) => {
    if (!r.tagged) return;
    const keys = items.map((it) => touchKey(r, it));
    const got = await labelsOfKeys(d.db, Number(row.database_id), r.table, keys.filter((k): k is string => k !== null), !key);
    const field = labelsField(r);
    items.forEach((it, i) => { it[field] = (keys[i] && got.get(keys[i]!)) || { tags: [], categories: [] }; });
  };
  // ?tag=lemon&tag=quick&category=desserts: what a list is asked to be narrowed to
  const labelsAsked = (q: Record<string, unknown>) => {
    const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String).slice(0, 10);
    return [...list(q.tag).map((name) => ({ kind: 'tag' as const, name })), ...list(q.category).map((name) => ({ kind: 'category' as const, name }))];
  };

  const said = (reply: FastifyReply, err: unknown) => {
    if (err instanceof RichTextError) return d.apiError(reply, 400, 'invalid', err.message);
    // the helper's own words, with its code mapped to something a program can
    // act on. Never the raw engine error.
    if (err instanceof PammyDbCallError) {
      const status = err.code === 'not-found' ? 404 : err.code === 'invalid' ? 400 : err.code === 'busy' ? 409 : 503;
      return d.apiError(reply, status, err.code, err.message);
    }
    throw err;
  };

  // Which record, from the address: every part of the key, as text.
  const whereFrom = (resource: CatalogResource, raw: string): Record<string, Scalar> | null => {
    const parts = raw.split(',');
    if (parts.length !== resource.key.length) return null;
    const where: Record<string, Scalar> = {};
    resource.key.forEach((k, i) => { where[k] = decodeURIComponent(parts[i]!); });
    return where;
  };

  // Only what the catalog exposes, whatever the request sends.
  const valuesFrom = (resource: CatalogResource, body: unknown): Record<string, Scalar> => {
    const o = ((body ?? {}) as Record<string, unknown>).values;
    const sent = (o ?? {}) as Record<string, unknown>;
    const allowed = new Set(resource.columns.filter((c) => !resource.key.includes(c)));
    const out: Record<string, Scalar> = {};
    for (const [k, v] of Object.entries(sent)) {
      if (!allowed.has(k)) continue;   // not in the catalog: the gate has never heard of it
      // a rich-text field goes through the cleaner, whatever the program sent (T6)
      if (resource.rich?.includes(k)) {
        if (typeof v === 'string' && v.length > MAX_RICH_SENT) throw new RichTextError(`${k} is too long to store.`);
        out[k] = v === null || v === undefined || v === '' ? null : asRich(v);
        continue;
      }
      out[k] = v === null || v === undefined || v === '' ? null
        : typeof v === 'number' || typeof v === 'boolean' ? v
          : String(v).slice(0, 100_000);
    }
    return out;
  };

  app.get('/_pammy/api/data/:engine/:name/:resource', async (req, reply) => {
    const ok = await open(req, reply, false, 'view');
    if (!ok) return reply;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = ok.resource;
    const per = Math.min(MAX_PER_PAGE, Math.max(1, Number(q.per) || PAGE));
    const page = Math.max(1, Math.min(100_000, Number(q.page) || 1));
    const sort = typeof q.sort === 'string' && r.sortable.includes(q.sort) ? q.sort : r.key[0]!;
    const search = typeof q.search === 'string' ? q.search.slice(0, 200) : '';
    // filters come as ?where.status=draft, and only on columns the catalog has
    const filters: Filter[] = [...Object.entries(q)
      .filter(([k]) => k.startsWith('where.'))
      .map(([k, v]) => ({ kind: 'equals' as const, column: k.slice(6), value: valueFor(r, k.slice(6), v) }))
      .filter((f) => r.columns.includes(f.column))
      .slice(0, 10), ...publicRule(r, ok.key, ok.grants), ...ownerRule(r, ok.visitor)];
    // B3: only the records with every label asked for (their keys, from the gate's copy)
    const wants = labelsAsked(q);
    if (wants.length) {
      if (!r.tagged) return d.apiError(reply, 400, 'not-tagged', `${r.plural} don't have tags: switch them on in the panel first.`);
      if (r.key.length !== 1) return d.apiError(reply, 400, 'not-tagged', `${r.plural} are told apart by more than one field, so they can't be asked for by tag.`);
      const found = await keysWithAll(d.db, Number(ok.row.database_id), r.table, wants, !ok.key);
      if ('missing' in found) {
        return d.apiError(reply, 404, 'no-label', `There is no ${ok.key ? '' : 'public '}${found.missing.kind} called "${found.missing.name}" on ${r.plural.toLowerCase()}.`);
      }
      const numeric = ['integer', 'decimal'].includes(r.types?.[r.key[0]!]?.type ?? '');
      filters.push({ kind: 'in', column: r.key[0]!, values: found.keys.map((k) => (numeric && /^-?\d+(\.\d+)?$/.test(k) ? Number(k) : k)) });
    }
    try {
      const got = await ask<RowPage>({
        op: 'list-rows', engine: ok.row.engine, name: ok.row.name, actor: 'api',
        query: {
          table: r.table, columns: r.columns, limit: per, offset: (page - 1) * per,
          order: { column: sort, dir: q.dir === 'desc' ? 'desc' : 'asc' },
          search: r.can.search && search && r.searchable.length ? { columns: r.searchable, text: search } : null,
          filters,
        },
      });
      await withLabels(ok.row, r, ok.key, got.items);
      await connect(ok.row, ok.key, r, got.items, ok.grants);
      return send(req, reply, ok.keyless, { resource: r.slug, rich: r.rich ?? [], page, per, total: got.total, items: richOut(r, got.items) });
    } catch (err) { return said(reply, err); }
  });

  app.get('/_pammy/api/data/:engine/:name/:resource/:id', async (req, reply) => {
    const ok = await open(req, reply, false, 'view');
    if (!ok) return reply;
    const where = whereFrom(ok.resource, String((req.params as { id: string }).id));
    if (!where) return d.apiError(reply, 400, 'bad-id', 'That is not how a record of this kind is named.');
    // X12: a record her rule keeps back is not there, without a key -- the same
    // answer as one that does not exist, so its existence is not given away
    for (const f of [...publicRule(ok.resource, ok.key, ok.grants), ...ownerRule(ok.resource, ok.visitor)]) if (f.kind === 'equals') where[f.column] = f.value;
    try {
      const got = await ask<{ row: Record<string, unknown> | null }>({
        op: 'get-row', engine: ok.row.engine, name: ok.row.name, actor: 'api',
        table: ok.resource.table, columns: ok.resource.columns, where,
      });
      if (!got.row) return d.apiError(reply, 404, 'not-found', 'There is no record with that name here.');
      await withLabels(ok.row, ok.resource, ok.key, [got.row]);
      await connect(ok.row, ok.key, ok.resource, [got.row], ok.grants);
      return send(req, reply, ok.keyless, { resource: ok.resource.slug, rich: ok.resource.rich ?? [], item: richOut(ok.resource, [got.row])[0] });
    } catch (err) { return said(reply, err); }
  });

  // B5: a tagged table's labels, with how many records have each (public ones only without
  // a key): for a page's filter buttons. `_labels`, so a record whose key is "labels" keeps
  // its address.
  app.get('/_pammy/api/data/:engine/:name/:resource/_labels', async (req, reply) => {
    const ok = await open(req, reply, false, 'view');
    if (!ok) return reply;
    if (!ok.resource.tagged) return d.apiError(reply, 404, 'not-tagged', `${ok.resource.plural} don't have tags: switch them on in the panel first.`);
    return send(req, reply, ok.keyless, { resource: ok.resource.slug, ...await labelCounts(d.db, Number(ok.row.database_id), ok.resource.table, !ok.key) });
  });

  // A record from a program can carry a rich-text field -- up to 100,000
  // characters kept, 500,000 sent (docs/rich-text-plan.md) -- far past the
  // gate's usual 8 KB. So the two routes that write a record take 2 MB (nginx's
  // gate.conf allows the same, for these two only). And only from a key that
  // exists or someone really signed in -- not from anything that merely looks
  // like one: the rest is turned away before its body is read, so nobody can
  // make the gate read 2 MB of nothing.
  const WRITE = {
    bodyLimit: 2 * 1024 * 1024,
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      const { token, key, visitor } = await callerOf(req);
      if (key || visitor) return;
      if (token) return badKey(req, reply);
      return d.apiError(reply, 401, 'no-key', 'This needs a key: send it as "Authorization: Bearer ...".');
    },
  };

  // docs/catalog-plan.md step 4: a write to a table she tags, for the panel's catalog.
  // Never fails the answer: the panel's listing catches anything missed.
  const touched = (req: FastifyRequest, row: CatalogRow, r: CatalogResource, what: 'changed' | 'deleted', where: Record<string, unknown> | null = null) =>
    noteTouch(d.db, d.now(), Number(row.database_id), r, what, where ? touchKey(r, where) : null)
      .catch((e: unknown) => req.log.warn({ err: e }, 'noting a write for the catalog failed'));

  // V2: a new record is theirs, whatever the page sent.
  const withOwner = (r: CatalogResource, visitor: string | null, values: Record<string, Scalar>) => {
    const o = ownerOf(r, visitor);
    return o ? { ...values, [o.column]: o.value } : values;
  };

  // Writes are POSTs with a word on the end, like every other write in this
  // codebase -- and because a program written in a hurry can always do GET and
  // POST, which is not true of the rest.
  app.post('/_pammy/api/data/:engine/:name/:resource/new', WRITE, async (req, reply) => {
    const ok = await open(req, reply, true, 'create');
    if (!ok) return reply;
    try {
      const got = await ask<{ row: Record<string, unknown> }>({
        op: 'insert-row', engine: ok.row.engine, name: ok.row.name, actor: 'api',
        table: ok.resource.table, values: withOwner(ok.resource, ok.visitor, valuesFrom(ok.resource, req.body)), back: ok.resource.columns,
      });
      await touched(req, ok.row, ok.resource, 'changed');
      return reply.code(201).send({ resource: ok.resource.slug, rich: ok.resource.rich ?? [], item: richOut(ok.resource, [got.row])[0] });
    } catch (err) { return said(reply, err); }
  });

  app.post('/_pammy/api/data/:engine/:name/:resource/:id/save', WRITE, async (req, reply) => {
    const ok = await open(req, reply, true, 'edit');
    if (!ok) return reply;
    const where = whereFrom(ok.resource, String((req.params as { id: string }).id));
    if (!where) return d.apiError(reply, 400, 'bad-id', 'That is not how a record of this kind is named.');
    const mine = ownerOf(ok.resource, ok.visitor);
    const values = valuesFrom(ok.resource, req.body);
    // their own rows only, and a row can't be handed to someone else (V2)
    if (mine) { where[mine.column] = mine.value; delete values[mine.column]; }
    try {
      const got = await ask<{ row: Record<string, unknown> | null }>({
        op: 'update-row', engine: ok.row.engine, name: ok.row.name, actor: 'api',
        table: ok.resource.table, values, where, back: ok.resource.columns,
      });
      if (!got.row) return d.apiError(reply, 404, 'not-found', 'There is no record with that name here.');
      await touched(req, ok.row, ok.resource, 'changed');
      return { resource: ok.resource.slug, rich: ok.resource.rich ?? [], item: richOut(ok.resource, [got.row])[0] };
    } catch (err) { return said(reply, err); }
  });

  app.post('/_pammy/api/data/:engine/:name/:resource/:id/delete', async (req, reply) => {
    const ok = await open(req, reply, true, 'delete');
    if (!ok) return reply;
    const where = whereFrom(ok.resource, String((req.params as { id: string }).id));
    if (!where) return d.apiError(reply, 400, 'bad-id', 'That is not how a record of this kind is named.');
    const mine = ownerOf(ok.resource, ok.visitor);
    if (mine) where[mine.column] = mine.value;
    try {
      const got = await ask<{ gone: boolean }>({
        op: 'delete-row', engine: ok.row.engine, name: ok.row.name, actor: 'api',
        table: ok.resource.table, where,
      });
      if (!got.gone) return d.apiError(reply, 404, 'not-found', 'There is no record with that name here.');
      await touched(req, ok.row, ok.resource, 'deleted', where);
      return { ok: true };
    } catch (err) { return said(reply, err); }
  });
}
