// What the tests use of proxy.mjs (plain JS: it runs in its own container).
import type { Server } from 'node:http';
export const PORT: number;
export const IDLE_MS: number;
export function loadAllow(text: string): string[];
export function allowed(list: string[], host: string): boolean;
export function target(authority: string): string | null;
export function makeLookup(servers: string[], log?: (line: string) => void): (host: string, opts: { all?: boolean } | undefined, cb: (...a: unknown[]) => void) => void;
export function createProxy(list: string[], log?: (line: string) => void, dns?: string[]): Server & { openTunnels: () => number };
