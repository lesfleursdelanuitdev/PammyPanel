// The software helper's runner: the core's (@panel/core/runner), with its units
// named "pammy-apps-<what>-..." as they always were.
import { runArgs as coreRunArgs, systemdRunner, type RunSpec } from '@panel/core/runner';

export { collect, realExec, realExecStream, RUN_PATH, type Exec, type ExecStream, type RunAs, type Runner, type RunResult, type RunSpec } from '@panel/core/runner';

export const runArgs = (spec: RunSpec, unit: string) => coreRunArgs(spec, unit, 'pammy-apps');
export const systemdRun = systemdRunner('pammy-apps');
