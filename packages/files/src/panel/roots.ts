// File Explorer's roots (docs/catalog-plan.md step 3, S3-1): the folders it can show,
// each reached through its own helper. The website is one (catalogued: its files have
// records, labels and thumbnails); each installed piece of software is another, its
// wp-content/ only, through pammy-rootfs@<id> running as the software's own user (not
// catalogued: File Explorer lists it straight from the helper).
//
// Who sees a software root: anyone with the files right who isn't kept to places, and a
// person kept to places who was given it ("software:blog", step 3b). A person kept only to
// software places doesn't see the website.
import { AccountError } from '@panel/core/accounts';
import type { Readable } from 'node:stream';
import { CallError } from '@panel/core/jsonline';
import { isOn } from '@panel/core/profile';
import { HELPER_STATUS, type PanelCtx } from '@panel/core/panel/context';
import { isAdmin, isKept, softwareOfPlaces, websitePlaces } from '@panel/core/panel/rights';
import type { Authed } from '@panel/core/sessions';
import { callSiteFs, readFromSiteFs, uploadToSiteFs } from '../sitefs/client.ts';

export type RootKind = 'website' | 'software';
export type Root = {
  id: string;           // "website", "software-blog"
  label: string;        // "Website", "blog (WordPress)"
  kind: RootKind;
  catalogued: boolean;  // records, labels, thumbnails (the website only, for now)
  socket: string;
};

export const WEBSITE = 'website';
const SOFTWARE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const softwareRoot = (id: string) => `software-${id}`;

// What Activity says a file of a software root is: "blog: wp-content/themes/x/style.css"
// (the website's files are named by their path, as ever).
export const rootTarget = (r: Root, path: string) => (r.kind === 'website' ? path : `${r.id.replace(/^software-/, '')}: wp-content${path ? `/${path}` : ''}`);

type SoftwareSummary = { id: string; kindName: string; setup: unknown; deleted: unknown };

// The helper's refusal, in the status the panel answers with (as ctx.helper does).
const refused = (e: unknown): never => {
  if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
  throw e;
};

export function roots(ctx: PanelCtx) {
  const website: Root = { id: WEBSITE, label: 'Website', kind: 'website', catalogued: true, socket: ctx.config.sitefsSocket };
  const socketOf = (id: string) => (ctx.config.rootfsSockets ?? '/run/pammy-rootfs-{id}.sock').replace('{id}', id);

  // Installed software (not mid-install, not deleted): the software helper's list.
  // No apps module, or the helper not answering: none (File Explorer still shows the website).
  async function software(): Promise<Root[]> {
    if (!isOn(ctx.config.site, 'apps')) return [];
    let list: { apps: SoftwareSummary[] };
    try { list = await ctx.software<{ apps: SoftwareSummary[] }>({ op: 'list', actor: 'files' }); } catch { return []; }
    return list.apps
      .filter((s) => s.setup === null && s.deleted === null && SOFTWARE_ID_RE.test(s.id))
      .map((s) => ({ id: softwareRoot(s.id), label: `${s.id} (${s.kindName})`, kind: 'software' as const, catalogued: false, socket: socketOf(s.id) }));
  }

  async function visible(a: Authed): Promise<Root[]> {
    if (!isKept(a.user)) return [website, ...await software()];
    const given = new Set(softwareOfPlaces(a.user).map(softwareRoot));
    const mine = given.size ? (await software()).filter((r) => given.has(r.id)) : [];
    return [...(websitePlaces(a.user).length ? [website] : []), ...mine];
  }

  // The root a request names (none: the website, so every address from before step 3
  // answers as it did). One they can't see is "not found".
  async function pick(a: Authed, v: unknown): Promise<Root> {
    if (v === undefined || v === null || v === '' || v === WEBSITE) {
      if (isKept(a.user) && !websitePlaces(a.user).length) throw new AccountError('Not found.', 404);
      return website;
    }
    if (typeof v !== 'string') throw new AccountError('Not found.', 404);
    const r = (await visible(a)).find((x) => x.id === v && x.kind === 'software');
    if (!r) throw new AccountError('Not found.', 404);
    return r;
  }

  // Asking a root's helper. A software root is told whether the person is a panel admin
  // (Q3-2: only they may write code there); the website's helper never needs it.
  const extra = (r: Root, a: Authed | null) => (r.kind === 'software' && a && isAdmin(a.user) ? { code: true } : {});
  return {
    website, visible, pick,
    call: async <T>(r: Root, a: Authed | null, req: Record<string, unknown>, timeoutMs?: number): Promise<T> => {
      if (r.kind === 'website' && timeoutMs === undefined) return ctx.helper<T>(req);
      try { return await callSiteFs<T>(r.socket, { ...req, ...extra(r, a) }, timeoutMs); } catch (e) { return refused(e); }
    },
    // as call, but a refusal stays the helper's CallError (the editor answers a conflict itself)
    callRaw: <T>(r: Root, a: Authed | null, req: Record<string, unknown>, timeoutMs?: number) => callSiteFs<T>(r.socket, { ...req, ...extra(r, a) }, timeoutMs),
    read: <T>(r: Root, a: Authed | null, req: Record<string, unknown>) => readFromSiteFs<T>(r.socket, { ...req, ...extra(r, a) }),
    upload: <T>(r: Root, a: Authed | null, req: Record<string, unknown>, body: Readable) => uploadToSiteFs<T>(r.socket, { ...req, ...extra(r, a) }, body),
  };
}
export type Roots = ReturnType<typeof roots>;
