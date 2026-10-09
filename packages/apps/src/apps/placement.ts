// Where a piece of software is served: the one placement line nginx is written
// from, the address it makes, and the moments backups are named by.
export type Placement =
  | { mode: 'off' | 'root'; name: null }
  | { mode: 'subdomain' | 'path'; name: string };

// The one placement line nginx is written from ("subdomain blog"); the same
// grammar as ~/pamela-setup/wordpress/lib.sh check_placement.
const NAME = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
export function parsePlacement(text: string | null): Placement | null {
  const t = text?.trim() ?? '';
  if (t === 'off' || t === 'root') return { mode: t, name: null };
  const m = t.match(new RegExp(`^(subdomain|path) (${NAME})$`));
  return m ? { mode: m[1] as 'subdomain' | 'path', name: m[2]! } : null;
}

// Where visitors find it, or null when it is served nowhere.
export function addressOf(p: Placement, domain: string): string | null {
  switch (p.mode) {
    case 'root': return `https://${domain}/`;
    case 'subdomain': return `https://${p.name}.${domain}/`;
    case 'path': return `https://${domain}/${p.name}/`;
    case 'off': return null;
  }
}

// The address WordPress's own settings use for it (content-url, WP_HOME): no
// trailing slash, as lib.sh placement_url writes it. Null when served nowhere.
export function siteUrlOf(p: Placement, domain: string): string | null {
  switch (p.mode) {
    case 'root': return `https://${domain}`;
    case 'subdomain': return `https://${p.name}.${domain}`;
    case 'path': return `https://${domain}/${p.name}`;
    case 'off': return null;
  }
}

// Names nginx and the panel keep for themselves (src/names.ts ALWAYS_RESERVED)
export const RESERVED = ['www', 'api', 'panel', 'media'];

// 20260923T033012Z -> unix seconds
export function stampToUnix(s: string): number {
  return Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)) / 1000);
}
