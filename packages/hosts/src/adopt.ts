// Taking over the stopgap (docs/hosts-plan.md H10, docs/lfdln-standup-plan.md L6): every
// folder already in the site folders' root was public at <name>.<domain> through the
// stopgap catch-all, so nothing that works may stop working. Each becomes a site folder
// marked adopted (it can't be deleted from the panel, platform plan D2), with the host of
// its name and a route at / showing it -- static only, as the stopgap served it (PHP off).
// Folders whose name can't be a site folder or a host are left alone and said.
//
// In one transaction with the routing helper applying the whole table, like every other
// change to the hosts: if nginx says no, nothing is written. Run by the installer through
// the command line (lfdln-panel adopt-folders), as the panel's own user.
import { logActivity } from '@panel/core/accounts';
import { all, one, run, tx, type Sql } from '@panel/core/pg';
import { addFolder, allFolders } from '@panel/files/site-folders/store';
import { ON_HOME } from './domains.ts';
import { folderName, hostName, NameError } from './names.ts';
import { tableFrom } from './panel/routes/hosts.ts';
import type { ServicePart, Table } from './render.ts';

export type Adopted = { adopted: string[]; shown: string[]; skipped: { name: string; why: string }[] };

// ports: where the site's services answer, for the service routes already in the table
export async function adoptFolders(db: Sql, o: { now: number; onDisk: string[]; actor: string; apply: (t: Table) => Promise<unknown>; ports?: ServicePart[] }): Promise<Adopted> {
  const out: Adopted = { adopted: [], shown: [], skipped: [] };
  const valid = (fn: () => string) => { try { return fn(); } catch (e) { if (e instanceof NameError) return e.message; throw e; } };
  await tx(db, async (q) => {
    const known = new Set((await allFolders(q)).map((r) => r.name));
    const hosts = new Set((await all<{ name: string }>(q, `SELECT name FROM hosts WHERE ${ON_HOME}`)).map((r) => r.name));
    const who = { id: null, label: o.actor };
    for (const name of [...o.onDisk].sort()) {
      if (known.has(name)) continue;
      const asFolder = name === 'media' ? '"media" is what a site folder\'s media folder is called (docs/phase8-plan.md P8-5)' : valid(() => folderName(name));
      if (asFolder !== name) { out.skipped.push({ name, why: asFolder }); continue; }
      const f = await addFolder(q, { name, runPhp: false, adopted: true, actor: o.actor, now: o.now });
      out.adopted.push(name);
      const asHost = valid(() => hostName(name));
      if (asHost !== name) {
        out.skipped.push({ name, why: `adopted, but shown nowhere: ${asHost}` });
        await logActivity(q, o.now, who, 'site-folder-adopted', name, 'on the server before the panel; not shown anywhere');
        continue;
      }
      if (hosts.has(name)) {
        out.skipped.push({ name, why: `adopted, but not shown: ${name} is already a host` });
        await logActivity(q, o.now, who, 'site-folder-adopted', name, 'on the server before the panel; its name is already a host');
        continue;
      }
      const h = (await one<{ id: number }>(q, "INSERT INTO hosts (name, origin, created_by, created_at) VALUES (?, 'folder', ?, ?) RETURNING id", name, o.actor, o.now))!;
      await run(q, `INSERT INTO routes (host_id, path, target_kind, target_ref, folder_id, created_by, created_at)
                    VALUES (?, '/', 'folder', '{"spa":false,"headers":[],"cacheForever":[]}', ?, ?, ?)`, h.id, f.id, o.actor, o.now);
      hosts.add(name);
      out.shown.push(name);
      await logActivity(q, o.now, who, 'site-folder-adopted', name, 'on the server before the panel; still shown at its own host');
    }
    // the whole table, even with nothing new: the first run writes the catch-all
    await o.apply(await tableFrom(q, o.ports ?? []));
  });
  return out;
}
