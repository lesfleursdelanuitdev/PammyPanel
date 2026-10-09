// The projects helper's commands for a site's command line (lfdln-panel; docs/s1-plan.md S1f).
// projects-put-back: S1d undone for every server project (or one), the step before a release
// older than S1d is installed -- their database variables at 10.0.2.2 again, their Quadlets
// slirp4netns:allow_host_loopback, each running one put live again slot to slot. Followed
// until it is done, as install-lfdln.sh follows refresh.
import { callProjects } from './client.ts';

export const PROJECTS_USAGE = 'projects-put-back [<project>]';

type Job = { id: string; state: string; error?: string | null; result?: { projects: { project: string; branch: string; result: string; env: string[]; error?: string }[]; failed: number } };

// true when cmd was one of these (done), false when it isn't
export async function projectsCommand(socket: string | undefined, cmd: string | undefined, args: string[], o: { sleep?: (ms: number) => Promise<void>; print?: (line: string) => void } = {}): Promise<boolean> {
  if (cmd !== 'projects-put-back') return false;
  const print = o.print ?? ((line: string) => console.log(line));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!socket || args.length > 1) {
    print(!socket ? 'This site has no projects helper.' : `usage: lfdln-panel ${PROJECTS_USAGE}`);
    process.exitCode = 2;
    return true;
  }
  let { job } = await callProjects<{ job: Job }>(socket, { op: 'put-back', id: args[0], actor: 'lfdln-panel' });
  print(`putting ${args[0] ?? 'every project'} back on slirp4netns with 10.0.2.2 (job ${job.id}): each running one is put live again, one after the other`);
  while (job.state !== 'done' && job.state !== 'failed') {
    await sleep(3000);
    ({ job } = await callProjects<{ job: Job }>(socket, { op: 'job', id: job.id }));
  }
  if (job.state === 'failed' || !job.result) {
    print(`FAIL  it stopped: ${job.error ?? '?'}`);
    process.exitCode = 1;
    return true;
  }
  for (const x of job.result.projects) {
    print(`  ${x.result}  ${x.project} ${x.branch}${x.env.length ? ` (${x.env.join(', ')} now at 10.0.2.2)` : ''}${x.error ? `: ${x.error}` : ''}`);
  }
  if (job.result.failed) {
    print(`FAIL  ${job.result.failed} branch(es) didn't answer on slirp4netns: each still runs its slot on pasta, its variables as they were`);
    process.exitCode = 1;
  } else {
    print('done: now install the older release (its installer); a deploy or Restart under this one puts them on pasta again');
  }
  return true;
}
