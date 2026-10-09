// Row mode (docs/form-to-database-plan.md): one response becomes one row in one
// of her tables, once. It is written when it arrives, or when she approves it.
//
// Three things decide whether a row is written, in this order, every time:
//
//   1. the link: is this form connected, switched on, and is it time (F3)?
//   2. the catalog: is the table still in her app, with "Add new ones" on, and
//      is every field still there and still of a kind the answer fits (F2, F12)?
//      The same pushed catalog the data API answers from -- so a table switched
//      off, a field hidden or renamed stops a form exactly as it stops a program.
//   3. the database itself, through the helper, like every other write.
//
// The response is always kept (F1): it is committed before any of this runs,
// and a row that cannot be written leaves the response saying why (F10). This
// module works out what to write and writes it; what the response then says is
// the queue's (saves/queue.ts).
import { one, type Db } from '@panel/core/pg';
import { callPammyDb, PammyDbCallError } from '@panel/studio/pammydb/client';
import type { Scalar } from '@panel/studio/pammydb/rows';
import { readCatalog } from '@panel/studio/studio/catalog';
import { noteTouch } from '@panel/studio/gate/studio';
import { buildValues, FormLinkError, type TargetField } from '../../studio/form-links.ts';
import type { StoredAnswer } from '@panel/forms/shared/form-types';
import type { StoredLink } from './links.ts';
import type { Outcome } from './queue.ts';
import type { SaveRow } from './save.ts';

export async function writeRow(db: Db, now: number, socket: string, r: SaveRow, link: StoredLink): Promise<Outcome> {
  // 2. the catalog: the window, as for the data API
  const cat = await one<{ catalog_json: string }>(db, 'SELECT catalog_json FROM studio_catalog WHERE database_id = ?', link.databaseId);
  if (!cat) return { kind: 'problem', problem: `The app for ${link.name} is switched off, so nothing can be saved in it.` };
  const resource = readCatalog(cat.catalog_json).resources.find((x) => x.table === link.table);
  if (!resource) return { kind: 'problem', problem: `The table ${link.table} isn't in the ${link.name} app any more.` };
  if (!resource.can.create) return { kind: 'problem', problem: `${resource.plural} are set up so that new ones can't be added.` };
  if (!resource.types) return { kind: 'problem', problem: `Open the ${link.name} app in the panel once, so it can bring its settings up to date.` };
  const fields: Record<string, TargetField> = {};
  for (const [name, t] of Object.entries(resource.types)) {
    if (!resource.key.includes(name) && resource.columns.includes(name)) fields[name] = t as TargetField;
  }

  let values: Record<string, Scalar>;
  try {
    const answers = JSON.parse(r.answers) as StoredAnswer[];
    values = buildValues(link, answers, { sentAt: Number(r.created_at), page: r.page, sender: r.visitor_name || r.visitor_username, engine: link.engine }, fields);
  } catch (e) {
    if (e instanceof FormLinkError) return { kind: 'problem', problem: e.message };
    throw e;
  }

  // 3. the database
  const back = [...resource.key, ...(resource.titleField && !resource.key.includes(resource.titleField) ? [resource.titleField] : [])];
  let row: Record<string, unknown>;
  try {
    ({ row } = await callPammyDb<{ row: Record<string, unknown> }>(socket, {
      op: 'insert-row', engine: link.engine, name: link.name, actor: 'forms', table: link.table, values, back,
    }, 30_000));
  } catch (e) {
    // (no claim to renew here: one call, and the outcome is written straight after)
    if (e instanceof PammyDbCallError) {
      // W4/B3: the request went in and the answer never came. Row mode has no
      // way to ask "is it there?" -- a second try could make a second row -- so
      // it stops here and says so in her words.
      if (e.code === 'timeout') {
        return { kind: 'unsure', problem: `The ${link.name} database took this and then stopped answering. It may already be in ${resource.plural}: look there before you press Try again.` };
      }
      return e.code === 'unavailable' || e.code === 'busy'
        ? { kind: 'retry', problem: e.message }
        : { kind: 'problem', problem: e.message };
    }
    return { kind: 'retry', problem: 'The database helper could not be reached. It will be tried again.' };
  }
  // docs/catalog-plan.md step 4: a table she tags hears of the new record (never fails the save)
  await noteTouch(db, now, link.databaseId, resource, 'changed').catch(() => undefined);
  const key = Object.fromEntries(resource.key.map((k) => [k, row[k] ?? null]));
  const label = String((resource.titleField ? row[resource.titleField] : null) ?? Object.values(key).join(', '));
  return {
    kind: 'done', table: resource.plural, label,
    savedTo: { engine: link.engine, name: link.name, table: link.table, plural: resource.plural, key, label, at: now },
  };
}
