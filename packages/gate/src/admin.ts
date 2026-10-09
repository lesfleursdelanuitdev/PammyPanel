// The gate's admin socket (/run/pammy-gate-admin.sock on pammy.org, /run/lfdln-gate-admin.sock
// on lfdln; only the panel's user may open it): how the panel manages protected
// folders and the people who can open them. Every value is checked here, whatever
// the panel checked. What belongs to a module the site has switched off is refused.
import { noticesSince } from '@panel/forms/gate/notices';
import { lstatSync } from 'node:fs';
import type { Server } from 'node:net';
import { join } from 'node:path';
import { all, isPgUnavailable, pgCode, type Db } from '@panel/core/pg';
import { createJsonLineServer, type JsonRequest } from '@panel/core/jsonline';
import type { GateLive } from '@panel/core/gate/live';
import {
  createAppKey, dropCatalog, listAppKeys, pushCatalog, renameAppKeyGrants, revokeAppKey, takeTouches, putRecordLabels, keepRecordLabels,
} from '@panel/studio/gate/studio';
import {
  EXAMPLES, examplesState, exampleForHer, isExampleKind, isStarter, resetExample, STARTERS,
} from '@panel/examples/gate/examples';
import { createApiKey, listApiKeys, revokeApiKey } from '@panel/api-keys/gate/forms/api-keys';
import { cleanScope } from '@panel/forms/gate/forms/items';
import {
  accessState, copySet, deleteGroup, deleteResource, deleteRole, readManifest, resetSet, saveGroup, saveResource, saveRole,
  setNeverTogether, setPersonRole, setSignedInRole,
} from '@panel/areas/gate/access';
import {
  formsState, hideUnreviewed, listResponses, markAllRead, responseScope, restoreResponse, setResponseApproved, setResponseRead, trashResponse, unreviewedAutoCount,
} from '@panel/forms/gate/forms/responses';
import {
  createForm, duplicateForm, formById, needForm, restoreForm, saveForm, setFormScope, setFormSwitches, suggestCopyName, summary, trashForm,
} from '@panel/forms/gate/forms/store';
import { resetExampleComments } from '@panel/forms/gate/forms/threads';
import { PAGES } from '@panel/areas/gate/policy';
import { deletionTold, listDeletions } from '@panel/areas/gate/deletions';
import { setRouteArea } from '@panel/areas/gate/route-areas';
import { dropLink, linksForDatabase, linkState, saveLink } from '@panel/form-links/gate/saves/links';
import { saveEarlier, saveResponse } from '@panel/form-links/gate/saves/save';

const socketOf = (cfg: AdminConfig) => cfg.pammydbSocket ?? '';
import {
  createArea, deleteArea, deleteRequest, moveArea, resolveRequest, setMember, setRequestsOpen, type Area, type Request,
} from '@panel/core/gate/store';
import {
  createVisitor, deleteVisitor, renameVisitor, setVisitorActive, setVisitorContact, setVisitorPassword, visitorById, type Visitor,
} from '@panel/people/gate/visitors';
import { cancelLinks, createLink, makeEmailedLink } from '@panel/people/gate/links';
import { revokeVisitorSessions } from '@panel/people/gate/sessions';
import { cleanBy, GateError } from '@panel/core/gate/ops';
import type { VisitorMail, VisitorMailer } from '@panel/core/gate/context';
import { readVisitorSettings } from '@panel/core/gate/visitor-settings';
import { setVisitorSwitch } from '@panel/people/gate/visitor-settings';
import { gateHousekeeping } from './housekeeping.ts';
import { appPath } from '@panel/core/paths';
import { MODULES, type Module } from '@panel/core/profile';

// Where setup links point. publicRoot null (tests without a website): always the built-in page.
// examplesDir: public-gate/examples, the worked examples' own files, which "Put this
// on my website" copies for her. It sits beside the code, so the default is right.
// pammydbSocket: the database helper, for forms that save into a database
// (docs/form-to-database-plan.md).
// modules: the site's (its profile's); every module when not given.
// visitorMail: the gate's door to the mail service (docs/accounts-plan.md step 4), for
// the emails an owner sends from People; none: emailed links can't be turned on.
export type AdminConfig = { publicRoot: string | null; domain: string; examplesDir?: string; pammydbSocket?: string; modules?: readonly Module[]; visitorMail?: VisitorMailer | null };
const EXAMPLES_DIR = `${appPath('public-gate', 'examples')}/`;

// The module each request belongs to; the rest (state, housekeeping, notices) every gate answers.
function moduleOf(op: string): Module | null {
  if (op === 'state' || op === 'housekeeping' || op === 'notices.since') return null;
  if (op.startsWith('request.')) return 'requests';
  if (op === 'starters' || op.startsWith('forms.') || op.startsWith('form.') || op.startsWith('responses.') || op.startsWith('response.')) return 'forms';
  // (the blog example's comment area is the examples', not every site's with comments: 8-6)
  if (op.startsWith('examples.') || op.startsWith('example.') || op === 'comments.example') return 'examples';
  if (op.startsWith('formlink')) return 'form-links';
  if (op.startsWith('comments.')) return 'comments';
  if (op.startsWith('apikey')) return 'api-keys';
  if (op.startsWith('catalog.') || op.startsWith('appkey')) return 'studio';
  // protected folders, people, roles, setup links and the visitor switches
  return 'areas';
}

async function state(db: Db, now: number) {
  const areas = await all<Area>(db, 'SELECT * FROM areas ORDER BY path');
  const visitors = await all<Visitor>(db, 'SELECT * FROM visitors ORDER BY username');
  // who may open each area's pages: a role given there with pages.read (the
  // "signed in, no role given" slot is everyone, not a list: the Access page, step 4)
  const grants = await all<{ visitor_id: number; area_id: number }>(db,
    "SELECT m.visitor_id, m.area_id FROM memberships m JOIN role_all_privileges p ON p.role_id = m.role_id AND p.privilege = 'pages.read'");
  const lastLogin = new Map((await all<{ visitor_id: number; at: number }>(db, "SELECT visitor_id, max(at) AS at FROM events WHERE event IN ('login', 'link-used', 'email-confirmed', 'password-reset') GROUP BY visitor_id")).map((r) => [r.visitor_id, r.at]));
  const sessions = new Map((await all<{ visitor_id: number; n: number }>(db, 'SELECT visitor_id, count(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ? GROUP BY visitor_id', now)).map((r) => [r.visitor_id, r.n]));
  const failed = new Map((await all<{ username: string; n: number }>(db, "SELECT username, count(*) AS n FROM events WHERE event = 'login-failed' AND at > ? GROUP BY username", now - 86400)).map((r) => [r.username, r.n]));
  // every open request, plus what was dealt with in the last 30 days
  const requests = await all<Request>(db, "SELECT * FROM requests WHERE status = 'open' OR handled_at > ? ORDER BY created_at DESC LIMIT 500", now - 30 * 86400);
  const links = new Map((await all<{ visitor_id: number; expires_at: number }>(db,
    "SELECT DISTINCT ON (visitor_id) visitor_id, expires_at FROM links WHERE purpose = 'setup' AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY visitor_id, id DESC", now))
    .map((l) => [l.visitor_id, l.expires_at]));
  return {
    // a route's area (step 5) is in the list too: kind says which, label is its address
    areas: areas.map((a) => ({
      id: a.id, token: a.token, path: a.path, createdAt: a.created_at, requestsOpen: a.requests_open === 1,
      kind: a.kind ?? 'folder', routeId: a.route_id ?? null, label: a.label ?? null,
      visitors: grants.filter((g) => g.area_id === a.id).map((g) => g.visitor_id),
    })),
    visitors: visitors.map((v) => ({
      id: v.id, username: v.username, name: v.name, contact: v.contact, active: v.active === 1, hasPassword: v.password_hash !== '',
      createdAt: v.created_at, passwordChangedAt: v.password_changed_at, lastLoginAt: lastLogin.get(v.id) ?? null,
      sessions: sessions.get(v.id) ?? 0, failedLast24h: failed.get(v.username) ?? 0,
      linkExpiresAt: links.get(v.id) ?? null,
      areas: grants.filter((g) => g.visitor_id === v.id).map((g) => g.area_id),
      // accounts people made themselves (docs/accounts-plan.md step 4)
      email: v.email, emailConfirmed: v.email_confirmed_at !== null, registered: v.registered,
    })),
    requests: requests.map((r) => ({
      id: r.id, kind: r.kind, areaId: r.area_id, visitorId: r.visitor_id, name: r.name, contact: r.contact, message: r.message,
      createdAt: r.created_at, status: r.status, handledAt: r.handled_at, handledBy: r.handled_by,
    })),
  };
}

const publicVisitor = (v: Visitor) => ({ id: v.id, username: v.username, name: v.name, active: v.active === 1, hasPassword: v.password_hash !== '' });

// Where an emailed link sent from the panel points: the hostname they last used
// with this site's gate (registered, signed in), else the domain itself.
async function hostFor(db: Db, cfg: AdminConfig, visitorId: number): Promise<string> {
  const r = await all<{ host: string }>(db, 'SELECT host FROM events WHERE visitor_id = ? AND host IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1', visitorId);
  const h = r[0]?.host ?? '';
  return h === cfg.domain || h.endsWith(`.${cfg.domain}`) ? h : accountsHost(db, cfg);
}

// Where a link goes when the person hasn't been anywhere yet. pammy.org: the domain, where
// /_pammy/ is everywhere. A site with hosts (lfdln) has the sign-in pages only on the
// addresses open with accounts (docs/roles-plan.md step 5), so one of those: the domain
// itself would answer 404.
async function accountsHost(db: Db, cfg: AdminConfig): Promise<string> {
  if (!cfg.modules?.includes('hosts')) return cfg.domain;
  const r = await all<{ label: string }>(db, "SELECT label FROM areas WHERE kind = 'route' AND label IS NOT NULL ORDER BY id LIMIT 1");
  const h = (r[0]?.label ?? '').split('/')[0]!;
  return h === cfg.domain || h.endsWith(`.${cfg.domain}`) ? h : cfg.domain;
}

// An email to someone, sent for an owner from People. The owner hears what went wrong.
async function mailFor(cfg: AdminConfig, m: VisitorMail) {
  if (!cfg.visitorMail) throw new GateError('invalid', "This site's gate can't send email.");
  try {
    await cfg.visitorMail(m);
  } catch (e) {
    throw new GateError((e as { code?: unknown }).code === 'full' ? 'full' : 'unavailable', `The email wasn't sent: ${(e as Error).message}`);
  }
}

// Owners never see or choose the password of an account someone made themselves
// (docs/accounts-plan.md, "In the panel"): they can send it a reset link instead.
async function notRegistered(db: Db, id: unknown) {
  const v = await visitorById(db, id);
  if (v?.registered) throw new GateError('invalid', `${v.username} made their own account: send them a reset link instead.`);
}

// The folder's own login-invite.html on pammy.org if it has one, else the built-in
// page. The token goes in the #fragment, so it never reaches Cloudflare or any log.
async function linkUrl(db: Db, cfg: AdminConfig, area: Area | null, token: string): Promise<string> {
  if (area && cfg.publicRoot) {
    let own = false;
    try { own = lstatSync(join(cfg.publicRoot, area.path, PAGES.invite)).isFile(); } catch { /* none */ }
    if (own) return `https://${cfg.domain}/${area.path.split('/').map(encodeURIComponent).join('/')}/${PAGES.invite}#${token}`;
  }
  // a route's area: its own address; else where the sign-in pages are
  const host = area?.kind === 'route' && area.label ? area.label.split('/')[0]! : await accountsHost(db, cfg);
  return `https://${host}/_pammy/invite#${token}`;
}

// A person kept to places (docs/media-plan.md D22-D24, docs/permissions-plan.md
// R5) only ever reaches forms and responses: the panel sends their places with
// each request, and anything in none of them is answered as not there.
// Everything else is refused outright.
const SCOPED_OPS = new Set([
  'forms.state', 'form.get', 'form.create', 'form.save', 'form.duplicate', 'form.copy-name', 'form.switches', 'form.hide-unreviewed',
  'form.trash', 'form.restore', 'starters', 'responses.list', 'response.read', 'responses.read-all', 'response.trash', 'response.restore', 'response.approve',
  'response.save-again',
]);

// What changes an area, a visitor, who may open what or what visitors may do for
// themselves: the gate's memory of areas, settings and sessions (live.ts) is
// cleared after each, before the panel hears it's done.
const changesMemory = (op: string) => op.startsWith('area.') || op.startsWith('visitor.') || op === 'grant' || op === 'visitor-settings.set' || op === 'route-area.set'
  || (op.startsWith('access.') && op !== 'access.state');

export async function handleAdmin(g: GateLive, now: number, req: JsonRequest, cfg: AdminConfig): Promise<unknown> {
  const m = moduleOf(req.op);
  if (m && !(cfg.modules ?? MODULES).includes(m)) throw new GateError('invalid', 'Unknown request.');
  if (!g.ready) throw unreachable();
  try {
    return await run(g.db, now, req, cfg);
  } catch (e) {
    // jsonline.ts sends any error with a code as a refusal, message and all, and
    // Postgres errors have codes: only ours may reach the panel.
    if (isPgUnavailable(e)) throw unreachable();
    if (pgCode(e)) throw new Error(`database error ${pgCode(e)}: ${(e as Error).message}`, { cause: e });
    throw e;
  } finally {
    // also after a failure: part of a change may have happened before it
    if (changesMemory(req.op)) await g.changed({ visitor: oneVisitor(req) });
  }
}

// A change to one visitor only (review P2): their own record, or their role in one area.
// Only their sessions are forgotten; anything else (a new visitor, areas, roles, the
// switches) forgets everyone's, as before.
function oneVisitor(req: JsonRequest): number | undefined {
  const id = req.op.startsWith('visitor.') && req.op !== 'visitor.create' ? req.id
    : req.op === 'grant' || req.op === 'access.person' ? req.visitorId : undefined;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined;
}

// The places the panel sent, each checked; none, or not sent: the whole site.
function placesOf(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length === 0) throw new GateError('invalid', 'Not found.');
  return v.map((p) => {
    const sc = cleanScope(p);
    if (sc === '/') throw new GateError('invalid', 'Not found.');   // a place is a folder, never the whole site
    return sc;
  });
}

const unreachable = () => new GateError('unavailable', "The gate's database isn't reachable at the moment. Please try again in a minute.");

async function run(db: Db, now: number, req: JsonRequest, cfg: AdminConfig): Promise<unknown> {
  // The one folder the panel sent before places (docs/permissions-plan.md step 2).
  // Nothing sends it now; one that still did would get the whole site's answer
  // if it were ignored, so it is refused.
  if ('scope' in req) throw new GateError('invalid', 'Not found.');
  const limit = placesOf(req.places);
  if (limit !== null) {
    if (!SCOPED_OPS.has(req.op)) throw new GateError('not-found', 'Not found.');
    const formIn = async (id: unknown) => {
      const f = await formById(db, id);
      if (!f || !limit.includes(f.scope)) throw new GateError('not-found', 'That form no longer exists.');
    };
    if (req.op.startsWith('form.') && req.op !== 'form.create') await formIn(req.id);
    if (req.op === 'form.create' && !limit.includes(cleanScope(req.formScope))) throw new GateError('not-found', 'Not found.');
    if ((req.op === 'responses.list' || req.op === 'responses.read-all') && req.formId !== undefined && req.formId !== null) await formIn(req.formId);
    if (req.op.startsWith('response.')) {
      const sc = await responseScope(db, req.id);
      if (!sc || !limit.includes(sc)) throw new GateError('not-found', 'That response is no longer there.');
    }
  }
  switch (req.op) {
    case 'state': return state(db, now);
    case 'area.create': { const a = await createArea(db, now, req.path); return { id: a.id, token: a.token, path: a.path }; }
    case 'area.move': { const a = await moveArea(db, req.id, req.path); return { id: a.id, path: a.path }; }
    case 'area.requests': { const a = await setRequestsOpen(db, req.id, req.open); return { id: a.id, requestsOpen: a.requests_open === 1 }; }
    case 'area.delete': await deleteArea(db, req.id); return { ok: true };
    // accounts on a route (docs/roles-plan.md step 5): the hosts module asks
    case 'route-area.set': return setRouteArea(db, now, req.routeId, req.accounts ?? null, req.address);
    case 'visitor.create': return publicVisitor(await createVisitor(db, now, req.username, req.name, req.password, req.contact));
    case 'visitor.rename': return publicVisitor(await renameVisitor(db, req.id, req.name));
    case 'visitor.contact': return publicVisitor(await setVisitorContact(db, req.id, req.contact));
    case 'visitor.password': await notRegistered(db, req.id); return publicVisitor(await setVisitorPassword(db, now, req.id, req.password));
    case 'visitor.active': return publicVisitor(await setVisitorActive(db, now, req.id, req.active));
    // accounts deleted, for the panel to pass on to the apps (docs/accounts-plan.md Q1, step 4b)
    case 'deletions.list': return { deletions: await listDeletions(db) };
    case 'deletions.told': return deletionTold(db, now, req.id, req.told, req.done, req.error ?? null);
    case 'visitor.delete': {
      const v = await deleteVisitor(db, req.id);
      // someone who made their own account hears that it's gone (A9)
      if (v.registered && v.email && v.email_confirmed_at && cfg.visitorMail) await cfg.visitorMail({ kind: 'deleted', to: v.email }).catch(() => null);
      return publicVisitor(v);
    }
    // ---- emails an owner sends from People (docs/accounts-plan.md step 4)
    case 'visitor.send-reset': {
      const v = await visitorById(db, req.id);
      if (!v) throw new GateError('not-found', 'That person no longer exists.');
      if (!v.active) throw new GateError('invalid', `${v.username} is switched off. Switch them on first.`);
      if (!v.email) throw new GateError('invalid', `${v.username} has no email address. Send them a setup link instead.`);
      const token = await makeEmailedLink(db, now, v.id, 'reset');
      await mailFor(cfg, { kind: 'reset', to: v.email, link: `https://${await hostFor(db, cfg, v.id)}/_pammy/reset#${token}` });
      return { ...publicVisitor(v), sentTo: v.email };
    }
    case 'visitor.resend-confirm': {
      const v = await visitorById(db, req.id);
      if (!v) throw new GateError('not-found', 'That person no longer exists.');
      if (!v.registered || !v.email || v.email_confirmed_at) throw new GateError('invalid', `${v.username} has nothing to confirm.`);
      const token = await makeEmailedLink(db, now, v.id, 'confirm');
      await mailFor(cfg, { kind: 'confirm', to: v.email, link: `https://${await hostFor(db, cfg, v.id)}/_pammy/confirm#${token}` });
      return { ...publicVisitor(v), sentTo: v.email };
    }
    case 'visitor.signout': {
      const v = await visitorById(db, req.id);
      if (!v) throw new GateError('not-found', 'That person no longer exists.');
      return { ...publicVisitor(v), signedOut: await revokeVisitorSessions(db, now, v.id) };
    }
    case 'grant': await setMember(db, now, req.visitorId, req.areaId, req.allow); return { ok: true };
    // the Access page (docs/roles-plan.md step 4): each change checked in @panel/areas/gate/access
    case 'access.state': return accessState(db, req.areaId);
    case 'access.copy': return copySet(db, now, req.areaId);
    case 'access.reset': return resetSet(db, req.areaId);
    case 'access.resource': return saveResource(db, req.areaId, { key: req.key, label: req.label, owned: req.owned, actions: req.actions, actionLabels: req.actionLabels });
    case 'access.resource.delete': return deleteResource(db, req.areaId, req.key);
    case 'access.group': return saveGroup(db, req.areaId, { id: req.id, label: req.label, privileges: req.privileges });
    case 'access.group.delete': return deleteGroup(db, req.areaId, req.id);
    case 'access.role': return saveRole(db, req.areaId, { id: req.id, label: req.label, groups: req.groups, privileges: req.privileges, parts: req.parts });
    case 'access.role.delete': return deleteRole(db, req.areaId, req.id, req.moveTo);
    case 'access.signed-in': return setSignedInRole(db, req.areaId, req.roleId);
    case 'access.never': return setNeverTogether(db, req.areaId, req.a, req.b, req.never);
    case 'access.person': return setPersonRole(db, now, req.areaId, req.visitorId, req.roleId);
    case 'access.manifest': return readManifest(db, now, req.areaId, req.text);
    case 'link.create': {
      await notRegistered(db, req.visitorId);
      const { token, link, visitor, area } = await createLink(db, now, req.visitorId, req.areaId);
      return { url: await linkUrl(db, cfg, area, token), expiresAt: link.expires_at, visitor: publicVisitor(visitor), areaPath: area?.path ?? null };
    }
    case 'link.cancel': {
      const v = await visitorById(db, req.visitorId);
      if (!v) throw new GateError('not-found', 'That person no longer exists.');
      return { cancelled: await cancelLinks(db, now, v.id) };
    }
    // ---- what visitors may do for themselves (docs/accounts-plan.md A5). mail:
    // whether the panel's mail is set up, which only the panel can tell.
    // gateMail: whether this gate can email visitors at all (its own door to the mail service)
    case 'visitor-settings.get': return { ...await readVisitorSettings(db), gateMail: !!cfg.visitorMail };
    // emailed links need both: the panel's mail set up, and this gate's own door to it
    case 'visitor-settings.set': return { ...await setVisitorSwitch(db, now, req.key, req.on, cleanBy(req.actor), { mail: req.mail === true && !!cfg.visitorMail }), gateMail: !!cfg.visitorMail };
    case 'request.resolve': { const r = await resolveRequest(db, now, req.id, req.status, req.actor); return { id: r.id, status: r.status }; }
    case 'request.delete': await deleteRequest(db, req.id); return { ok: true };
    // ---- forms (docs/forms-plan.md)
    case 'forms.state': return formsState(db, limit);
    case 'form.get': {
      const f = await formById(db, req.id);
      if (!f) throw new GateError('not-found', 'That form no longer exists.');
      return summary(f);
    }
    // A new form of hers, empty or filled in from one of the starters (examples.ts).
    case 'form.create': {
      const starter = isStarter(req.starter) ? STARTERS[req.starter] : null;
      return summary(await createForm(db, now, {
        name: req.name,
        title: req.title ?? starter?.title,
        items: req.items ?? starter?.items ?? [],
        settings: req.settings ?? starter?.settings,
        // where it works: for a person kept to places, one of theirs (checked
        // above); the others choose (everywhere by default)
        scope: req.formScope,
        // docs/comments-plan.md: a comment area, and what its comments are about
        kind: req.kind, contentType: req.contentType,
        ...(req.kind === 'comments' && req.items === undefined ? { items: undefined } : {}),
      }, req.actor));
    }
    // ---- the worked examples (docs/examples-plan.md)
    case 'starters': return { starters: Object.entries(STARTERS).map(([kind, s]) => ({ kind, label: s.label, about: s.about, title: s.title })) };
    case 'examples.state': return examplesState(db);
    case 'example.reset': { const f = await resetExample(db, now, req.kind, cfg.domain); return summary(f); }
    // The three files her own copy is made of, ready for the website helper.
    case 'example.files': {
      if (!isExampleKind(req.kind)) throw new GateError('invalid', 'There is no example of that kind.');
      const dir = cfg.examplesDir ?? EXAMPLES_DIR;
      const form = await formById(db, req.formId);
      if (!form || form.trashedAt) throw new GateError('not-found', 'That form no longer exists.');
      const pageName = typeof req.pageName === 'string' && req.pageName ? req.pageName : EXAMPLES[req.kind].pageName;
      return { files: exampleForHer(dir, req.kind, form.name, pageName), formName: form.name };
    }
    case 'form.save': return summary(await saveForm(db, now, { id: req.id, version: req.version, title: req.title, items: req.items, settings: req.settings }, req.actor));
    case 'form.duplicate': return summary(await duplicateForm(db, now, req.id, req.name, req.actor));
    case 'form.copy-name': {
      const f = await formById(db, req.id);
      if (!f) throw new GateError('not-found', 'That form no longer exists.');
      return { name: await suggestCopyName(db, f.name) };
    }
    case 'form.switches': {
      const f = await setFormSwitches(db, req.id, { enabled: req.enabled, approvable: req.approvable, publicApproved: req.publicApproved, autoApprove: req.autoApprove });
      // how many went up on their own unseen, so the panel can offer to hide them
      return { ...summary(f), unreviewedAuto: await unreviewedAutoCount(db, f.id) };
    }
    case 'form.hide-unreviewed': { const r = await hideUnreviewed(db, req.id); return { id: r.form.id, name: r.form.name, hidden: r.hidden }; }
    case 'form.trash': { const f = await trashForm(db, now, req.id, req.actor); return { id: f.id, name: f.name, title: f.title }; }
    case 'form.restore': { const f = await restoreForm(db, req.id); return { id: f.id, name: f.name, title: f.title }; }
    case 'form.scope': return summary(await setFormScope(db, req.id, req.formScope));
    case 'responses.list': return listResponses(db, { trash: req.trash, formId: req.formId, read: req.read, approval: req.approval, before: req.before, hideExamples: req.hideExamples, places: limit, kind: req.kind, contentType: req.contentType, contentId: req.contentId });
    case 'response.read': { const m = await setResponseRead(db, now, req.id, req.read, req.actor); return { id: m.id, readAt: m.readAt }; }
    case 'responses.read-all': return { marked: await markAllRead(db, now, req.formId, req.actor, limit) };
    // a comment in the trash is not shown, in her table either (A1); back, and it is again
    case 'response.trash': { const m = await trashResponse(db, now, req.id, req.actor); await saveResponse(db, now, socketOf(cfg), m.id).catch(() => null); return { id: m.id, formName: m.formName }; }
    case 'response.restore': { const m = await restoreResponse(db, req.id); await saveResponse(db, now, socketOf(cfg), m.id).catch(() => null); return { id: m.id, formName: m.formName }; }
    case 'response.approve': {
      const m = await setResponseApproved(db, now, req.id, req.approved, req.actor);
      // a form that saves its answers when she approves them: now (F3). The
      // approval stands whatever happens to the row -- the response says why
      // (a comment area's copy follows un-approving too -- docs/comments-plan.md A1)
      const saved = await saveResponse(db, now, socketOf(cfg), m.id);
      return { id: m.id, formName: m.formName, approvedAt: m.approvedAt, saved };
    }
    // ---- forms into a database (docs/form-to-database-plan.md)
    case 'response.save-again': return saveResponse(db, now, socketOf(cfg), req.id, { force: true });
    case 'formlink.get': return linkState(db, req.id);
    case 'formlink.save': return saveLink(db, now, { ...(req.link as Record<string, unknown> ?? {}), formId: req.id }, req.actor);
    case 'formlink.drop': return dropLink(db, req.id);
    case 'formlink.save-earlier': return saveEarlier(db, now, socketOf(cfg), req.id);
    case 'formlinks.for-database': return { links: await linksForDatabase(db, req.databaseId) };
    // the blog example's comment area: made or put back, with its samples,
    // keeping its copy in the example database (docs/comments-plan.md)
    case 'comments.example': {
      const f = await resetExampleComments(db, now, { name: req.name, fixture: req.fixture, title: req.title, contentType: req.contentType, items: req.items, page: req.page });
      const ids = await all<{ id: number }>(db, 'SELECT id FROM responses WHERE form_id = ? ORDER BY id', f.id);
      // the blog example keeps its approved comments in its app too; the tutorial
      // example (docs/tutorial-examples-plan.md) has no tables for them
      if (!req.link) return { id: f.id, name: f.name, comments: ids.length, saved: 0 };
      await saveLink(db, now, { ...(req.link as Record<string, unknown>), formId: f.id, mode: 'comments' }, req.actor);
      let saved = 0;
      for (const r of ids) if ((await saveResponse(db, now, socketOf(cfg), r.id)).saved === true) saved++;
      return { id: f.id, name: f.name, comments: ids.length, saved };
    }
    case 'apikeys.list': return { keys: await listApiKeys(db) };
    case 'apikey.create': return createApiKey(db, now, { label: req.label, level: req.level, forms: req.forms, media: req.media }, req.actor,
      { form: (id) => needForm(db, id), mediaFolder: cleanScope });
    case 'apikey.revoke': { const k = await revokeApiKey(db, now, req.id, req.actor); return { id: k.id, label: k.label }; }
    // the data API (slice 9): the panel pushes a finished catalog, and the
    // keys that may ask live here beside the form keys
    case 'catalog.push': return pushCatalog(db, now, {
      databaseId: req.databaseId, engine: req.engine, name: req.name,
      apiRead: req.apiRead, apiWrite: req.apiWrite, catalog: req.catalog,
    });
    case 'catalog.drop': return dropCatalog(db, now, req.databaseId);
    case 'appkeys.list': return { keys: await listAppKeys(db, req.databaseId) };
    case 'appkey.create': return createAppKey(db, now, {
      databaseId: req.databaseId, label: req.label, resources: req.resources, canWrite: req.canWrite,
    }, req.actor);
    case 'appkey.revoke': { const k = await revokeAppKey(db, now, req.id, req.actor); return { id: k.id, label: k.label }; }
    case 'appkeys.rename-table': return { keys: await renameAppKeyGrants(db, req.databaseId, req.from, req.to) };
    // writes to tables she tags, for the panel's catalog (docs/catalog-plan.md step 4)
    case 'record-touches.take': return takeTouches(db, now);
    // ...and the gate's copy of their labels, for the data API (step 4b)
    case 'record-labels.put': return putRecordLabels(db, req);
    case 'record-labels.keep': return keepRecordLabels(db, req.tables);
    case 'housekeeping': await gateHousekeeping(db, now, cfg.modules ?? MODULES); return { ok: true };
    // the panel's email notices (docs/apps-plan.md phase 3)
    case 'notices.since': return noticesSince(db, { responses: req.responses, requests: req.requests });
    default: throw new GateError('invalid', 'Unknown request.');
  }
}

export function createGateAdminServer(g: GateLive, now: () => number, log: (line: string) => void, cfg: AdminConfig): Server {
  // passwords, contact details, link tokens, API keys and responses never reach the log:
  // describe() only ever names ids, paths and usernames, and results aren't logged
  return createJsonLineServer((req) => handleAdmin(g, now(), req, cfg), log, {
    describe: (req) => JSON.stringify(req.path ?? req.page ?? req.username ?? req.id ?? req.visitorId ?? '').slice(0, 120),
    // a tagged table's labels come whole (docs/catalog-plan.md step 4b: up to 20,000 records)
    maxRequest: 4 * 1024 * 1024,
  });
}
