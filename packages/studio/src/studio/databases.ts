// The panel's side of her databases: which ones it looks after, and what she
// calls them (docs/databases-plan.md 15). The helper owns the engines; this owns
// the meaning. Nothing here opens a database or composes SQL for one -- if a
// route needs that, it is a helper op (docs/studio-plan.md).
//
// The live list always wins. A row here for a database the helper no longer
// lists means "it's gone", not "it exists": that is what `live: false` says.
import { AccountError } from '@panel/core/accounts';
import { all, one, run, type Db } from '@panel/core/pg';
import type { DatabaseFacts, EngineState } from '../pammydb/driver.ts';
import { ENGINE_NAMES, type Engine } from '../pammydb/ident.ts';

export type ManagedRow = {
  id: number;
  engine: Engine;
  name: string;
  display_name: string;
  adopted_at: number;
  status: 'inactive' | 'active';
  api_read: number;
  api_write: number;
  // which example it is, when the panel made it for one (docs/db-examples-plan.md X2)
  example?: string | null;
};

// One card on /databases. `managed` = the panel looks after it. `live` is three
// states on purpose: true = the engine has it, false = the engine answered and it
// is not there, null = the engine did not answer, so we do not know. Telling her
// a database is gone when the server is merely asleep would be a lie.
export type DatabaseCard = {
  engine: Engine;
  engineName: string;          // "Postgres" / "MariaDB", as she reads it
  name: string;
  displayName: string;
  managed: boolean;
  live: boolean | null;
  bytes: number | null;
  tables: number | null;
  owner: string | null;
  protectedName: boolean;      // never created or deleted by the panel
  system: boolean;             // the engine's own machinery
  appOwned: boolean;           // an app's (docs/phase8-plan.md P8-9): looked inside, never changed
  projectOwned: boolean;       // ...a project's (docs/phase8b-plan.md 8b-5)
  status: 'inactive' | 'active';
  adoptedAt: number | null;
  // the panel's own example, which she can use but not delete, rename or switch off
  example: string | null;
};

export type Dashboard = { databases: DatabaseCard[]; engines: EngineState[] };

const key = (engine: string, name: string) => `${engine}:${name}`;

// What the dashboard shows: everything the engines have, plus anything the panel
// still remembers that they no longer do. Pure, so the shape is testable without
// an engine or a database.
export function mergeDatabases(live: DatabaseFacts[], managed: ManagedRow[], engines: EngineState[] = []): DatabaseCard[] {
  const silent = new Set(engines.filter((e) => !e.ok).map((e) => e.engine));
  const rows = new Map(managed.map((m) => [key(m.engine, m.name), m]));
  const cards: DatabaseCard[] = [];
  for (const d of live) {
    const m = rows.get(key(d.engine, d.name));
    rows.delete(key(d.engine, d.name));
    cards.push({
      engine: d.engine,
      engineName: ENGINE_NAMES[d.engine],
      name: d.name,
      displayName: m?.display_name ?? '',
      managed: !!m,
      live: true,
      bytes: d.bytes,
      tables: d.tables,
      owner: d.owner,
      protectedName: d.protectedName,
      system: d.system,
      appOwned: d.appOwned ?? false,
      projectOwned: d.projectOwned ?? false,
      status: m?.status ?? 'inactive',
      adoptedAt: m?.adopted_at ?? null,
      example: m?.example ?? null,
    });
  }
  // Remembered, but the engine did not list it. Either it is gone (and she needs
  // to be told) or the engine never answered (and she must not be told it is gone).
  for (const m of rows.values()) {
    cards.push({
      engine: m.engine,
      engineName: ENGINE_NAMES[m.engine],
      name: m.name,
      displayName: m.display_name,
      managed: true,
      live: silent.has(m.engine) ? null : false,
      bytes: null,
      tables: null,
      owner: null,
      protectedName: false,
      system: false,
      appOwned: false,
      projectOwned: false,
      status: m.status,
      adoptedAt: m.adopted_at,
      example: m.example ?? null,
    });
  }
  // hers first, then the examples
  cards.sort((a, b) => Number(!!a.example) - Number(!!b.example) || a.engine.localeCompare(b.engine) || a.name.localeCompare(b.name));
  return cards;
}

export const listManaged = (db: Db) =>
  all<ManagedRow>(db, 'SELECT * FROM studio_databases ORDER BY engine, name');

export const getManaged = (db: Db, engine: Engine, name: string) =>
  one<ManagedRow>(db, 'SELECT * FROM studio_databases WHERE engine = ? AND name = ?', engine, name);

// Start looking after a database -- one the panel has just made, or one she made
// herself and is adopting. Doing it twice is not an error: the row is already
// what it would have written.
export async function startManaging(db: Db, o: { engine: Engine; name: string; displayName?: string; at: number }): Promise<ManagedRow> {
  await run(db,
    `INSERT INTO studio_databases (engine, name, display_name, adopted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (engine, name) DO NOTHING`,
    o.engine, o.name, o.displayName ?? '', o.at);
  const row = await getManaged(db, o.engine, o.name);
  if (!row) throw new AccountError('The panel could not write that database down.', 500);
  return row;
}

export async function setDisplayName(db: Db, engine: Engine, name: string, displayName: string): Promise<void> {
  const n = await run(db, 'UPDATE studio_databases SET display_name = ? WHERE engine = ? AND name = ?', displayName, engine, name);
  if (!n) throw new AccountError('The panel is not looking after that database.', 404);
}

// Stop looking after it, without touching the database itself (12: Unmanage).
// Refused while its app is switched on, so a live /app never loses its meaning.
export async function stopManaging(db: Db, engine: Engine, name: string, app = 'app'): Promise<void> {
  const row = await getManaged(db, engine, name);
  if (!row) throw new AccountError('The panel is not looking after that database.', 404);
  if (row.status === 'active') {
    throw new AccountError(`Switch its ${app} off first, then the panel can stop looking after it.`, 403);
  }
  await run(db, 'DELETE FROM studio_databases WHERE id = ?', row.id);
}
