// Her records in the catalog (docs/catalog-plan.md step 4): a table she switched on is a
// source, and this keeps its items in step with the table (S4-3):
//  - the panel's own record pages call recordSaved / recordDeleted as they write;
//  - the gate's writes come as touches (gate.record_touches), taken every minute;
//  - a listing every 15 minutes (and "Read again") catches everything else: her PHP
//    pages, her own SQL.
// A record not in a full listing goes missing and keeps its labels 30 days (S4-4).
import { AccountError, logActivity, type Actor } from '@panel/core/accounts';
import { all, one, run, tx, type Db, type Sql } from '@panel/core/pg';
import {
  dropSource, itemDeleted, labelsForGate, makeSource, markMissing, presentItems, purgeMissing, putItem, relabelSource, sourceRefs,
  type SourceCounts, type SourceRefs,
} from '@panel/catalog/items';
import type { Engine } from '../pammydb/ident.ts';
import type { Snapshot } from '../pammydb/ir.ts';
import type { RowPage } from '../pammydb/rows.ts';
import { fieldRows, resourceRows } from '../studio/resource-store.ts';
import { resourceViews, type ResourceView } from '../studio/resources.ts';
import { LIST_PAGE, MAX_TAGGED, keyFields, listingColumns, seenOf, whereOfKey, type Seen } from '../studio/tagging.ts';

type Ask = <T>(req: Record<string, unknown>) => Promise<T>;
type DbRow = { id: number; engine: Engine; name: string; status: string };
export type ReadResult = { items: number; made: number; back: number; missing: number; error?: string };
export type TableState = { at: number; items: number; missing: number; error: string | null };

const AUTOMATIC: Actor = { id: null, label: 'automatic check' };
const stateKey = (source: number) => `studio:${source}`;

export class RecordKeeper {
  readonly db: Sql;
  readonly studio: Ask;
  readonly gate: Ask;
  readonly now: () => number;
  log: (msg: string, err?: unknown) => void = () => {};
  #chain: Promise<unknown> = Promise.resolve();
  // step 4b: tables whose labels the gate is to be told again soon, and when
  #soon = new Map<number, ReturnType<typeof setTimeout>>();
  // how long a flurry of changes is gathered before the gate is told (tests: 0)
  publishDelayMs = 3000;

  constructor(db: Sql, studio: Ask, gate: Ask, now: () => number) {
    this.db = db;
    this.studio = studio;
    this.gate = gate;
    this.now = now;
  }

  // ---------------------------------------------------------------- what a table is
  async #database(id: number): Promise<DbRow | undefined> {
    return await one<DbRow>(this.db, 'SELECT id, engine, name, status FROM studio_databases WHERE id = ?', id);
  }

  async #views(d: DbRow, actor: string): Promise<ResourceView[]> {
    const { hash: _hash, ...snapshot } = await this.studio<Snapshot & { hash: string }>({ op: 'introspect', engine: d.engine, name: d.name, actor });
    return resourceViews(snapshot, await resourceRows(this.db, d.id), await fieldRows(this.db, d.id));
  }

  async #resourceId(databaseId: number, table: string): Promise<number> {
    await run(this.db, 'INSERT INTO studio_resources (database_id, table_name) VALUES (?, ?) ON CONFLICT (database_id, table_name) DO NOTHING', databaseId, table);
    return Number((await one<{ id: number }>(this.db, 'SELECT id FROM studio_resources WHERE database_id = ? AND table_name = ?', databaseId, table))!.id);
  }

  // ---------------------------------------------------------------- the switch (S4-1, S4-9)
  async count(d: DbRow, r: ResourceView, actor: string): Promise<number> {
    const page = await this.studio<RowPage>({ op: 'list-rows', engine: d.engine, name: d.name, actor,
      query: { table: r.table, columns: keyFields(r), limit: 1, offset: 0, order: null, search: null, filters: [] } });
    return page.total;
  }

  async switchOn(databaseId: number, r: ResourceView, by: string, picture: string | null): Promise<ReadResult> {
    const d = await this.#database(databaseId);
    if (!d) throw new AccountError('Not found.', 404);
    if (!keyFields(r).length) throw new AccountError(`${r.plural} have no field that tells one record from another, so they can't be tagged. Give the table a primary key on the Tables page first.`, 400);
    const n = await this.count(d, r, by);
    if (n > MAX_TAGGED) throw new AccountError(`${r.plural} are ${n.toLocaleString('en')} records; tags work on tables of up to ${MAX_TAGGED.toLocaleString('en')} for now.`, 400);
    const id = await this.#resourceId(databaseId, r.table);
    await tx(this.db, async (q) => {
      const had = await one<{ catalog_source: number | null }>(q, 'SELECT catalog_source FROM studio_resources WHERE id = ?', id);
      if (!had?.catalog_source) {
        const refs = await makeSource(q, this.now(), by, { kind: 'studio', ref: String(id), label: r.plural, resource: 'records' });
        await run(q, 'UPDATE studio_resources SET catalog_source = ? WHERE id = ?', refs.source, id);
      }
      await run(q, 'UPDATE studio_resources SET picture_field = ? WHERE id = ?', picture ?? '', id);
    });
    const fresh = (await this.#views(d, by)).find((x) => x.table === r.table)!;
    return await this.readNow(d, fresh, by);
  }

  // Off: its items and labels go (Q4-6); Everywhere's labels only lose these links.
  async switchOff(databaseId: number, r: ResourceView): Promise<SourceCounts | null> {
    if (!r.catalogSource) return null;
    const counts = await tx(this.db, async (q) => {
      const counts = await dropSource(q, r.catalogSource!);
      await run(q, "UPDATE studio_resources SET catalog_source = NULL, picture_field = '' WHERE database_id = ? AND table_name = ?", databaseId, r.table);
      await run(q, 'DELETE FROM sync_state WHERE key = ?', stateKey(r.catalogSource!));
      return counts;
    });
    // the data API stops answering with them (step 4b); the next listing would too
    await this.gate({ op: 'record-labels.put', databaseId, table: r.table, labels: [], records: [] })
      .catch((e: unknown) => this.log('telling the gate a table\'s labels went failed', e));
    return counts;
  }

  async setPicture(databaseId: number, table: string, picture: string | null) {
    await run(this.db, 'UPDATE studio_resources SET picture_field = ? WHERE database_id = ? AND table_name = ?', picture ?? '', databaseId, table);
  }

  async state(source: number): Promise<TableState | null> {
    const r = await one<{ value: string }>(this.db, 'SELECT value FROM sync_state WHERE key = ?', stateKey(source));
    return r ? JSON.parse(r.value) as TableState : null;
  }

  async #setState(source: number, s: TableState) {
    await run(this.db, 'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', stateKey(source), JSON.stringify(s));
  }

  // ---------------------------------------------------------------- one record (the panel's pages)
  async refs(r: ResourceView): Promise<SourceRefs | undefined> {
    return r.tagged && r.catalogSource ? await sourceRefs(this.db, r.catalogSource) : undefined;
  }

  // Made or changed: read back its key, title and picture (the page's answer may not hold
  // the title field, if she hid it) and put it in the catalog.
  // Never fails the save it follows: the record is written; the next listing puts it right.
  async recordSaved(d: { engine: Engine; name: string }, r: ResourceView, row: Record<string, unknown>, actor: string): Promise<number | null> {
    try {
      return await this.#once(() => this.#saved(d, r, row, actor));
    } catch (e) {
      this.log(`putting a ${r.singular} in the catalog failed`, e);
      return null;
    }
  }

  async #saved(d: { engine: Engine; name: string }, r: ResourceView, row: Record<string, unknown>, actor: string): Promise<number | null> {
    const refs = await this.refs(r);
    if (!refs) return null;
    let seen = seenOf(r, row);
    const cols = listingColumns(r);
    if (seen && cols.some((c) => !(c in row))) {
      const where = whereOfKey(r, seen.key);
      const got = where && await this.studio<{ row: Record<string, unknown> | null }>({ op: 'get-row', engine: d.engine, name: d.name, table: r.table, columns: cols, where, actor });
      seen = got && got.row ? seenOf(r, got.row) : seen;
    }
    if (!seen) return null;
    return await this.#put(this.db, refs, seen);
  }

  async #put(q: Db, refs: SourceRefs, s: Seen): Promise<number> {
    const id = await putItem(q, refs, { key: s.key, title: s.title, kind: 'records' }, this.now());
    await run(q, `INSERT INTO studio_catalog_records (item_id, picture) VALUES (?, ?)
      ON CONFLICT (item_id) DO UPDATE SET picture = excluded.picture WHERE studio_catalog_records.picture IS DISTINCT FROM excluded.picture`, id, s.picture);
    return id;
  }

  // Deleted: its item and links go at once, and Activity says which labels went.
  async recordDeleted(r: ResourceView, key: string, actor: Actor) {
    try {
      await this.#once(() => this.#deleted(r, key, actor));
    } catch (e) {
      this.log(`taking a ${r.singular} out of the catalog failed`, e);
    }
  }

  async #deleted(r: ResourceView, key: string, actor: Actor) {
    const refs = await this.refs(r);
    if (!refs) return;
    const gone = await itemDeleted(this.db, refs.resource, key);
    if (gone?.labels.length) this.labelsChanged(refs.source);
    if (gone?.labels.length) {
      await logActivity(this.db, this.now(), actor, 'record-labels-gone', `${r.singular} "${gone.title ?? key}"`, `it had ${gone.labels.join(', ')}`);
    }
  }

  // ---------------------------------------------------------------- the listing (S4-3)
  // Every record's key, title and picture, compared with the items. Only a listing that
  // saw the whole table (and the table not changing size under it) marks anything missing.
  async read(d: { id: number; engine: Engine; name: string }, r: ResourceView, actor: string): Promise<ReadResult> {
    const refs = await this.refs(r);
    if (!refs) return { items: 0, made: 0, back: 0, missing: 0 };
    const at = this.now();
    try {
      const seen: Seen[] = [];
      let total = -1, stable = true;
      const cols = listingColumns(r);
      for (let offset = 0; ; offset += LIST_PAGE) {
        const page = await this.studio<RowPage>({ op: 'list-rows', engine: d.engine, name: d.name, actor,
          query: { table: r.table, columns: cols, limit: LIST_PAGE, offset, order: { column: keyFields(r)[0], dir: 'asc' }, search: null, filters: [] } });
        if (total === -1) total = page.total;
        else if (page.total !== total) stable = false;
        if (total > MAX_TAGGED) throw new AccountError(`${r.plural} are ${total.toLocaleString('en')} records now, more than the ${MAX_TAGGED.toLocaleString('en')} tags work on: the tags stay, but new records aren't added.`, 400);
        for (const row of page.items) { const s = seenOf(r, row); if (s) seen.push(s); }
        if (page.items.length < LIST_PAGE || offset + LIST_PAGE >= total) break;
      }
      const result = await tx(this.db, async (q) => {
        const before = await presentItems(q, refs.resource);
        let made = 0;
        const keys = new Set<string>();
        for (const s of seen) {
          if (keys.has(s.key)) continue;
          keys.add(s.key);
          const had = before.get(s.key);
          if (!had || had.title !== s.title) await this.#put(q, refs, s);
          else await run(q, `INSERT INTO studio_catalog_records (item_id, picture) VALUES (?, ?)
            ON CONFLICT (item_id) DO UPDATE SET picture = excluded.picture WHERE studio_catalog_records.picture IS DISTINCT FROM excluded.picture`, had.id, s.picture);
          if (!had) made++;
        }
        const gone = stable && seen.length >= total ? [...before.values()].filter((i) => !keys.has(i.key)).map((i) => i.id) : [];
        const missing = await markMissing(q, gone, at);
        await relabelSource(q, refs.source, r.plural);
        return { items: keys.size, made, back: 0, missing };
      });
      await this.#setState(refs.source, { at, items: result.items, missing: result.missing, error: null });
      // (the table was read; the gate not hearing of it is said in the log, not as a failed read)
      await this.#publish(refs.source).catch((e: unknown) => this.log('telling the gate a table\'s labels failed', e));
      return result;
    } catch (e) {
      const error = e instanceof AccountError ? e.message : 'The panel could not read the table just now.';
      await this.#setState(refs.source, { at, items: (await presentItems(this.db, refs.resource)).size, missing: 0, error });
      if (!(e instanceof AccountError)) this.log(`reading ${d.name}.${r.table} for the catalog failed`, e);
      return { items: 0, made: 0, back: 0, missing: 0, error };
    }
  }

  // Every table switched on, one after the other; then records missing 30 days are forgotten.
  async readAll(): Promise<number> {
    return await this.#once(async () => {
      const dbs = await all<{ database_id: number }>(this.db, 'SELECT DISTINCT database_id FROM studio_resources WHERE catalog_source IS NOT NULL');
      let n = 0;
      for (const { database_id } of dbs) n += await this.#readDatabase(Number(database_id), null);
      await purgeMissing(this.db, this.now());
      // the gate forgets every table that isn't tagged any more (off, renamed, gone)
      const tagged = await all<{ database_id: number; table_name: string }>(this.db, 'SELECT database_id, table_name FROM studio_resources WHERE catalog_source IS NOT NULL');
      await this.gate({ op: 'record-labels.keep', tables: tagged.map((t) => ({ databaseId: Number(t.database_id), table: t.table_name })) })
        .catch((e: unknown) => this.log('telling the gate which tables are tagged failed', e));
      return n;
    });
  }

  async #readDatabase(databaseId: number, only: Set<string> | null): Promise<number> {
    const d = await this.#database(databaseId);
    if (!d) return 0;
    let views: ResourceView[];
    try {
      views = await this.#views(d, AUTOMATIC.label);
    } catch (e) {
      this.log(`looking at ${d.name} for the catalog failed`, e);
      return 0;
    }
    let n = 0;
    for (const r of views) {
      if (!r.tagged || (only && !only.has(r.table))) continue;
      await this.read(d, r, AUTOMATIC.label);
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- the gate's writes (S4-3, Q4-3)
  // A delete the gate knew the key of goes at once; anything else reads that table again.
  async takeTouches(): Promise<number> {
    return await this.#once(async () => {
      const { touches } = await this.gate<{ touches: { database_id: number; table_name: string; key: string | null; what: 'changed' | 'deleted' }[] }>({ op: 'record-touches.take' });
      if (!touches.length) return 0;
      const again = new Map<number, Set<string>>();
      const views = new Map<number, ResourceView[]>();
      for (const t of touches) {
        const id = Number(t.database_id);
        if (t.what === 'deleted' && t.key) {
          const d = await this.#database(id);
          if (!d) continue;
          if (!views.has(id)) views.set(id, await this.#views(d, AUTOMATIC.label).catch(() => []));
          const r = views.get(id)!.find((x) => x.table === t.table_name);
          if (r) await this.#deleted(r, t.key, { id: null, label: 'a program or a form' });
          continue;
        }
        again.set(id, (again.get(id) ?? new Set()).add(t.table_name));
      }
      for (const [id, tables] of again) await this.#readDatabase(id, tables);
      return touches.length;
    });
  }

  // ---------------------------------------------------------------- the data API's copy (step 4b)
  // A table's labels changed (a record's, a label renamed, deleted or made public): the gate
  // is told a moment later, once for a flurry of changes.
  labelsChanged(source: number) {
    clearTimeout(this.#soon.get(source));
    this.#soon.set(source, setTimeout(() => {
      this.#soon.delete(source);
      this.#once(() => this.#publish(source)).catch((e: unknown) => this.log('telling the gate a table\'s labels failed', e));
    }, this.publishDelayMs));
  }

  // An Everywhere label changed: every tagged table.
  async allChanged() {
    for (const r of await all<{ catalog_source: number }>(this.db, 'SELECT catalog_source FROM studio_resources WHERE catalog_source IS NOT NULL')) {
      this.labelsChanged(Number(r.catalog_source));
    }
  }

  // Everything waiting to be told, now (tests, and before a listing's end).
  async flush() {
    const waiting = [...this.#soon.keys()];
    for (const s of waiting) { clearTimeout(this.#soon.get(s)); this.#soon.delete(s); }
    for (const s of waiting) await this.#once(() => this.#publish(s));
  }

  async #publish(source: number) {
    const t = await one<{ database_id: number; table_name: string }>(this.db, 'SELECT database_id, table_name FROM studio_resources WHERE catalog_source = ?', source);
    if (!t) return;
    const { labels, records } = await labelsForGate(this.db, source);
    await this.gate({ op: 'record-labels.put', databaseId: Number(t.database_id), table: t.table_name, labels, records });
  }

  // one run at a time, in the order asked: a listing, the touches and "Read again" never
  // write the same items at once
  #once<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#chain.then(fn, fn);
    this.#chain = p.catch(() => undefined);
    return p;
  }

  // "Read again", and the first listing after the switch: queued with the rest.
  readNow(d: { id: number; engine: Engine; name: string }, r: ResourceView, actor: string): Promise<ReadResult> {
    return this.#once(() => this.read(d, r, actor));
  }
}
