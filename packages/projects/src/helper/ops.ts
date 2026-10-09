// What the projects helper does (docs/phase8b-plan.md "The projects helper"). Every piece of
// work is a named systemd unit (@panel/core/runner): as svc-lfdln-apps for the project's own
// folders and its build containers, as root only to make or trash a project's folder in
// /srv/lfdln-projects (root's). The helper itself never switches user and never runs a build
// in its own process; it reads /srv but writes only its state folder.
//
// Step 8b-1: the record, the ports, the job queue, the build environment's check.
// Step 8b-2: static projects -- make (the starter tool, the first commit), build a branch into
// a release, roll back, delete (to the trash, 30 days).
// Step 8b-3: git and the dev branch -- owners and a Unix group per project, the repository
// shared with that group (D3-2..4), pushes from the hook's spool (D3-5), the dev branch and
// Put dev live (D3-7).
// Step 8b-4a: Next.js servers -- a release image per build, two ports per branch, the new
// release started beside the live one and nginx switched to it once it answers (D4-2..10).
// Step 8b-4b: each branch's environment (D4-11) -- kept here, root's; an env file the server's
// Quadlet reads, and the same handed to each build; and how each server is, for monitoring
// (D4-12). Step 8b-5: each branch's database, as the panel made it.
// Step 8b-8a: packages -- checked, added, updated, removed, fixed (a commit, then a build; undone
// if the build fails), its scripts run; the npm registry searched from a short box.
// Step 8b-8b: every box on the internal network lfdln-build, out only through lfdln-build-proxy
// (P8b-11); each night, every project's packages checked (and updated, if it says so).
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Runner, RunResult } from '@panel/core/runner';
import { createQueue, JOB_ID_RE, type Queue } from '../jobs.ts';
import {
  BRANCHES, DB_ENGINES, DB_NAME_RE, freePorts, LONG_RUNNING, PKG_NAME_RE, PKG_SPEC_RE, SCRIPT_RE, groupOf, isProjectId, isServer, KEEP_RELEASES, KINDS, loadRecord, MADE_KINDS, MAX_OWNERS, OWNER_RE, PORT_MAX, PORT_MIN, portsOf, ProjectsError, RELEASE_RE, saveRecord,
  type Branch, type BranchDatabase, type Kind, type PackageManager, type Project, type Release,
} from '../record.ts';

// who builds and runs the projects (exam prep's user too), and the image every Node build runs in
export const APPS_USER = 'svc-lfdln-apps';
export const BUILD_IMAGE = 'localhost/lfdln-build-node:current';
export const PROJECTS_ROOT = '/srv/lfdln-projects';
// the scripts that run inside the build container (read-only there, as /lfdln)
export const CONTAINER_DIR = fileURLToPath(new URL('../../container', import.meta.url));
export const TRASH_DAYS = 30;
// the push hook every project's repository runs (root's, in the release), the spool it drops
// pushes into, the group that may drop them, and the list of repositories git lets their
// group push to (/etc/gitconfig includes it)
export const HOOKS_DIR = fileURLToPath(new URL('../../git-hooks', import.meta.url));
export const SPOOL = '/run/lfdln-projects/pushes';
export const GIT_GROUP = 'lfdln-git';
export const SAFE_FILE = '/etc/lfdln-projects/gitconfig';
// the helper's own git: no hook a pusher could have set runs as svc-lfdln-apps (D3-6)
const GIT = ['git', '-c', 'core.hooksPath=/dev/null'];
const SHA_RE = /^[0-9a-f]{40}$/;
// a server's release image is built on the build image's own base, never pulled at deploy (D4-2)
export const RUN_IMAGE = 'docker.io/library/node:24-bookworm-slim';
// where the projects helper keeps one nginx upstream per server branch (D4-4)
export const NGINX_DIR = '/etc/nginx/lfdln-projects';
// how long a new release has to answer before nothing is switched (D4-4)
const ANSWER_MS = 90_000;
// what a branch's server may use (D4-3): main twice what dev gets
const MEMORY: Record<Branch, string> = { main: '512m', dev: '256m' };

// A branch's environment (D4-11): names as the shell has them, one line each, 100 at most.
// The first four are the panel's (the release image sets them); HOME and CI are the build
// box's own; the last two the server's Quadlet sets (the gate's key, docs/s1-plan.md S1a).
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const PANEL_ENV = ['PORT', 'HOSTNAME', 'NODE_ENV', 'NEXT_TELEMETRY_DISABLED', 'HOME', 'CI', 'LFDLN_IDENTITY_KEY', 'LFDLN_IDENTITY_AUDIENCE'];
export const MAX_ENV = 100;
export const ENV_VALUE_MAX = 4096;
// in the files every visitor gets, not secret (D4-11: a warning on the page)
export const PUBLIC_ENV = ['NEXT_PUBLIC_', 'VITE_'];
export const isPublicEnv = (name: string) => PUBLIC_ENV.some((x) => name.startsWith(x));
// moved: refresh's before-copy (S1f (a)); an older release keeps it as it is
export type EnvStore = { version: 1; branches: Partial<Record<Branch, Record<string, string>>>; moved?: Partial<Record<Branch, MovedCopy>> };
// what a change takes before it is used: a static project's are built in; a server's are read
// when it starts, but for those built into the pages (NEXT_PUBLIC_)
export type EnvNeeds = 'rebuild' | 'restart' | 'nothing';
// podman's env file: NAME=value a line, the value as it is (no quotes)
export const envFileText = (vars: Record<string, string>) => Object.keys(vars).sort().map((k) => `${k}=${vars[k]}\n`).join('');

export type Probe = (port: number, path: string, timeoutMs: number) => Promise<{ status: number | null; ms: number }>;
const slotWord = (slot: 0 | 1) => (slot === 0 ? 'a' : 'b');
// a slot's container and unit: proj-<name>-<branch>-<a|b>
export const unitOf = (id: string, branch: Branch, slot: 0 | 1) => `proj-${id}-${branch}-${slotWord(slot)}`;
export const upstreamOf = (id: string, branch: Branch) => `lfdln-project-${id}-${branch}`;

// The release image (D4-2): root owns the code, the server runs as node, on 3000 inside.
export const CONTAINERFILE = [
  '# A project\'s release (docs/phase8b-plan.md D4-2): written by the projects helper.',
  `FROM ${RUN_IMAGE}`,
  'ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0',
  'WORKDIR /app',
  'COPY --chown=root:root . /app/',
  'USER node',
  'EXPOSE 3000',
  'CMD ["node", "server.js"]',
  '',
].join('\n');

// The gate's public key (docs/s1-plan.md S1a): what a project's server checks X-Lfdln-Proof
// with. Public, so outside /etc/lfdln-panel (which this helper may not read); none: none told.
export const IDENTITY_PUB = '/etc/lfdln-identity/identity.pub';
export function identityKeyOf(file: string = IDENTITY_PUB): string | undefined {
  try {
    const k = readFileSync(file, 'utf8').trim();
    return /^[A-Za-z0-9_-]{43}$/.test(k) ? k : undefined;
  } catch {
    return undefined;
  }
}

// A project's network (docs/s1-plan.md S1d, S1-Q6): pasta, IPv4 only (as slirp4netns was), an
// address of its own (10.0.2.100; else pasta gives it the server's, and the server's own
// websites would answer from inside the container), and of the host's 127.0.0.1 only the
// database ports, forwarded to the container's own 127.0.0.1 (-T). No way to the gateway
// (--no-map-gw): 10.0.2.2 goes nowhere, the panel, the gate and the other apps can't be asked.
export const PROJECT_ADDRESS = '10.0.2.100';
export const PROJECT_GATEWAY = '10.0.2.2';
// the network before S1d (every port of the host's loopback at 10.0.2.2): written again only
// by putBack (S1f), the step before an older release is installed
export const HOST_LOOPBACK = 'slirp4netns:allow_host_loopback=true';
export function projectNetwork(dbPorts: readonly number[] = []): string {
  const ports = [...new Set(dbPorts)].filter((p) => Number.isInteger(p) && p > 0 && p < 65536).sort((a, b) => a - b);
  return ['pasta:-4', '--no-map-gw', '-a', PROJECT_ADDRESS, '-n', '24', '-g', PROJECT_GATEWAY, ...ports.flatMap((p) => ['-T', String(p)])].join(',');
}

// What refresh (S1d) and putBack (S1f) say of a branch. `env` names the variables moved,
// `left` those still naming 10.0.2.2 (never values).
export type Refreshed = { project: string; branch: Branch; result: 'redeployed' | 'unchanged' | 'stopped' | 'failed' | 'kept'; env: string[]; left?: string[]; error?: string };
// The plain host variables moved when their port says it is an engine's (PGHOST + PGPORT ...)
export const HOST_PORT_VARS: Record<string, string> = {
  PGHOST: 'PGPORT', DB_HOST: 'DB_PORT', DATABASE_HOST: 'DATABASE_PORT', POSTGRES_HOST: 'POSTGRES_PORT', MYSQL_HOST: 'MYSQL_PORT', MARIADB_HOST: 'MARIADB_PORT',
};
export const OLD_HOST = '10.0.2.2';
const NEW_HOST = '127.0.0.1';
// a value naming the old way to the host (S1f (b): a warning on the Environment page)
export const namesOldHost = (value: string) => value.includes(OLD_HOST);
// The before-copy refresh keeps of what it moved (S1f (a)), per branch: name -> its value
// before (`from`) and the one refresh wrote (`to`)
export type MovedCopy = Record<string, { from: string; to: string }>;
// A branch's variables with one host told another where it is sure the address is one of the
// engines (`ports`): a URL's @<host>:<port>, libpq's host=<host> port=<port>, and a
// HOST_PORT_VARS variable that is exactly <host> with an engine's port. Never public ones.
function rehost(vars: Record<string, string>, ports: ReadonlySet<number>, from: string, to: string, skip: (k: string) => boolean = () => false) {
  const out = { ...vars };
  const moved: string[] = [];
  const engine = (port: string) => ports.has(Number(port));
  const f = from.replace(/\./g, '\\.');
  const url = new RegExp(`@${f}:(\\d+)(?=[/?#]|$)`, 'g');
  const libpq = new RegExp(`\\bhost=${f}(\\s+port=(\\d+))\\b`, 'g');
  for (const [k, v] of Object.entries(vars)) {
    if (isPublicEnv(k) || skip(k)) continue;
    let nv = v.replace(url, (m, port: string) => (engine(port) ? `@${to}:${port}` : m));
    nv = nv.replace(libpq, (m, rest: string, port: string) => (engine(port) ? `host=${to}${rest}` : m));
    const portVar = HOST_PORT_VARS[k];
    if (portVar && nv === from && engine(vars[portVar] ?? '')) nv = to;
    if (nv !== v) { out[k] = nv; moved.push(k); }
  }
  return { vars: out, moved };
}
// A branch's variables with its database addresses at 10.0.2.2 told 127.0.0.1 (S1d). `left`:
// the others that still name 10.0.2.2 after that.
export function moveVars(vars: Record<string, string>, ports: ReadonlySet<number>) {
  const { vars: out, moved } = rehost(vars, ports, OLD_HOST, NEW_HOST);
  const left = Object.keys(out).filter((k) => !isPublicEnv(k) && namesOldHost(out[k]!)).sort();
  return { vars: out, moved: moved.sort(), left };
}
// ...and back (S1f (a), a rollback of S1d): each variable refresh moved, from its before-copy,
// while it still has the value refresh wrote; any other database address at 127.0.0.1 (moved
// by a release before the copy was kept, or made since at 127.0.0.1) told 10.0.2.2 the same
// way refresh told it 127.0.0.1. `fromCopy`: those put back from the copy.
export function backVars(vars: Record<string, string>, ports: ReadonlySet<number>, copy: MovedCopy = {}) {
  const fromCopy = Object.keys(copy).filter((k) => !isPublicEnv(k) && vars[k] !== undefined && vars[k] === copy[k]!.to && copy[k]!.from !== copy[k]!.to).sort();
  const { vars: out, moved } = rehost(vars, ports, NEW_HOST, OLD_HOST, (k) => fromCopy.includes(k));
  for (const k of fromCopy) out[k] = copy[k]!.from;
  return { vars: out, moved: [...fromCopy, ...moved].sort(), fromCopy };
}

// A slot's Quadlet (D4-3), exam prep's shape. identityKey: the gate's public key, told to the
// server with the name its proofs are made out to (docs/s1-plan.md S1a); net: the engines it
// may reach on its own 127.0.0.1 (S1d), or HOST_LOOPBACK, as before S1d (only putBack, S1f)
export function quadletText(id: string, branch: Branch, slot: 0 | 1, port: number, image: string, envFile?: string, identityKey?: string, net: readonly number[] | typeof HOST_LOOPBACK = []): string {
  const unit = unitOf(id, branch, slot);
  return [
    `# lfdln project ${id}, ${branch}, slot ${slotWord(slot)} (docs/phase8b-plan.md D4-3): written by the projects helper.`,
    '[Unit]',
    `Description=lfdln project ${id} (${branch}, slot ${slotWord(slot)})`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Container]',
    `Image=${image}`,
    `ContainerName=${unit}`,
    `PublishPort=127.0.0.1:${port}:3000`,
    // its environment (8b-4b, D4-11): svc-lfdln-apps' file, 600
    ...(envFile ? [`EnvironmentFile=${envFile}`] : []),
    // who is signed in comes with the gate's proof, for this branch alone (docs/s1-plan.md S1a)
    ...(identityKey && /^[A-Za-z0-9_-]{43}$/.test(identityKey)
      ? [`Environment=LFDLN_IDENTITY_KEY=${identityKey}`, `Environment=LFDLN_IDENTITY_AUDIENCE=project.${id}.${branch}`] : []),
    // its database on the host (8b-5) at 127.0.0.1, and nothing else there (S1d)
    `Network=${net === HOST_LOOPBACK ? HOST_LOOPBACK : projectNetwork(net)}`,
    `Label=lfdln.project=${id}`,
    `Label=lfdln.branch=${branch}`,
    'ReadOnly=true',
    'Tmpfs=/tmp:rw,size=64m,mode=1777',
    'Tmpfs=/app/.next/cache:rw,size=128m,mode=1777',
    'DropCapability=all',
    'NoNewPrivileges=true',
    `PodmanArgs=--memory=${MEMORY[branch]} --cpus=1 --pids-limit=256`,
    'HealthCmd=node /app/.lfdln-health.mjs',
    'HealthInterval=30s',
    'HealthRetries=3',
    'HealthStartPeriod=20s',
    'HealthOnFailure=kill',
    '',
    '[Service]',
    'Restart=always',
    'RestartSec=2',
    'TimeoutStartSec=120',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// A branch's upstream (D4-4): its live slot's port, or nowhere (down) until one runs.
export function upstreamText(id: string, branch: Branch, port: number | null): string {
  return [
    `# lfdln project ${id}, ${branch} (docs/phase8b-plan.md D4-4): written by the projects helper.`,
    `upstream ${upstreamOf(id, branch)} {`,
    port === null ? '    server 127.0.0.1:9 down;   # nothing running yet' : `    server 127.0.0.1:${port};`,
    '}',
    '',
  ].join('\n');
}
// The boxes' network (8b-8b, P8b-11): internal, its one way out the proxy, which lets through
// HTTPS to the registries only (container/proxy-allow.txt). npm, pnpm and git read the proxy
// from the environment; Node's own fetch (the registry box) does with NODE_USE_ENV_PROXY.
export const BUILD_NETWORK = 'lfdln-build';
export const BUILD_PROXY = 'http://lfdln-build-proxy:3128';
export const PROXY_UNIT = 'lfdln-build-proxy.service';
export const proxyArgs = (network: string | null) => (network === null ? [] : [`--network=${network}`,
  ...['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].flatMap((k) => ['-e', `${k}=${BUILD_PROXY}`]),
  '-e', 'NO_PROXY=localhost,127.0.0.1', '-e', 'no_proxy=localhost,127.0.0.1', '-e', 'NODE_USE_ENV_PROXY=1']);
// a build: 15 minutes, 2 GB, 2 CPUs (G9)
const BUILD_SECONDS = 900;

export type ProjectsDeps = {
  recordFile: string;
  stateDir: string;               // jobs.json and the job logs
  run: Runner;
  now: () => number;
  root?: string;                  // the tests' stand-in for "/" (/etc/passwd)
  projectsRoot?: string;          // the tests' stand-in for /srv/lfdln-projects
  containerDir?: string;
  hooksDir?: string;
  spool?: string;                 // the tests' stand-in for /run/lfdln-projects/pushes
  safeFile?: string;
  probe?: Probe;                  // asks a server on 127.0.0.1 (8b-4)
  sleep?: (ms: number) => Promise<void>;
  nginxDir?: string;              // the tests' stand-in for /etc/nginx/lfdln-projects
  answerMs?: number;              // how long a new release has to answer (90 s)
  buildNetwork?: string | null;   // the boxes' network (lfdln-build); null: the tests' own
  identityPub?: string;           // the tests' stand-in for /etc/lfdln-identity/identity.pub
  dbPorts?: number[];             // the engines a project reaches on its own 127.0.0.1 (S1d)
  log?: (line: string) => void;
};

export type Versions = { node: string; npm: string; pnpm: string; git: string };
export type NewProject = { id: string; kind: Kind; pm: PackageManager; typescript: boolean; tailwind: boolean };
type Passwd = { name: string; uid: number; gid: number; home: string; shell: string };
const lastLines = (r: RunResult, n = 3) => (r.stderr || r.stdout).trim().split('\n').slice(-n).join(' | ').slice(0, 300);
// "20261005173000" from seconds
export const releaseIdAt = (s: number) => new Date(s * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);

export function createProjectsOps(d: ProjectsDeps) {
  const queue: Queue = createQueue({ dir: d.stateDir, now: d.now, log: d.log });
  const record = () => loadRecord(d.recordFile);
  const save = (r: ReturnType<typeof record>) => saveRecord(d.recordFile, r);
  const top = d.projectsRoot ?? PROJECTS_ROOT;
  const dirOf = (id: string) => join(top, id);
  const trash = join(top, '.trash');

  const passwd = async (): Promise<Passwd[]> => {
    let text = '';
    try { text = await readFile(join(d.root ?? '/', 'etc/passwd'), 'utf8'); } catch { /* none */ }
    return text.split('\n').map((line) => line.split(':')).filter((f) => f[0] && /^\d+$/.test(f[2] ?? '') && /^\d+$/.test(f[3] ?? ''))
      .map((f) => ({ name: f[0]!, uid: Number(f[2]), gid: Number(f[3]), home: f[5] ?? '', shell: f[6] ?? '' }));
  };
  const appsUser = async () => {
    const u = (await passwd()).find((x) => x.name === APPS_USER);
    if (u) return { user: APPS_USER, uid: u.uid, gid: u.gid, home: u.home || `/var/lib/${APPS_USER}` };
    throw new ProjectsError('unavailable', `The projects' system user (${APPS_USER}) is missing: run install-lfdln.sh.`);
  };
  // The owners who have a Unix account (D3-2): the same name, a person's uid, a login shell;
  // never a system user, whatever a panel account is called.
  const unixPeople = async (names: readonly string[]) => {
    const all = await passwd();
    return names.filter((n) => all.some((u) => u.name === n && u.uid >= 1000 && u.uid < 60000 && !n.startsWith('svc-')
      && /^\/(usr\/)?bin\/[a-z]+$/.test(u.shell) && !/(nologin|false)$/.test(u.shell)));
  };
  // a group's members, from /etc/group
  const groupMembers = (name: string): string[] => {
    let text = '';
    try { text = readFileSync(join(d.root ?? '/', 'etc/group'), 'utf8'); } catch { /* none */ }
    const f = text.split('\n').map((l) => l.split(':')).find((x) => x[0] === name);
    return f?.[3] ? f[3].split(',').filter(Boolean) : [];
  };
  const asApps = async (argv: string[], what: string, timeoutSec = 120) => {
    const { user, uid, home } = await appsUser();
    return d.run({ as: { user, uid, home }, argv, what, timeoutSec });
  };
  const asRoot = (argv: string[], what: string) => d.run({ as: 'root', argv, what, timeoutSec: 300 });
  const must = (r: RunResult, words: string) => {
    if (r.code !== 0) throw new ProjectsError('internal', `${words} (${lastLines(r)}).`);
    return r;
  };

  // asked of podman at most once a minute (the page asks for info every few seconds while a
  // job runs); a check always asks afresh
  let imageSeen: { at: number; there: boolean } | null = null;
  const imageThere = async (fresh = false) => {
    if (!fresh && imageSeen && d.now() - imageSeen.at < 60) return imageSeen.there;
    let there = false;
    try { there = (await asApps(['podman', 'image', 'exists', BUILD_IMAGE], 'image-exists', 60)).code === 0; } catch { /* no user */ }
    imageSeen = { at: d.now(), there };
    return there;
  };

  // node, npm, pnpm and git in the build image: no network, read-only, small limits
  const versions = async (): Promise<Versions> => {
    const r = await asApps(['podman', 'run', '--rm', '--network=none', '--read-only', '--memory=512m', '--pids-limit=128', '--cpus=1',
      BUILD_IMAGE, '/usr/local/bin/lfdln-build-versions'], 'versions', 300);
    if (r.code !== 0) throw new ProjectsError('internal', `The build image didn't run (${lastLines(r)}).`);
    const v = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Partial<Versions>;
    if (![v.node, v.npm, v.pnpm, v.git].every((x) => typeof x === 'string' && x.length > 0 && x.length < 40)) throw new ProjectsError('internal', 'The build image answered something unexpected.');
    return v as Versions;
  };

  // One of the container scripts, as svc-lfdln-apps: the project's folders and nothing else
  // of the server's; its own user inside (keep-id: the files it writes are svc-lfdln-apps');
  // read-only but for them and a small /tmp; the network (the registries) open (P8b-11).
  //   --user too: the image's own USER (node, 1000) would win over keep-id, and 1000 inside is
  //   not svc-lfdln-apps outside, so the project's 700 folders would be shut to it
  //   envFile: the branch's environment (8b-4b), first, so the box's own -e settings win
  const net = d.buildNetwork === undefined ? BUILD_NETWORK : d.buildNetwork;
  const inBox = async (id: string, mounts: [string, string, 'ro' | 'rw'][], script: 'scaffold.mjs' | 'build.mjs' | 'packages.mjs', args: string[], log: (t: string) => void, envFile?: string) => {
    const u = await appsUser();
    const argv = [
      'podman', 'run', '--rm', `--timeout=${BUILD_SECONDS}`, '--userns=keep-id', `--user=${u.uid}:${u.gid}`, '--memory=2g', '--memory-swap=2g', '--cpus=2', '--pids-limit=1024',
      '--read-only', '--tmpfs', '/tmp:rw,size=512m,exec', '--label', `lfdln.project=${id}`,
      ...(envFile ? ['--env-file', envFile] : []),
      ...proxyArgs(net),
      '-e', 'HOME=/tmp/home', '-e', 'CI=1', '-e', 'NEXT_TELEMETRY_DISABLED=1', '-e', 'npm_config_update_notifier=false',
      '-e', 'npm_config_cache=/cache/npm', '-e', 'npm_config_store_dir=/cache/pnpm',
      ...mounts.flatMap(([host, inside, mode]) => ['-v', `${host}:${inside}:${mode}`]),
      '-v', `${d.containerDir ?? CONTAINER_DIR}:/lfdln:ro`,
      BUILD_IMAGE, 'node', `/lfdln/${script}`, ...args,
    ];
    const what = script === 'build.mjs' ? 'build' : script === 'scaffold.mjs' ? 'make' : 'packages';
    const r = await asApps(argv, what, BUILD_SECONDS + 60);
    log([r.stdout, r.stderr].filter(Boolean).join('\n'));
    if (r.code !== 0) throw new ProjectsError('internal', `${{ build: 'The build', make: 'Making it', packages: 'It' }[what]} failed: ${lastLines(r, 1).replace(/^FAILED: /, '')}`);
    try { return JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>; } catch {
      throw new ProjectsError('internal', 'The build container answered something unexpected.');
    }
  };

  // The npm registry, asked from a short box (8b-8a): the helper has no network of its own.
  // No folders, small, a minute.
  const registryBox = async (args: string[]) => {
    const u = await appsUser();
    const r = await asApps(['podman', 'run', '--rm', '--timeout=60', '--userns=keep-id', `--user=${u.uid}:${u.gid}`, '--memory=256m', '--cpus=1', '--pids-limit=128',
      '--read-only', '--tmpfs', '/tmp:rw,size=64m', '-e', 'HOME=/tmp', ...proxyArgs(net), '-v', `${d.containerDir ?? CONTAINER_DIR}:/lfdln:ro`,
      BUILD_IMAGE, 'node', '/lfdln/packages.mjs', ...args], 'registry', 90);
    if (r.code !== 0) throw new ProjectsError('unavailable', `The npm registry couldn't be asked: ${lastLines(r, 1).replace(/^FAILED: /, '')}`);
    try { return JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>; } catch {
      throw new ProjectsError('internal', 'The registry box answered something unexpected.');
    }
  };

  const projectOf = (id: unknown): Project => {
    if (!isProjectId(id)) throw new ProjectsError('invalid', 'Which project?');
    const p = record().projects.find((x) => x.id === id);
    if (!p) throw new ProjectsError('not-found', `There is no project called ${id}.`);
    return p;
  };
  const branchOf = (v: unknown): Branch => {
    if (!(BRANCHES as readonly unknown[]).includes(v)) throw new ProjectsError('invalid', 'Which branch: main or dev?');
    return v as Branch;
  };
  const update = (id: string, fn: (p: Project) => void) => {
    const r = record();
    const p = r.projects.find((x) => x.id === id);
    if (!p) throw new ProjectsError('not-found', `${id} isn't there any more.`);
    fn(p);
    save(r);
    return p;
  };

  // ---------------------------------------------------------------- git (8b-3)
  const repoOf = (id: string) => join(dirOf(id), 'repo.git');
  // The helper's own git on a project's repository, as svc-lfdln-apps (D3-6). A repository
  // whose top folder has a commondir or gitdir file (the one thing a pusher could add there
  // that changes what git reads) is refused.
  const git = async (id: string, args: string[], what: string) => {
    const odd = await asApps(['find', repoOf(id), '-maxdepth', '1', '(', '-name', 'commondir', '-o', '-name', 'gitdir', ')'], 'git-check');
    if (odd.code !== 0 || odd.stdout.trim()) throw new ProjectsError('internal', `${id}'s repository has something in it that shouldn't be there (${odd.stdout.trim().slice(0, 100) || lastLines(odd)}): ask momolig.`);
    return asApps([...GIT, `--git-dir=${repoOf(id)}`, ...args], what);
  };
  const headOf = async (id: string, branch: Branch): Promise<string | null> => {
    const r = await git(id, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], 'git-head');
    const sha = r.stdout.trim();
    return r.code === 0 && SHA_RE.test(sha) ? sha : null;
  };

  // The project's group (D3-2): svc-lfdln-apps and its owners with a Unix account; then
  // lfdln-git, who may drop pushes into the spool: svc-lfdln-apps and every project's people.
  const syncGroups = async (id: string, owners: readonly string[], log: (t: string) => void) => {
    const g = groupOf(id);
    must(await asRoot(['groupadd', '-f', '--system', g], 'group'), `Its group (${g}) couldn't be made`);
    const people = await unixPeople(owners);
    must(await asRoot(['gpasswd', '-M', [APPS_USER, ...people].join(','), g], 'group'), `Its group's members couldn't be set`);
    log(`group ${g}: ${people.length ? `${people.join(', ')} may push by SSH` : 'no owner has a Unix account, so nobody pushes by SSH yet'}`);
    await syncGitGroup(id, people);
  };
  const syncGitGroup = async (id?: string, people: string[] = []) => {
    const everyone = new Set<string>([APPS_USER, ...people]);
    for (const p of record().projects) if (p.id !== id) for (const u of await unixPeople(p.owners)) everyone.add(u);
    must(await asRoot(['gpasswd', '-M', [...everyone].join(','), GIT_GROUP], 'group'), `The pushers' group (${GIT_GROUP}) couldn't be set`);
  };

  // The repositories git lets their groups push to (D3-4): one safe.directory each.
  const writeSafeList = async (ids: string[]) => {
    const text = ['# lfdln projects (docs/phase8b-plan.md D3-4): written by the projects helper; /etc/gitconfig includes it.',
      '[safe]', ...ids.sort().map((id) => `\tdirectory = ${repoOf(id)}`), ''].join('\n');
    // tee, not `install /dev/stdin`: under systemd-run --pipe stdin is a socket, which
    // /dev/stdin can't open (and install had already removed the old list). A new file
    // beside it, then one rename: never half a list, never none.
    await putRootFile(d.safeFile ?? SAFE_FILE, text, 'safe-list', 'Git\'s list of shared repositories');
  };
  // A root file from the helper's text: tee into a new file beside it, 644, one rename.
  const putRootFile = async (file: string, text: string, what: string, words: string) => {
    must(await d.run({ as: 'root', argv: ['tee', `${file}.new`], what, timeoutSec: 60, stdin: text }), `${words} couldn't be written`);
    must(await asRoot(['chmod', '644', `${file}.new`], what), `${words} couldn't be made readable`);
    must(await asRoot(['mv', '-f', `${file}.new`, file], what), `${words} couldn't be put in place`);
  };
  // ...and one of svc-lfdln-apps' own (a Quadlet, a Containerfile)
  const putAppsFile = async (file: string, text: string, what: string, words: string) => {
    const u = await appsUser();
    must(await d.run({ as: { user: u.user, uid: u.uid, home: u.home }, argv: ['tee', `${file}.new`], what, timeoutSec: 60, stdin: text }), `${words} couldn't be written`);
    must(await asApps(['mv', '-f', `${file}.new`, file], what), `${words} couldn't be put in place`);
  };

  // ...one only svc-lfdln-apps may read (an env file): made 600 empty first, then filled
  const putAppsSecret = async (file: string, text: string, what: string, words: string) => {
    const u = await appsUser();
    must(await asApps(['install', '-m', '600', '/dev/null', `${file}.new`], what), `${words} couldn't be made`);
    must(await d.run({ as: { user: u.user, uid: u.uid, home: u.home }, argv: ['tee', `${file}.new`], what, timeoutSec: 60, stdin: text }), `${words} couldn't be written`);
    must(await asApps(['mv', '-f', `${file}.new`, file], what), `${words} couldn't be put in place`);
  };

  // ---------------------------------------------------------------- environment (8b-4b)
  // Kept in the helper's state folder (root's, 600), one file a project; written whole.
  const envDir = join(d.stateDir, 'env');
  const envStoreOf = (id: string) => join(envDir, `${id}.json`);
  const loadEnv = (id: string): EnvStore => {
    try {
      const v = JSON.parse(readFileSync(envStoreOf(id), 'utf8')) as EnvStore;
      if (v && v.version === 1 && v.branches && typeof v.branches === 'object') return v;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ProjectsError('internal', `${id}'s environment couldn't be read.`); }
    return { version: 1, branches: {} };
  };
  const saveEnv = (id: string, e: EnvStore) => {
    mkdirSync(envDir, { recursive: true, mode: 0o700 });
    const f = envStoreOf(id);
    writeFileSync(`${f}.new`, `${JSON.stringify(e, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${f}.new`, f);
  };
  const varsOf = (id: string, branch: Branch) => loadEnv(id).branches[branch] ?? {};
  // refresh's before-copy (S1f) of a variable removed (or a whole branch's) let go with it
  // (names: those; none: the branch's whole copy; [] only tidies)
  const forgetMoved = (e: EnvStore, branch: Branch, names?: string[]) => {
    if (!e.moved?.[branch]) return;
    if (names === undefined) delete e.moved[branch];
    else for (const n of names) delete e.moved[branch]![n];
    if (e.moved[branch] && !Object.keys(e.moved[branch]!).length) delete e.moved[branch];
    if (!Object.keys(e.moved).length) delete e.moved;
  };
  // the server's env file: /srv/lfdln-projects/<name>/env/<branch>.env, svc-lfdln-apps' own, 600
  const runEnvFile = (id: string, branch: Branch) => join(dirOf(id), 'env', `${branch}.env`);
  const writeRunEnv = async (id: string, branch: Branch) => {
    must(await asApps(['mkdir', '-p', '-m', '700', join(dirOf(id), 'env')], 'env'), 'Its environment\'s folder couldn\'t be made');
    await putAppsSecret(runEnvFile(id, branch), envFileText(varsOf(id, branch)), 'env', `${id}'s environment (${branch})`);
  };
  // one change at a time (a change is quick: never queued behind a build)
  let envChain: Promise<unknown> = Promise.resolve();
  const envLocked = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = envChain.then(fn, fn);
    envChain = p.catch(() => {});
    return p;
  };

  // The repository shared with its group (D3-3): its settings, then its modes.
  const shareRepo = async (id: string, owners: readonly string[], log: (t: string) => void) => {
    await syncGroups(id, owners, log);
    const repo = repoOf(id);
    for (const [k, v] of [['core.sharedRepository', '0664'], ['receive.denyDeletes', 'true'], ['receive.autogc', 'false'], ['core.hooksPath', d.hooksDir ?? HOOKS_DIR]] as const) {
      must(await git(id, ['config', k, v], 'git-config'), `Its repository's setting ${k} couldn't be made`);
    }
    // the top 3770 (pushers make their own lock files, touch nothing else there); config, HEAD,
    // hooks/, info/ not group-writable; objects/ and refs/ group-writable, setgid. Others' bits
    // are left as git made them: inside the build box only svc-lfdln-apps' own uid exists, so
    // it reads pushers' objects as "others" (the top folder keeps everyone else out).
    //   As svc-lfdln-apps, never root: this runs only before anyone could push (made, or
    // first shared), so every file is still its own -- and root never walks a tree pushers write.
    const g = groupOf(id);
    must(await asApps(['chgrp', '-R', '--', g, repo], 'modes'), 'Its repository\'s group couldn\'t be set');
    must(await asApps(['chmod', '-R', 'g+rX,g-w', '--', repo], 'modes'), 'Its repository\'s modes couldn\'t be set');
    must(await asApps(['find', join(repo, 'objects'), join(repo, 'refs'), '-type', 'd', '-exec', 'chmod', 'g+ws', '{}', '+'], 'modes'), 'Its repository\'s folders couldn\'t be made group-writable');
    must(await asApps(['chmod', '3770', '--', repo], 'modes'), 'Its repository\'s top folder couldn\'t be set');
    await writeSafeList([...new Set([...record().projects.map((p) => p.id), id])]);
    log(`repository shared with ${g} (${repo})`);
  };

  // `current` is a link to the live release, replaced in one rename: nginx follows it
  const link = async (id: string, branch: Branch, release: string) => {
    const rel = join(dirOf(id), 'releases', branch);
    must(await asApps(['ln', '-sfn', release, join(rel, '.current-new')], 'link'), 'The new release couldn\'t be linked');
    must(await asApps(['mv', '-Tf', join(rel, '.current-new'), join(rel, 'current')], 'switch'), 'The new release couldn\'t be put live');
  };

  // the boxes' way out (8b-8b): the proxy's unit, as svc-lfdln-apps' systemd says
  const proxyUp = async () => (await asApps(['systemctl', '--user', 'is-active', '-q', PROXY_UNIT], 'proxy', 30).catch(() => ({ code: 1 }))).code === 0;

  // ---------------------------------------------------------------- servers (8b-4a)
  const nginxDir = d.nginxDir ?? NGINX_DIR;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const upstreamFile = (id: string, branch: Branch) => join(nginxDir, `${id}-${branch}.conf`);
  const quadletDir = async () => join((await appsUser()).home, '.config', 'containers', 'systemd');
  const userctl = (args: string[], what: string, timeoutSec = 120) => asApps(['systemctl', '--user', ...args], what, timeoutSec);

  // The branch's upstream pointed at a port (or nowhere). With `reload`, nginx is asked
  // first (-t) and reloaded; if it refuses, the file is put back as it was (D4-4).
  const pointUpstream = async (id: string, branch: Branch, port: number | null, reload: boolean) => {
    const file = upstreamFile(id, branch);
    let before: string | null = null;
    try { before = readFileSync(file, 'utf8'); } catch { /* none yet */ }
    await putRootFile(file, upstreamText(id, branch, port), 'upstream', `${id}'s nginx upstream`);
    if (!reload) return;
    const t = await asRoot(['nginx', '-t', '-q'], 'nginx-test');
    if (t.code !== 0) {
      if (before !== null) await putRootFile(file, before, 'upstream', `${id}'s nginx upstream`).catch(() => {});
      else await asRoot(['rm', '-f', '--', file], 'upstream').catch(() => {});
      throw new ProjectsError('internal', `nginx refused the switch (${lastLines(t, 1)}): nothing changed.`);
    }
    must(await asRoot(['systemctl', 'reload', 'nginx'], 'nginx-reload'), 'nginx took the switch but couldn\'t reload');
  };

  // a server answers on its port: anything below 500 from / (D4-4)
  const answers = async (port: number, limitMs = d.answerMs ?? ANSWER_MS) => {
    if (!d.probe) throw new ProjectsError('internal', 'This helper can\'t ask servers if they answer.');
    const started = Date.now();
    for (;;) {
      const r = await d.probe(port, '/', 5000);
      if (r.status !== null && r.status < 500) return true;
      if (Date.now() - started > limitMs) return false;
      await sleep(2000);
    }
  };

  // A slot stopped, its file gone (so it never starts with the server), and no mask left.
  const stopSlot = async (id: string, branch: Branch, slot: 0 | 1) => {
    const unit = unitOf(id, branch, slot);
    await userctl(['stop', `${unit}.service`], 'stop', 180).catch(() => {});
    // a container killed on stop leaves its unit failed, and so still listed: forget it
    await userctl(['reset-failed', `${unit}.service`], 'reset').catch(() => {});
    await userctl(['unmask', `${unit}.service`], 'unmask').catch(() => {});
    await asApps(['rm', '-f', '--', join(await quadletDir(), `${unit}.container`)], 'quadlet').catch(() => {});
    await userctl(['daemon-reload'], 'reload').catch(() => {});
  };

  // A release image put live (D4-4): started in the slot that isn't live, nginx switched to
  // it once it answers, then the old slot stopped. Anything short of that changes nothing.
  // `vars` (refresh, S1d): the new slot starts with these, from a file of its own
  // (<branch>.env.next), so the live slot's env file is untouched until nginx has switched;
  // `switched` then runs (the shared file and the variables made so), and the new slot's
  // Quadlet is pointed at the shared file again. Short of the switch, the next file is gone.
  // `net` (putBack, S1f): the network to write instead of this site's (HOST_LOOPBACK).
  const deploy = async (id: string, branch: Branch, image: string, step: (w: string) => void, log: (t: string) => void,
    o: { vars?: Record<string, string>; switched?: () => Promise<void>; net?: typeof HOST_LOOPBACK } = {}) => {
    const b = projectOf(id).branches[branch];
    if (!b || b.ports.length !== 2) throw new ProjectsError('internal', `${id}'s ${branch} has no ports for its server.`);
    const live = b.slot ?? null;
    const next: 0 | 1 = live === 0 ? 1 : 0;
    const port = b.ports[next]!;
    const unit = unitOf(id, branch, next);
    const qdir = await quadletDir();
    const quadletOf = (envFile: string) => quadletText(id, branch, next, port, image, envFile, identityKeyOf(d.identityPub), o.net ?? d.dbPorts);
    const nextEnv = `${runEnvFile(id, branch)}.next`;
    const dropNext = () => asApps(['rm', '-f', '--', nextEnv], 'env').catch(() => {});
    const failed = async () => { await stopSlot(id, branch, next); if (o.vars) await dropNext(); };
    step(`starting it on port ${port}${live === null ? '' : ', beside the live one'}`);
    must(await asApps(['mkdir', '-p', '-m', '700', qdir], 'quadlet'), 'The containers\' folder couldn\'t be made');
    if (o.vars) {
      must(await asApps(['mkdir', '-p', '-m', '700', join(dirOf(id), 'env')], 'env'), 'Its environment\'s folder couldn\'t be made');
      await putAppsSecret(nextEnv, envFileText(o.vars), 'env', `${id}'s environment (${branch}, the new slot's)`);
    } else await writeRunEnv(id, branch);
    await putAppsFile(join(qdir, `${unit}.container`), quadletOf(o.vars ? nextEnv : runEnvFile(id, branch)), 'quadlet', `${unit}'s Quadlet`);
    await userctl(['unmask', `${unit}.service`], 'unmask').catch(() => {});
    must(await userctl(['daemon-reload'], 'reload'), 'svc-lfdln-apps\' units couldn\'t be reloaded');
    const started = await userctl(['restart', `${unit}.service`], 'start', 180);
    if (started.code !== 0 || !await answers(port)) {
      await failed();
      throw new ProjectsError('internal', started.code !== 0
        ? `The new release didn't start (${lastLines(started, 1)}): nothing changed.`
        : `The new release didn't answer on port ${port} within ${ANSWER_MS / 1000} seconds: nothing changed. Its server log may say why.`);
    }
    log(`${unit} answers on 127.0.0.1:${port}`);
    step('nginx switched to it');
    try { await pointUpstream(id, branch, port, true); } catch (e) { await failed(); throw e; }
    if (live !== null) {
      step('the old one stopped');
      await stopSlot(id, branch, live);
    }
    update(id, (x) => { Object.assign(x.branches[branch]!, { slot: next, stopped: false }); });
    if (o.vars) {
      await o.switched?.();
      await writeRunEnv(id, branch);
      await putAppsFile(join(qdir, `${unit}.container`), quadletOf(runEnvFile(id, branch)), 'quadlet', `${unit}'s Quadlet`);
      await userctl(['daemon-reload'], 'reload').catch(() => {});
      await dropNext();
    }
    log(`live: ${unit} on port ${port}${live !== null ? ` (${unitOf(id, branch, live)} stopped)` : ''}`);
  };

  // A server branch all gone (delete, dev off: D4-10): both slots, its images, its upstream.
  const removeServer = async (id: string, branch: Branch, log: (t: string) => void) => {
    for (const slot of [0, 1] as const) await stopSlot(id, branch, slot);
    const imgs = await asApps(['podman', 'images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=localhost/proj-${id}`], 'images');
    const mine = imgs.stdout.split('\n').map((x) => x.trim()).filter((x) => x.startsWith(`localhost/proj-${id}:${branch}-`));
    for (const img of mine) await asApps(['podman', 'rmi', '-i', img], 'let-go').catch(() => {});
    await asRoot(['rm', '-f', '--', upstreamFile(id, branch)], 'upstream').catch(() => {});
    log(`${branch}'s server gone: its two slots, ${mine.length} image(s), its nginx upstream`);
  };

  // what systemd says of each server branch's live slot (asked at most every 5 seconds)
  let seen: { at: number; units: Map<string, Record<string, string>> } | null = null;
  const serverStates = async () => {
    const live = record().projects.filter((p) => isServer(p.kind)).flatMap((p) => BRANCHES.flatMap((b) => {
      const s = p.branches[b]?.slot;
      return s === 0 || s === 1 ? [unitOf(p.id, b, s)] : [];
    }));
    if (!live.length) return new Map<string, Record<string, string>>();
    if (seen && Date.now() - seen.at < 5000 && live.every((u) => seen!.units.has(`${u}.service`))) return seen.units;
    const r = await userctl(['show', '-p', 'Id,LoadState,ActiveState,SubState', ...live.map((u) => `${u}.service`)], 'show', 30).catch(() => null);
    const units = new Map<string, Record<string, string>>();
    for (const block of (r?.stdout ?? '').split(/\n\s*\n/)) {
      const kv: Record<string, string> = {};
      for (const line of block.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1); }
      if (kv.Id) units.set(kv.Id, kv);
    }
    seen = { at: Date.now(), units };
    return units;
  };

  // the ports still free, and those a project being made has taken already
  const takenPorts = () => [...portsOf(record()), ...[...making.values()].flatMap((m) => Object.values(m.ports).flat())];

  // A branch built into a new release, put live, and the oldest let go (3 kept). A server's
  // (8b-4a): its image built from the output, then switched in.
  const build = async (id: string, branch: Branch, by: string, step: (w: string) => void, log: (t: string) => void): Promise<Release> => {
    const p = projectOf(id);
    const dir = dirOf(id);
    // (two builds in one second get the next second, not the same id)
    let at = d.now();
    while (p.branches[branch]?.releases.some((r) => r.id === releaseIdAt(at))) at++;
    const rid = releaseIdAt(at);
    const server = isServer(p.kind);
    // a server's output goes to the build folder (never readable by nginx), then into its image
    const out = server ? join(dir, 'build', 'out') : join(dir, 'releases', branch);
    step('a clean folder to build in');
    must(await asApps(['rm', '-rf', '--', join(dir, 'build')], 'clean'), 'The build folder couldn\'t be emptied');
    must(await asApps(['mkdir', '-m', '700', join(dir, 'build')], 'clean'), 'The build folder couldn\'t be made');
    if (server) must(await asApps(['mkdir', '-m', '700', out], 'clean'), 'The build folder couldn\'t be made');
    // the branch's environment, for the build only (D4-11): beside the build folder, gone after
    const vars = varsOf(id, branch);
    const envFile = Object.keys(vars).length ? join(dir, 'build.env') : undefined;
    if (envFile) {
      await putAppsSecret(envFile, envFileText(vars), 'env', `${id}'s environment for the build`);
      log(`its environment: ${Object.keys(vars).sort().join(', ')}`);
    }
    step(`building ${branch} (install, then build)`);
    let made: Record<string, unknown>;
    try {
      made = await inBox(id, [[join(dir, 'repo.git'), '/repo', 'ro'], [join(dir, 'cache'), '/cache', 'rw'], [join(dir, 'build'), '/build', 'rw'],
        [out, '/out', 'rw']], 'build.mjs', [branch, rid, p.kind], log, envFile);
    } finally {
      // node_modules is big; the release has what it needs
      await asApps(['rm', '-rf', '--', join(dir, 'build', 'src')], 'clean').catch(() => {});
      if (envFile) await asApps(['rm', '-f', '--', envFile], 'env').catch(() => {});
    }
    if (typeof made.commit !== 'string' || !/^[0-9a-f]{40}$/.test(made.commit)) throw new ProjectsError('internal', 'The build didn\'t say which commit it built.');
    const release: Release = { id: rid, commit: made.commit, at: d.now(), by, files: Number(made.files) || 0, bytes: Number(made.bytes) || 0 };
    if (server) {
      const image = `localhost/proj-${id}:${branch}-${rid}`;
      step('its release image');
      try {
        await putAppsFile(join(dir, 'build', 'Containerfile'), CONTAINERFILE, 'image', 'The release\'s Containerfile');
        const img = await asApps(['podman', 'build', '--pull=never', '-q', '--label', `lfdln.project=${id}`, '-t', image, '-f', join(dir, 'build', 'Containerfile'), join(out, rid)], 'image', 600);
        log([img.stdout, img.stderr].filter(Boolean).join('\n'));
        must(img, 'The release image couldn\'t be built');
      } finally {
        await asApps(['rm', '-rf', '--', out], 'clean').catch(() => {});
      }
      release.image = image;
      try { await deploy(id, branch, image, step, log); } catch (e) {
        await asApps(['podman', 'rmi', '-i', image], 'let-go').catch(() => {});
        throw e;
      }
    } else {
      step('putting it live');
      await link(id, branch, rid);
    }
    let gone: Release[] = [];
    update(id, (x) => {
      const b = x.branches[branch] ?? { ports: [], live: null, releases: [] };
      b.releases = [release, ...b.releases];
      b.live = release;
      gone = b.releases.slice(KEEP_RELEASES);
      b.releases = b.releases.slice(0, KEEP_RELEASES);
      x.branches[branch] = b;
    });
    for (const g of gone) {
      if (g.image) await asApps(['podman', 'rmi', '-i', g.image], 'let-go').catch(() => {});
      else await asApps(['rm', '-rf', '--', join(dir, 'releases', branch, g.id)], 'let-go').catch(() => {});
    }
    log(`live: release ${rid} (commit ${release.commit.slice(0, 12)})${gone.length ? `; let go: ${gone.map((g) => g.id).join(', ')}` : ''}`);
    return release;
  };

  // ---------------------------------------------------------------- packages (8b-8a)
  // The last check of a branch's packages, kept in the state folder; changes go to dev when
  // the project has it (tried there first), else to main.
  const packagesFile = (id: string, branch: Branch) => join(d.stateDir, 'packages', `${id}-${branch}.json`);
  const changeBranch = (p: Project): Branch => (p.branches.dev ? 'dev' : 'main');
  const lastCheck = (id: string, branch: Branch): Record<string, unknown> | null => {
    try { return JSON.parse(readFileSync(packagesFile(id, branch), 'utf8')) as Record<string, unknown>; } catch { return null; }
  };
  // one of the box's jobs on a branch: a clean build folder, the repository (written only by a
  // change), the caches; the branch's environment for what runs its code
  const packagesBox = async (id: string, branch: Branch, args: string[], log: (t: string) => void, o: { write?: boolean; env?: boolean } = {}) => {
    const dir = dirOf(id);
    must(await asApps(['rm', '-rf', '--', join(dir, 'build')], 'clean'), 'The build folder couldn\'t be emptied');
    must(await asApps(['mkdir', '-m', '700', join(dir, 'build')], 'clean'), 'The build folder couldn\'t be made');
    const vars = o.env ? varsOf(id, branch) : {};
    const envFile = Object.keys(vars).length ? join(dir, 'build.env') : undefined;
    if (envFile) await putAppsSecret(envFile, envFileText(vars), 'env', `${id}'s environment`);
    try {
      return await inBox(id, [[join(dir, 'repo.git'), '/repo', o.write ? 'rw' : 'ro'], [join(dir, 'cache'), '/cache', 'rw'], [join(dir, 'build'), '/build', 'rw']], 'packages.mjs', args, log, envFile);
    } finally {
      await asApps(['rm', '-rf', '--', join(dir, 'build', 'src')], 'clean').catch(() => {});
      if (envFile) await asApps(['rm', '-f', '--', envFile], 'env').catch(() => {});
    }
  };
  const checkPackages = async (id: string, branch: Branch, log: (t: string) => void) => {
    const r = await packagesBox(id, branch, ['check', branch], log);
    const saved = { ...r, branch, at: d.now() };
    mkdirSync(join(d.stateDir, 'packages'), { recursive: true, mode: 0o700 });
    writeFileSync(`${packagesFile(id, branch)}.new`, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
    renameSync(`${packagesFile(id, branch)}.new`, packagesFile(id, branch));
    log(`${Array.isArray(r.packages) ? r.packages.length : 0} packages checked on ${branch}`);
    return saved;
  };
  // the one change a job makes (checked here, whatever the panel checked)
  type Change = { add: { name: string; version?: string; dev?: boolean }[] } | { update: 'all' | string[] } | { remove: string[] } | { fix: true };
  const checkChange = (v: unknown): Change => {
    const c = v as Record<string, unknown>;
    const names = (x: unknown, max: number) => Array.isArray(x) && x.length >= 1 && x.length <= max && x.every((n) => typeof n === 'string' && PKG_NAME_RE.test(n)) && new Set(x).size === x.length;
    if (!c || typeof c !== 'object' || Object.keys(c).length !== 1) throw new ProjectsError('invalid', 'One change at a time: add, update, remove or fix.');
    if ('add' in c && Array.isArray(c.add) && c.add.length >= 1 && c.add.length <= 20
      && c.add.every((a: Record<string, unknown>) => a && typeof a.name === 'string' && PKG_NAME_RE.test(a.name) && (a.version === undefined || (typeof a.version === 'string' && PKG_SPEC_RE.test(a.version))) && (a.dev === undefined || typeof a.dev === 'boolean'))) {
      return { add: (c.add as { name: string; version?: string; dev?: boolean }[]).map((a) => ({ name: a.name, ...(a.version ? { version: a.version } : {}), ...(a.dev ? { dev: true } : {}) })) };
    }
    if ('update' in c && (c.update === 'all' || names(c.update, 50))) return { update: c.update as 'all' | string[] };
    if ('remove' in c && names(c.remove, 50)) return { remove: c.remove as string[] };
    if ('fix' in c && c.fix === true) return { fix: true };
    throw new ProjectsError('invalid', 'Which packages? (npm names, at most 20 to add at once, a version or range each.)');
  };

  // A change (D8-4): in the box, committed and pushed to the branch; then built as a push would
  // be; if the build fails the branch is put back (only if still at the change), so nothing
  // changes live. The Packages page's changes and the nightly update both come here.
  const changeAndBuild = async (id: string, branch: Branch, c: Change, by: string, step: (w: string) => void, log: (t: string) => void) => {
    step(`the change, on ${branch}, in the build container`);
    const r = await packagesBox(id, branch, ['change', branch, by, JSON.stringify(c)], log, { write: true, env: true });
    if (!r.changed) { log(`nothing changed (${String(r.summary)})`); return { changed: false }; }
    const before = String(r.before);
    const commit = String(r.commit);
    if (!SHA_RE.test(before) || !SHA_RE.test(commit)) throw new ProjectsError('internal', 'The change didn\'t say which commits.');
    log(`${branch}: ${before.slice(0, 12)} -> ${commit.slice(0, 12)} (${String(r.summary)})`);
    let release: Release;
    try { release = await build(id, branch, by, step, log); } catch (e) {
      step('the change undone');
      const back = await git(id, ['update-ref', '-m', `undo: the build failed (${by})`, `refs/heads/${branch}`, before, commit], 'git-update');
      log(back.code === 0 ? `${branch} is back at ${before.slice(0, 12)}` : `${branch} couldn't be put back (pushed to since?): ${lastLines(back)}`);
      throw new ProjectsError('internal', `The build failed, so the change was undone${back.code === 0 ? '' : ' (not quite: see the log)'}: ${(e as Error).message}`);
    }
    step('checking the packages again');
    await checkPackages(id, branch, log).catch((e) => log(`(the check after it failed: ${(e as Error).message})`));
    return { changed: true, commit, summary: r.summary, release };
  };

  // What the last check says, in short (8b-8b: the Projects list's badges)
  const summaryOf = (p: Project) => {
    const c = lastCheck(p.id, changeBranch(p)) as { at?: number; packages?: { name: string; current: string | null; wanted: string | null; latest: string | null }[]; audit?: Record<string, number> } | null;
    if (!c?.packages) return null;
    const major = (v: string | null) => Number(/^(\d+)/.exec(v ?? '')?.[1] ?? NaN);
    return {
      at: c.at ?? null,
      outdated: c.packages.filter((x) => x.latest && x.current && x.latest !== x.current).length,
      inRange: c.packages.filter((x) => x.wanted && x.current && x.wanted !== x.current).length,
      majors: c.packages.filter((x) => major(x.latest) > major(x.current)).map((x) => x.name),
      advisories: Object.values(c.audit ?? {}).reduce((a, b) => a + (Number(b) || 0), 0),
    };
  };

  // Each night (8b-8b, D8b-5): from 03:00 server time, once a day, every project's packages
  // checked; those that say so then updated within their ranges. Asked every ten minutes.
  const nightlyFile = join(d.stateDir, 'nightly.json');
  const nightly = async (force = false) => {
    const at = new Date(d.now() * 1000);
    const day = `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
    let last = '';
    try { last = String((JSON.parse(readFileSync(nightlyFile, 'utf8')) as { day?: string }).day ?? ''); } catch { /* never */ }
    if (!force && (at.getHours() < 3 || last === day)) return [];
    writeFileSync(`${nightlyFile}.new`, `${JSON.stringify({ day, at: d.now() })}\n`, { mode: 0o600 });
    renameSync(`${nightlyFile}.new`, nightlyFile);
    return record().projects.map((p) => queue.add('nightly', 'nightly', async ({ step, log }) => {
      const branch = changeBranch(projectOf(p.id));
      step(`checking ${branch}'s packages`);
      await checkPackages(p.id, branch, log);
      const s = summaryOf(projectOf(p.id));
      log(`${s?.outdated ?? 0} with a newer version (${s?.inRange ?? 0} within their ranges), ${s?.advisories ?? 0} security issue(s)${s?.majors.length ? `; new major versions: ${s.majors.join(', ')}` : ''}`);
      if (!projectOf(p.id).autoUpdate || !s?.inRange) return { checked: true };
      log('it updates each night: all within their ranges');
      return { checked: true, update: await changeAndBuild(p.id, branch, { update: 'all' }, 'panel', step, log) };
    }, { project: p.id, branch: changeBranch(p) }).id);
  };

  // the trash's own: an entry is "<project>--<when>" and goes after 30 days
  const purgeTrash = async (log: (t: string) => void) => {
    if (!existsSync(trash)) return;
    for (const e of readdirSync(trash)) {
      const m = /^([a-z0-9-]+)--([0-9]{14})$/.exec(e);
      if (!m) continue;
      const at = Date.UTC(+m[2]!.slice(0, 4), +m[2]!.slice(4, 6) - 1, +m[2]!.slice(6, 8), +m[2]!.slice(8, 10), +m[2]!.slice(10, 12), +m[2]!.slice(12, 14)) / 1000;
      if (d.now() - at > TRASH_DAYS * 86400) {
        await asRoot(['rm', '-rf', '--', join(trash, e)], 'purge');
        log(`gone for good: ${m[1]} (in the trash since ${m[2]})`);
      }
    }
  };

  // The dev branch on (D3-7): dev = main where git has no dev yet, its releases folder, built.
  const devOn = async (id: string, by: string, step: (w: string) => void, log: (t: string) => void, ports: number[] = []) => {
    step('the dev branch');
    // a server's dev gets two ports of its own and its upstream (pointing nowhere until it runs)
    if (isServer(projectOf(id).kind) && ports.length !== 2) {
      ports = projectOf(id).branches.dev?.ports.length === 2 ? projectOf(id).branches.dev!.ports : freePorts(takenPorts(), 2);
      await pointUpstream(id, 'dev', null, false);
    }
    if (!await headOf(id, 'dev')) {
      const main = await headOf(id, 'main');
      if (!main) throw new ProjectsError('internal', `${id} has no main branch to start dev from.`);
      // "" as the old value: only while there still is no dev
      must(await git(id, ['update-ref', 'refs/heads/dev', main, ''], 'git-update'), 'The dev branch couldn\'t be made');
      log(`dev made from main (${main.slice(0, 12)})`);
    } else {
      log('dev is already in the repository: built as it is');
    }
    must(await asApps(['mkdir', '-p', '-m', '755', join(dirOf(id), 'releases', 'dev')], 'folders'), 'Its dev releases folder couldn\'t be made');
    update(id, (x) => { x.branches.dev ??= { ports, live: null, releases: [], ...(ports.length ? { slot: null, stopped: false } : {}) }; });
    return build(id, 'dev', by, step, log);
  };

  // Put dev live (D3-7): main fast-forwarded to dev, never merged; the old value given to
  // update-ref, so a push to main in between makes it fail rather than lose that push.
  const promote = async (id: string, by: string, step: (w: string) => void, log: (t: string) => void) => {
    step('comparing dev with main');
    const main = await headOf(id, 'main');
    const dev = await headOf(id, 'dev');
    if (!main || !dev) throw new ProjectsError('not-found', `${id} needs both main and dev in its repository.`);
    if (main === dev) {
      log(`main is already at dev (${dev.slice(0, 12)}): nothing to put live`);
      return { same: true, commit: dev };
    }
    const behind = await git(id, ['merge-base', '--is-ancestor', main, dev], 'git-ancestor');
    if (behind.code === 1) throw new ProjectsError('conflict', 'main has commits that dev doesn\'t: merge main into dev (and push it), then put dev live.');
    must(behind, 'main and dev couldn\'t be compared');
    step('main moved to dev');
    must(await git(id, ['update-ref', '-m', `put dev live (${by})`, 'refs/heads/main', dev, main], 'git-update'), 'main couldn\'t be moved to dev (was it pushed to just now?)');
    log(`main: ${main.slice(0, 12)} -> ${dev.slice(0, 12)}`);
    return { commit: dev, release: await build(id, 'main', by, step, log) };
  };

  // ---------------------------------------------------------------- pushes (D3-5)
  // The hook's files: "push.<10 letters>", "<project> <branch> <commit>". Each is read once
  // and removed, whatever it says; it counts only if its owner may push to that project.
  const spool = d.spool ?? SPOOL;
  const PUSH_NAME_RE = /^push\.[A-Za-z0-9]{10}$/;
  // (8b-7: " via <panel username>" from a push over HTTPS, believed only from svc-lfdln-apps' files)
  const PUSH_RE = /^([a-z0-9-]{1,36}) (main|dev) ([0-9a-f]{40})(?: via ([a-z][a-z0-9-]{1,31}))?\n?$/;
  let draining = false;
  const drainPushes = async (): Promise<number> => {
    if (draining) return 0;
    draining = true;
    let queued = 0;
    try {
      let names: string[] = [];
      try { names = readdirSync(spool); } catch { return 0; }
      for (const n of names) {
        const f = join(spool, n);
        if (n.startsWith('.')) {
          // one a hook never finished: gone after an hour
          // (a file's age by the wall clock, as its mtime is)
          try { if (Date.now() - lstatSync(f).mtimeMs > 3600_000) unlinkSync(f); } catch { /* gone */ }
          continue;
        }
        let text = '';
        let uid = -1;
        // never through a link (O_NOFOLLOW), and who owns it read from the file opened
        try {
          const fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const st = fstatSync(fd);
            if (st.isFile() && st.size < 200 && PUSH_NAME_RE.test(n)) {
              uid = st.uid;
              const buf = Buffer.alloc(st.size);
              readSync(fd, buf, 0, st.size, 0);
              text = buf.toString('utf8');
            }
          } finally { closeSync(fd); }
        } catch { /* a link, or gone */ }
        try { unlinkSync(f); } catch { /* gone */ }
        const m = PUSH_RE.exec(text);
        if (!m) { d.log?.(`push file ${n.slice(0, 20)} ignored: not one the hook writes`); continue; }
        const [, id, branch, sha, via] = m as unknown as [string, string, Branch, string, string | undefined];
        const p = record().projects.find((x) => x.id === id);
        const owner = (await passwd()).find((u) => u.uid === uid)?.name;
        // over HTTPS: the person the panel let in (D7-7); anyone else's "via" is ignored
        const who = owner === APPS_USER && via ? via : owner;
        if (!p || !owner || !who) { d.log?.(`push to ${id} ignored: ${p ? `uid ${uid} is nobody` : 'no such project'}`); continue; }
        // who may drop it is the file's owner, not the name it gives
        if (owner !== APPS_USER && !groupMembers(groupOf(id)).includes(owner)) { d.log?.(`push to ${id} by ${owner} ignored: not in ${groupOf(id)}`); continue; }
        if (!p.branches[branch]) { d.log?.(`push to ${id} ${branch} by ${who}: ${branch} is off, nothing built`); continue; }
        // a build of that branch still waiting builds this push too
        if (queue.list(id).some((j) => j.state === 'queued' && j.branch === branch && (j.what === 'push' || j.what === 'build'))) continue;
        queue.add('push', who, async ({ step, log }) => {
          log(`${who} pushed ${branch} (${sha.slice(0, 12)})${owner === APPS_USER && via ? ' over HTTPS' : ''}`);
          return { release: await build(id, branch, who, step, log) };
        }, { project: id, branch });
        queued++;
      }
    } finally { draining = false; }
    return queued;
  };

  // projects asked for and not made yet: the panel shows them (a route to one can be made at
  // once, as New project does, and serves its release when the first build is done)
  // (a server's ports are taken when it is asked for, so its upstreams can be written at once: D4-5)
  const making = new Map<string, { kind: Kind; dev: boolean; ports: Partial<Record<Branch, number[]>> }>();

  // refresh's and putBack's work (S1d, S1f): every server branch (or `only`'s) with its
  // variables moved `to` pasta (127.0.0.1) or `back` (10.0.2.2, slirp4netns), each running one
  // put live again in its other slot, its variables saved only once nginx has switched.
  const moveAll = async (to: 'pasta' | 'back', only: string | null, { step, log }: { step: (w: string) => void; log: (t: string) => void }) => {
    const ports = new Set(d.dbPorts ?? []);
    const net = to === 'back' ? HOST_LOOPBACK : d.dbPorts;
    const where = to === 'back' ? '10.0.2.2' : '127.0.0.1';
    const out: Refreshed[] = [];
    for (const p of record().projects) {
      if (!isServer(p.kind) || (only && p.id !== only)) continue;
      for (const b of BRANCHES) {
        const st = p.branches[b];
        if (!st) continue;
        const before = varsOf(p.id, b);
        const m = to === 'pasta' ? moveVars(before, ports) : { ...backVars(before, ports, loadEnv(p.id).moved?.[b]), left: [] as string[] };
        const { vars, moved, left } = m;
        if (left.length) {
          log(`${p.id} ${b}: kept as it is (slirp4netns): ${left.join(', ')} still name 10.0.2.2, which a project on pasta can't reach; set them to 127.0.0.1, then Restart`);
          out.push({ project: p.id, branch: b, result: 'kept', env: [], left });
          continue;
        }
        // the variables, under the env lock, as they are by then (a change since is kept);
        // the before-copy with them: what refresh wrote, or put back, forgotten
        const saveMoved = () => envLocked(async () => {
          const e = loadEnv(p.id);
          const now = e.branches[b];
          if (!now) return;
          const copy: MovedCopy = { ...(e.moved?.[b] ?? {}) };
          for (const k of moved) {
            if (now[k] !== before[k]) continue;
            now[k] = vars[k]!;
            if (to === 'pasta') copy[k] = { from: before[k]!, to: vars[k]! };
            else delete copy[k];
          }
          e.moved = { ...(e.moved ?? {}), [b]: copy };
          forgetMoved(e, b, []);
          saveEnv(p.id, e);
        });
        if ((st.slot !== 0 && st.slot !== 1) || !st.live?.image) {
          // nothing running yet: its first release starts with these
          if (moved.length) { await saveMoved(); out.push({ project: p.id, branch: b, result: 'unchanged', env: moved }); }
          continue;
        }
        const slot = st.slot;
        const unit = unitOf(p.id, b, slot);
        const file = join(await quadletDir(), `${unit}.container`);
        const want = quadletText(p.id, b, slot, st.ports[slot]!, st.live.image, runEnvFile(p.id, b), identityKeyOf(d.identityPub), net);
        const have = await asApps(['cat', '--', file], 'quadlet').catch(() => null);
        if (have?.code === 0 && have.stdout === want && !moved.length) { out.push({ project: p.id, branch: b, result: 'unchanged', env: [] }); continue; }
        if (st.stopped) {
          if (moved.length) await saveMoved();
          await writeRunEnv(p.id, b);
          await putAppsFile(file, want, 'quadlet', `${unit}'s Quadlet`);
          log(`${unit}: stopped, its files as ${to === 'back' ? 'a release before S1d' : 'this release'} writes them; it starts so`);
          out.push({ project: p.id, branch: b, result: 'stopped', env: moved });
          continue;
        }
        step(`${p.id} ${b}: put live again`);
        try {
          seen = null;
          await deploy(p.id, b, st.live.image, () => {}, log, { vars, switched: moved.length ? saveMoved : undefined, net: to === 'back' ? HOST_LOOPBACK : undefined });
          if (moved.length) log(`${p.id} ${b}: ${moved.join(', ')} now at ${where}`);
          out.push({ project: p.id, branch: b, result: 'redeployed', env: moved });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          log(`${p.id} ${b}: ${error}`);
          out.push({ project: p.id, branch: b, result: 'failed', env: [], error });
        }
      }
    }
    return { projects: out, failed: out.filter((x) => x.result === 'failed').length, kept: out.filter((x) => x.result === 'kept').length };
  };

  const wait = async <T extends { id: string }>(j: T, yes: unknown) => ({ job: yes === true ? await queue.done(j.id) : j });

  return {
    queue,
    async info() {
      const r = record();
      let user = true;
      try { await appsUser(); } catch { user = false; }
      const checks = queue.list().filter((j) => j.what === 'check');
      const lastCheck = checks.find((j) => j.state === 'done' || j.state === 'failed') ?? null;
      return {
        user: user ? APPS_USER : null, image: user && await imageThere() ? BUILD_IMAGE : null,
        ports: { min: PORT_MIN, max: PORT_MAX, used: portsOf(r).length },
        projects: r.projects.length, busy: queue.busy(),
        lastCheck: lastCheck && { id: lastCheck.id, state: lastCheck.state, at: lastCheck.endedAt, result: lastCheck.result, error: lastCheck.error },
      };
    },
    // with each project's group and the owners who may push to it by SSH (D3-10)
    list: async () => {
      const projects = record().projects;
      const units = await serverStates();
      // a server branch's live slot as systemd sees it (8b-4a)
      const running = (p: (typeof projects)[number]) => Object.fromEntries(BRANCHES.flatMap((b) => {
        const st = p.branches[b];
        if (!isServer(p.kind) || !st || (st.slot !== 0 && st.slot !== 1)) return [];
        const kv = units.get(`${unitOf(p.id, b, st.slot)}.service`) ?? {};
        return [[b, { unit: unitOf(p.id, b, st.slot), port: st.ports[st.slot], active: kv.ActiveState ?? 'unknown', sub: kv.SubState ?? '', masked: kv.LoadState === 'masked' }]];
      }));
      return {
        projects: await Promise.all(projects.map(async (p) => ({ ...p, group: groupOf(p.id), pushers: await unixPeople(p.owners), running: running(p), packages: summaryOf(p) }))),
        making: [...making].filter(([id]) => !projects.some((p) => p.id === id)).map(([id, m]) => ({ id, kind: m.kind, dev: m.dev })),
      };
    },
    ports: async () => ({ ports: portsOf(record()), free: freePorts(portsOf(record()), 1) }),
    jobs: async (project?: unknown) => {
      if (project !== undefined && !isProjectId(project)) throw new ProjectsError('invalid', 'Which project?');
      return { jobs: queue.list(project as string | undefined).slice(0, 50) };
    },
    job: async (id: unknown) => {
      if (typeof id !== 'string' || !JOB_ID_RE.test(id)) throw new ProjectsError('invalid', 'Which job?');
      const j = queue.get(id);
      if (!j) throw new ProjectsError('not-found', 'There is no such job.');
      return { job: j, log: queue.log(id) };
    },
    // "Check the build environment": a job like any build, so it waits its turn
    async check(actor: string, waitFor = false) {
      const j = queue.add('check', actor, async ({ step, log }) => {
        step('the projects\' user');
        await appsUser();
        step('the build image');
        if (!await imageThere(true)) throw new ProjectsError('unavailable', `The build image (${BUILD_IMAGE}) is missing: run install-lfdln.sh.`);
        step('running it');
        const v = await versions();
        log(`node ${v.node}, npm ${v.npm}, pnpm ${v.pnpm}, git ${v.git}`);
        if (net !== null) {
          step('the way out to the registries (lfdln-build-proxy)');
          if (!await proxyUp()) throw new ProjectsError('unavailable', `The builds' proxy (${PROXY_UNIT}, svc-lfdln-apps') isn't running: builds can't reach the registries. Run install-lfdln.sh.`);
          log(`${PROXY_UNIT} is running: builds reach the registries through it, and nothing else`);
        }
        return v;
      });
      return wait(j, waitFor);
    },

    // New project: its folder, the starter tool, the first commit, the first build of main.
    async create(spec: Record<string, unknown>, actor: string, waitFor: unknown) {
      const id = spec.id;
      if (!isProjectId(id)) throw new ProjectsError('invalid', 'A project\'s name is lowercase letters, digits and dashes, starting with a letter, not ending in -dev, at most 36 long.');
      const kind = spec.kind as Kind;
      if (!(KINDS as readonly unknown[]).includes(kind)) throw new ProjectsError('invalid', 'Which kind of project?');
      if (!MADE_KINDS.includes(kind)) throw new ProjectsError('invalid', `${kind} projects come in a later version of the panel.`);
      if (spec.pm !== 'npm' && spec.pm !== 'pnpm') throw new ProjectsError('invalid', 'npm or pnpm?');
      if (typeof spec.typescript !== 'boolean' || typeof spec.tailwind !== 'boolean') throw new ProjectsError('invalid', 'TypeScript and Tailwind are yes or no.');
      if (spec.dev !== undefined && typeof spec.dev !== 'boolean') throw new ProjectsError('invalid', 'The dev branch is yes or no.');
      const want: NewProject = { id, kind, pm: spec.pm, typescript: spec.typescript, tailwind: spec.tailwind };
      const dev = spec.dev === true;
      const owners = OWNER_RE.test(actor) ? [actor] : [];
      if (record().projects.some((p) => p.id === id)) throw new ProjectsError('conflict', `There is already a project called ${id}.`);
      if (making.has(id)) throw new ProjectsError('conflict', `${id} is being made already.`);
      const makeIt = async ({ step, log }: { step: (w: string) => void; log: (t: string) => void }) => {
        // (another job may have made it while this one waited)
        if (record().projects.some((p) => p.id === id) || existsSync(dirOf(id))) throw new ProjectsError('conflict', `There is already a project (or a folder) called ${id}.`);
        if (!await imageThere(true)) throw new ProjectsError('unavailable', `The build image (${BUILD_IMAGE}) is missing: run install-lfdln.sh.`);
        const dir = dirOf(id);
        step('its folders');
        const u = await appsUser();
        must(await asRoot(['install', '-d', '-o', u.user, '-g', u.user, '-m', '711', dir], 'folder'), 'Its folder couldn\'t be made');
        try {
          must(await asApps(['mkdir', '-m', '700', join(dir, 'repo.git'), join(dir, 'work'), join(dir, 'cache'), join(dir, 'build')], 'folders'), 'Its folders couldn\'t be made');
          must(await asApps(['mkdir', '-m', '755', join(dir, 'releases'), join(dir, 'releases', 'main')], 'folders'), 'Its releases folder couldn\'t be made');
          step(`the starter (${kind.startsWith('next') ? 'create-next-app' : 'create-vite'}), its packages, the first commit`);
          const made = await inBox(id, [[join(dir, 'work'), '/work', 'rw'], [join(dir, 'repo.git'), '/repo', 'rw'], [join(dir, 'cache'), '/cache', 'rw']], 'scaffold.mjs',
            [kind, want.typescript ? 'ts' : 'js', want.tailwind ? 'tailwind' : 'plain', want.pm, id, actor], log);
          await asApps(['rm', '-rf', '--', join(dir, 'work', 'app')], 'clean').catch(() => {});
          if (typeof made.commit !== 'string') throw new ProjectsError('internal', 'Making it didn\'t say its first commit.');
          step('its repository shared with its owners');
          await shareRepo(id, owners, log);
          const r = record();
          r.projects.push({ ...want, createdAt: d.now(), createdBy: actor, owners, shared: true,
            branches: { main: { ports: ports.main ?? [], live: null, releases: [], ...(server ? { slot: null, stopped: false } : {}) } } });
          save(r);
        } catch (e) {
          // nothing points at it yet: gone, not trashed (and its group, if it got that far)
          await asRoot(['rm', '-rf', '--', dir], 'undo').catch(() => {});
          await asRoot(['groupdel', groupOf(id)], 'undo').catch(() => {});
          throw e;
        }
        const release = await build(id, 'main', actor, step, log);
        return { release, ...(dev ? { dev: await devOn(id, actor, step, log, ports.dev) } : {}) };
      };
      // a server's ports and upstreams first (D4-5): its routes can be made at once
      const server = isServer(kind);
      const ports: Partial<Record<Branch, number[]>> = {};
      if (server) {
        ports.main = freePorts(takenPorts(), 2);
        if (dev) ports.dev = freePorts([...takenPorts(), ...ports.main], 2);
      }
      making.set(id, { kind, dev, ports });
      try {
        for (const b of Object.keys(ports) as Branch[]) await pointUpstream(id, b, null, false);
      } catch (e) { making.delete(id); throw e; }
      const j = queue.add('create', actor, async (o) => {
        try { return await makeIt(o); } finally { making.delete(id); }
      }, { project: id, branch: 'main' });
      return wait(j, waitFor);
    },

    // Rebuild: the branch as it is now, a new release
    async build(id: unknown, branch: unknown, actor: string, waitFor: unknown) {
      const p = projectOf(id);
      const b = branchOf(branch);
      if (!p.branches[b]) throw new ProjectsError('not-found', `${p.id} has no ${b} branch.`);
      const j = queue.add('build', actor, async ({ step, log }) => ({ release: await build(p.id, b, actor, step, log) }), { project: p.id, branch: b });
      return wait(j, waitFor);
    },

    // Roll back (or forward again): one of the kept releases put live
    async rollback(id: unknown, branch: unknown, release: unknown, actor: string, waitFor: unknown) {
      const p = projectOf(id);
      const b = branchOf(branch);
      if (typeof release !== 'string' || !RELEASE_RE.test(release)) throw new ProjectsError('invalid', 'Which release?');
      if (!p.branches[b]?.releases.some((r) => r.id === release)) throw new ProjectsError('not-found', `${p.id} has no release ${release} on ${b} (only the last ${KEEP_RELEASES} are kept).`);
      const j = queue.add('rollback', actor, async ({ step, log }) => {
        step(`putting release ${release} live`);
        const r = projectOf(p.id).branches[b]!.releases.find((x) => x.id === release)!;
        // a server's: its image switched in, as a deploy (D4-6)
        if (r.image) await deploy(p.id, b, r.image, step, log);
        else await link(p.id, b, release);
        update(p.id, (x) => { x.branches[b]!.live = x.branches[b]!.releases.find((r) => r.id === release)!; });
        log(`live: release ${release}`);
        return { release };
      }, { project: p.id, branch: b });
      return wait(j, waitFor);
    },

    // Delete: out of the record, its folder to the trash for 30 days (the panel takes its
    // routes away first)
    async remove(id: unknown, actor: string, waitFor: unknown) {
      const p = projectOf(id);
      const j = queue.add('delete', actor, async ({ step, log }) => {
        if (isServer(p.kind)) {
          step('its servers stopped');
          for (const b of BRANCHES) if (p.branches[b]) await removeServer(p.id, b, log);
        }
        step('to the trash');
        must(await asRoot(['install', '-d', '-o', 'root', '-g', 'root', '-m', '700', trash], 'trash'), 'The trash couldn\'t be made');
        const to = join(trash, `${p.id}--${releaseIdAt(d.now())}`);
        if (existsSync(dirOf(p.id))) must(await asRoot(['mv', '-T', '--', dirOf(p.id), to], 'trash'), 'It couldn\'t be moved to the trash');
        const r = record();
        r.projects = r.projects.filter((x) => x.id !== p.id);
        save(r);
        log(`${p.id} is in the trash (${to}) for ${TRASH_DAYS} days`);
        // its environment's record (its env files went with its folder)
        await envLocked(async () => { rmSync(envStoreOf(p.id), { force: true }); });
        for (const b of BRANCHES) rmSync(packagesFile(p.id, b), { force: true });
        step('its group and git\'s list');
        await asRoot(['groupdel', groupOf(p.id)], 'group').catch(() => {});
        await writeSafeList(r.projects.map((x) => x.id));
        await syncGitGroup();
        await purgeTrash(log);
        return { trashed: to };
      }, { project: p.id });
      return wait(j, waitFor);
    },

    // Owners (D3-1): the panel says who may; here, the record and the groups follow
    async owners(id: unknown, owners: unknown, actor: string, waitFor: unknown) {
      const p = projectOf(id);
      if (!Array.isArray(owners) || owners.length < 1 || owners.length > MAX_OWNERS || owners.some((o) => typeof o !== 'string' || !OWNER_RE.test(o)) || new Set(owners).size !== owners.length) {
        throw new ProjectsError('invalid', `A project has 1 to ${MAX_OWNERS} owners, each a panel username.`);
      }
      const want = owners as string[];
      const j = queue.add('owners', actor, async ({ step, log }) => {
        step('its owners and its group');
        update(p.id, (x) => { x.owners = [...want]; });
        await syncGroups(p.id, want, log);
        log(`owners: ${want.join(', ')}`);
        return { owners: want };
      }, { project: p.id });
      return wait(j, waitFor);
    },

    // The dev branch on (made from main if git has none, built) or off (its releases gone,
    // the branch kept in git; the panel refuses while a route shows it)
    async dev(id: unknown, on: unknown, actor: string, waitFor: unknown) {
      const p = projectOf(id);
      if (typeof on !== 'boolean') throw new ProjectsError('invalid', 'On or off?');
      if (on === !!p.branches.dev) throw new ProjectsError('conflict', `${p.id}'s dev branch is already ${on ? 'on' : 'off'}.`);
      const j = queue.add(on ? 'dev-on' : 'dev-off', actor, async ({ step, log }) => {
        if (on) return { release: await devOn(p.id, actor, step, log) };
        step('the dev branch off');
        if (isServer(p.kind)) await removeServer(p.id, 'dev', log);
        update(p.id, (x) => { delete x.branches.dev; });
        await envLocked(async () => {
          const e = loadEnv(p.id);
          if (e.branches.dev) { delete e.branches.dev; forgetMoved(e, 'dev'); saveEnv(p.id, e); log('its dev environment is gone'); }
          await asApps(['rm', '-f', '--', runEnvFile(p.id, 'dev')], 'env').catch(() => {});
        });
        await asApps(['rm', '-rf', '--', join(dirOf(p.id), 'releases', 'dev')], 'let-go').catch(() => {});
        rmSync(packagesFile(p.id, 'dev'), { force: true });
        log('dev is off: its releases are gone; the branch stays in git, and a push to it builds nothing');
        return { off: true };
      }, { project: p.id, branch: 'dev' });
      return wait(j, waitFor);
    },

    async promote(id: unknown, actor: string, waitFor: unknown) {
      const p = projectOf(id);
      if (!p.branches.dev) throw new ProjectsError('conflict', `${p.id} has no dev branch to put live.`);
      const j = queue.add('promote', actor, async ({ step, log }) => promote(p.id, actor, step, log), { project: p.id, branch: 'main' });
      return wait(j, waitFor);
    },

    // Start, Stop, Restart a server branch's live slot (D4-7): stop = stop, then mask, so
    // it stays stopped after a reboot; start = unmask, start, and wait until it answers
    async control(id: unknown, branch: unknown, action: unknown, actor: string, waitFor: unknown) {
      const p = projectOf(id);
      const b = branchOf(branch);
      if (!isServer(p.kind)) throw new ProjectsError('invalid', `${p.id} serves files: there is nothing to start or stop.`);
      if (action !== 'start' && action !== 'stop' && action !== 'restart') throw new ProjectsError('invalid', 'Start, stop or restart?');
      const st = p.branches[b];
      if (!st || (st.slot !== 0 && st.slot !== 1)) throw new ProjectsError('conflict', `${p.id}'s ${b} has no release running yet.`);
      if (action === 'restart' && st.stopped) throw new ProjectsError('conflict', `${p.id}'s ${b} is stopped: start it instead.`);
      const j = queue.add(action, actor, async ({ step, log }) => {
        seen = null;
        // (as it is now: a deploy queued before this one may have switched slots)
        const now = projectOf(p.id).branches[b];
        if (!now || (now.slot !== 0 && now.slot !== 1)) throw new ProjectsError('conflict', `${p.id}'s ${b} has no release running.`);
        const slot = now.slot;
        const port = now.ports[slot]!;
        const unit = `${unitOf(p.id, b, slot)}.service`;
        if (action === 'stop') {
          step('stopping it');
          must(await userctl(['stop', unit], 'stop', 180), `${unit} couldn't be stopped`);
          must(await userctl(['mask', unit], 'mask'), `${unit} stopped, but couldn't be kept stopped after a restart of the server`);
          update(p.id, (x) => { x.branches[b]!.stopped = true; });
          log(`${unit} stopped (and stays stopped after a restart of the server)`);
          return { stopped: true };
        }
        step(action === 'start' ? 'starting it' : 'restarting it');
        // with its environment as it is now (D4-11), in a Quadlet that reads it (8b-4a's didn't)
        const image = now.live?.image;
        if (image) {
          await writeRunEnv(p.id, b);
          await putAppsFile(join(await quadletDir(), `${unitOf(p.id, b, slot)}.container`), quadletText(p.id, b, slot, port, image, runEnvFile(p.id, b), identityKeyOf(d.identityPub), d.dbPorts), 'quadlet', `${unit}'s Quadlet`);
        }
        if (action === 'start') await userctl(['unmask', unit], 'unmask').catch(() => {});
        must(await userctl(['daemon-reload'], 'reload'), 'svc-lfdln-apps\' units couldn\'t be reloaded');
        must(await userctl([action === 'start' ? 'start' : 'restart', unit], 'start', 180), `${unit} couldn't be ${action === 'start' ? 'started' : 'restarted'}`);
        update(p.id, (x) => { x.branches[b]!.stopped = false; });
        step('waiting until it answers');
        if (!await answers(port)) throw new ProjectsError('internal', `${unit} runs but didn't answer on port ${port} within ${ANSWER_MS / 1000} seconds: its server log may say why.`);
        log(`${unit} answers on port ${port}`);
        return { answering: true };
      }, { project: p.id, branch: b });
      return wait(j, waitFor);
    },

    // Every project as this release makes it (docs/s1-plan.md S1d), asked by install-lfdln.sh:
    // a server's database addresses at 10.0.2.2 told 127.0.0.1 (moveVars), and each running
    // one put live again in its other slot with them (nginx switches once it answers; its
    // variables and env file change only then); a stopped one gets its files and starts so.
    // A branch with 10.0.2.2 left in a variable after that (a form moveVars doesn't know) is
    // kept as it is, on slirp4netns, and named (never its values): pasta would cut it off.
    // One that doesn't answer stays as it was, its env file untouched. Asked again: nothing.
    // What it moved is kept, before and after (the env store's `moved`), for putBack.
    async refresh(actor: string, waitFor: unknown) {
      return wait(queue.add('refresh', actor, (io) => moveAll('pasta', null, io)), waitFor);
    },
    // ...and back (S1f (a)), the step before an older release than S1d is installed: each
    // server's moved variables at 10.0.2.2 again (backVars: from refresh's copy, else by their
    // form) and its Quadlet slirp4netns:allow_host_loopback, as that release writes them; put
    // live again slot to slot as refresh does. `id`: that project alone (verify). The next
    // deploy or restart under this release puts it on pasta again (with 10.0.2.2 in its
    // variables, reaching nothing: the Environment page warns), so the older installer follows.
    async putBack(id: unknown, actor: string, waitFor: unknown) {
      const only = id === undefined || id === null ? null : projectOf(id).id;
      return wait(queue.add('put-back', actor, (io) => moveAll('back', only, io), only ? { project: only } : undefined), waitFor);
    },

    // A server branch's log (D4-8): the journal of both its slots (the live one, and a new
    // release that didn't answer), the last 200 lines
    async logs(id: unknown, branch: unknown) {
      const p = projectOf(id);
      const b = branchOf(branch);
      if (!isServer(p.kind)) throw new ProjectsError('invalid', `${p.id} serves files: it has no server log (each build's log is with its job).`);
      const u = await appsUser();
      const r = await asRoot(['journalctl', `_UID=${u.uid}`, `_SYSTEMD_USER_UNIT=${unitOf(p.id, b, 0)}.service`, `_SYSTEMD_USER_UNIT=${unitOf(p.id, b, 1)}.service`,
        '-n', '200', '-o', 'short-iso', '--no-pager', '-q'], 'logs');
      if (r.code !== 0) throw new ProjectsError('internal', `${p.id}'s server log couldn't be read (${lastLines(r)}).`);
      return { lines: r.stdout.split('\n').filter(Boolean).slice(-200) };
    },

    // A branch's environment (D4-11): its names, never its values; which are in the files
    // every visitor gets
    async env(id: unknown, branch: unknown) {
      const p = projectOf(id);
      const b = branchOf(branch);
      if (!p.branches[b]) throw new ProjectsError('not-found', `${p.id} has no ${b} branch.`);
      // oldHost (S1f (b)): it names 10.0.2.2, which a project on pasta can't reach (a warning)
      const vars = varsOf(p.id, b);
      return { vars: Object.keys(vars).sort().map((name) => ({ name, public: isPublicEnv(name), oldHost: namesOldHost(vars[name]!) })), max: MAX_ENV, panel: PANEL_ENV };
    },
    // ...and its values (the panel asks for a fresh passkey first)
    async envValues(id: unknown, branch: unknown) {
      const p = projectOf(id);
      const b = branchOf(branch);
      if (!p.branches[b]) throw new ProjectsError('not-found', `${p.id} has no ${b} branch.`);
      return { values: varsOf(p.id, b) };
    },
    // One set (value a string) or removed (value null). A server's env file follows at once;
    // what it takes before it is used is said (EnvNeeds).
    async envSet(id: unknown, branch: unknown, name: unknown, value: unknown) {
      const p = projectOf(id);
      const b = branchOf(branch);
      if (!p.branches[b]) throw new ProjectsError('not-found', `${p.id} has no ${b} branch.`);
      if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) throw new ProjectsError('invalid', 'A name is capital letters, digits and _, not starting with a digit (MY_API_KEY).');
      if (PANEL_ENV.includes(name)) throw new ProjectsError('invalid', `${name} is the panel's: ${PANEL_ENV.join(', ')} are set for every project.`);
      if (value !== null && (typeof value !== 'string' || value.length > ENV_VALUE_MAX || /[\r\n\0]/.test(value))) {
        throw new ProjectsError('invalid', `A value is one line, at most ${ENV_VALUE_MAX} characters.`);
      }
      return envLocked(async () => {
        const e = loadEnv(p.id);
        const vars = { ...(e.branches[b] ?? {}) };
        if (value === null) {
          if (!(name in vars)) throw new ProjectsError('not-found', `${p.id}'s ${b} has no ${name}.`);
          delete vars[name];
          forgetMoved(e, b, [name]);
        } else {
          if (!(name in vars) && Object.keys(vars).length >= MAX_ENV) throw new ProjectsError('invalid', `A branch has at most ${MAX_ENV} variables.`);
          vars[name] = value;
        }
        e.branches[b] = vars;
        saveEnv(p.id, e);
        const server = isServer(p.kind);
        const st = projectOf(p.id).branches[b];
        if (server) await writeRunEnv(p.id, b);
        const needs: EnvNeeds = !st?.live ? 'nothing' : !server || isPublicEnv(name) ? 'rebuild' : 'restart';
        d.log?.(`${p.id} ${b}: ${name} ${value === null ? 'removed' : 'set'}`);
        return { name, removed: value === null, needs, public: isPublicEnv(name) };
      });
    },

    // Packages (8b-8a): the last check of the branch changes go to, and which that is
    async packages(id: unknown) {
      const p = projectOf(id);
      const branch = changeBranch(p);
      return { branch, check: lastCheck(p.id, branch), autoUpdate: !!p.autoUpdate };
    },
    // each night, updated within their ranges, or not (8b-8b)
    async autoUpdate(id: unknown, on: unknown) {
      const p = projectOf(id);
      if (typeof on !== 'boolean') throw new ProjectsError('invalid', 'On or off?');
      update(p.id, (x) => { if (on) x.autoUpdate = true; else delete x.autoUpdate; });
      return { autoUpdate: on };
    },
    // the night's run, now (verify and the tests): every project checked as it would be
    nightly: () => nightly(true).then((jobs) => ({ jobs })),
    async packagesCheck(id: unknown, actor: string, waitFor: unknown) {
      const p = projectOf(id);
      const branch = changeBranch(p);
      const j = queue.add('packages-check', actor, async ({ step, log }) => {
        step(`checking ${branch}'s packages (installed, then asked of the registry)`);
        return { check: await checkPackages(p.id, branch, log) };
      }, { project: p.id, branch });
      return wait(j, waitFor);
    },
    // A change (D8-4): in the box, committed and pushed to the branch; then built as a push
    // would be. If the build fails the branch is put back, so nothing changes live.
    async packagesChange(id: unknown, change: unknown, actor: string, waitFor: unknown) {
      const p = projectOf(id);
      const c = checkChange(change);
      const branch = changeBranch(p);
      const by = OWNER_RE.test(actor) ? actor : 'panel';
      const j = queue.add('packages', actor, async ({ step, log }) => {
        return changeAndBuild(p.id, branch, c, by, step, log);
      }, { project: p.id, branch });
      return wait(j, waitFor);
    },
    // A script of package.json's (D8-6), with the branch's environment; its output is the job's log
    async packagesRun(id: unknown, script: unknown, actor: string, waitFor: unknown) {
      const p = projectOf(id);
      if (typeof script !== 'string' || !SCRIPT_RE.test(script)) throw new ProjectsError('invalid', 'Which script?');
      if (LONG_RUNNING.includes(script)) throw new ProjectsError('invalid', `${script} serves and never finishes: it isn't run here.`);
      const branch = changeBranch(p);
      const j = queue.add('script', actor, async ({ step, log }) => {
        step(`running ${script} on ${branch}`);
        return await packagesBox(p.id, branch, ['run', branch, script], log, { env: true });
      }, { project: p.id, branch });
      return wait(j, waitFor);
    },
    // the registry's search, and one package with its warnings (D8-3): never queued
    async packageSearch(text: unknown) {
      if (typeof text !== 'string' || !text.trim() || text.length > 100) throw new ProjectsError('invalid', 'Search for what?');
      return registryBox(['search', text.trim()]);
    },
    async packageAbout(name: unknown, lang: unknown) {
      if (typeof name !== 'string' || !PKG_NAME_RE.test(name)) throw new ProjectsError('invalid', 'That isn\'t a package name.');
      return registryBox(['about', name, lang === 'ts' ? 'ts' : 'js']);
    },

    // A branch's database, as the panel made it with the database helper (8b-5): written down
    // here, beside the branch; null when it no longer uses one (the database itself is kept)
    async database(id: unknown, branch: unknown, db: unknown, actor: string) {
      const p = projectOf(id);
      const b = branchOf(branch);
      if (!p.branches[b]) throw new ProjectsError('not-found', `${p.id} has no ${b} branch.`);
      if (!isServer(p.kind)) throw new ProjectsError('invalid', `${p.id} serves files: only a server uses a database.`);
      let rec: BranchDatabase | null = null;
      if (db !== null) {
        const v = db as Partial<BranchDatabase>;
        if (!v || typeof v !== 'object' || !(DB_ENGINES as readonly unknown[]).includes(v.engine) || ![v.name, v.owner, v.app].every((x) => typeof x === 'string' && DB_NAME_RE.test(x))) {
          throw new ProjectsError('invalid', 'Which database (its engine, name and two logins)?');
        }
        rec = { engine: v.engine!, name: v.name!, owner: v.owner!, app: v.app!, at: d.now(), by: actor, ...(v.shared === true ? { shared: true } : {}) };
      }
      update(p.id, (x) => { x.branches[b]!.database = rec; });
      d.log?.(`${p.id} ${b}: database ${rec ? `${rec.engine} ${rec.name}${rec.shared ? ' (main\'s)' : ''}` : 'none'}`);
      return { database: rec };
    },

    // How each server is (D4-12, for monitoring): every branch with a release, its live
    // slot as systemd sees it, and whether it answers / on its port
    async health() {
      seen = null;
      const units = await serverStates();
      const out: { project: string; branch: Branch; unit: string; port: number; active: string; sub: string; stopped: boolean; answering: { status: number | null; ms: number } | null }[] = [];
      for (const p of record().projects.filter((x) => isServer(x.kind))) {
        for (const b of BRANCHES) {
          const st = p.branches[b];
          if (!st || (st.slot !== 0 && st.slot !== 1)) continue;
          const unit = unitOf(p.id, b, st.slot);
          const kv = units.get(`${unit}.service`) ?? {};
          const port = st.ports[st.slot]!;
          const stopped = !!st.stopped || kv.LoadState === 'masked';
          const active = kv.ActiveState ?? 'unknown';
          out.push({ project: p.id, branch: b, unit, port, active, sub: kv.SubState ?? '', stopped,
            answering: !stopped && active === 'active' && d.probe ? await d.probe(port, '/', 5000) : null });
        }
      }
      return { servers: out, proxy: net === null ? null : await proxyUp() };
    },

    // The pushes the hook dropped (the helper calls this on start, when the folder changes,
    // and every minute); verify and the tests call it too.
    drainPushes,

    // On start: projects made before 8b-3 shared with their owners (D3-9), the spool drained
    // and then watched.
    start() {
      for (const p of record().projects) {
        if (p.shared) continue;
        queue.add('share', 'the panel', async ({ step, log }) => {
          step('its repository shared with its owners');
          await shareRepo(p.id, p.owners, log);
          update(p.id, (x) => { x.shared = true; });
          return { shared: true };
        }, { project: p.id });
      }
      void drainPushes();
      let soon: NodeJS.Timeout | undefined;
      try {
        watch(spool, () => { clearTimeout(soon); soon = setTimeout(() => void drainPushes(), 200); }).on('error', () => {});
      } catch (e) { d.log?.(`pushes: not watching ${spool} (${(e as Error).message}); checked every minute`); }
      setInterval(() => void drainPushes(), 60_000).unref();
      setInterval(() => void nightly().catch((e) => d.log?.(`nightly: ${(e as Error).message}`)), 600_000).unref();
    },
  };
}
export type ProjectsOps = ReturnType<typeof createProjectsOps>;
