// pammy.org onto its hosts (docs/phase8-plan.md 8-7c): the pamela site out of sites-enabled and
// pammy-hosts in, in one nginx -t, the way lfdln's hand-written hosts were taken over
// (packages/hosts/src/take-over.ts):
//   1. everything asked of the live pamela site, twice (a page that is never the same twice --
//      WordPress's -- isn't compared by its bytes): every top-level file and folder of her
//      website and what is directly inside each folder, on pammy.org, www and the folder's own
//      <folder>.pammy.org, protected ones included (their sign-in redirects), the 404s, the
//      gate's own addresses, /api/, the blog, a name no host has;
//   2. the switch: the rows are there already (hosts-seed), so only the links change;
//   3. the same asked again once nginx's old workers have gone; any difference, and the pamela
//      link is back (and pammy-hosts' out), one nginx -t, and it is asked once more.
import { existsSync, lstatSync } from 'node:fs';
import { logActivity } from '@panel/core/accounts';
import { tx, type Sql } from '@panel/core/pg';
import { LABEL_RE } from '@panel/hosts/names';
import { compare, probe, type Answer, type Check, type Takeover, type Where } from '@panel/hosts/takeover';
import type { Table } from '@panel/hosts/render';
import { pammyTable, type Install } from './nginx-hosts.ts';

export type Listing = { buckets: { name: string }[]; files: { name: string }[] };
export type SwitchDeps = {
  now: number;
  actor: string;
  where: Where;                                   // nginx on this machine: 127.0.0.1, 80 and 443, pammy.org
  list: (dir: string) => Promise<Listing>;       // the folder helper's files-list
  installs: Install[];
  apply: (t: Table, link: { takeOver?: string; giveBack?: string }) => Promise<unknown>;
  sitesEnabled?: string;                          // /etc/nginx/sites-enabled (the tests: their own)
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};
export type Switched = { state: 'switched' | 'already' | 'given-back'; answers: number; differences: string[] };

const seg = (s: string) => encodeURIComponent(s);
const PER_FOLDER = 25;          // what is directly inside a folder: this many of each

// Everything asked, as takeover.ts's hosts: pammy.org (and www), each folder's own name, the blog's.
export async function questions(d: Pick<SwitchDeps, 'list' | 'installs'>): Promise<Takeover[]> {
  const top = await d.list('');
  const folders = top.buckets.map((b) => b.name).sort();
  const apex: Check[] = [];
  const both = (c: Check) => { apex.push(c, { ...c, www: true }); };
  for (const p of ['/', '/index.html', '/404.html', '/zz-no-such-page', '/zz-no-such-folder/', '/.env', '/api/', '/_pammy/login.js', '/_pammy/me', '/_pammy/check', '/media/photos/', '/xmlrpc.php']) both({ path: p });
  apex.push({ path: '/', http: true }, { path: '/zz-no-such-page', http: true });
  for (const f of top.files) both({ path: `/${seg(f.name)}` });
  const hosts: Takeover[] = [];
  for (const name of folders) {
    const inside = await d.list(name).catch(() => ({ buckets: [], files: [] } as Listing));
    const paths = [
      '/', '/zz-no-such-page', '/zz-no-such-folder/',
      ...inside.files.slice(0, PER_FOLDER).map((f) => `/${seg(f.name)}`),
      ...inside.buckets.slice(0, PER_FOLDER).map((b) => `/${seg(b.name)}/`),
    ];
    both({ path: `/${seg(name)}` });
    for (const p of paths) both({ path: `/${seg(name)}${p}` });
    // its own name, where it is one (a folder with a name no DNS label can have has none)
    if (LABEL_RE.test(name) && name !== 'www' && name !== 'api') {
      hosts.push({ name, link: 'pamela', host: { name, enabled: true }, routes: [], checks: () => paths.map((path) => ({ path })) });
    }
  }
  // the software on names of their own (the blog)
  for (const a of d.installs) {
    if (a.deleted || a.placement?.mode !== 'subdomain' || !a.placement.name || folders.includes(a.placement.name)) continue;
    hosts.push({ name: a.placement.name, link: 'pamela', host: { name: a.placement.name, enabled: true }, routes: [],
      checks: () => ['/', '/xmlrpc.php', '/.env', '/wp-login.php'].map((path) => ({ path })) });
  }
  // a name no host has, and no folder
  hosts.push({ name: 'zz-no-such-folder', link: 'pamela', host: { name: 'zz-no-such-folder', enabled: true }, routes: [], checks: () => [{ path: '/' }] });
  return [{ name: '@', link: 'pamela', host: { name: '@', enabled: true, withWww: true }, routes: [], checks: () => apex }, ...hosts];
}

type Probed = { what: string; answer: Answer | string }[];
const ask = async (list: Takeover[], w: Where): Promise<Probed> => {
  const out: Probed = [];
  for (const t of list) out.push(...await probe(t, w, { harness: false, folderDir: null }));
  return out;
};
const unstable = (a: Probed, b: Probed) => new Set(a.map((x, i) => (JSON.stringify(x.answer) !== JSON.stringify(b[i]?.answer) ? i : -1)).filter((i) => i >= 0));
const withoutBodies = (p: Probed, skip: Set<number>) => p.map((x, i) => (skip.has(i) && typeof x.answer === 'object' ? { ...x, answer: { ...x.answer, body: null } } : x));
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

export async function switchToHosts(db: Sql, d: SwitchDeps): Promise<Switched> {
  const log = d.log ?? (() => {});
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const en = d.sitesEnabled ?? '/etc/nginx/sites-enabled';
  if (!isLink(`${en}/pamela`) && isLink(`${en}/pammy-hosts`)) return { state: 'already', answers: 0, differences: [] };
  if (!isLink(`${en}/pamela`)) throw new Error(`sites-enabled/pamela isn't there, and neither is pammy-hosts: nginx isn't serving pammy.org the way the switch expects`);
  if (existsSync(`${en}/pammy-hosts`)) throw new Error('sites-enabled/pammy-hosts is there beside pamela: take it out first');
  const list = await questions(d);

  // 1. before
  const b1 = await ask(list, d.where);
  const noAnswer = b1.filter((x) => typeof x.answer === 'string');
  if (noAnswer.length) throw new Error(`the pamela site doesn't answer everything, so there is nothing to compare with: ${noAnswer.slice(0, 5).map((x) => `${x.what}: ${x.answer}`).join('; ')}`);
  const b2 = await ask(list, d.where);
  const skip = unstable(b1, b2);
  const before = withoutBodies(b1, skip);
  log(`asked ${b1.length} things of the pamela site${skip.size ? ` (${skip.size} never the same twice: not compared by their bytes)` : ''}`);

  // 2. the switch: the rows as they are, the links in one nginx -t
  await tx(db, async (q) => {
    await logActivity(q, d.now, { id: null, label: d.actor }, 'host-taken-over', 'pammy.org', 'from sites-enabled/pamela: pammy.org and its folder subdomains now from the hosts rows');
    await d.apply(await pammyTable(q), { takeOver: 'pamela' });
  });

  // 3. after: until nginx's old workers have gone, then every answer compared
  let differences: string[] = [];
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    differences = compare(before, withoutBodies(await ask(list, d.where), skip));
    if (!differences.length) break;
  }
  if (!differences.length) return { state: 'switched', answers: before.length, differences };

  log(`pammy.org answered differently from its hosts, so the pamela site goes back:\n  ${differences.slice(0, 30).join('\n  ')}`);
  await tx(db, async (q) => {
    await logActivity(q, d.now, { id: null, label: d.actor }, 'host-given-back', 'pammy.org', `${differences.length} answer(s) differed`);
    await d.apply(await pammyTable(q), { giveBack: 'pamela' });
  });
  let still: string[] = [];
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    still = compare(before, withoutBodies(await ask(list, d.where), skip));
    if (!still.length) break;
  }
  if (still.length) log(`after giving it back, pammy.org still doesn't answer as it did before:\n  ${still.slice(0, 30).join('\n  ')}`);
  return { state: 'given-back', answers: before.length, differences };
}

// Back by hand (`pammy-panel switch-back`): the pamela site in, pammy-hosts out, one nginx -t.
export async function switchBack(db: Sql, d: Pick<SwitchDeps, 'now' | 'actor' | 'apply'>) {
  await tx(db, async (q) => {
    await logActivity(q, d.now, { id: null, label: d.actor }, 'host-given-back', 'pammy.org', 'by hand: the pamela site serves pammy.org again');
    await d.apply(await pammyTable(q), { giveBack: 'pamela' });
  });
}
