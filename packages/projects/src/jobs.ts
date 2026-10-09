// The projects helper's jobs (docs/phase8b-plan.md "The projects helper"): one at a time on
// the whole server, in the order asked, each with its steps and a log of its own. A build
// can use 2 GB, so two never run together. Kept: the last 200, in jobs.json beside the
// record; each log in logs/<project or "-">/<job>.log.
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectsError } from './record.ts';

export type JobState = 'queued' | 'running' | 'done' | 'failed';
export type Job = {
  id: string; project: string | null; branch: string | null; what: string; by: string;
  state: JobState; queuedAt: number; startedAt: number | null; endedAt: number | null;
  step: string | null; error: string | null; result: unknown;
};
// What a job does: tell each step, write to its log, and return a result or throw.
export type JobWork = (o: { step: (words: string) => void; log: (text: string) => void; job: Job }) => Promise<unknown>;

export const KEEP = 200;
export const JOB_ID_RE = /^[0-9]{10}-[0-9a-f]{8}$/;

export function createQueue(o: { dir: string; now: () => number; log?: (line: string) => void }) {
  const historyFile = join(o.dir, 'jobs.json');
  let jobs: Job[] = [];
  try { jobs = (JSON.parse(readFileSync(historyFile, 'utf8')) as Job[]).filter((j) => JOB_ID_RE.test(j.id)); } catch { /* none yet */ }
  // a job running when the helper stopped didn't finish
  for (const j of jobs) if (j.state === 'queued' || j.state === 'running') Object.assign(j, { state: 'failed', error: 'The helper stopped while this job was waiting or running.', endedAt: j.endedAt ?? o.now() });
  const work = new Map<string, JobWork>();
  const waiting = new Map<string, ((j: Job) => void)[]>();
  let running = false;

  const save = () => {
    jobs = jobs.slice(-KEEP);
    const tmp = `${historyFile}.new`;
    writeFileSync(tmp, JSON.stringify(jobs), { mode: 0o600 });
    renameSync(tmp, historyFile);
  };
  const logFile = (j: Job) => join(o.dir, 'logs', j.project ?? '-', `${j.id}.log`);
  const append = (j: Job, text: string) => {
    mkdirSync(join(o.dir, 'logs', j.project ?? '-'), { recursive: true, mode: 0o700 });
    appendFileSync(logFile(j), text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
  };

  const next = async () => {
    if (running) return;
    const j = jobs.find((x) => x.state === 'queued');
    if (!j) return;
    running = true;
    Object.assign(j, { state: 'running', startedAt: o.now() });
    save();
    o.log?.(`job ${j.id} ${j.what}${j.project ? ` ${j.project}` : ''} started`);
    try {
      j.result = await work.get(j.id)!({
        job: j,
        step: (words) => { j.step = words; append(j, `--- ${words}`); },
        log: (text) => append(j, text),
      }) ?? null;
      Object.assign(j, { state: 'done', step: null });
    } catch (e) {
      const words = e instanceof ProjectsError ? e.message : `Something went wrong: ${(e as Error).message}`.slice(0, 400);
      Object.assign(j, { state: 'failed', error: words });
      append(j, `FAILED: ${words}`);
    } finally {
      j.endedAt = o.now();
      work.delete(j.id);
      save();
      o.log?.(`job ${j.id} ${j.state}`);
      for (const resolve of waiting.get(j.id) ?? []) resolve(j);
      waiting.delete(j.id);
      running = false;
      void next();
    }
  };

  return {
    // Queue it; the answer comes at once, the work later.
    add(what: string, by: string, fn: JobWork, where: { project?: string; branch?: string } = {}): Job {
      const j: Job = {
        id: `${String(o.now()).padStart(10, '0')}-${randomBytes(4).toString('hex')}`, project: where.project ?? null, branch: where.branch ?? null,
        what, by, state: 'queued', queuedAt: o.now(), startedAt: null, endedAt: null, step: null, error: null, result: null,
      };
      jobs.push(j);
      work.set(j.id, fn);
      save();
      void next();
      return j;
    },
    // until it has finished (verify's self-test waits)
    done(id: string): Promise<Job> {
      const j = jobs.find((x) => x.id === id);
      if (!j) return Promise.reject(new ProjectsError('not-found', 'There is no such job.'));
      if (j.state === 'done' || j.state === 'failed') return Promise.resolve(j);
      return new Promise((resolve) => waiting.set(id, [...(waiting.get(id) ?? []), resolve]));
    },
    list: (project?: string) => jobs.filter((j) => project === undefined || j.project === project).slice().reverse(),
    get: (id: string) => jobs.find((j) => j.id === id) ?? null,
    log(id: string): string {
      const j = jobs.find((x) => x.id === id);
      if (!j) throw new ProjectsError('not-found', 'There is no such job.');
      try { return readFileSync(logFile(j), 'utf8').slice(-512 * 1024); } catch { return ''; }
    },
    busy: () => running,
  };
}
export type Queue = ReturnType<typeof createQueue>;
