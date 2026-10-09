import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
// Folder-name rules, shared by the panel (to explain) and the website folder
// helper (to enforce). They mirror the folder-subdomain server_name regex in
// the pamela nginx vhost: one DNS label, lowercase.

export const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// www = main site, api = her app's /api/ proxy, panel = this panel, media = the
// main site's media folder (not a site of its own). Each WordPress install adds
// its own name (read from its placement line: the blog's, and one per panel
// install, docs/apps-plan.md 4b).
export const ALWAYS_RESERVED = ['www', 'api', 'panel', 'media'] as const;

export function reservedNames(placements: string | null): string[] {
  const names = (placements ?? '').split('\n')
    .map((l) => l.trim().match(/^(subdomain|path) ([a-z0-9-]+)$/)?.[2])
    .filter((n): n is string => !!n);
  return [...ALWAYS_RESERVED, ...new Set(names)];
}

// Every install's placement line, from the blog's file and the placement-<id>
// files beside it, as one text (a line each).
export function readPlacements(placementFile: string | null): string | null {
  if (!placementFile) return null;   // a site without WordPress
  const lines: string[] = [];
  try { lines.push(readFileSync(placementFile, 'utf8').trim()); } catch { /* WordPress not installed */ }
  try {
    for (const f of readdirSync(dirname(placementFile))) {
      if (/^placement-[a-z0-9-]{1,32}$/.test(f)) {
        try { lines.push(readFileSync(join(dirname(placementFile), f), 'utf8').trim()); } catch { /* gone meanwhile */ }
      }
    }
  } catch { /* no folder */ }
  return lines.length ? lines.join('\n') : null;
}

// Why a new folder name can't be used, or null if it can.
export function newNameProblem(name: unknown, reserved: string[]): string | null {
  if (typeof name !== 'string' || name === '') return 'Please type a name.';
  if (name.length > 63) return 'Names can be at most 63 characters.';
  if (/[A-Z]/.test(name)) return 'Use lowercase letters only.';
  if (!SUBDOMAIN_RE.test(name)) {
    return 'Use only lowercase letters, digits and hyphens, and start and end with a letter or digit.';
  }
  if (reserved.includes(name)) return `"${name}" is already used by the server, so pick another name.`;
  return null;
}

// Any existing top-level folder in her website, including ones that can't be
// subdomains (like "My Recipes"). Never a path, never hidden.
export function isSafeEntryName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length >= 1 && name.length <= 200
    && !name.startsWith('.')
    && !/[/\\\u0000-\u001f\u007f]/.test(name);
}

// Trash entries are "<original name>--<UTC stamp>".
export const TRASH_ENTRY_RE = /^(.+)--(\d{8}T\d{6}Z)$/;

export function trashStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function parseTrashEntry(entry: string): { name: string; trashedAt: number } | null {
  const m = entry.match(TRASH_ENTRY_RE);
  if (!m || !isSafeEntryName(m[1])) return null;
  const s = m[2]!;
  const t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
  return Number.isFinite(t) ? { name: m[1]!, trashedAt: Math.floor(t / 1000) } : null;
}

// Protected folders: a path inside the web root like "recipes/private" -- no
// leading or trailing slash, no hidden or path-like parts, never the whole site.
export const MARKER = '.pammy-protected';
export const AREA_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function cleanAreaPath(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const parts = v.split('/').filter((p) => p !== '');
  if (parts.length < 1 || parts.length > 8) return null;
  for (const p of parts) {
    if (p === '.' || p === '..' || !isSafeEntryName(p)) return null;
  }
  return parts.join('/');
}
