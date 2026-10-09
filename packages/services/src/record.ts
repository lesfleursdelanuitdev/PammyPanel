// The services helper's record of what it looks after (docs/adopt-plan.md V7):
// /var/lib/lfdln-services/services.json, root 600. Only adopting writes it (run by
// the installer, never through the socket), and the helper does nothing to a unit
// that isn't in it. Adopting changes nothing of the services themselves (A1).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class ServicesError extends Error {
  code: 'invalid' | 'not-found' | 'busy' | 'conflict' | 'unavailable' | 'internal';
  constructor(code: ServicesError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// a service's or a part's id: one label
export const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// the system user its containers run as, and a unit in that user's manager (without ".service")
export const USER_RE = /^svc-[a-z0-9-]{1,28}$/;
export const UNIT_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
// the path its health is asked at
export const HEALTH_RE = /^\/[A-Za-z0-9._~/-]{0,200}$/;

export type Part = {
  id: string;                   // "web", "public", "gedcom-api"
  title: string;
  unit: string;                 // its unit in the user's manager, without ".service"
  port: number | null;          // where it answers on 127.0.0.1 (null: nothing, a one-shot)
  health: string | null;        // the path it answers 2xx/3xx on when it is well
  controls: boolean;            // started, stopped and restarted from the panel (not a one-shot migrator)
  requires: string[];           // the parts it can't run without (its unit's Requires=)
  source: string | null;        // its Quadlet file, as systemd says (SourcePath), when adopted
  sha256: string | null;        // that file's checksum when adopted: "changed since" on the page
};

export type Service = {
  id: string;
  title: string;
  user: string;
  about: string;                // one line on the page: where its code and runbook are
  parts: Part[];                // in the order they start (and the reverse, stop)
  adoptedAt: number;            // unix seconds
};

export type ServicesRecord = { version: 1; services: Service[] };

export const emptyRecord = (): ServicesRecord => ({ version: 1, services: [] });

export function checkRecord(v: unknown): ServicesRecord {
  const r = v as ServicesRecord;
  if (!r || r.version !== 1 || !Array.isArray(r.services)) throw new ServicesError('internal', 'The services record is not one this helper knows.');
  for (const s of r.services) {
    if (!ID_RE.test(s.id) || !USER_RE.test(s.user) || !Array.isArray(s.parts)) throw new ServicesError('internal', `The services record has a service it can't read (${String(s.id).slice(0, 40)}).`);
    for (const p of s.parts) {
      if (!ID_RE.test(p.id) || !UNIT_RE.test(p.unit) || (p.port !== null && !(Number.isInteger(p.port) && p.port >= 1024 && p.port <= 65535))
        || (p.health !== null && !HEALTH_RE.test(p.health)) || typeof p.controls !== 'boolean' || !Array.isArray(p.requires)) {
        throw new ServicesError('internal', `The services record has a part it can't read (${s.id}/${String(p.id).slice(0, 40)}).`);
      }
    }
  }
  return r;
}

export function loadRecord(path: string): ServicesRecord {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyRecord();
    throw new ServicesError('unavailable', `The services record can't be read: ${(e as Error).message}`);
  }
  return checkRecord(JSON.parse(text));
}

// Whole or not at all: a temporary file, then one rename. Root's, 600.
export function saveRecord(path: string, r: ServicesRecord): void {
  checkRecord(r);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.new`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function findService(r: ServicesRecord, id: unknown): Service {
  const s = typeof id === 'string' ? r.services.find((x) => x.id === id) : undefined;
  if (!s) throw new ServicesError('not-found', 'There is no such service.');
  return s;
}

export function findPart(s: Service, id: unknown): Part {
  const p = typeof id === 'string' ? s.parts.find((x) => x.id === id) : undefined;
  if (!p) throw new ServicesError('not-found', `${s.title} has no such part.`);
  return p;
}

// Every part that runs only while this one does (its Requires=, followed back).
export function dependentsOf(s: Service, id: string): Part[] {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of s.parts) if (!out.has(p.id) && p.requires.some((r) => out.has(r))) { out.add(p.id); grew = true; }
  }
  return s.parts.filter((p) => out.has(p.id));
}

// Every part this one needs running, itself too (its Requires=, followed forward).
export function neededBy(s: Service, id: string): Part[] {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of s.parts) if (out.has(p.id)) for (const r of p.requires) if (!out.has(r)) { out.add(r); grew = true; }
  }
  return s.parts.filter((p) => out.has(p.id));
}
