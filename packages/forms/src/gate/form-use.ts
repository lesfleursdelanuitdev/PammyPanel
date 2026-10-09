// What a form and a comment area ask of a request (docs/forms-plan.md): which
// page it is on, whether this visitor may use it there, and what the page is
// shown of it. The forms routes and the comments routes share one of these, so
// "Used on" is noted once an hour whichever of them a page asked.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { Item, StoredAnswer } from '../shared/form-types.ts';
import type { GateCtx } from '@panel/core/gate/context';
import { inScope } from './forms/items.ts';
import { formByName, recordFormPage, type Form } from './forms/store.ts';
import { decide, encodePath, pathOnHost, resolve, safeNext, type Resolved } from '@panel/areas/gate/policy';

// A form goes on any page: <pammy-form name="olivias-form">. Which page it is
// on is resolved like /check does, so a form on a page inside a protected
// folder can only be seen and used by people who may open that page.
export type PageTarget = { resolved: Resolved & { kind: 'ok' }; rel: string };
// How a service's page is named where a file's path would be (docs/phase8-plan.md 8-6)
export const ADDRESS = 'https://';
// The form a request is about, and who is sending: a form that is switched on,
// on a page this visitor may open.
export type FormUse = { form: Form; target: PageTarget | null; sender: { visitorId: number; username: string; name: string } | null };

export type FormPages = ReturnType<typeof formPages>;

export function formPages(ctx: GateCtx) {
  const { cfg, live, db, now, visitorOf } = ctx;
  // pages whose form was noted lately, so page views don't each cost a write
  const seenPages = new Map<string, number>();

  // host: on a site with routes (lfdln, docs/phase8-plan.md 8-5), the page is placed by the
  // route it is on -- a path in the site folder it shows, or a service's page (placedAt);
  // elsewhere by the base, as ever
  function pageTarget(base: string, page: unknown, host?: string): PageTarget | null {
    const hostPath = safeNext(page);
    if (!hostPath || hostPath.includes('#')) return null;
    let path: string;
    try { path = decodeURIComponent(hostPath.split('?')[0]!); } catch { return null; }
    if (host && live.siteRoutes) return placedAt(host, path);
    return fileTarget(`${base}${path}`);
  }
  // A page that is a file of the site, known by its path from the web root.
  function fileTarget(at: string): PageTarget | null {
    const r = resolve(live, cfg.publicRoot, at);
    if (r.kind !== 'ok' || !r.exists) return null;
    let root: string;
    try { root = realpathSync(cfg.publicRoot); } catch { return null; }
    const rel = relative(root, r.real).split(sep).join('/');
    return { resolved: r, rel: rel === '' ? '/' : rel };
  }
  // A page on a host with routes: a file in the site folder its route shows, or a page some
  // other route answers (a service's, docs/phase8-plan.md 8-6). That one has no file: it is
  // known by its address (rel "https://<host><path>", which no file's path can be), and only
  // its route's area protects it, as nginx's /check/<token> does -- so a form or a comment
  // area of one site folder is never used there (inScope), and one for signed-in people only
  // where the route has accounts.
  function placedAt(host: string, path: string): PageTarget | null {
    const place = live.siteRoutes!.placeOf(host, path);
    if (!place) return null;
    if (place.kind === 'folder') return fileTarget(`${place.base}${place.path}`);
    const { area: token } = place.route;
    const area = token ? live.byToken(token) : undefined;
    const protections = token ? [{ area: area?.kind === 'route' ? area : null, token, dir: '', rel: `/route`, exempt: false }] : [];
    return { resolved: { kind: 'ok', real: '', exists: false, protections }, rel: `${ADDRESS}${host}${path}` };
  }
  // Is a page some response was sent from one this visitor may open (comments shown on
  // another page of the same thread)? Found again from its rel, as it is now: a page whose
  // route has gone may be opened by nobody.
  function pageResolved(rel: string): Resolved {
    if (live.siteRoutes && rel.startsWith(ADDRESS)) {
      const at = rel.slice(ADDRESS.length);
      const slash = at.indexOf('/');
      const t = slash > 0 ? placedAt(at.slice(0, slash), at.slice(slash)) : null;
      return t ? t.resolved : { kind: 'unreadable' };
    }
    return resolve(live, cfg.publicRoot, `/${rel === '/' ? '' : rel}`);
  }

  const noForm = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'unavailable', message: "This form isn't available right now." });
  const signInAgain = (reply: FastifyReply) =>
    reply.code(401).send({ error: 'signed-out', message: 'Please reload the page and sign in again to use this form.' });
  const signInNeeded = (reply: FastifyReply) =>
    reply.code(403).send({ error: 'sign-in-needed', message: 'This form is only for people signed in to a private folder.' });

  // The form a request is about, and who is sending: a form that is switched on,
  // on a page this visitor may open.
  async function formUse(req: FastifyRequest, reply: FastifyReply, host: string, base: string, name: unknown, page: unknown): Promise<FormUse | null> {
    const form = await formByName(db, name);
    if (!form || form.trashedAt || !form.enabled) { void noForm(reply); return null; }
    const target = pageTarget(base, page, host);
    // a folder's form works only on that folder's pages (docs/media-plan.md D22),
    // by where the page really is, whatever address it was reached by
    if (form.scope !== '/' && !(target && inScope(form.scope, target.rel))) { void noForm(reply); return null; }
    const s = await visitorOf(req, host);
    let sender: FormUse['sender'] = null;
    if (target) {
      const d = decide(target.resolved, s);
      if (!d.allow) { void signInAgain(reply); return null; }
      if (d.protectedContent && s) sender = { visitorId: s.visitor.id, username: s.visitor.username, name: s.visitor.name };
    }
    if (form.settings.signedInOnly && !sender) { void signInNeeded(reply); return null; }
    return { form, target, sender };
  }

  // What the component needs. Hidden fields keep their fixed value here (the
  // page never sees it); a picture's address is turned into one this hostname serves.
  function publicItems(items: Item[], base: string): Item[] {
    return items.map((i) => {
      if (i.type === 'hidden') { const { value: _fixed, public: _p, ...rest } = i; return rest; }
      if (i.type === 'image' && i.src) {
        const onHost = pathOnHost(i.src, base);
        const { public: _p, ...rest } = i;
        return { ...rest, src: onHost === null ? `https://${cfg.domain}/${encodePath(i.src)}` : encodePath(onHost) };
      }
      const { public: _p, ...rest } = i;
      return rest;
    });
  }

  // Which pages show a form ("Used on" in the panel), noted at most once an hour each.
  function notePage(form: Form, target: PageTarget | null) {
    if (!target) return;
    const key = `${form.id}|${target.rel}`;
    const last = seenPages.get(key) ?? 0;
    if (now() - last < 3600) return;
    seenPages.set(key, now());
    if (seenPages.size > 5000) seenPages.clear();
    recordFormPage(db, now(), form.id, target.rel).catch(() => { /* not worth failing the page for */ });
  }

  return { pageTarget, pageResolved, noForm, formUse, publicItems, notePage };
}

// A response's answers, only the fields in allowed.
export const answersOut = (answers: StoredAnswer[], allowed: Set<string>) =>
  Object.fromEntries(answers.filter((a) => allowed.has(a.key)).map((a) => [a.key, a.value]));
