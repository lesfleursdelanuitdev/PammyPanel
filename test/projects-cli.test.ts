// lfdln-panel projects-put-back (docs/s1-plan.md S1f (a)): asks the helper, follows the job,
// says each branch, fails when one didn't answer.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonLineServer, type JsonRequest } from '@panel/core/jsonline';
import { projectsCommand } from '@panel/projects/cli';

describe('lfdln-panel projects-put-back (S1f)', () => {
  const sock = join(mkdtempSync(join(tmpdir(), 'projects-cli-')), 'p.sock');
  const asked: JsonRequest[] = [];
  let polls = 0;
  let failed = 0;
  const result = () => ({ projects: [{ project: 'app', branch: 'main', result: failed ? 'failed' : 'redeployed', env: failed ? [] : ['DATABASE_URL'], error: failed ? 'no answer' : undefined }], failed, kept: 0 });
  const server = createJsonLineServer((req) => {
    asked.push(req);
    if (req.op === 'put-back') return { job: { id: 'j1', state: 'queued' } };
    if (req.op === 'job') return { job: { id: 'j1', state: ++polls < 2 ? 'running' : 'done', result: result() } };
    throw new Error('?');
  });
  const ready = new Promise<void>((r) => server.listen(sock, r));
  after(() => server.close());
  const run = async (args: string[], cmd = 'projects-put-back') => {
    await ready;
    const lines: string[] = [];
    const prev = process.exitCode;
    process.exitCode = undefined;
    const took = await projectsCommand(sock, cmd, args, { sleep: async () => {}, print: (l) => lines.push(l) });
    const code = process.exitCode;
    process.exitCode = prev;
    return { took, lines, code };
  };

  it('not its command: not taken', async () => {
    assert.equal((await run([], 'users')).took, false);
  });

  it('asks put-back (one project or all), follows the job until done, names each branch', async () => {
    const r = await run(['app']);
    assert.equal(r.took, true);
    assert.deepEqual(asked.map((x) => x.op), ['put-back', 'job', 'job']);
    assert.deepEqual([asked[0]!.id, asked[0]!.actor, asked[1]!.id], ['app', 'lfdln-panel', 'j1']);
    assert.ok(r.lines.some((l) => l === '  redeployed  app main (DATABASE_URL now at 10.0.2.2)'), r.lines.join('\n'));
    assert.match(r.lines.at(-1)!, /install the older release/);
    assert.equal(r.code, undefined);
  });

  it('a branch that didn\'t answer: FAIL, exit 1; too many words: usage, exit 2', async () => {
    failed = 1;
    polls = 5;
    const r = await run([]);
    assert.equal(asked.filter((x) => x.op === 'put-back').at(-1)!.id, undefined, 'every project');
    assert.match(r.lines.join('\n'), /failed {2}app main: no answer[\s\S]*FAIL {2}1 branch/);
    assert.equal(r.code, 1);
    assert.equal((await run(['a', 'b'])).code, 2);
  });
});
