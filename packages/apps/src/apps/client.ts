// The panel's side of the software helper socket.
import { callJsonLine, callJsonLineRead, CallError } from '@panel/core/jsonline';

export { CallError as AppsCallError };

// A status can walk a whole WordPress for its size, and waits up to 8 seconds
// for the site to answer.
export function callApps<T = unknown>(socketPath: string, req: Record<string, unknown>, timeoutMs = 45_000): Promise<T> {
  return callJsonLine<T>(socketPath, req, 'software helper', timeoutMs);
}

// A backup as one .tar: its name, then its bytes (phase 2).
export const readFromApps = <T = unknown>(socketPath: string, req: Record<string, unknown>) =>
  callJsonLineRead<T>(socketPath, req, 'software helper');
