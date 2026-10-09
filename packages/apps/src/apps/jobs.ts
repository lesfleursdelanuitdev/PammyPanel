// The long changes -- a backup, a restore, taking it offline, bringing it back
// (docs/apps-plan.md phase 2) -- run as jobs: the request starts one and answers
// at once, and the page watches `status` until it ends. The panel's API answers
// within 30 seconds; a backup of WordPress takes longer.
//
// One job per piece of software at a time. What each one did is kept in
// /var/lib/pammy-apps/history.json (the last 200), which is what the page's
// "What was done" list shows.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { AppsError } from './record.ts';

export type JobOp = 'backup' | 'restore' | 'offline' | 'online' | 'admin-password' | 'mail-test' | 'move' | 'install' | 'delete' | 'undelete' | 'purge';
export type Job = {
  app: string;
  op: JobOp;
  by: string;
  startedAt: number;
  step: string;              // what it is doing now, in her words
  endedAt: number | null;
  ok: boolean | null;
  message: string | null;    // how it ended, in her words
};

const KEEP = 200;
const HISTORY = 'history.json';

export class Jobs {
  running = new Map<string, Job>();
  dir: string;
  now: () => number;
  log: (line: string) => void;
  constructor(dir: string, now: () => number, log: (line: string) => void = () => {}) {
    this.dir = dir;
    this.now = now;
    this.log = log;
  }

  history(): Job[] {
    try {
      const h = JSON.parse(readFileSync(join(this.dir, HISTORY), 'utf8'));
      return Array.isArray(h) ? h : [];
    } catch { return []; }
  }

  recent(app: string, n = 10): Job[] {
    return this.history().filter((j) => j.app === app).slice(-n).reverse();
  }

  private remember(job: Job) {
    const h = [...this.history(), job].slice(-KEEP);
    const tmp = join(this.dir, `.${HISTORY}.${process.pid}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify(h, null, 1)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, join(this.dir, HISTORY));
    } catch (e) {
      this.log(`history not written: ${(e as Error).message}`);
    }
  }

  // A change quick enough to be done while the request waits (a new admin
  // password): only its line in the history.
  note(app: string, op: JobOp, by: string, ok: boolean, message: string) {
    const t = this.now();
    this.remember({ app, op, by, startedAt: t, step: 'Done', endedAt: t, ok, message });
  }

  // Starts `work` and returns the job at once. `work` reports its steps and
  // returns how it ended; an AppsError's message is her words, anything else
  // is the helper's own trouble and says so.
  start(app: string, op: JobOp, by: string, work: (step: (s: string) => void) => Promise<string>): Job {
    if (this.running.has(app)) {
      throw new AppsError('busy', 'Something else is being done to it just now. Wait until that has finished.');
    }
    const job: Job = { app, op, by, startedAt: this.now(), step: 'Starting', endedAt: null, ok: null, message: null };
    this.running.set(app, job);
    this.log(`job ${op} ${app} by ${by}: started`);
    const end = (ok: boolean, message: string) => {
      Object.assign(job, { ok, message, endedAt: this.now() });
      this.running.delete(app);
      this.remember({ ...job });
      this.log(`job ${op} ${app} by ${by}: ${ok ? 'done' : 'FAILED'} -- ${message}`);
    };
    void Promise.resolve()
      .then(() => work((s) => { job.step = s; this.log(`job ${op} ${app}: ${s}`); }))
      .then((m) => end(true, m), (e: unknown) => {
        if (e instanceof AppsError) return end(false, e.message);
        this.log(`job ${op} ${app}: ${(e as Error)?.stack ?? e}`);
        end(false, 'The helper hit an unexpected error. momolig can see what happened in its log.');
      });
    return { ...job };
  }
}
