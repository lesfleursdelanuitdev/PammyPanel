// Where the site folders are shown (docs/phase8b-plan.md 8b-9): the routes are this module's,
// the folders' names the files module's (@panel/files/site-folders/store). What the site needs
// for File Explorer's places, a file's addresses and a route's folder, without SQL of its own.
import { all, one, type Db } from '@panel/core/pg';
import { allFolders } from '@panel/files/site-folders/store';
import { ON_HOME } from '../domains.ts';

const namesById = async (q: Db) => new Map((await allFolders(q)).map((f) => [f.id, f.name]));

// the site folders the routes on these home domain hosts show: a person kept to places
// (hosts, "/tutor") is kept to these in File Explorer, media and forms (P8-2)
export async function foldersShownOn(q: Db, hostNames: readonly string[]): Promise<string[]> {
  if (!hostNames.length) return [];
  const names = await namesById(q);
  const ids = await all<{ folder_id: number }>(q, `SELECT DISTINCT r.folder_id FROM routes r JOIN hosts h ON h.id = r.host_id
    WHERE r.folder_id IS NOT NULL AND ${ON_HOME.replace(/domain_id/g, 'h.domain_id')} AND h.name IN (SELECT jsonb_array_elements_text(?::text::jsonb))`, JSON.stringify(hostNames));
  return ids.map((r) => names.get(r.folder_id)!).filter(Boolean);
}

// each folder's addresses: through every enabled route, on an enabled host, that shows it
export async function folderAddresses(q: Db, home: string): Promise<Record<string, string[]>> {
  const names = await namesById(q);
  const rows = await all<{ folder_id: number; host: string; path: string; domain: string | null }>(q, `SELECT r.folder_id, h.name AS host, r.path, d.name AS domain
    FROM routes r JOIN hosts h ON h.id = r.host_id LEFT JOIN domains d ON d.id = h.domain_id
    WHERE r.folder_id IS NOT NULL AND r.enabled AND h.enabled ORDER BY h.name, r.path`);
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const name = names.get(r.folder_id);
    if (name) (out[name] ??= []).push(`https://${r.host === '@' ? '' : `${r.host}.`}${r.domain ?? home}${r.path}`);
  }
  return out;
}

// what a route shows, by its id: its kind, its service, its folder's name (undefined: no such route)
export async function routeTarget(q: Db, routeId: number): Promise<{ kind: string; service: string | null; folder: string | null } | undefined> {
  const r = await one<{ kind: string; service: string | null; folder_id: number | null }>(q,
    "SELECT target_kind AS kind, target_ref->>'service' AS service, folder_id FROM routes WHERE id = ?", routeId);
  if (!r) return undefined;
  return { kind: r.kind, service: r.service, folder: r.folder_id === null ? null : (await namesById(q)).get(r.folder_id) ?? null };
}
