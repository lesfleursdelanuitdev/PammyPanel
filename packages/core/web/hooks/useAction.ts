import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { ApiError, confirmWithPasskey, friendlyError, signedOut } from '../lib/api';
import { clearNotice, notify } from '../lib/status';

type Done<T> = string | ((result: T) => string) | undefined;

// Runs a change. If the server wants a fresh passkey check, asks for one and
// tries once more. Afterwards everything on screen is fetched again.
export function useAction() {
  const qc = useQueryClient();
  return useCallback(async <T>(fn: () => Promise<T>, done?: Done<T>): Promise<T | undefined> => {
    clearNotice();
    try {
      let result: T;
      try {
        result = await fn();
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'reauth-required') throw err;
        await confirmWithPasskey();
        result = await fn();
      }
      if (done) notify(typeof done === 'function' ? done(result) : done);
      return result;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && err.code === 'signed-out') { signedOut(); return undefined; }
      notify(friendlyError(err), 'error');
      return undefined;
    } finally {
      void qc.invalidateQueries();
    }
  }, [qc]);
}

export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify(`${what} copied.`);
  } catch {
    notify("Couldn't copy. Select the text and copy it yourself.", 'error');
  }
}
