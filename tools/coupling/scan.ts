// The coupling report (docs/master-plan.md K0, docs/module-contracts-plan.md): made from the
// code on main, never by hand, so it can't drift the way architecture.md's lists did.
// It finds three things:
//
//   1. SQL on another module's tables (rule 1). A table's owner is the package whose
//      migration creates it, or, for the closed baseline (db/migrations), the module it
//      belongs to by meaning (BASELINE below), or a decided move (MOVED below).
//   2. Socket and gate ops a package sends without declaring the package that answers
//      them (rule 5).
//   3. Modules named by the kernel (core), the gate host and the sites (rule 3).
//
// Its JSON is C1's allow list: entries name a module, a table and the files, never a line,
// so editing a file doesn't change it; only new or removed coupling does.
// Parsing is the oxc parser that comes with vite (rolldown/utils): comments are skipped and
// a template literal's pieces are read as one statement.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync, transformSync } from 'rolldown/utils';

// an ESTree node, as the parser hands it over
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = { type: string; start: number; end: number; [k: string]: any };

// The baseline (db/migrations/0001-0018) made tables for many modules at once; who owns
// each is by meaning (docs/architecture.md section 3). A baseline table missing here stops
// the report, so a new one can't go unowned.
const BASELINE: Record<string, string> = {
  'panel.users': 'core', 'panel.passkeys': 'core', 'panel.invites': 'core', 'panel.sessions': 'core',
  'panel.ceremonies': 'core', 'panel.activity': 'core',
  'gate.areas': 'areas',
  'gate.visitors': 'people', 'gate.sessions': 'people', 'gate.links': 'people',
  // the gate's event log: the kernel's, with logEvent and its purge (docs/k-a-plan.md KA-Q1)
  'gate.events': 'core',
  'gate.requests': 'requests',
  'gate.forms': 'forms', 'gate.responses': 'forms', 'gate.response_values': 'forms', 'gate.form_pages': 'forms',
  'gate.api_keys': 'api-keys',
  'panel.studio_databases': 'studio', 'panel.studio_db_users': 'studio', 'panel.studio_drafts': 'studio',
  'panel.studio_layouts': 'studio', 'panel.studio_resources': 'studio', 'panel.studio_fields': 'studio',
  'gate.studio_catalog': 'studio', 'gate.studio_app_keys': 'studio',
  'gate.form_links': 'form-links', 'gate.response_saves': 'form-links',
  'panel.started_paths': 'getting-started', 'panel.path_steps': 'getting-started',
  'panel.mail_notices': 'mail',
};
// Decided owners that differ from the migration that made the table.
const MOVED: Record<string, { owner: string; why: string }> = {
  'panel.site_folders': { owner: 'files', why: 'docs/phase8b-plan.md 8b-9: hosts made it, files owns it' },
  'files.files': { owner: 'files', why: 'A-Q5 (a): catalog made it, files takes it over in K' },
  'files.imported_notes': { owner: 'files', why: 'A-Q5 (a): catalog made it, files takes it over in K' },
  'files.records': { owner: 'files', why: 'A-Q5 (a): catalog made it, files takes it over in K' },
  'thumbs.thumbs': { owner: 'thumbs', why: 'A-Q5 (a): catalog made it, thumbs takes it over in K' },
  'public.schema_migrations': { owner: 'core', why: 'made by core/src/pg-migrate.ts, not a migration' },
  'gate.visitor_settings': { owner: 'people', why: 'docs/k-a-plan.md KA-Q3: areas/0001 made it; people writes it (K-a4), the kernel reads it until K-b' },
};

// Every JSON-line server and the package that answers it. A new createJsonLineServer
// anywhere else stops the report: add it here.
const SERVERS: Record<string, { module: string; file: string }> = {
  gate: { module: 'gate', file: 'packages/gate/src/admin.ts' },
  sitefs: { module: 'files', file: 'packages/files/src/sitefs/service.ts' },
  thumbs: { module: 'thumbs', file: 'packages/thumbs/src/thumbs/service.ts' },
  pammydb: { module: 'studio', file: 'packages/studio/src/pammydb/service.ts' },
  apps: { module: 'apps', file: 'packages/apps/src/apps/service.ts' },
  mail: { module: 'mail', file: 'packages/mail/src/mail/service.ts' },
  routes: { module: 'hosts', file: 'packages/hosts/src/helper/service.ts' },
  services: { module: 'services', file: 'packages/services/src/helper/service.ts' },
  projects: { module: 'projects', file: 'packages/projects/src/helper/service.ts' },
};
// How a request reaches its server: the function it is handed to (the callee's last part,
// or all of it), or, for the plain callJsonLine*, the words naming the service (3rd argument).
const CLIENTS: Record<string, string> = {
  gate: 'gate',
  helper: 'sitefs', 'R.call': 'sitefs', 'R.read': 'sitefs', 'R.upload': 'sitefs',
  callSiteFs: 'sitefs', readFromSiteFs: 'sitefs', uploadToSiteFs: 'sitefs',
  studio: 'pammydb', studioSlow: 'pammydb', ask: 'pammydb', callPammyDb: 'pammydb',
  software: 'apps', readFromApps: 'apps',
  mailer: 'mail', mail: 'mail', callMail: 'mail',
  routesHelper: 'routes', callServices: 'services', callProjects: 'projects',
};
const LABELS: Record<string, string> = {
  'protected-folder service': 'gate', 'the gate': 'gate', 'the routing helper': 'routes',
  'the software helper': 'apps', 'mail service': 'mail', 'thumbnail service': 'thumbs',
  'website folder helper': 'sitefs',
};
// A client a file makes for itself (const helper = ...) is named by the socket it opens.
const SOCKETS: Record<string, string> = {
  gate: 'gate', sitefs: 'sitefs', rootfs: 'sitefs', thumbs: 'thumbs', pammydb: 'pammydb', apps: 'apps',
  mail: 'mail', routes: 'routes', services: 'services', projects: 'projects',
};
// a request written straight to a socket, with no client to name it
const RAW_WRITES: Record<string, string> = { 'packages/monitoring/src/watchdog.ts': 'mail' };

export type TableInfo = { owner: string; createdBy: string; why?: string };
export type SqlTouch = { module: string; table: string; access: 'read' | 'write'; files: string[] };
export type OpCall = { from: string; server: string; op: string; owner: string; files: string[] };
// a gate op: the module it belongs to (the gate's own moduleOf, which switches it off with
// the module), and whose code its case runs ('core': the stores in core/src/gate; 'gate': its own)
export type GateOp = { module: string; runs: string[] };
export type Naming = { file: string; module: string; how: 'import' | 'name'; count: number };
export type Report = {
  tables: Record<string, TableInfo>;
  sqlOwn: number;
  sqlCross: SqlTouch[];
  sqlUnsure: { file: string; table: string; why: string }[];
  servers: Record<string, { module: string; file: string; ops: string[] }>;
  gateOps: Record<string, GateOp>;
  calls: OpCall[];
  undeclared: { from: string; to: string; via: string[] }[];
  unplaced: { file: string; op: string; why: string }[];
  naming: Naming[];
};

const parts = ['src', 'web', 'widgets'];
function sourceFiles(root: string, dir: string): string[] {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(root, join(dir, e.name)) : /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [join(dir, e.name)] : []).sort();
}
const moduleOfFile = (f: string) => {
  const [top, name] = f.split('/');
  return top === 'sites' ? `site:${name}` : name!;
};
// which process runs it, so which schemas an unqualified name means (core/src/pg.ts)
// (the path says, except for these few: who imports them runs them)
const PROCESS: Record<string, 'panel' | 'gate'> = {
  'packages/areas/src/manifest.ts': 'gate',      // applyManifest, from areas/src/gate/access.ts
};
const processOf = (f: string) => PROCESS[f] ?? (f.startsWith('packages/gate/') || f.includes('/src/gate/') ? 'gate' : 'panel');

function walk(n: unknown, visit: (n: N, parents: N[]) => void, parents: N[] = []) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const c of n) walk(c, visit, parents); return; }
  const node = n as N;
  if (typeof node.type === 'string') visit(node, parents);
  const down = typeof node.type === 'string' ? [...parents, node] : parents;
  for (const [k, v] of Object.entries(node)) if (k !== 'type' && v && typeof v === 'object') walk(v, visit, down);
}
const parse = (file: string, src: string) => {
  const r = parseSync(file, src, { lang: file.endsWith('x') ? 'tsx' : 'ts' });
  if (r.errors.length) throw new Error(`${file}: ${r.errors[0]!.message}`);
  return r.program as unknown as N;
};
const stringOf = (n: N | undefined): string | null =>
  n?.type === 'Literal' && typeof n.value === 'string' ? n.value
    : n?.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0].value.cooked : null;

// ---------- tables and their owners

function tables(root: string): Record<string, TableInfo> {
  const snapshot = readFileSync(join(root, 'db/schema.snapshot.sql'), 'utf8');
  const live = [...snapshot.matchAll(/CREATE (?:TABLE|VIEW) ([a-z_]+\.[a-z_]+)/g)].map((m) => m[1]!);
  const creators = new Map<string, string>();
  const migrations = [
    ...readdirSync(join(root, 'db/migrations')).sort().map((f) => `db/migrations/${f}`),
    ...readdirSync(join(root, 'packages')).sort().flatMap((p) => existsSync(join(root, 'packages', p, 'migrations'))
      ? readdirSync(join(root, 'packages', p, 'migrations')).sort().map((f) => `packages/${p}/migrations/${f}`) : []),
  ];
  for (const m of migrations) {
    for (const x of readFileSync(join(root, m), 'utf8').matchAll(/CREATE (?:OR REPLACE )?(?:TABLE|VIEW) (?:IF NOT EXISTS )?([a-z_]+\.[a-z_]+)/gi)) {
      if (!creators.has(x[1]!)) creators.set(x[1]!, m);
    }
  }
  const out: Record<string, TableInfo> = {};
  for (const t of live.sort()) {
    const createdBy = creators.get(t) ?? '(code)';
    const moved = MOVED[t];
    const pkg = createdBy.startsWith('packages/') ? createdBy.split('/')[1]! : null;
    const owner = moved?.owner ?? pkg ?? BASELINE[t];
    if (!owner) throw new Error(`coupling report: ${t} (made by ${createdBy}) has no owner: add it to BASELINE or MOVED in tools/coupling/scan.ts`);
    out[t] = { owner, createdBy, ...(moved ? { why: moved.why } : pkg ? {} : { why: 'baseline: by meaning' }) };
  }
  return out;
}

function searchPaths(root: string): Record<'panel' | 'gate', string[]> {
  const src = readFileSync(join(root, 'packages/core/src/pg.ts'), 'utf8');
  const path = (role: string) => {
    const m = new RegExp(`\\b${role}: '([^']+)'`).exec(/const SEARCH_PATH[^=]*=\s*\{([^}]*)\}/.exec(src)?.[1] ?? '');
    if (!m) throw new Error(`coupling report: no search path for ${role} in core/src/pg.ts`);
    return m[1]!.split(',').map((s) => s.trim());
  };
  return { panel: path('panel'), gate: path('gate') };
}

// ---------- SQL in one file

// A reference to a table after the words that name one. CREATE TABLE is left out on purpose:
// runtime code creates only SQLite tables (the media index), never the panel's.
const REF = /\b(DELETE\s+FROM|INSERT\s+INTO|FROM|JOIN|INTO|UPDATE|USING|ALTER\s+TABLE|TRUNCATE(?:\s+TABLE)?|LOCK\s+TABLE)\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:"?([a-z_][a-z0-9_]*)"?\.)?"?([a-z_][a-z0-9_]*)"?/g;
const WRITES = /^(DELETE|INSERT|INTO|UPDATE|ALTER|TRUNCATE|LOCK)/;

export function sqlRefs(text: string): { schema: string | null; name: string; access: 'read' | 'write' }[] {
  return [...text.matchAll(REF)].map((m) => ({ schema: m[2] ?? null, name: m[3]!, access: WRITES.test(m[1]!) ? 'write' as const : 'read' as const }));
}

// The SQL texts of a file, leaving out what goes to SQLite (prepare / exec on a DatabaseSync).
export function sqlTexts(file: string, src: string): string[] {
  const program = parse(file, src);
  const sqlite = /from 'node:sqlite'/.test(src);
  const out: string[] = [];
  walk(program, (n, parents) => {
    let text: string | null = null;
    if (n.type === 'Literal' && typeof n.value === 'string') text = n.value;
    else if (n.type === 'TemplateLiteral') text = n.quasis.map((q: N) => q.value.cooked ?? q.value.raw).join(' ? ');
    if (text === null || !REF.test(text)) return;
    REF.lastIndex = 0;
    const parent = parents[parents.length - 1];
    if (parent?.type === 'ImportDeclaration' || parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportAllDeclaration') return;
    if (parent?.type === 'TemplateLiteral') return;    // a piece of a template: read with the whole
    if (sqlite && parent?.type === 'CallExpression' && parent.arguments.includes(n)
      && parent.callee.type === 'MemberExpression' && ['prepare', 'exec'].includes(parent.callee.property?.name)) return;
    out.push(text);
  });
  return out;
}

// ---------- ops

function serverOps(root: string, file: string): string[] {
  const src = readFileSync(join(root, file), 'utf8');
  const ops = new Set<string>();
  walk(parse(file, src), (n, parents) => {
    if (n.type === 'SwitchCase') { const s = stringOf(n.test); if (s) ops.add(s); }
    // streams: { op: handler } (uploads, downloads, the thumbnail service's one op)
    const parent = parents[parents.length - 1];
    if (n.type === 'ObjectExpression' && parent?.type === 'Property' && parent.key?.name === 'streams') {
      for (const p of n.properties) if (p.type === 'Property') ops.add(p.key.name ?? p.key.value);
    }
  });
  return [...ops].sort();
}

// Which packages answer each gate admin op: what the op's case uses, followed through the
// gate's own functions. An op that uses no module's code is the gate's own ('gate'), or the
// kernel's when it goes through core/src/gate (the stores K-a splits: 'core').
function gateOps(root: string): Record<string, GateOp> {
  const file = SERVERS.gate!.file;
  const src = readFileSync(join(root, file), 'utf8');
  const program = parse(file, src);
  const imported = new Map<string, string>();
  const local = new Map<string, N>();
  let sw: N | null = null;
  walk(program, (n) => {
    if (n.type === 'ImportDeclaration') {
      const from: string = n.source.value;
      const pkg = from.startsWith('@panel/') ? (from.startsWith('@panel/core/gate/') ? 'core:gate' : from.split('/')[1]!) : from.startsWith('.') ? 'gate' : null;
      if (pkg) for (const s of n.specifiers) imported.set(s.local.name, pkg);
    }
    if (n.type === 'FunctionDeclaration' && n.id) local.set(n.id.name, n);
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && /Function|Arrow/.test(n.init?.type ?? '')) local.set(n.id.name, n.init);
    if (n.type === 'SwitchStatement' && src.slice(n.discriminant.start, n.discriminant.end) === 'req.op') sw = n;
  });
  if (!sw) throw new Error(`coupling report: no switch (req.op) in ${file}`);
  // the gate's own answer to "which module is this op", run as written
  const fn = local.get('moduleOf');
  if (!fn) throw new Error(`coupling report: no moduleOf() in ${file}`);
  const js = transformSync('moduleOf.ts', src.slice(fn.start, fn.end), {}).code;
  const moduleOf = new Function(`${js}\nreturn moduleOf;`)() as (op: string) => string | null;
  const uses = (body: N[], seen: Set<string>): Set<string> => {
    const pkgs = new Set<string>();
    walk(body, (n, parents) => {
      if (n.type !== 'Identifier') return;
      const p = parents[parents.length - 1];
      if (p?.type === 'MemberExpression' && p.property === n && !p.computed) return;
      if (p?.type === 'Property' && p.key === n && !p.shorthand) return;
      const pkg = imported.get(n.name);
      if (pkg) pkgs.add(pkg);
      else if (local.has(n.name) && !seen.has(n.name)) {
        seen.add(n.name);
        for (const x of uses([local.get(n.name)!], seen)) pkgs.add(x);
      }
    });
    return pkgs;
  };
  const out: Record<string, GateOp> = {};
  let waiting: string[] = [];
  for (const c of (sw as N).cases as N[]) {
    const s = stringOf(c.test);
    if (s) waiting.push(s);
    if (!c.consequent.length) continue;           // falls through to the next case's body
    const pkgs = uses(c.consequent, new Set());
    const modules = [...pkgs].filter((p) => p !== 'gate' && p !== 'core' && p !== 'core:gate').sort();
    const runs = modules.length ? modules : pkgs.has('core:gate') ? ['core'] : ['gate'];
    for (const op of waiting) out[op] = { module: moduleOf(op) ?? 'gate', runs };
    waiting = [];
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function serverOf(file: string, src: string, call: N, local: Map<string, string>): string | null {
  const callee = src.slice(call.callee.start, call.callee.end);
  if (local.has(callee)) return local.get(callee)!;
  if (CLIENTS[callee]) return CLIENTS[callee]!;
  if (/^callJsonLine(Read|Upload)?$/.test(callee)) return LABELS[stringOf(call.arguments[2]) ?? ''] ?? null;
  if (callee === 'JSON.stringify') return RAW_WRITES[file] ?? null;
  const last = callee.split('.').pop()!;
  return CLIENTS[last] ?? null;
}

// ---------- the report

export function makeReport(root: string): Report {
  const files = ['packages', 'sites'].flatMap((top) => readdirSync(join(root, top)).sort()
    .flatMap((p) => parts.flatMap((part) => sourceFiles(root, `${top}/${p}/${part}`))));
  const modules = readdirSync(join(root, 'packages')).filter((p) => p !== 'core' && p !== 'gate' && p !== 'modules').sort();
  const depsOf = (m: string): string[] => {
    const pj = JSON.parse(readFileSync(join(root, 'packages', m, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    return Object.keys(pj.dependencies ?? {}).map((d) => d.replace('@panel/', ''));
  };

  const tbl = tables(root);
  const paths = searchPaths(root);
  const schemas = new Set(Object.keys(tbl).map((t) => t.split('.')[0]!));
  const servers = Object.fromEntries(Object.entries(SERVERS).map(([k, v]) => [k, { ...v, ops: serverOps(root, v.file) }]));
  const gate = gateOps(root);

  const touches = new Map<string, Set<string>>();       // module|table|access -> files
  let sqlOwn = 0;
  const sqlUnsure: Report['sqlUnsure'] = [];
  const calls = new Map<string, Set<string>>();         // from|server|op -> files
  const unplaced: Report['unplaced'] = [];
  const naming = new Map<string, number>();             // file|module|how -> count

  const serverFiles = files.filter((f) => /createJsonLineServer\(/.test(readFileSync(join(root, f), 'utf8')) && f !== 'packages/core/src/jsonline.ts');
  const known = Object.values(SERVERS).map((s) => s.file).sort();
  if (JSON.stringify(serverFiles.sort()) !== JSON.stringify(known)) {
    throw new Error(`coupling report: the JSON-line servers are ${serverFiles.join(', ')}; SERVERS in tools/coupling/scan.ts knows ${known.join(', ')}`);
  }

  for (const file of files) {
    const src = readFileSync(join(root, file), 'utf8');
    const mod = moduleOfFile(file);
    const server = file.split('/')[2] === 'src';

    // 1. SQL (server code only: the pages and widgets run in a browser)
    if (server) {
      for (const text of sqlTexts(file, src)) {
        for (const r of sqlRefs(text)) {
          let table: string | null = null;
          if (r.schema) {
            if (!schemas.has(r.schema)) continue;            // pg_catalog, information_schema, her databases
            table = `${r.schema}.${r.name}`;
            if (!tbl[table]) { sqlUnsure.push({ file, table, why: 'no such table' }); continue; }
          } else {
            const mine = paths[processOf(file)].find((s) => tbl[`${s}.${r.name}`]);
            if (mine) table = `${mine}.${r.name}`;
            else {
              const other = paths[processOf(file) === 'gate' ? 'panel' : 'gate'].find((s) => tbl[`${s}.${r.name}`]);
              if (!other) continue;                         // a CTE, an alias, a function, her tables
              table = `${other}.${r.name}`;
              sqlUnsure.push({ file, table, why: `runs in the ${processOf(file)} process by its path, but only the other one sees this table` });
            }
          }
          if (tbl[table]!.owner === mod) { sqlOwn++; continue; }
          const key = `${mod}|${table}|${r.access}`;
          if (!touches.has(key)) touches.set(key, new Set());
          touches.get(key)!.add(file);
        }
      }
    }

    // 2. ops sent, and 3. modules named (both only where they can be: parse once)
    const program = parse(file, src);
    // the file's own clients: a function whose body opens a known socket
    const local = new Map<string, string>();
    walk(program, (n) => {
      const fn = n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && /Function|Arrow/.test(n.init?.type ?? '') ? n.init
        : n.type === 'FunctionDeclaration' && n.id ? n : null;
      if (!fn) return;
      const sockets = new Set([...src.slice(fn.start, fn.end).matchAll(/\b([a-z]+)Socket\b/g)].map((m) => SOCKETS[m[1]!]).filter(Boolean));
      if (sockets.size === 1) local.set((n.id as N).name, [...sockets][0]!);
    });
    const kernel = mod === 'core' || mod === 'gate' || mod.startsWith('site:');
    walk(program, (n, parents) => {
      if (n.type === 'ObjectExpression') {
        const opProp = n.properties.find((p: N) => p.type === 'Property' && (p.key.name === 'op' || p.key.value === 'op'));
        const op = opProp ? stringOf(opProp.value) : null;
        if (!op) return;
        const parent = parents[parents.length - 1];
        if (parent?.type !== 'CallExpression' || !parent.arguments.includes(n)) {
          unplaced.push({ file, op, why: 'not handed straight to a client' });
          return;
        }
        const s = serverOf(file, src, parent, local);
        if (!s) { unplaced.push({ file, op, why: `sent through ${src.slice(parent.callee.start, parent.callee.end)}` }); return; }
        const key = `${mod}|${s}|${op}`;
        if (!calls.has(key)) calls.set(key, new Set());
        calls.get(key)!.add(file);
        return;
      }
      if (!kernel) return;
      if (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ImportExpression') {
        const m = /^@panel\/([a-z-]+)\//.exec(n.source?.value ?? '');
        if (m && modules.includes(m[1]!)) {
          const key = `${file}|${m[1]}|import`;
          naming.set(key, (naming.get(key) ?? 0) + 1);
        }
        return;
      }
      if (n.type === 'Literal' && typeof n.value === 'string' && modules.includes(n.value)) {
        const parent = parents[parents.length - 1];
        if (parent?.type === 'ImportDeclaration' || parent?.type === 'ImportExpression' || parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportAllDeclaration') return;
        const key = `${file}|${n.value}|name`;
        naming.set(key, (naming.get(key) ?? 0) + 1);
      }
    });
  }

  const sqlCross: SqlTouch[] = [...touches].map(([k, f]) => {
    const [module, table, access] = k.split('|') as [string, string, 'read' | 'write'];
    return { module, table, access, files: [...f].sort() };
  }).sort((a, b) => a.module.localeCompare(b.module) || a.table.localeCompare(b.table) || a.access.localeCompare(b.access));

  const callList: OpCall[] = [...calls].map(([k, f]) => {
    const [from, server, op] = k.split('|') as [string, string, string];
    const owner = server === 'gate' ? gate[op]?.module ?? '?' : SERVERS[server]!.module;
    return { from, server, op, owner, files: [...f].sort() };
  }).sort((a, b) => a.from.localeCompare(b.from) || a.server.localeCompare(b.server) || a.op.localeCompare(b.op));
  for (const c of callList) {
    if (!servers[c.server]!.ops.includes(c.op)) unplaced.push({ file: c.files[0]!, op: c.op, why: `the ${c.server} server has no op by that name` });
  }

  const undeclared = new Map<string, Set<string>>();
  for (const c of callList) {
    if (c.from.startsWith('site:')) continue;              // a site may use anything (rule 4 is about its SQL and logic)
    const deps = c.from === 'gate' ? [] : depsOf(c.from);
    const o = c.owner;
    if (o === c.from || o === 'core' || o === 'gate' || o === '?' || deps.includes(o)) continue;
    const key = `${c.from}|${o}`;
    if (!undeclared.has(key)) undeclared.set(key, new Set());
    undeclared.get(key)!.add(`${c.server}:${c.op}`);
  }

  return {
    tables: tbl,
    sqlOwn,
    sqlCross,
    sqlUnsure: dedupe(sqlUnsure.map((u) => JSON.stringify(u))).map((s) => JSON.parse(s) as Report['sqlUnsure'][number]),
    servers,
    gateOps: gate,
    calls: callList,
    undeclared: [...undeclared].map(([k, v]) => ({ from: k.split('|')[0]!, to: k.split('|')[1]!, via: [...v].sort() }))
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    unplaced: dedupe(unplaced.map((u) => JSON.stringify(u))).map((s) => JSON.parse(s) as Report['unplaced'][number]),
    naming: [...naming].map(([k, count]) => {
      const [file, module, how] = k.split('|') as [string, string, 'import' | 'name'];
      return { file, module, how, count };
    }).sort((a, b) => a.file.localeCompare(b.file) || a.module.localeCompare(b.module) || a.how.localeCompare(b.how)),
  };
}
const dedupe = (xs: string[]) => [...new Set(xs)].sort();
