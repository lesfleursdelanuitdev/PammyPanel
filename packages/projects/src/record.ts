// What the projects helper keeps (docs/phase8b-plan.md): every project, its branches, their
// ports and releases. /var/lib/lfdln-projects/projects.json, root's, 600, written only by the
// helper (unlike the services' record, which only the installer writes: projects are made and
// deleted from the panel).
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export class ProjectsError extends Error {
  code: 'invalid' | 'not-found' | 'busy' | 'unavailable' | 'internal' | 'conflict';
  constructor(code: ProjectsError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// The kinds of project (the plan's "What a project can be"); 8b-2 makes the static ones
export const KINDS = ['react', 'vue', 'svelte', 'lit', 'next-static', 'next', 'laravel'] as const;
export type Kind = (typeof KINDS)[number];
// what step 8b-2 makes: built into files that nginx serves, nothing running
export const STATIC_KINDS: readonly Kind[] = ['react', 'vue', 'svelte', 'lit', 'next-static'];
// 8b-4: a server in a container per release, two ports per branch (P8b-6)
export const SERVER_KINDS: readonly Kind[] = ['next'];
export const MADE_KINDS: readonly Kind[] = [...STATIC_KINDS, ...SERVER_KINDS];
export const isServer = (k: Kind) => SERVER_KINDS.includes(k);
// a single-page app: an address with no file of its own gets index.html (Lit's starter is one page too)
export const SPA_KINDS: readonly Kind[] = ['react', 'vue', 'svelte', 'lit'];
// releases kept per branch, the live one among them (G9)
export const KEEP_RELEASES = 3;
export const BRANCHES = ['main', 'dev'] as const;
export type Branch = (typeof BRANCHES)[number];
export type PackageManager = 'npm' | 'pnpm';

// a DNS label, so <name>.<domain> and <name>-dev.<domain> are both one level (P8b-1)
export const ID_RE = /^[a-z](?:[a-z0-9-]{0,34}[a-z0-9])?$/;
export const isProjectId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v) && !v.endsWith('-dev') && !v.includes('--');

// Ports for projects' servers (P8b-3): 4100-4199 stay for services made by hand (exam prep's 4101).
export const PORT_MIN = 4200;
export const PORT_MAX = 4999;

// a release's id is when it was built, UTC, to the second: 20261005173000
export const RELEASE_RE = /^[0-9]{14}$/;
// (a server's release is its image, localhost/proj-<name>:<branch>-<id>: 8b-4)
export type Release = { id: string; commit: string; at: number; by: string; files: number; bytes: number; image?: string };
// a branch's database (8b-5): made by the database helper, its connection in the branch's
// environment; shared: dev using main's (P8b-5, an owner's choice)
export const DB_ENGINES = ['postgres', 'mariadb'] as const;
export type BranchDatabase = { engine: (typeof DB_ENGINES)[number]; name: string; owner: string; app: string; at: number; by: string; shared?: boolean };
export const DB_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
// a package (8b-8a): npm's rule for a name (scoped or not), and a version or range as people
// write them; the scripts that serve and never finish (container/packages.mjs keeps the same)
export const PKG_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;
export const PKG_SPEC_RE = /^[a-zA-Z0-9.^~<>=*+_ |-]{1,64}$/;
export const SCRIPT_RE = /^[A-Za-z0-9:._-]{1,64}$/;
export const LONG_RUNNING = ['dev', 'start', 'preview', 'serve'];
// a server's branch (8b-4): its two ports (slots a and b), which one is live, and whether
// it was stopped from the panel
export type BranchState = { ports: number[]; live: Release | null; releases: Release[]; slot?: 0 | 1 | null; stopped?: boolean; database?: BranchDatabase | null };
export type Project = {
  id: string; kind: Kind; pm: PackageManager; typescript: boolean; tailwind: boolean;
  createdAt: number; createdBy: string;
  branches: Partial<Record<Branch, BranchState>>;
  // 8b-3: who may change it (panel usernames, the maker first), and whether its repository
  // has its group, modes and hook yet (D3-9: projects made before 8b-3 get them on start)
  owners: string[];
  shared: boolean;
  // 8b-8b: each night, its packages updated within their ranges (built, undone if that fails)
  autoUpdate?: boolean;
};
export type ProjectsRecord = { version: 1; projects: Project[] };

// a panel username (@panel/core/util USERNAME_RE)
export const OWNER_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const MAX_OWNERS = 20;

// The project's Unix group (D3-2): lfdln-p-<name>, or cut to the 32 a group name may have,
// with a hash of the whole name so two long names never share one.
export function groupOf(id: string): string {
  const g = `lfdln-p-${id}`;
  if (g.length <= 32) return g;
  return `lfdln-p-${id.slice(0, 17)}-${createHash('sha256').update(id).digest('hex').slice(0, 6)}`;
}

const empty = (): ProjectsRecord => ({ version: 1, projects: [] });

export function checkRecord(v: unknown): ProjectsRecord {
  const r = v as ProjectsRecord;
  if (!r || typeof r !== 'object' || r.version !== 1 || !Array.isArray(r.projects)) throw new ProjectsError('internal', 'The projects record is not one this helper reads.');
  const seen = new Set<string>();
  for (const p of r.projects) {
    if (!isProjectId(p.id) || seen.has(p.id)) throw new ProjectsError('internal', `The projects record has a bad or doubled project name (${String(p.id).slice(0, 40)}).`);
    if (!(KINDS as readonly string[]).includes(p.kind)) throw new ProjectsError('internal', `The projects record has an unknown kind for ${p.id}.`);
    // made before 8b-3: its maker owns it, and its repository isn't shared yet
    if (p.owners === undefined) p.owners = OWNER_RE.test(p.createdBy) ? [p.createdBy] : [];
    if (p.shared === undefined) p.shared = false;
    if (!Array.isArray(p.owners) || p.owners.some((o) => typeof o !== 'string' || !OWNER_RE.test(o))) throw new ProjectsError('internal', `The projects record has a bad owner for ${p.id}.`);
    seen.add(p.id);
  }
  return r;
}

export function loadRecord(path: string): ProjectsRecord {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw e;
  }
  return checkRecord(JSON.parse(text));
}

// Whole or not at all: a new file beside it, then one rename.
export function saveRecord(path: string, r: ProjectsRecord) {
  const tmp = `${path}.new`;
  writeFileSync(tmp, `${JSON.stringify(checkRecord(r), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export const portsOf = (r: ProjectsRecord) => r.projects.flatMap((p) => Object.values(p.branches).flatMap((b) => b?.ports ?? []));

// The lowest free ports in the range, `n` of them; `taken` also holds what else listens there.
export function freePorts(taken: Iterable<number>, n: number): number[] {
  const used = new Set(taken);
  const out: number[] = [];
  for (let p = PORT_MIN; p <= PORT_MAX && out.length < n; p++) if (!used.has(p)) out.push(p);
  if (out.length < n) throw new ProjectsError('unavailable', `No free ports left for projects (${PORT_MIN}-${PORT_MAX}).`);
  return out;
}
