// Same rules as src/names.ts; the server checks again, these are only for hints.
import { SITE } from './site';
export const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function nameProblem(name: string, reserved: string[]): string | null | '' {
  if (!name) return '';
  if (name.length > 63) return 'Names can be at most 63 characters.';
  if (/[A-Z]/.test(name)) return 'Use lowercase letters only.';
  if (!SUBDOMAIN_RE.test(name)) return 'Use only lowercase letters, digits and hyphens, and start and end with a letter or digit.';
  if (reserved.includes(name)) return `"${name}" is already used by the server, so pick another name.`;
  return null;
}

// A form's name: it is what her pages ask for, so it can never change (forms-plan D3).
export const FORM_NAME_RULE = 'Lowercase letters, digits and hyphens, like olivias-form. It goes on your pages, and it can never be changed.';
export const formNameProblem = (name: string) =>
  !name ? 'Give the form a name.'
    : !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length < 2 || name.length > 64 ? FORM_NAME_RULE : null;

// Passwords are made up in the browser and shown once; the server keeps only a hash.
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makePassword(): string {
  const n = crypto.getRandomValues(new Uint32Array(16));
  return [...n].map((x) => PW_ALPHABET[x % PW_ALPHABET.length]).join('').match(/.{4}/g)!.join('-');
}

// "Rose Smith" -> "rose.smith", made unique; only a suggestion, she can change it.
export function suggestUsername(name: string, taken: Set<string>): string {
  const base = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 30).replace(/\.+$/, '');
  const stem = base.length >= 2 ? base : `${base || 'guest'}.guest`.replace(/^\./, '');
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) if (!taken.has(`${stem}${i}`)) return `${stem}${i}`;
}

// Links to a site folder: pammy.org/<path>/, and <first>.pammy.org/<rest>/ when that's a subdomain
// (only on a site whose folders are subdomains: the profile's folderSubdomains).
export function folderAddresses(path: string, reserved: string[]): { href: string; text: string }[] {
  const parts = path.split('/');
  const enc = (p: string[]) => p.map(encodeURIComponent).join('/');
  const out = [{ href: `https://${SITE.domain}/${enc(parts)}/`, text: `${SITE.domain}/${path}/` }];
  const [first, ...rest] = parts;
  if (SITE.folderSubdomains && first && SUBDOMAIN_RE.test(first) && !reserved.includes(first)) {
    const tail = rest.length ? `${rest.join('/')}/` : '';
    out.push({ href: `https://${first}.${SITE.domain}/${rest.length ? `${enc(rest)}/` : ''}`, text: `${first}.${SITE.domain}/${tail}` });
  }
  return out;
}

export const personLabel = (v: { name: string; username: string }) => (v.name ? `${v.name} (${v.username})` : v.username);
