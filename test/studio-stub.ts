// An in-memory stand-in for the shape inside one of her databases, so the panel
// tests and the browser tests can exercise the designer without a real engine.
// test/pammydb.test.ts is what drives real Postgres and MariaDB.
//
// It is deliberately NOT a SQL engine: it moves tables and fields around in a
// snapshot, exactly as far as the patch steps say and no further. Anything about
// whether an engine would accept a step is the live tests' business.
import type { ApplyOutcome } from '@panel/studio/pammydb/driver';
import type { Engine } from '@panel/studio/pammydb/ident';
import type { Snapshot, Table } from '@panel/studio/pammydb/ir';
import type { Step } from '@panel/studio/pammydb/patch';

export type MemorySchemas = {
  get(database: string): Snapshot;
  set(database: string, tables: Table[]): void;
  introspect(engine: Engine, database: string): Promise<Snapshot>;
  apply(engine: Engine, database: string, steps: Step[]): Promise<ApplyOutcome>;
  // which step the stub should refuse, to test what the panel does when an
  // engine says no half way through
  refuse(at: ((step: Step, at: number) => boolean) | null): void;
};

export function memorySchemas(engine: Engine, seed: Record<string, Table[]> = {}): MemorySchemas {
  const schemas = new Map<string, Table[]>(Object.entries(seed));
  let refusing: ((step: Step, at: number) => boolean) | null = null;

  const tablesOf = (database: string) => schemas.get(database) ?? [];
  const snapshot = (database: string): Snapshot => ({
    engine,
    database,
    tables: structuredClone(tablesOf(database)).sort((a, b) => a.name.localeCompare(b.name)),
    notes: [],
  });

  const one = (tables: Table[], name: string) => {
    const t = tables.find((x) => x.name === name);
    if (!t) throw new Error(`stub: no table ${name}`);
    return t;
  };

  return {
    get: snapshot,
    set: (database, tables) => schemas.set(database, tables),
    refuse: (at) => { refusing = at; },
    introspect: async (_e, database) => snapshot(database),
    apply: async (_e, database, steps) => {
      let tables = structuredClone(tablesOf(database));
      let applied = 0;
      for (; applied < steps.length; applied++) {
        const step = steps[applied]!;
        if (refusing?.(step, applied)) {
          // like MariaDB: what already ran, ran
          schemas.set(database, tables);
          return { applied, rolledBack: false, failed: { at: applied, message: `the stub refused ${step.kind}` } };
        }
        switch (step.kind) {
          case 'create-table': tables.push(structuredClone(step.table)); break;
          case 'drop-table': tables = tables.filter((t) => t.name !== step.table); break;
          case 'rename-table': one(tables, step.table).name = step.to; break;
          case 'add-column': one(tables, step.table).columns.push(structuredClone(step.column)); break;
          case 'drop-column': {
            const t = one(tables, step.table);
            t.columns = t.columns.filter((c) => c.name !== step.column);
            break;
          }
          case 'rename-column': {
            const t = one(tables, step.table);
            const c = t.columns.find((x) => x.name === step.column);
            if (c) c.name = step.to;
            t.primaryKey = t.primaryKey.map((k) => (k === step.column ? step.to : k));
            break;
          }
          case 'alter-column': {
            const t = one(tables, step.table);
            t.columns = t.columns.map((c) => (c.name === step.column.name ? structuredClone(step.column) : c));
            break;
          }
          case 'add-unique': one(tables, step.table).uniques.push(structuredClone(step.unique)); break;
          case 'drop-unique': {
            const t = one(tables, step.table);
            t.uniques = t.uniques.filter((u) => u.name !== step.unique);
            break;
          }
          case 'add-foreign-key': one(tables, step.table).foreignKeys.push(structuredClone(step.foreignKey)); break;
          case 'drop-foreign-key': {
            const t = one(tables, step.table);
            t.foreignKeys = t.foreignKeys.filter((f) => f.name !== step.foreignKey);
            break;
          }
        }
      }
      // a draft marker is a drawing's business and never reaches an engine
      for (const t of tables) {
        delete t.was;
        for (const c of t.columns) delete c.was;
      }
      schemas.set(database, tables);
      return { applied, failed: null, rolledBack: false };
    },
  };
}

// A small schema to start the stubs from: one table that exists, with a field
// the panel could not have made, so "left as it is" has something to be about.
export const seedTables = (): Table[] => [{
  name: 'recipes',
  columns: [
    { name: 'id', type: 'integer', required: true, identity: true, default: null, sqlType: 'integer' },
    { name: 'title', type: 'text', required: true, default: null, sqlType: 'text' },
    { name: 'servings', type: 'integer', required: false, default: { kind: 'number', value: 4 }, sqlType: 'integer' },
    { name: 'tags', type: 'other', required: false, default: null, sqlType: 'text[]' },
  ],
  primaryKey: ['id'],
  uniques: [],
  foreignKeys: [],
  indexes: [],
}];

// ------------------------------------------------------------------ her rows
// A very small in-memory stand-in for rows, enough that the panel tests and the
// browser tests can list, add, change and delete records. It is NOT a SQL
// engine: search is a substring over the chosen columns, filters cover only
// what the DataViewer sends, and sorting is a plain comparison.
// test/pammydb.test.ts is what proves the real statements against real engines.
import type { RowPage, RowQuery, Scalar } from '@panel/studio/pammydb/rows';

export type MemoryRows = {
  set(database: string, table: string, rows: Record<string, unknown>[]): void;
  // a database dropped: its rows go with it, as on an engine
  forget(database: string): void;
  all(database: string, table: string): Record<string, unknown>[];
  list(database: string, q: RowQuery): Promise<RowPage>;
  get(database: string, table: string, columns: string[], where: Record<string, Scalar>): Promise<Record<string, unknown> | null>;
  insert(database: string, table: string, values: Record<string, Scalar>, back: string[]): Promise<Record<string, unknown>>;
  update(database: string, table: string, values: Record<string, Scalar>, where: Record<string, Scalar>, back: string[]): Promise<Record<string, unknown> | null>;
  remove(database: string, table: string, where: Record<string, Scalar>): Promise<boolean>;
  setLinks(database: string, table: string, here: string, id: Scalar, there: string, ids: Scalar[]): Promise<number>;
};

export function memoryRows(seed: Record<string, Record<string, Record<string, unknown>[]>> = {}): MemoryRows {
  const store = new Map<string, Record<string, unknown>[]>();
  for (const [db, tables] of Object.entries(seed)) {
    for (const [table, rows] of Object.entries(tables)) store.set(`${db}.${table}`, structuredClone(rows));
  }
  const key = (db: string, table: string) => `${db}.${table}`;
  const rowsOf = (db: string, table: string) => store.get(key(db, table)) ?? [];
  const matches = (row: Record<string, unknown>, where: Record<string, Scalar>) =>
    Object.entries(where).every(([c, v]) => (v === null ? row[c] == null : String(row[c]) === String(v)));
  const pick = (row: Record<string, unknown>, columns: string[]) =>
    Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));

  return {
    set(db, table, rows) { store.set(key(db, table), structuredClone(rows)); },
    forget(db) { for (const k of [...store.keys()]) if (k.startsWith(`${db}.`)) store.delete(k); },
    all(db, table) { return structuredClone(rowsOf(db, table)); },

    async list(db, q) {
      let rows = rowsOf(db, q.table);
      for (const f of q.filters) {
        rows = rows.filter((r) => {
          const v = r[f.column];
          switch (f.kind) {
            case 'equals': return f.value === null ? v == null : String(v) === String(f.value);
            case 'contains': return String(v ?? '').toLowerCase().includes(f.text.toLowerCase());
            case 'range':
              return (f.from === null || String(v ?? '') >= String(f.from))
                && (f.to === null || String(v ?? '') <= String(f.to));
            case 'empty': return f.empty ? v == null : v != null;
            case 'in': return f.values.some((x) => String(x) === String(v));
          }
        });
      }
      if (q.search) {
        const needle = q.search.text.toLowerCase();
        rows = rows.filter((r) => q.search!.columns.some((c) => String(r[c] ?? '').toLowerCase().includes(needle)));
      }
      if (q.order) {
        const { column, dir } = q.order;
        rows = [...rows].sort((a, b) => {
          const x = a[column], y = b[column];
          const n = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''));
          return dir === 'desc' ? -n : n;
        });
      }
      return { items: rows.slice(q.offset, q.offset + q.limit).map((r) => pick(r, q.columns)), total: rows.length };
    },

    async get(db, table, columns, where) {
      const row = rowsOf(db, table).find((r) => matches(r, where));
      return row ? pick(row, columns) : null;
    },

    async insert(db, table, values, back) {
      const rows = rowsOf(db, table);
      // stand in for an engine filling in the key
      const id = Math.max(0, ...rows.map((r) => Number(r.id) || 0)) + 1;
      const row = { id, ...values };
      store.set(key(db, table), [...rows, row]);
      return pick(row, back);
    },

    async update(db, table, values, where, back) {
      const rows = rowsOf(db, table);
      const i = rows.findIndex((r) => matches(r, where));
      if (i === -1) return null;
      rows[i] = { ...rows[i], ...values };
      store.set(key(db, table), rows);
      return pick(rows[i]!, back);
    },

    async setLinks(db, table, here, id, there, ids) {
      const keep = rowsOf(db, table).filter((r) => String(r[here]) !== String(id));
      store.set(key(db, table), [...keep, ...ids.map((v) => ({ [here]: id, [there]: v }))]);
      return ids.length;
    },

    async remove(db, table, where) {
      const rows = rowsOf(db, table);
      const left = rows.filter((r) => !matches(r, where));
      store.set(key(db, table), left);
      return left.length < rows.length;
    },
  };
}
