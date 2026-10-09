// Apps as sources (docs/catalog-plan.md step 5). A service whose pammy-panel.json has a
// `catalog` section offers kinds of thing to tag (exam prep: its topics). Switched on, each
// kind is a source of its own (kind 'app', ref "<service>/<resource>") with its scope under
// All, as a Studio table is, and its items are what the service lists:
//  - pulled (C7): the panel asks the service's `list` path, signed with the service's key,
//    every 15 minutes and on "Read again"; an id not in a full listing goes missing and
//    keeps its labels 30 days (back only with the same title, as records);
//  - pushed: the service tells the app's door (door.ts) what changed, at once.
// The service may also read its labels and tag its own items through the door (C8: the
// app's own labels, not moderated). The catalog knows services only through AppDeps: the
// site hands in where a service's manifest, port and key are.
import { AccountError, logActivity } from '@panel/core/accounts';
import { catalogOf, CatalogManifestError, type CatalogResource, type CatalogUse } from '@panel/core/manifest-catalog';
import { all, one, run, tx, type Db, type Param, type Sql } from '@panel/core/pg';
import { signRequest } from '@panel/core/signed';
import {
  allScopeId, dropSource, itemDeleted, makeSource, markMissing, namesByKey, presentItems, purgeMissing, putItem, sourceCounts,
  type Names, type SourceCounts, type SourceRefs,
} from './items.ts';
import { checkLabelName, labelSlug, type LabelType } from './labels.ts';

// The most items one kind of thing may have (as a Studio table's, S4-1), and a listing's page.
export const MAX_APP_ITEMS = 20_000;
export const APP_LIST_PAGE = 500;
// how long the panel waits for one page of a service's list
const LIST_TIMEOUT_MS = 15_000;
// the most a page of a list may be
const LIST_MAX_BYTES = 5 * 1024 * 1024;
const ID_MAX = 200;
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SERVICE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export type AppService = { id: string; title: string };
export type AppDeps = {
  db: Sql;
  now: () => number;
  // the services this panel looks after, and their titles
  services: () => Promise<AppService[]>;
  // a service's pammy-panel.json (throws with the reason when it has none)
  manifest: (service: string) => Promise<string>;
  // where the service answers on 127.0.0.1 (null: nowhere)
  port: (service: string) => Promise<number | null>;
  // the service's own key (null: it has none)
  key: (service: string) => Promise<string | null>;
  fetch?: typeof fetch;
  log?: (msg: string, err?: unknown) => void;
};

export type ReadState = { at: number; items: number; missing: number; error: string | null };
export type AppResourceView = {
  key: string; label: string; source: number | null; open: string | null; scopes: string | null; uses: Record<string, CatalogUse>;
  counts: SourceCounts | null; state: ReadState | null;
};
export type AppOffer = { service: AppService; resources: CatalogResource[] | null; error: string | null };
export type AppItem = { key: string; title: string | null; scope: string | null; labels: Names };

// One item as a service describes it, in its list or a push.
type ItemSeen = { key: string; title: string | null; kind: string; scope: string | null };

const refOf = (service: string, resource: string) => `${service}/${resource}`;
const stateKey = (source: number) => `app:${source}`;

export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export class AppKeeper {
  readonly d: AppDeps;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(d: AppDeps) {
    this.d = d;
  }

  get #log() { return this.d.log ?? (() => {}); }

  // ---------------------------------------------------------------- what a service offers
  async service(id: string): Promise<AppService> {
    if (!SERVICE_RE.test(id)) throw new AccountError('Not found.', 404);
    const s = (await this.d.services()).find((x) => x.id === id);
    if (!s) throw new AccountError('There is no such service.', 404);
    return s;
  }

  // Its manifest's catalog section, as it is now: null resources with the reason when it
  // has no manifest, no section, or a bad one.
  async offer(service: AppService): Promise<AppOffer> {
    let text: string;
    try {
      text = await this.d.manifest(service.id);
    } catch (e) {
      return { service, resources: null, error: (e as Error).message };
    }
    try {
      const resources = catalogOf(text);
      return { service, resources, error: resources ? null : `${service.title}'s pammy-panel.json offers nothing to tag (it has no "catalog" section).` };
    } catch (e) {
      return { service, resources: null, error: e instanceof CatalogManifestError ? e.message : `${service.title}'s pammy-panel.json can't be read.` };
    }
  }

  // The sources of a service that's switched on: by resource key.
  async sources(service: string): Promise<Map<string, SourceRefs>> {
    const rows = await all<{ source: number; resource: number; key: string; scope: number }>(this.d.db,
      `SELECT s.id AS source, r.id AS resource, r.key, c.id AS scope FROM sources s JOIN resources r ON r.source_id = s.id
         JOIN scopes c ON c.source_id = s.id AND c.path = '/'
       WHERE s.kind = 'app' AND starts_with(s.ref, ?) ORDER BY s.id`, `${service}/`);
    return new Map(rows.map((r) => [r.key, { source: Number(r.source), resource: Number(r.resource), scope: Number(r.scope) }]));
  }

  async refs(service: string, resource: string): Promise<SourceRefs> {
    const r = (await this.sources(service)).get(resource);
    if (!r) throw new AccountError('Tags aren\'t switched on for that.', 404);
    return r;
  }

  // What the page shows of a service: what it offers now, and each kind switched on.
  async status(id: string) {
    const service = await this.service(id);
    const offer = await this.offer(service);
    const on = await this.sources(id);
    const decl = new Map((offer.resources ?? []).map((r) => [r.key, r]));
    const keys = [...new Set([...decl.keys(), ...on.keys()])];
    const resources: (AppResourceView & { offered: boolean })[] = [];
    for (const key of keys) {
      const refs = on.get(key);
      const kept = refs ? await this.#kept(refs.resource) : null;
      const d = decl.get(key);
      resources.push({
        key, label: d?.label ?? kept?.label ?? key, source: refs?.source ?? null, offered: !!d,
        open: d?.open ?? kept?.open ?? null, scopes: d?.scopes ?? kept?.scopes ?? null, uses: d?.uses ?? kept?.uses ?? {},
        counts: refs ? await sourceCounts(this.d.db, refs.source) : null,
        state: refs ? await this.state(refs.source) : null,
      });
    }
    return { service, on: on.size > 0, error: offer.error, resources, max: MAX_APP_ITEMS };
  }

  // What was last read from the manifest for a resource
  async #kept(resource: number): Promise<{ label: string; open: string | null; scopes: string | null; uses: Record<string, CatalogUse>; list: string | null } | undefined> {
    const r = await one<{ label: string; open_url: string | null; scopes_field: string | null; uses: Record<string, CatalogUse>; list_path: string | null }>(this.d.db,
      'SELECT label, open_url, scopes_field, uses, list_path FROM resources WHERE id = ?', resource);
    return r && { label: r.label, open: r.open_url, scopes: r.scopes_field, uses: r.uses ?? {}, list: r.list_path };
  }

  async state(source: number): Promise<ReadState | null> {
    const r = await one<{ value: string }>(this.d.db, 'SELECT value FROM sync_state WHERE key = ?', stateKey(source));
    return r ? JSON.parse(r.value) as ReadState : null;
  }

  async #setState(source: number, s: ReadState) {
    await run(this.d.db, 'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', stateKey(source), JSON.stringify(s));
  }

  // ---------------------------------------------------------------- the switch (S5-2)
  // On: a source per kind of thing it offers, then each read. What a kind that left the
  // manifest had is only let go on Read again with `letGo` (the page asks first).
  async switchOn(id: string, by: string): Promise<{ read: Record<string, ReadResult> }> {
    const service = await this.service(id);
    const offer = await this.offer(service);
    if (!offer.resources) throw new AccountError(offer.error ?? `${service.title} offers nothing to tag.`, 400);
    await this.#once(() => this.#take(service, offer.resources!, by, 'refuse'));
    return { read: await this.readService(id, by) };
  }

  // Off: every kind's items and labels go; Everywhere's labels only lose these links.
  async switchOff(id: string): Promise<SourceCounts> {
    const service = await this.service(id);
    return await this.#once(async () => {
      const total: SourceCounts = { items: 0, labelled: 0, links: 0, labels: 0 };
      for (const refs of (await this.sources(service.id)).values()) {
        const c = await dropSource(this.d.db, refs.source);
        await run(this.d.db, 'DELETE FROM sync_state WHERE key = ?', stateKey(refs.source));
        for (const k of Object.keys(total) as (keyof SourceCounts)[]) total[k] += c[k];
      }
      return total;
    });
  }

  // "Read again": the manifest first (kinds added, what each says brought up to date, and a
  // kind no longer offered let go if `letGo`, else refused with what it would take), then
  // every kind's list.
  async readAgain(id: string, by: string, letGo: boolean): Promise<{ read: Record<string, ReadResult>; gone: string[] }> {
    const service = await this.service(id);
    if (!(await this.sources(id)).size) throw new AccountError(`Tags aren't switched on for ${service.title}.`, 400);
    const offer = await this.offer(service);
    if (!offer.resources) throw new AccountError(offer.error ?? `${service.title} offers nothing to tag.`, 400);
    const gone = await this.#once(() => this.#take(service, offer.resources!, by, letGo ? 'let-go' : 'refuse'));
    return { read: await this.readService(id, by), gone };
  }

  // The manifest's kinds, into the catalog. A kind it no longer offers: refused (with what
  // it would take), let go, or kept as it is (the 15-minute round). Returns the labels of
  // the kinds let go.
  async #take(service: AppService, resources: CatalogResource[], by: string | null, going_: 'refuse' | 'let-go' | 'keep'): Promise<string[]> {
    const have = await this.sources(service.id);
    const offered = new Set(resources.map((r) => r.key));
    const going = going_ === 'keep' ? [] : [...have].filter(([k]) => !offered.has(k));
    if (going.length && going_ === 'refuse') {
      const lines: string[] = [];
      for (const [k, refs] of going) {
        const c = await sourceCounts(this.d.db, refs.source);
        lines.push(`${(await this.#kept(refs.resource))?.label ?? k} (${c.labelled.toLocaleString('en')} with tags)`);
      }
      throw new AppError(`${service.title} no longer offers ${lines.join(', ')}: its tags would go.`, 409);
    }
    const gone: string[] = [];
    for (const [k, refs] of going) {
      gone.push((await this.#kept(refs.resource))?.label ?? k);
      await dropSource(this.d.db, refs.source);
      await run(this.d.db, 'DELETE FROM sync_state WHERE key = ?', stateKey(refs.source));
    }
    for (const r of resources) {
      const label = `${service.title}: ${r.label}`.slice(0, 200);
      let refs = have.get(r.key);
      if (!refs) refs = await makeSource(this.d.db, this.d.now(), by, { kind: 'app', ref: refOf(service.id, r.key), label, resource: r.key, resourceLabel: r.label });
      await tx(this.d.db, async (q) => {
        await run(q, 'UPDATE sources SET label = ? WHERE id = ? AND label <> ?', label, refs.source, label);
        await run(q, "UPDATE scopes SET label = ? WHERE source_id = ? AND path = '/' AND label <> ?", label, refs.source, label);
        await run(q, `UPDATE resources SET label = ?, list_path = ?, open_url = ?, scopes_field = ?, uses = ?::text::jsonb, visitor_labels = ?, visitor_new_labels = ? WHERE id = ?`,
          r.label, r.list, r.open, r.scopes, JSON.stringify(r.uses), r.visitorLabels, r.visitorNewLabels, refs.resource);
      });
    }
    return gone;
  }

  // ---------------------------------------------------------------- the list (S5-3)
  async readService(id: string, actor: string | null): Promise<Record<string, ReadResult>> {
    const out: Record<string, ReadResult> = {};
    for (const [key, refs] of await this.sources(id)) out[key] = await this.#once(() => this.#read(id, key, refs, actor));
    return out;
  }

  // Every service switched on (every 15 minutes): the manifest taken again (new kinds come
  // in; a kind no longer offered stays, with a note, until Read again lets it go), then
  // their lists; items missing 30 days are forgotten.
  async readAll(): Promise<number> {
    const refs = await all<{ ref: string }>(this.d.db, "SELECT ref FROM sources WHERE kind = 'app'");
    const services = [...new Set(refs.map((r) => r.ref.split('/')[0]!))];
    let n = 0;
    for (const id of services) {
      const service = (await this.d.services()).find((x) => x.id === id);
      if (!service) continue;
      const offer = await this.offer(service);
      if (offer.resources) {
        try {
          await this.#once(() => this.#take(service, offer.resources!, null, 'keep'));
        } catch (e) {
          this.#log(`taking ${service.title}'s catalog section again failed`, e);
        }
      }
      n += Object.keys(await this.readService(id, null)).length;
    }
    await purgeMissing(this.d.db, this.d.now());
    return n;
  }

  // A signed GET to the service (panel -> app, v2)
  async #get(service: string, path: string): Promise<unknown> {
    const port = await this.d.port(service);
    if (!port) throw new AppError('The service answers nowhere on this server just now.');
    const key = await this.d.key(service);
    if (!key) throw new AppError('The panel has no key for this service, so it can\'t ask it anything.');
    const ts = String(Date.now());
    let r: Response;
    try {
      r = await (this.d.fetch ?? fetch)(`http://127.0.0.1:${port}${path}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        headers: { Accept: 'application/json', 'X-Lfdln-Timestamp': ts, 'X-Lfdln-Signature': signRequest(key, ts, 'GET', path, '') },
      });
    } catch (e) {
      throw new AppError(`The service didn't answer (${(e as Error).message}).`);
    }
    if (r.status !== 200) throw new AppError(`The service answered ${r.status} to ${path}.`);
    const text = await r.text();
    if (text.length > LIST_MAX_BYTES) throw new AppError('The service\'s list is too big for one page.');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError('The service\'s list isn\'t JSON.');
    }
  }

  async #read(service: string, resource: string, refs: SourceRefs, actor: string | null): Promise<ReadResult> {
    const at = this.d.now();
    const kept = await this.#kept(refs.resource);
    try {
      if (!kept?.list) throw new AppError('Its pammy-panel.json says nowhere to read the list.');
      const seen: ItemSeen[] = [];
      let after: string | null = null;
      for (let page = 0; ; page++) {
        if (page > MAX_APP_ITEMS / APP_LIST_PAGE + 5) throw new AppError('The service\'s list went on and on.');
        const q: string = `${kept.list}${kept.list.includes('?') ? '&' : '?'}limit=${APP_LIST_PAGE}${after === null ? '' : `&after=${encodeURIComponent(after)}`}`;
        const got = await this.#get(service, q) as { items?: unknown; next?: unknown };
        if (!got || typeof got !== 'object' || !Array.isArray(got.items)) throw new AppError('The service\'s list has no "items".');
        for (const x of got.items) seen.push(this.#seen(resource, kept.scopes, x));
        if (seen.length > MAX_APP_ITEMS) throw new AppError(`It lists more than ${MAX_APP_ITEMS.toLocaleString('en')}; tags work on up to that for now.`);
        if (got.next === null || got.next === undefined) break;
        if (typeof got.next !== 'string' && typeof got.next !== 'number') throw new AppError('The service\'s "next" is neither text nor null.');
        if (String(got.next) === after) throw new AppError('The service gave the same page twice.');
        after = String(got.next);
      }
      const result = await this.#apply(refs, seen, true);
      await this.#setState(refs.source, { at, items: result.items, missing: result.missing, error: null });
      if (actor && result.missing) {
        await logActivity(this.d.db, at, { id: null, label: actor }, 'app-items-missing', kept.label, `${result.missing} no longer listed (their tags are kept 30 days)`);
      }
      return result;
    } catch (e) {
      const error = e instanceof AppError || e instanceof AccountError ? e.message : 'The panel could not read the list just now.';
      if (!(e instanceof AppError)) this.#log(`reading ${service}/${resource} for the catalog failed`, e);
      await this.#setState(refs.source, { at, items: (await presentItems(this.d.db, refs.resource)).size, missing: 0, error });
      return { items: 0, made: 0, missing: 0, error };
    }
  }

  // One item as the service describes it: {id, title?, kind?, <its scopes field>?}
  #seen(resource: string, scopesField: string | null, x: unknown): ItemSeen {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new AppError('An item in the service\'s list isn\'t an object.');
    const o = x as Record<string, unknown>;
    const key = typeof o.id === 'number' && Number.isFinite(o.id) ? String(o.id) : o.id;
    if (typeof key !== 'string' || key.length < 1 || key.length > ID_MAX || /[\x00-\x1f\x7f]/.test(key)) throw new AppError(`An item's id has to be text of 1 to ${ID_MAX} characters.`);
    const title = typeof o.title === 'string' ? o.title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) : null;
    const kind = typeof o.kind === 'string' && KIND_RE.test(o.kind) ? o.kind : resource;
    const sv = scopesField ? o[scopesField] : null;
    const scope = typeof sv === 'string' && sv.trim() ? sv.trim().replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) : null;
    return { key, title, kind, scope };
  }

  // Items into the catalog: made, brought up to date, moved between sub-scopes; with
  // `full`, what isn't in the list goes missing, and sub-scopes left empty go.
  async #apply(refs: SourceRefs, seen: ItemSeen[], full: boolean): Promise<ReadResult> {
    const at = this.d.now();
    return await tx(this.d.db, async (q) => {
      const before = await presentItems(q, refs.resource);
      const scopes = new Map<string, number>();
      const keys = new Set<string>();
      let made = 0;
      for (const s of seen) {
        if (keys.has(s.key)) continue;
        keys.add(s.key);
        const scope = s.scope === null ? refs.scope : scopes.get(s.scope) ?? await this.#subScope(q, refs, s.scope, scopes);
        const had = before.get(s.key);
        if (!had || had.title !== s.title || had.scope !== scope) await putItem(q, refs, { key: s.key, title: s.title, kind: s.kind, scope }, at);
        if (!had) made++;
      }
      let missing = 0;
      if (full) {
        missing = await markMissing(q, [...before.values()].filter((i) => !keys.has(i.key)).map((i) => i.id), at);
        await run(q, `DELETE FROM scopes s WHERE s.source_id = ? AND s.path <> '/' AND s.automatic
          AND NOT EXISTS (SELECT 1 FROM items i WHERE i.scope_id = s.id) AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.scope_id = s.id)`, refs.source);
      }
      return { items: keys.size, made, missing };
    });
  }

  // The automatic scope below a kind's own for one value of its `scopes` field ("Polynomials
  // & exponents"): found by its label, else made, its path a slug kept unique.
  async #subScope(q: Db, refs: SourceRefs, value: string, cache: Map<string, number>): Promise<number> {
    const found = await one<{ id: number }>(q, 'SELECT id FROM scopes WHERE source_id = ? AND parent_id = ? AND label = ?', refs.source, refs.scope, value);
    let id = found ? Number(found.id) : 0;
    if (!id) {
      const base = `/${labelSlug(value) || 'other'}`;
      for (let n = 1; ; n++) {
        const path = n === 1 ? base : `${base}-${n}`;
        if (await one(q, 'SELECT 1 FROM scopes WHERE source_id = ? AND path = ?', refs.source, path)) continue;
        id = Number((await one<{ id: number }>(q, `INSERT INTO scopes (parent_id, source_id, path, label, automatic, created_at, created_by)
          VALUES (?, ?, ?, ?, true, ?, NULL) RETURNING id`, refs.scope, refs.source, path, value, this.d.now()))!.id);
        break;
      }
    }
    cache.set(value, id);
    return id;
  }

  // ---------------------------------------------------------------- the app's door (S5-4)
  // A push: these items made or changed now; `gone` deleted (their labels go, as a record
  // deleted in the panel).
  async push(service: AppService, resource: string, items: unknown, gone: unknown): Promise<{ items: number; made: number; gone: number }> {
    const refs = await this.refs(service.id, resource);
    const kept = await this.#kept(refs.resource);
    if (items !== undefined && (!Array.isArray(items) || items.length > 1000)) throw new AppError('"items": a list of up to 1,000.');
    if (gone !== undefined && (!Array.isArray(gone) || gone.length > 1000)) throw new AppError('"gone": a list of up to 1,000 ids.');
    const seen = ((items ?? []) as unknown[]).map((x) => this.#seen(resource, kept?.scopes ?? null, x));
    const goneKeys = ((gone ?? []) as unknown[]).map((g) => (typeof g === 'number' ? String(g) : g));
    if (goneKeys.some((g) => typeof g !== 'string' || !g || g.length > ID_MAX)) throw new AppError('"gone": ids as text.');
    return await this.#once(async () => {
      if (seen.length) {
        const now = await presentItems(this.d.db, refs.resource);
        const added = seen.filter((s) => !now.has(s.key)).length;
        if (now.size + added > MAX_APP_ITEMS) throw new AppError(`That would be more than ${MAX_APP_ITEMS.toLocaleString('en')}.`);
      }
      const r = await this.#apply(refs, seen, false);
      let n = 0;
      for (const g of goneKeys as string[]) {
        const had = await itemDeleted(this.d.db, refs.resource, g);
        if (!had) continue;
        n++;
        if (had.labels.length) await logActivity(this.d.db, this.d.now(), { id: null, label: service.title }, 'app-item-gone', `${kept?.label ?? resource} "${had.title ?? g}"`, `it had ${had.labels.join(', ')}`);
      }
      return { items: seen.length, made: r.made, gone: n };
    });
  }

  // The labels a kind can use (its scope's and Everywhere's), each with its use and count.
  async labels(refs: SourceRefs): Promise<{ type: LabelType; name: string; everywhere: boolean; count: number; use: CatalogUse | null }[]> {
    const uses = (await this.#kept(refs.resource))?.uses ?? {};
    const rows = await all<{ kind: LabelType; name: string; everywhere: boolean; count: number }>(this.d.db,
      `SELECT l.kind, l.name, s.parent_id IS NULL AS everywhere,
         (SELECT count(*) FROM links x JOIN items i ON i.id = x.item_id WHERE x.label_id = l.id AND i.resource_id = ? AND i.state = 'present') AS count
       FROM labels l JOIN scopes s ON s.id = l.scope_id WHERE s.id IN (?, ?) ORDER BY l.kind, l.name`, refs.resource, refs.scope, await allScopeId(this.d.db));
    return rows.map((r) => ({ type: r.kind, name: r.name, everywhere: r.everywhere, count: Number(r.count), use: uses[r.name]?.kind === r.kind ? uses[r.name]! : null }));
  }

  // The keys of the items with every one of these labels (a name: the kind's own or Everywhere's).
  async keysWith(refs: SourceRefs, want: { tags: string[]; categories: string[] }): Promise<string[]> {
    const { where, args } = await this.#labelWhere(refs, want);
    return (await all<{ key: string }>(this.d.db, `SELECT i.key FROM items i WHERE i.resource_id = ? AND i.state = 'present' ${where} ORDER BY i.key`,
      refs.resource, ...args)).map((r) => r.key);
  }

  async #labelWhere(refs: SourceRefs, want: { tags: string[]; categories: string[] }): Promise<{ where: string; args: Param[] }> {
    const all_ = await allScopeId(this.d.db);
    const parts: string[] = [];
    const args: Param[] = [];
    for (const [kind, names] of [['tag', want.tags], ['category', want.categories]] as const) {
      for (const n of names) {
        parts.push(`AND EXISTS (SELECT 1 FROM links x JOIN labels l ON l.id = x.label_id WHERE x.item_id = i.id AND l.kind = ? AND l.name = ? AND l.scope_id IN (?, ?))`);
        args.push(kind, n, refs.scope, all_);
      }
    }
    return { where: parts.join(' '), args };
  }

  async itemLabels(refs: SourceRefs, key: string): Promise<Names> {
    const item = await one<{ id: number }>(this.d.db, "SELECT id FROM items WHERE resource_id = ? AND key = ? AND state = 'present'", refs.resource, key);
    if (!item) throw new AccountError('No such item (push it, or wait for the next listing).', 404);
    return (await namesByKey(this.d.db, refs.resource, [key])).get(key) ?? { tags: [], categories: [] };
  }

  // The app tags its own item (C8: shared, not moderated): a name that isn't the kind's own
  // or Everywhere's is made in the kind's own scope (the app never makes Everywhere's).
  async tag(service: AppService, refs: SourceRefs, key: string, type: LabelType, name: unknown, on: boolean): Promise<{ changed: boolean; created: boolean }> {
    const n = checkLabelName(name);
    return await this.#once(() => tx(this.d.db, async (q) => {
      const item = await one<{ id: number; title: string | null }>(q, "SELECT id, title FROM items WHERE resource_id = ? AND key = ? AND state = 'present'", refs.resource, key);
      if (!item) throw new AccountError('No such item (push it, or wait for the next listing).', 404);
      const all_ = await allScopeId(q);
      const label = await one<{ id: number }>(q, 'SELECT id FROM labels WHERE kind = ? AND name = ? AND scope_id IN (?, ?) ORDER BY (scope_id = ?) DESC LIMIT 1', type, n, refs.scope, all_, refs.scope);
      let changed = false, created = false;
      const by = `app:${service.id}`;
      if (on) {
        let id = label?.id;
        if (!id) {
          id = (await one<{ id: number }>(q, `INSERT INTO labels (scope_id, kind, name, created_at, created_by) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (scope_id, kind, name) DO UPDATE SET name = excluded.name RETURNING id`, refs.scope, type, n, this.d.now(), by))!.id;
          created = true;
        }
        changed = await run(q, 'INSERT INTO links (item_id, label_id, made_by, made_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', item.id, id, by, this.d.now()) > 0;
      } else if (label) {
        changed = await run(q, `DELETE FROM links WHERE item_id = ? AND label_id IN (SELECT id FROM labels WHERE kind = ? AND name = ? AND scope_id IN (?, ?))`,
          item.id, type, n, refs.scope, all_) > 0;
      }
      if (changed) {
        await run(q, 'UPDATE items SET changed_at = ? WHERE id = ?', this.d.now(), item.id);
        const kept = await this.#kept(refs.resource);
        await logActivity(q, this.d.now(), { id: null, label: service.title }, on ? 'app-tagged' : 'app-untagged',
          `${kept?.label ?? 'item'} "${(item.title ?? key).slice(0, 80)}"`, `${type === 'tag' ? `#${n}` : n}${created ? ' (made)' : ''}`);
      }
      return { changed, created };
    }));
  }

  // ---------------------------------------------------------------- the page's list of items
  async items(refs: SourceRefs, o: { q?: string; scope?: number | null; tags?: string[]; categories?: string[]; offset?: number; limit?: number }):
    Promise<{ items: AppItem[]; total: number }> {
    const { where, args } = await this.#labelWhere(refs, { tags: o.tags ?? [], categories: o.categories ?? [] });
    const conds: string[] = [];
    const cargs: Param[] = [];
    if (o.scope) { conds.push('AND i.scope_id = ?'); cargs.push(o.scope); }
    if (o.q) {
      const like = `%${o.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push("AND (i.title ILIKE ? OR i.key ILIKE ?)");
      cargs.push(like, like);
    }
    const base = `FROM items i JOIN scopes s ON s.id = i.scope_id WHERE i.resource_id = ? AND i.state = 'present' ${conds.join(' ')} ${where}`;
    const total = Number((await one<{ n: number }>(this.d.db, `SELECT count(*) AS n ${base}`, refs.resource, ...cargs, ...args))!.n);
    const rows = await all<{ key: string; title: string | null; scope: string; top: boolean }>(this.d.db,
      `SELECT i.key, i.title, s.label AS scope, s.path = '/' AS top ${base} ORDER BY lower(coalesce(i.title, i.key)), i.key LIMIT ? OFFSET ?`,
      refs.resource, ...cargs, ...args, Math.min(o.limit ?? 50, 200), Math.max(o.offset ?? 0, 0));
    const names = await namesByKey(this.d.db, refs.resource, rows.map((r) => r.key));
    return {
      total,
      items: rows.map((r) => ({ key: r.key, title: r.title, scope: r.top ? null : r.scope, labels: names.get(r.key) ?? { tags: [], categories: [] } })),
    };
  }

  // A kind's sub-scopes, with how many items each has.
  async subScopes(refs: SourceRefs): Promise<{ id: number; label: string; items: number }[]> {
    return (await all<{ id: number; label: string; items: number }>(this.d.db,
      `SELECT s.id, s.label, (SELECT count(*) FROM items i WHERE i.scope_id = s.id AND i.state = 'present') AS items
       FROM scopes s WHERE s.source_id = ? AND s.path <> '/' ORDER BY s.label`, refs.source)).map((s) => ({ id: Number(s.id), label: s.label, items: Number(s.items) }));
  }

  async itemId(refs: SourceRefs, key: string): Promise<number> {
    const r = await one<{ id: number }>(this.d.db, "SELECT id FROM items WHERE resource_id = ? AND key = ? AND state = 'present'", refs.resource, key);
    if (!r) throw new AccountError('That isn\'t there any more. Read again to see what the service lists now.', 404);
    return Number(r.id);
  }

  // one run at a time, in the order asked: a listing, a push and a switch never write the
  // same items at once
  #once<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#chain.then(fn, fn);
    this.#chain = p.catch(() => undefined);
    return p;
  }
}

export type ReadResult = { items: number; made: number; missing: number; error?: string };

