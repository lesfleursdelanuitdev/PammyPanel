// Tags and categories on her records (docs/catalog-plan.md step 4): what a record is to
// the catalog. Pure: no database, no socket, no clock.
//
// A record's key in the catalog is its primary key as text: the value itself for a
// one-field key (what the data API calls its `id`), or the values as a JSON list for a
// key of several fields. Its title is the title field's value, its picture the picture
// field's.
import type { Scalar } from '../pammydb/rows.ts';
import type { ResourceView } from './resources.ts';

// S4-1 (Q4-5): the listing reads every key, so a table bigger than this can't be tagged.
export const MAX_TAGGED = 20_000;
// how many rows one listing asks the helper for at a time (the helper's own cap)
export const LIST_PAGE = 200;

export const keyFields = (r: ResourceView): string[] => r.fields.filter((f) => f.primaryKey).map((f) => f.name);

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
};

// The record's key as the catalog keeps it; null when a part of it is missing.
export function recordKey(r: ResourceView, row: Record<string, unknown>): string | null {
  const parts = keyFields(r).map((k) => text(row[k]));
  if (!parts.length || parts.some((p) => p === null || p === '')) return null;
  return parts.length === 1 ? parts[0]! : JSON.stringify(parts);
}

// ...and back to the fields that name the record (the record pages' `where`).
export function whereOfKey(r: ResourceView, key: string): Record<string, Scalar> | null {
  const fields = keyFields(r);
  let parts: unknown[];
  if (fields.length === 1) parts = [key];
  else {
    try { parts = JSON.parse(key) as unknown[]; } catch { return null; }
    if (!Array.isArray(parts) || parts.length !== fields.length) return null;
  }
  const out: Record<string, Scalar> = {};
  fields.forEach((f, i) => {
    const v = parts[i];
    const type = r.fields.find((x) => x.name === f)?.type;
    out[f] = (type === 'integer' || type === 'decimal') && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v as Scalar;
  });
  return out;
}

// What the listing and the record pages read of a record: the key, the title, the picture.
export function listingColumns(r: ResourceView): string[] {
  return [...new Set([...keyFields(r), ...(r.titleField ? [r.titleField] : []), ...(r.pictureField ? [r.pictureField] : [])])];
}

export type Seen = { key: string; title: string | null; picture: string | null };

export function seenOf(r: ResourceView, row: Record<string, unknown>): Seen | null {
  const key = recordKey(r, row);
  if (key === null || key.length > 4096) return null;
  const title = r.titleField ? text(row[r.titleField]) : null;
  const picture = r.pictureField ? text(row[r.pictureField]) : null;
  return { key, title: title?.trim() ? title.slice(0, 200) : null, picture: picture?.trim() ? picture.trim().slice(0, 2000) : null };
}

// S4-8: a picture field's value as a website file's path ("media/x.jpg"), or null for
// anything else (an address on another site, a data: URL): the panel never fetches those.
export function sitePathOf(picture: string | null): string | null {
  if (!picture) return null;
  let p = picture.trim();
  const origin = /^https?:\/\/[^/]+/i.exec(p);
  if (origin) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null;
  p = p.split(/[?#]/)[0]!.replace(/^\/+/, '');
  if (!p || p.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  try { p = decodeURIComponent(p); } catch { return null; }
  return p.length <= 1000 ? p : null;
}
