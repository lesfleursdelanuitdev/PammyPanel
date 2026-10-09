// The panel's side of the database helper socket. The panel never opens her
// engines itself (studio-plan.md: "do not query her engines from src/app.ts").
import { callJsonLine, CallError } from '@panel/core/jsonline';

export { CallError as PammyDbCallError };

// Slice 1's ops all answer quickly; introspect and Apply get a longer timeout of
// their own when they arrive (60-120s, studio-plan.md).
export function callPammyDb<T = unknown>(socketPath: string, req: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  return callJsonLine<T>(socketPath, req, 'database helper', timeoutMs);
}
