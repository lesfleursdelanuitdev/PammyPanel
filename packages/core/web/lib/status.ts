// The panel's one line of news: "Saved.", "Link copied.", or what went wrong.
// A tiny store, so anything (queries included) can set it.
import { useSyncExternalStore } from 'react';

export type Notice = { id: number; text: string; kind: 'ok' | 'error'; keep: boolean };
let current: Notice | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

// `keep`: this message is the result of something she pressed that then moves
// her to another page. The shell clears old news on a new page, which is right
// for a message she has already read and wrong for the answer to what she just
// did -- so a kept message survives exactly one move, and is ordinary after it.
export function notify(text: string, kind: Notice['kind'] = 'ok', keep = false) {
  current = text ? { id: nextId++, text, kind, keep } : null;
  emit();
}
export const clearNotice = () => notify('');

// Called by the shell on a new page. True means "leave this one alone, once".
export function keepNoticeThroughNavigation(): boolean {
  if (!current?.keep) return false;
  current = { ...current, keep: false };
  emit();
  return true;
}

export function useNotice(): Notice | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
}
