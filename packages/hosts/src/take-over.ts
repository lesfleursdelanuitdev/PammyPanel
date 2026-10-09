// Taking over a hand-written host (docs/adopt-plan.md V6), one at a time, run by
// lfdln's installer through the command line (`lfdln-panel take-over-host <name>`):
//   1. its requests (takeover.ts) sent to the live hand-written block -- twice, so
//      a page that is never the same twice (a Next.js page's ids) isn't compared by
//      its bytes;
//   2. in one transaction: its site folder, host and routes written down (adopted),
//      and the routing helper writing the panel's block and taking the hand-written
//      file's link out of sites-enabled, with one nginx -t;
//   3. the same requests again (once nginx's old workers have gone), every answer
//      compared; any difference, and the hand-written link is put back and the rows
//      taken out again, so the host is exactly as it was.
// The site folder itself is copied in by the installer first (as root).
import { logActivity } from '@panel/core/accounts';
import { one, run, tx, type Db, type Sql } from '@panel/core/pg';
import { addFolder, dropFolder, folderByName } from '@panel/files/site-folders/store';
import { tableFrom } from './panel/routes/hosts.ts';
import type { ServicePart, Table } from './render.ts';
import { compare, fullName, probe, TAKEOVERS, type Answer, type Takeover, type Where } from './takeover.ts';

export type LinkOp = { takeOver?: string; giveBack?: string };
export type TakeOverDeps = {
  now: number;
  actor: string;
  where: Where;                                   // nginx on this machine: 127.0.0.1, 80 and 443
  ports: ServicePart[];
  apply: (t: Table, link: LinkOp) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  takeovers?: Takeover[];                         // (the tests: one made to differ)
};
export type TakenOver = { name: string; state: 'taken-over' | 'already' | 'given-back'; answers: number; differences: string[] };

type Probed = { what: string; answer: Answer | string }[];
// a body that differed between two sends before anything changed isn't compared
const unstable = (a: Probed, b: Probed) => new Set(a.map((x, i) => (JSON.stringify(x.answer) !== JSON.stringify(b[i]?.answer) ? i : -1)).filter((i) => i >= 0));
const withoutBodies = (p: Probed, skip: Set<number>) => p.map((x, i) => (skip.has(i) && typeof x.answer === 'object' ? { ...x, answer: { ...x.answer, body: null } } : x));

// name: the host as the table names it (a label, on the site's own domain), or its full
// name ("admin.gonsalvesfamily.com", "gonsalvesfamily.com"; docs/domains-hosts-plan.md step 7)
export async function takeOverHost(db: Sql, name: string, d: TakeOverDeps): Promise<TakenOver> {
  const list = d.takeovers ?? TAKEOVERS;
  const t = list.find((x) => fullName(x, d.where.domain) === name || (!x.domain && x.name === name));
  if (!t) throw new Error(`${name} isn't one the panel takes over (${list.map((x) => fullName(x, d.where.domain)).join(', ')})`);
  const log = d.log ?? (() => {});
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const shown = fullName(t, d.where.domain);
  // its domain's row: the home one, or the other one it is on (added first, through the guide)
  const dom = await one<{ id: number }>(db, t.domain ? 'SELECT id FROM domains WHERE name = ?' : 'SELECT id FROM domains WHERE home', ...(t.domain ? [t.domain] : []));
  if (t.domain && !dom) throw new Error(`${t.domain} isn't a domain in the panel yet: add it first (Hosts > Add a domain)`);
  const onIt = dom ? 'domain_id = ?' : 'domain_id IS NULL';
  const onArgs = dom ? [dom.id] : [];
  if (await one(db, `SELECT 1 FROM hosts WHERE name = ? AND ${onIt} AND adopted`, t.name, ...onArgs)) return { name: shown, state: 'already', answers: 0, differences: [] };
  if (await one(db, `SELECT 1 FROM hosts WHERE name = ? AND ${onIt}`, t.name, ...onArgs)) throw new Error(`${shown} is already a host made in the panel: nothing to take over`);
  const opts = { harness: false, folderDir: t.folder?.from ?? t.probeDir ?? null };

  // 1. before
  const b1 = await probe(t, d.where, opts);
  const noAnswer = b1.filter((x) => typeof x.answer === 'string');
  if (noAnswer.length) throw new Error(`the hand-written ${t.link} doesn't answer everything, so there is nothing to compare with: ${noAnswer.map((x) => `${x.what}: ${x.answer}`).join('; ')}`);
  const b2 = await probe(t, d.where, opts);
  const skip = unstable(b1, b2);
  const before = withoutBodies(b1, skip);
  log(`asked ${b1.length} things of the hand-written ${t.link}${skip.size ? ` (${skip.size} never the same twice: not compared by their bytes)` : ''}`);

  // 2. the switch
  const rows = async (q: Db) => {
    let folderId: number | null = null;
    if (t.folder) {
      folderId = (await folderByName(q, t.folder.name))?.id
        ?? (await addFolder(q, { name: t.folder.name, runPhp: t.folder.runPhp, adopted: true, actor: d.actor, now: d.now })).id;
    }
    const h = (await one<{ id: number }>(q, "INSERT INTO hosts (name, with_www, adopted, origin, domain_id, created_by, created_at) VALUES (?, ?, true, 'adopted', ?, ?, ?) RETURNING id",
      t.name, t.host.withWww === true, dom?.id ?? null, d.actor, d.now))!;
    // each route as the table names it: its kind, and that kind's fields as target_ref
    // (docs/domains-hosts-plan.md step 2); a site folder route's folder in folder_id
    for (const r of t.routes) {
      const { host: _h, domain: _d, path, enabled: _e, accounts: _a, kind, folder: _f, ...ref } = r;
      await run(q, 'INSERT INTO routes (host_id, path, target_kind, target_ref, folder_id, created_by, created_at) VALUES (?, ?, ?, ?::text::jsonb, ?, ?, ?)',
        h.id, path, kind, JSON.stringify(ref), kind === 'folder' ? folderId : null, d.actor, d.now);
    }
    await logActivity(q, d.now, { id: null, label: d.actor }, 'host-taken-over', shown,
      `from sites-enabled/${t.link}${t.folder ? `; its files now in the site folder ${t.folder.name}` : ''}`);
  };
  await tx(db, async (q) => {
    await rows(q);
    await d.apply(await tableFrom(q, d.ports), { takeOver: t.link });
  });

  // 3. after: until nginx's old workers have gone, then every answer compared
  let differences: string[] = [];
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    differences = compare(before, withoutBodies(await probe(t, d.where, opts), skip));
    if (!differences.length) break;
  }
  if (!differences.length) return { name: shown, state: 'taken-over', answers: before.length, differences };

  // given back: the rows out again, the hand-written link back, one nginx -t
  log(`the panel's ${shown} answered differently, so the hand-written ${t.link} goes back:\n  ${differences.join('\n  ')}`);
  await tx(db, async (q) => {
    await run(q, `DELETE FROM hosts WHERE name = ? AND ${onIt}`, t.name, ...onArgs);     // (its routes with it)
    // its folder too, unless a route still shows it
    const f = t.folder ? await folderByName(q, t.folder.name) : undefined;
    if (f && !await one(q, 'SELECT 1 FROM routes WHERE folder_id = ?', f.id)) await dropFolder(q, f.id);
    await logActivity(q, d.now, { id: null, label: d.actor }, 'host-given-back', shown, `${differences.length} answer(s) differed`);
    await d.apply(await tableFrom(q, d.ports), { giveBack: t.link });
  });
  // ...and it answers as it did before, once nginx's old workers have gone
  let still: string[] = [];
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    still = compare(before, withoutBodies(await probe(t, d.where, opts), skip));
    if (!still.length) break;
  }
  if (still.length) log(`after giving it back, ${shown} still doesn't answer as it did before:\n  ${still.join('\n  ')}`);
  return { name: shown, state: 'given-back', answers: before.length, differences };
}
