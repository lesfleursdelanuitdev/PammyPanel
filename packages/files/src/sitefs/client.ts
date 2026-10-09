// The panel's side of the website folder helper socket.
import type { Readable } from 'node:stream';
import { callJsonLine, callJsonLineRead, callJsonLineUpload, CallError } from '@panel/core/jsonline';

export { CallError as SiteFsCallError };

export function callSiteFs<T = unknown>(socketPath: string, req: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  return callJsonLine<T>(socketPath, req, 'website folder helper', timeoutMs);
}

export const uploadToSiteFs = <T = unknown>(socketPath: string, req: Record<string, unknown>, body: Readable) =>
  callJsonLineUpload<T>(socketPath, req, body, 'website folder helper');

export const readFromSiteFs = <T = unknown>(socketPath: string, req: Record<string, unknown>) =>
  callJsonLineRead<T>(socketPath, req, 'website folder helper');
