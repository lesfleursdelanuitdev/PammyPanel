// Every service runs with SystemCallFilter=~@privileged, and a forbidden syscall
// kills the process (SIGSYS) instead of failing. These tests don't run sandboxed,
// so keep out of the server code the calls that end in one: fs.copyFileSync (and
// fs.cp) fchown() the copy, and chown is @privileged. Use copyBytes (sitefs/media.ts).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
// the server code: every package and site (src/ is only entry points that load them)
const DIRS = ['packages', 'sites'];
const FORBIDDEN = /\b(copyFile(Sync)?|cp(Sync)?|l?f?chown(Sync)?)\s*\(/;

it('server code never calls copyFile, cp or chown (the seccomp filter would kill it)', () => {
  const hits: string[] = [];
  for (const dir of DIRS) {
    for (const f of readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })) {
      if (!f.endsWith('.ts') || f.includes('node_modules')) continue;
      readFileSync(join(ROOT, dir, f), 'utf8').split('\n').forEach((line, i) => {
        if (!/^\s*\/\//.test(line) && FORBIDDEN.test(line)) hits.push(`${dir}/${f}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(hits, []);
});
