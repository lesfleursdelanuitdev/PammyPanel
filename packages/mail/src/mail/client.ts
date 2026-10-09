// The panel's side of pammy-mail's socket.
import { callJsonLine, CallError } from '@panel/core/jsonline';

export { CallError as MailCallError };

export function callMail<T = unknown>(socketPath: string, req: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  return callJsonLine<T>(socketPath, req, 'mail service', timeoutMs);
}
