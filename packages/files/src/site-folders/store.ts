// Site folders' records (docs/phase8b-plan.md 8b-9; domains-hosts D-3): the files module's
// table panel.site_folders (made by hosts/0001-hosts.sql before the move; it keeps its name
// and rows). A folder of static files, and PHP pages when run_php is on, under the site
// folders' root; its name is its folder on disk. adopted: it was there before the panel (it
// can't be deleted from the panel until nothing shows it, platform plan D2). Only this file
// reads or writes the table; the hosts module's routes point at a folder by its id
// (routes.folder_id, ON DELETE RESTRICT) and come here for the rest.
import { all, one, run, type Db } from '@panel/core/pg';

export type FolderRow = { id: number; name: string; run_php: boolean; adopted: boolean; created_by: string | null; created_at: number };

export const allFolders = (q: Db) => all<FolderRow>(q, 'SELECT * FROM site_folders ORDER BY name');
export const folderById = (q: Db, id: number) => one<FolderRow>(q, 'SELECT * FROM site_folders WHERE id = ?', id);
export const folderByName = (q: Db, name: string) => one<FolderRow>(q, 'SELECT * FROM site_folders WHERE name = ?', name);

export async function addFolder(q: Db, f: { name: string; runPhp: boolean; adopted?: boolean; actor: string; now: number }): Promise<FolderRow> {
  return (await one<FolderRow>(q, 'INSERT INTO site_folders (name, run_php, adopted, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *',
    f.name, f.runPhp, f.adopted === true, f.actor, f.now))!;
}
export const setRunPhp = (q: Db, id: number, runPhp: boolean) => run(q, 'UPDATE site_folders SET run_php = ? WHERE id = ?', runPhp, id);
// (the database refuses while a route still shows it)
export const dropFolder = (q: Db, id: number) => run(q, 'DELETE FROM site_folders WHERE id = ?', id);
