// How a root helper does things outside its sandbox (docs/apps-plan.md phase 2,
// docs/hosts-plan.md H7): it asks systemd to run one command as a short-lived
// unit of its own (`systemd-run --wait --pipe`), as root or as another user, and
// waits for it. So the helper itself never switches user and holds almost
// nothing -- and every step it takes is a named unit in the journal
// ("<helper>-<what>-..."). The software helper (packages/apps) and the routing
// helper (packages/hosts) each name their units with their own prefix.
//
// The tests stand a recording runner in for this one (test/apps-jobs.test.ts,
// test/hosts-helper.test.ts); the verify scripts run the real thing.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

export type RunAs = 'root' | { user: string; uid: number; home: string };
export type RunSpec = {
  as: RunAs;
  argv: string[];
  what: string;              // a word for the unit's name and the journal: "backup", "nginx-test"
  stdin?: string;
  timeoutSec: number;        // systemd stops it after this (RuntimeMaxSec)
};
export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (spec: RunSpec) => Promise<RunResult>;

const MAX_OUT = 1024 * 1024;

// Collect a child's output, up to a limit, and how it ended.
export function collect(child: ReturnType<typeof spawn>, stdin?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (c: string) => { if (stdout.length < MAX_OUT) stdout += c; });
    child.stderr?.setEncoding('utf8').on('data', (c: string) => { if (stderr.length < MAX_OUT) stderr += c; });
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: `${stderr}${(e as Error).message}` }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin ?? '');
  });
}

// The commands' PATH. It has the sbin folders: the steps run by `sh -c` find
// useradd, usermod and nginx through it (systemd resolves only the first word).
export const RUN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function runArgs(spec: RunSpec, unit: string, helper: string): string[] {
  const args = [
    '--quiet', '--wait', '--pipe', '--collect', '--service-type=exec',
    `--unit=${unit}`, `--description=${helper}: ${spec.what}`,
    '-p', `RuntimeMaxSec=${spec.timeoutSec}`, '-p', 'WorkingDirectory=/',
  ];
  if (spec.as !== 'root') {
    const { user, uid, home } = spec.as;
    // rootless podman and `systemctl --user` need the user's runtime folder and bus
    args.push('-p', `User=${user}`, '-p', `Group=${user}`,
      '-E', `HOME=${home}`, '-E', `XDG_RUNTIME_DIR=/run/user/${uid}`, '-E', `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`);
  }
  args.push('-E', `PATH=${RUN_PATH}`, '--', ...spec.argv);
  return args;
}

// A runner whose units are named after the helper: "<helper>-<what>-<random>".
export const systemdRunner = (helper: string): Runner => (spec) => {
  const unit = `${helper}-${spec.what}-${randomBytes(4).toString('hex')}`;
  return collect(spawn('/usr/bin/systemd-run', runArgs(spec, unit, helper), { stdio: ['pipe', 'pipe', 'pipe'] }), spec.stdin);
};

// Things the helper does itself, as it is: read-only work its one capability
// covers (gzip -t, journalctl, tar of the backups for a download).
export type Exec = (argv: string[]) => Promise<RunResult>;
export type ExecStream = (argv: string[]) => Readable;

export const realExec: Exec = (argv) => collect(spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] }));
export const realExecStream: ExecStream = (argv) => {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
  return child.stdout;
};
