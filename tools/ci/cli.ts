// lfdln-ci (docs/ci-plan.md, T1-c): what CI says about the branches, and asking it for a run.
//   lfdln-ci status                   every recent branch: its head, fast and full results
//   lfdln-ci log <commit|branch> [fast|full]
//   lfdln-ci full [<branch|commit>]   ask for the full tier (default: the branch you are on)
//   lfdln-ci check <commit>           exit 0 if the full tier passed for that commit (installers)
// Anyone may read; asking for a run needs write access to the requests folder (momolig).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { heads, readResult, REQUESTS, RECENT_DAYS, resultFile, SRC, type Result, type Tier } from './runner.ts';

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const said = (r: Result | null) => (!r ? '—' : r.skipped ? 'skipped (no --tier)' : r.ok ? `passed ${ago(r.finished)} (${r.seconds}s)` : `FAILED ${ago(r.finished)} in "${r.failedSection}"`);

// a branch name, a short or full commit -> the full commit, from the shared repository
function commitOf(what: string): string {
  const r = spawnSync('git', ['-C', SRC, 'rev-parse', '--verify', '--quiet', `${what}^{commit}`], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`lfdln-ci: no branch or commit "${what}" in ${SRC}`); process.exit(2); }
  return r.stdout.trim();
}

function currentBranch(): string {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  if (r.status !== 0 || r.stdout.trim() === 'HEAD') { console.error('lfdln-ci full: name a branch or commit (not inside a branch here)'); process.exit(2); }
  return r.stdout.trim();
}

const [cmd = 'status', arg, tierArg] = process.argv.slice(2);
if (cmd === 'status') {
  const now = Date.now() / 1000;
  const rows = heads().filter((h) => now - h.at <= RECENT_DAYS * 86400);
  if (!rows.length) console.log(`no branch with a commit in the last ${RECENT_DAYS} days`);
  for (const h of rows) {
    console.log(`${h.branch.padEnd(24)} ${h.commit.slice(0, 12)}  fast: ${said(readResult(h.commit, 'fast')).padEnd(34)} full: ${said(readResult(h.commit, 'full'))}`);
  }
} else if (cmd === 'log') {
  if (!arg) { console.error('lfdln-ci log <commit|branch> [fast|full]'); process.exit(2); }
  const commit = commitOf(arg);
  const tier: Tier = tierArg === 'full' ? 'full' : tierArg === 'fast' ? 'fast' : (readResult(commit, 'full') ? 'full' : 'fast');
  try { process.stdout.write(readFileSync(resultFile(commit, tier, 'log'))); } catch { console.error(`no ${tier} log for ${commit.slice(0, 12)} yet`); process.exit(1); }
} else if (cmd === 'full') {
  const commit = commitOf(arg ?? currentBranch());
  const by = process.env.SUDO_USER ?? process.env.USER ?? null;
  try {
    writeFileSync(join(REQUESTS, `${commit}.full.json`), `${JSON.stringify({ commit, tier: 'full', by, at: new Date().toISOString() })}\n`, { mode: 0o664 });
  } catch (e) { console.error(`lfdln-ci full: can't write the request (${(e as Error).message})`); process.exit(1); }
  console.log(`asked for the full tier of ${commit.slice(0, 12)}: it starts within a minute if nothing else is running (lfdln-ci status)`);
} else if (cmd === 'check') {
  if (!arg) { console.error('lfdln-ci check <commit>'); process.exit(2); }
  const r = readResult(commitOf(arg), 'full');
  if (r?.skipped) { console.log(`CI: ${r.commit.slice(0, 12)} was not checked: ${r.skipped}`); process.exit(1); }
  if (r?.ok) { console.log(`CI: the full tier passed for ${r.commit.slice(0, 12)} (${ago(r.finished)})`); process.exit(0); }
  console.log(r ? `CI: the full tier FAILED for ${r.commit.slice(0, 12)} in "${r.failedSection}"` : `CI: no full-tier result for ${arg} (lfdln-ci full ${arg})`);
  process.exit(1);
} else {
  console.error('lfdln-ci status | log <commit|branch> [fast|full] | full [<branch|commit>] | check <commit>');
  process.exit(2);
}
