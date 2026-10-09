// pammy-panel.json's `catalog` section (docs/catalog-plan.md step 5, S5-1): what a service
// offers the catalog to tag, per resource -- where the panel reads the list, where an item
// opens, which field of an item names its sub-scope, what its labels mean to it (`uses`),
// and what its visitors may do (kept now, used in step 6). Checked here, in the core, so
// the roles' checks (@panel/areas manifest.ts) refuse a file with a bad section and the
// catalog reads the same thing.
export type CatalogUse = { kind: 'tag' | 'category'; label: string; means: string | null };
export type VisitorLabels = 'none' | 'personal' | 'shared' | 'both';
export type CatalogResource = {
  key: string;
  label: string;
  list: string;                 // a path on the service, answering the signed listing
  open: string | null;          // where an item opens: a path or an https address with {id}
  scopes: string | null;        // the field of an item naming its sub-scope
  visitorLabels: VisitorLabels;
  visitorNewLabels: boolean;
  uses: Record<string, CatalogUse>;   // by label name
};

export const MAX_CATALOG_RESOURCES = 10;
export const MAX_USES = 20;
export const VISITOR_LABELS: readonly VisitorLabels[] = ['none', 'personal', 'shared', 'both'];

const WORD = /^[a-z][a-z0-9-]{0,31}$/;
// a label's name (@panel/catalog labels.ts LABEL_NAME_RE: the same rule)
const LABEL_NAME = /^(?=[a-z0-9-]{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIST_PATH = /^\/(?!\/)[A-Za-z0-9._~/-]{0,199}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Every problem is handed to `bad` (the manifest's list); what comes back is only to be
// used when there were none.
export function checkCatalogSection(v: unknown, bad: (m: string) => void): CatalogResource[] {
  if (!isObject(v)) { bad('catalog: an object, one entry per kind of thing to tag'); return []; }
  const entries = Object.entries(v);
  if (!entries.length) bad('catalog: at least one kind of thing to tag, or leave it out');
  if (entries.length > MAX_CATALOG_RESOURCES) bad(`catalog: at most ${MAX_CATALOG_RESOURCES} kinds of thing`);
  const text = (x: unknown, where: string, max: number) => {
    if (typeof x !== 'string' || x.trim() === '' || x.length > max) { bad(`${where}: 1 to ${max} characters`); return ''; }
    return x.trim();
  };
  return entries.map(([key, r]) => {
    const at = `catalog.${key}`;
    if (!WORD.test(key)) bad(`${at}: a lowercase word (a-z, 0-9, -), up to 32`);
    if (!isObject(r)) { bad(`${at}: an object`); return null; }
    for (const k of Object.keys(r)) if (!['label', 'list', 'open', 'scopes', 'visitorLabels', 'visitorNewLabels', 'uses'].includes(k)) bad(`${at}: "${k}" isn't something it can say`);
    const label = text(r.label, `${at}.label`, 80);
    if (typeof r.list !== 'string' || !LIST_PATH.test(r.list) || r.list.split('/').some((p) => p === '..' || p === '.')) bad(`${at}.list: a path on the service starting with /, like /_lfdln/catalog/${key}`);
    let open: string | null = null;
    if (r.open !== undefined && r.open !== null) {
      if (typeof r.open !== 'string' || r.open.length > 500 || !r.open.includes('{id}') || !(/^\/(?!\/)/.test(r.open) || r.open.startsWith('https://')) || /[\s"<>\\]/.test(r.open)) {
        bad(`${at}.open: a path starting with / (or an https address) with {id} where the item's id goes`);
      } else open = r.open;
    }
    let scopes: string | null = null;
    if (r.scopes !== undefined && r.scopes !== null) {
      if (typeof r.scopes !== 'string' || !FIELD.test(r.scopes)) bad(`${at}.scopes: the name of a field of each item (letters, digits, _)`);
      else scopes = r.scopes;
    }
    const vl = r.visitorLabels ?? 'none';
    if (!VISITOR_LABELS.includes(vl as VisitorLabels)) bad(`${at}.visitorLabels: one of ${VISITOR_LABELS.join(', ')}`);
    if (r.visitorNewLabels !== undefined && typeof r.visitorNewLabels !== 'boolean') bad(`${at}.visitorNewLabels: true or false`);
    const uses: Record<string, CatalogUse> = {};
    if (r.uses !== undefined) {
      if (!isObject(r.uses)) bad(`${at}.uses: an object, one entry per label name`);
      else {
        const us = Object.entries(r.uses);
        if (us.length > MAX_USES) bad(`${at}.uses: at most ${MAX_USES}`);
        for (const [name, u] of us) {
          const w = `${at}.uses.${name}`;
          if (!LABEL_NAME.test(name)) bad(`${w}: a label's name (lowercase letters, digits and hyphens, at most 40)`);
          if (!isObject(u)) { bad(`${w}: an object`); continue; }
          for (const k of Object.keys(u)) if (!['kind', 'label', 'means'].includes(k)) bad(`${w}: "${k}" isn't something it can say`);
          if (u.kind !== 'tag' && u.kind !== 'category') bad(`${w}.kind: tag or category`);
          const means = u.means === undefined ? null : text(u.means, `${w}.means`, 200);
          uses[name] = { kind: u.kind === 'category' ? 'category' : 'tag', label: text(u.label, `${w}.label`, 80), means };
        }
      }
    }
    return { key, label, list: typeof r.list === 'string' ? r.list : '', open, scopes, visitorLabels: vl as VisitorLabels, visitorNewLabels: r.visitorNewLabels === true, uses };
  }).filter((x): x is CatalogResource => x !== null);
}

// A manifest's catalog section alone, from the file's text (the catalog reads it this way);
// null when there is none. Throws with the problems, as the whole file would be refused.
export function catalogOf(text: string): CatalogResource[] | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new CatalogManifestError([`it isn't JSON (${(e as Error).message})`]); }
  if (!isObject(raw) || raw.catalog === undefined) return null;
  const problems: string[] = [];
  const out = checkCatalogSection(raw.catalog, (m) => { if (problems.length < 20) problems.push(m); });
  if (problems.length) throw new CatalogManifestError(problems);
  return out;
}

export class CatalogManifestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`pammy-panel.json's catalog section was not taken: ${problems.join('; ')}`);
    this.problems = problems;
  }
}
