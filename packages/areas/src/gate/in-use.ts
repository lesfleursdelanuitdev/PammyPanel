// What the areas use that a visitor switch turns on (docs/k-a-plan.md K-a4 and KA-Q3): the
// two checks people's setVisitorSwitch makes before a switch goes off, on areas' tables.
// Each answers the areas' names (a folder's path, a route's address), in order.
import { all, type Db } from '@panel/core/pg';

// Areas on roles of their own: anything but the built-in sets. (A route's area on Open
// with accounts is on built-in roles too: docs/roles-plan.md step 5.) Roles can't go off
// while there are any (docs/roles-plan.md step 4).
export const ownRoleSetsInUse = async (db: Db): Promise<string[]> => (await all<{ path: string }>(db,
  "SELECT coalesce(a.label, a.path) AS path FROM areas a JOIN role_sets s ON s.id = a.role_set_id WHERE s.key IS NULL OR s.key NOT IN ('protected-folder', 'open-with-accounts') ORDER BY 1"))
  .map((a) => a.path);

// Routes anyone may open (pages.read in the "not signed in" slot): on the built-in set, a
// copy of it, or an app's own roles. "Open with accounts" can't go off while there are any.
export const routesOpenToAll = async (db: Db): Promise<string[]> => (await all<{ path: string }>(db,
  `SELECT coalesce(a.label, a.path) AS path FROM areas a
    WHERE a.kind = 'route' AND EXISTS (SELECT 1 FROM roles r JOIN role_all_privileges p ON p.role_id = r.id
                                       WHERE r.role_set_id = a.role_set_id AND r.slot = 'not-signed-in' AND p.privilege = 'pages.read')
    ORDER BY 1`))
  .map((a) => a.path);
