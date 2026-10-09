// Shared by the scripts that run inside the build container (docs/phase8b-plan.md "A build"):
// plain Node, no packages, nothing of the panel's. Each step's command is printed before it
// runs, so the job's log reads like a terminal; the last line printed is the JSON answer.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function run(cmd, args, cwd) {
  console.log(`$ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  if (r.error) throw new Error(`${cmd} didn't start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ''} failed (exit ${r.status ?? r.signal})`);
}

export function out(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: process.env });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ''} failed: ${(r.stderr || '').trim().slice(-300)}`);
  return r.stdout.trim();
}

// npm or pnpm: the lockfile decides (Q-J4)
export const pmOf = (dir) => (existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm');

export function answer(o) { console.log(JSON.stringify(o)); }

export async function main(fn) {
  try { await fn(); } catch (e) {
    console.error(`\nFAILED: ${e.message}`);
    process.exit(1);
  }
}
