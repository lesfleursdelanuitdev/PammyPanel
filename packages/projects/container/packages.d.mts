// What the tests use of packages.mjs (plain JS: it runs in the build container, with no packages).
export type Warning = { kind: 'new' | 'few' | 'lookalike' | 'deprecated' | 'license' | 'scripts'; text: string };
export function closeTo(a: string, b: string): boolean;
export function warningsOf(p: { name: string; created: string | null; weekly: number | null; deprecated: string | null; license: string | null; installScripts: boolean }, popular: string[]): Warning[];
export const NAME_RE: RegExp;
export const SPEC_RE: RegExp;
export const LONG_RUNNING: string[];
