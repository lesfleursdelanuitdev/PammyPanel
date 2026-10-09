// One definition per module (docs/module-contracts-plan.md section 1, step C1): each
// package says what it is in its own src/module.ts, and the lists that used to be written
// by hand in profile.ts (NEEDS, FACTS) are made from the definitions (@panel/modules).
//
// C1 moves only what a module *is*: its name, what it needs on, and what it needs from the
// site's profile. What it *does* (its routes, gate parts, sockets, rights) moves into the
// definition in K-b, when the kernel stops naming modules.
import type { Module, SiteProfile } from './profile.ts';

export type ModuleDefinition = {
  name: Module;
  kernel: '^1';                // the kernel version it is written for (section 4)
  needs: readonly Module[];    // the modules it needs on: the same as its package.json's dependencies
  facts: readonly string[];    // what it needs from the profile, each a path into it ('services.gate')
};

export const defineModule = <const D extends ModuleDefinition>(d: D): D => d;

// Every module's definition, by name: what @panel/modules hands the kernel.
export type ModuleRegistry = Readonly<Record<Module, ModuleDefinition>>;

// A module switched on without one it needs is a mistake in the profile: say which.
export function checkModules(modules: readonly Module[], registry: ModuleRegistry): void {
  const on = new Set(modules);
  for (const m of modules) {
    if (!Object.hasOwn(registry, m)) throw new Error(`profile: there is no module "${m}"`);
    const missing = registry[m].needs.filter((d) => !on.has(d));
    if (missing.length) throw new Error(`profile: module ${m} needs ${missing.join(', ')} on too`);
  }
}

// A module switched on without what it needs from the profile: say which.
export function checkFacts(p: SiteProfile, registry: ModuleRegistry): void {
  const at = (path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], p);
  for (const m of p.modules) {
    const missing = registry[m].facts.filter((f) => at(f) === undefined);
    if (missing.length) throw new Error(`profile ${p.name}: module ${m} needs ${missing.join(', ')}`);
  }
}
