// The CI runner's choice of what to run next (docs/ci-plan.md, T1-c): a request first,
// else the newest recent branch head with no fast result; old heads are left alone.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const state = mkdtempSync(join(tmpdir(), 'ci-runner-'));
process.env.CI_STATE = state;
const { pick, REQUESTS, RESULTS, resultFile, RECENT_DAYS } = await import('../tools/ci/runner.ts');
after(() => rmSync(state, { recursive: true, force: true }));

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const now = Date.now();
const at = (daysAgo: number) => Math.round(now / 1000 - daysAgo * 86400);
const heads = [
  { branch: 'newest', commit: A, at: at(0.1) },
  { branch: 'older', commit: B, at: at(2) },
  { branch: 'stale', commit: C, at: at(RECENT_DAYS + 1) },
];
const passed = (commit: string, tier: 'fast' | 'full') => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resultFile(commit, tier, 'json'), JSON.stringify({ commit, tier, ok: true }));
};

describe('the CI runner picks', () => {
  it('the newest branch head with no fast result', () => {
    assert.deepEqual(pick(now, heads), { commit: A, tier: 'fast', request: null });
  });
  it('the next one once that has a result, and never a head older than a week', () => {
    passed(A, 'fast');
    assert.equal(pick(now, heads)?.commit, B);
    passed(B, 'fast');
    assert.equal(pick(now, heads), null);
  });
  it('a request before anything else, and drops one it cannot read', () => {
    mkdirSync(REQUESTS, { recursive: true });
    writeFileSync(join(REQUESTS, 'bad.json'), '{"commit":"not a commit","tier":"full"}');
    writeFileSync(join(REQUESTS, 'ok.json'), JSON.stringify({ commit: C, tier: 'full', by: 'momolig' }));
    const job = pick(now, heads);
    assert.equal(job?.commit, C);
    assert.equal(job?.tier, 'full');
    assert.equal(job?.request?.by, 'momolig');
    assert.equal(existsSync(join(REQUESTS, 'bad.json')), false);
  });
});
