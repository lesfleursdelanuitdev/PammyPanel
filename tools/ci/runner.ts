// The CI runner (docs/ci-plan.md, T1-c). Run by svc-ci's lfdln-ci.service every minute
// (a oneshot: systemd never starts a second one while one runs), from a copy the
// installer put in /opt/lfdln-ci, so a branch under test can't change the runner itself.
//
// Each start does at most one thing:
//   1. a "full" request someone made with `lfdln-ci full` (oldest first), or
//   2. the fast tier for the newest branch head that has no result yet.
// A result belongs to a commit, not a branch: two branches at the same commit share it.
//
// It reads the shared repository (~/pamela-setup/.git) and never writes there: its own
// clone (`git clone --shared`) fetches from it, checks the commit out and runs
// panel/build.sh --tier <tier>, which takes the server's test lock itself.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';

export const SRC = process.env.CI_SOURCE ?? '/home/momolig/pamela-setup';
export const STATE = process.env.CI_STATE ?? '/var/lib/lfdln-ci';
export const REPO = join(STATE, 'repo');
export const RESULTS = join(STATE, 'results');
export const REQUESTS = join(STATE, 'requests');
// a branch whose head is older than this is not checked on its own (13 worktrees, some long done)
export const RECENT_DAYS = 7;
export type Tier = 'fast' | 'full';

export type Section = { name: string; seconds: number };
export type Result = {
  commit: string; tier: Tier; ok: boolean; branches: string[];
  started: string; finished: string; seconds: number;
  failedSection: string | null; sections: Section[]; requestedBy: string | null;
  // not run, and why (a commit from before build.sh had --tier: it would build a whole release)
  skipped?: string;
};

const SHA_RE = /^[0-9a-f]{40}$/;

export function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${dir}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export type Head = { branch: string; commit: string; at: number };
export function heads(src = SRC): Head[] {
  const out = git(src, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short) %(objectname) %(committerdate:unix)', 'refs/heads');
  return out.split('\n').filter(Boolean).map((l) => {
    const [branch, commit, at] = l.split(' ');
    return { branch: branch!, commit: commit!, at: Number(at) };
  });
}

export const resultFile = (commit: string, tier: Tier, ext: 'json' | 'log') => join(RESULTS, `${commit}.${tier}.${ext}`);
export function readResult(commit: string, tier: Tier): Result | null {
  try { return JSON.parse(readFileSync(resultFile(commit, tier, 'json'), 'utf8')) as Result; } catch { return null; }
}

function writeAtomically(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}

type Request = { file: string; commit: string; tier: Tier; by: string | null };
// requests/<anything>.json: { "commit": "<40 hex>", "tier": "full", "by": "momolig" }
function nextRequest(): Request | null {
  let names: string[];
  try { names = readdirSync(REQUESTS).filter((n) => n.endsWith('.json')); } catch { return null; }
  const withTimes = names.map((n) => ({ n, t: statSync(join(REQUESTS, n)).mtimeMs })).sort((a, b) => a.t - b.t);
  for (const { n } of withTimes) {
    const file = join(REQUESTS, n);
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as { commit?: unknown; tier?: unknown; by?: unknown };
      if (typeof r.commit === 'string' && SHA_RE.test(r.commit) && (r.tier === 'full' || r.tier === 'fast')) {
        return { file, commit: r.commit, tier: r.tier, by: typeof r.by === 'string' ? r.by.slice(0, 64) : null };
      }
    } catch { /* unreadable: dropped below */ }
    rmSync(file, { force: true });
  }
  return null;
}

// What runs now: a request first, else the newest recent branch head with no fast result.
export function pick(now: number, hs: Head[]): { commit: string; tier: Tier; request: Request | null } | null {
  const req = nextRequest();
  if (req) return { commit: req.commit, tier: req.tier, request: req };
  for (const h of hs) {
    if (now / 1000 - h.at > RECENT_DAYS * 86400) continue;
    if (!readResult(h.commit, 'fast')) return { commit: h.commit, tier: 'fast', request: null };
  }
  return null;
}

// The clone, at exactly that commit, with node_modules kept unless package-lock changed.
function checkout(commit: string) {
  if (!existsSync(join(REPO, '.git'))) {
    const r = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', SRC, REPO], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git clone: ${r.stderr.trim()}`);
  }
  git(REPO, 'fetch', '--quiet', '--prune', SRC, '+refs/heads/*:refs/remotes/src/*');
  git(REPO, 'checkout', '--quiet', '--force', '--detach', commit);
  git(REPO, 'clean', '-q', '-ffdx', '-e', 'panel/node_modules');
  const lock = join(REPO, 'panel', 'package-lock.json');
  const mark = join(REPO, 'panel', 'node_modules', '.lfdln-ci-lock-hash');
  const hash = existsSync(lock) ? createHash('sha256').update(readFileSync(lock)).digest('hex') : '';
  let had = '';
  try { had = readFileSync(mark, 'utf8').trim(); } catch { /* none yet */ }
  if (had !== hash) {
    rmSync(join(REPO, 'panel', 'node_modules'), { recursive: true, force: true });
    const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: join(REPO, 'panel'), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`npm ci: ${r.stderr.trim().slice(-2000)}`);
    writeFileSync(mark, `${hash}\n`);
  }
}

// build.sh's "--- name" lines mark its sections; each one's time is taken as it goes by.
function run(commit: string, tier: Tier): Promise<{ ok: boolean; sections: Section[]; failedSection: string | null }> {
  return new Promise((resolve) => {
    const log = createWriteStream(resultFile(commit, tier, 'log'), { mode: 0o644 });
    const sections: Section[] = [];
    let current = 'setup', since = Date.now(), buffer = '';
    const close = () => { sections.push({ name: current, seconds: Math.round((Date.now() - since) / 1000) }); };
    const onData = (chunk: Buffer) => {
      log.write(chunk);
      buffer += chunk.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        const m = /^--- (.+)$/.exec(line);
        if (m && !m[1]!.startsWith('waiting for another test run')) { close(); current = m[1]!; since = Date.now(); }
      }
    };
    const child = spawn('./build.sh', ['--tier', tier], { cwd: join(REPO, 'panel'), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      close();
      log.end();
      resolve({ ok: code === 0, sections, failedSection: code === 0 ? null : current });
    });
  });
}

// build.sh knows --tier only from T1-a on; an older one ignores it and builds a whole release
export function knowsTiers(commit: string, src = SRC): boolean {
  const r = spawnSync('git', ['-C', src, 'show', `${commit}:panel/build.sh`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes('--tier');
}

export async function main() {
  for (const d of [RESULTS, REQUESTS]) mkdirSync(d, { recursive: true });
  const hs = heads();
  let job = pick(Date.now(), hs);
  // a commit CI can't check is written down as skipped (so it isn't picked again), and the next one looked at
  while (job && !knowsTiers(job.commit)) {
    const at = new Date().toISOString();
    const skipped: Result = {
      commit: job.commit, tier: job.tier, ok: false, branches: hs.filter((h) => h.commit === job!.commit).map((h) => h.branch),
      started: at, finished: at, seconds: 0, failedSection: null, sections: [], requestedBy: job.request?.by ?? null,
      skipped: "its build.sh has no --tier (from before CI): merge main into the branch",
    };
    writeAtomically(resultFile(job.commit, job.tier, 'json'), `${JSON.stringify(skipped, null, 2)}\n`);
    if (job.request) rmSync(job.request.file, { force: true });
    job = pick(Date.now(), hs);
  }
  if (!job) return;
  const started = new Date();
  const branches = hs.filter((h) => h.commit === job!.commit).map((h) => h.branch);
  let outcome: { ok: boolean; sections: Section[]; failedSection: string | null };
  try {
    checkout(job.commit);
    outcome = await run(job.commit, job.tier);
  } catch (e) {
    writeAtomically(resultFile(job.commit, job.tier, 'log'), `${(e as Error).message}\n`);
    outcome = { ok: false, sections: [], failedSection: 'checkout' };
  }
  const finished = new Date();
  const result: Result = {
    commit: job.commit, tier: job.tier, ok: outcome.ok, branches,
    started: started.toISOString(), finished: finished.toISOString(),
    seconds: Math.round((finished.getTime() - started.getTime()) / 1000),
    failedSection: outcome.failedSection, sections: outcome.sections, requestedBy: job.request?.by ?? null,
  };
  writeAtomically(resultFile(job.commit, job.tier, 'json'), `${JSON.stringify(result, null, 2)}\n`);
  if (job.request) rmSync(job.request.file, { force: true });
  console.log(`${job.tier} ${job.commit.slice(0, 12)} (${branches.join(', ') || 'no branch'}): ${result.ok ? 'passed' : `FAILED in "${result.failedSection}"`} after ${result.seconds}s`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => { console.error(e); process.exit(1); });
}
