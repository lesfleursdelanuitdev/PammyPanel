// One definition per module (docs/module-contracts-plan.md section 1, step C1): each package's
// src/module.ts, put together in @panel/modules. These check that the lists made from them are
// the ones written by hand in packages/core/src/profile.ts until C1 (frozen below), so C1
// changes nothing a site does; and that each definition agrees with its package.json.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkFacts, checkModules } from '@panel/core/module';
import { MODULES, type Module, type SiteProfile } from '@panel/core/profile';
import { DEFINITIONS, FACTS, NEEDS, REGISTRY } from '@panel/modules/index';
import { PROFILE as PAMMY } from '@panel/pammy/profile';
import { PROFILE as LFDLN } from '@panel/lfdln/profile';

const ROOT = join(import.meta.dirname, '..');

// packages/core/src/profile.ts at 8b78a5a, before C1 (the comments are in each module.ts now)
const NEEDS_BEFORE: Record<Module, readonly Module[]> = {
  mail: [], areas: [], 'api-keys': [], php: [],
  // the one change since (docs/k-a-plan.md KA-Q4, K-a4): Settings > Visitors uses people's switch words and rules
  settings: ['people'],
  catalog: [], thumbs: ['catalog'],
  studio: ['catalog'],
  people: ['areas'],
  requests: ['areas'],
  files: ['catalog', 'thumbs'],
  media: ['areas', 'api-keys', 'catalog', 'files', 'thumbs'],
  forms: ['areas', 'mail', 'api-keys'],
  'form-links': ['forms', 'studio'],
  comments: ['areas', 'forms', 'form-links', 'studio'],
  apps: ['mail', 'studio'],
  examples: ['areas', 'files', 'forms', 'api-keys', 'studio', 'form-links', 'comments', 'apps'],
  help: [],
  'getting-started': ['help', 'examples', 'studio'],
  hosts: ['files'],
  services: ['hosts'],
  monitoring: [],
  projects: ['hosts'],
};
const FACTS_BEFORE: Partial<Record<Module, readonly string[]>> = {
  mail: ['mail', 'services.sockets.mail', 'services.mailSettings'],
  areas: ['services.gate', 'services.sockets.gateAdmin'],
  people: ['services.gate', 'services.sockets.gateAdmin'],
  requests: ['services.gate', 'services.sockets.gateAdmin'],
  thumbs: ['services.sockets.thumbs', 'services.mediaPublic'],
  media: ['services.mediaPublic', 'services.gate'],
  forms: ['services.gate', 'services.sockets.gateAdmin'],
  'api-keys': ['services.gate', 'services.sockets.gateAdmin'],
  // S2 (docs/s2-plan.md): the gate's own door to the database helper
  studio: ['services.sockets.pammydb', 'services.sockets.pammydbGate'],
  apps: ['owner', 'apps', 'services.sockets.apps', 'services.wordpressPlacement'],
  php: ['services.phpRun'],
  examples: ['services.tutorialExamples'],
  help: ['help'],
  hosts: ['hosts', 'services.sockets.routes'],
  services: ['services.sockets.services'],
  projects: ['services.sockets.projects'],
};

// What a site asks of its profile: each module on, and each fact those modules need.
const asks = (p: SiteProfile, facts: Partial<Record<Module, readonly string[]>>) =>
  p.modules.flatMap((m) => (facts[m] ?? []).map((f) => `${m}: ${f}`)).sort();

describe('module definitions', () => {
  it('are one per module, in MODULES\' order, each under its own name', () => {
    assert.deepEqual(DEFINITIONS.map((d) => d.name), [...MODULES]);
    for (const m of MODULES) assert.equal(REGISTRY[m].name, m);
    // the packages that aren't modules: the kernel, every site's gate, and this list itself
    const pkgs = readdirSync(join(ROOT, 'packages')).filter((n) => !['core', 'gate', 'modules'].includes(n)).sort();
    assert.deepEqual([...MODULES].sort(), pkgs);
  });

  it('make the NEEDS and FACTS that were written by hand', () => {
    assert.deepEqual(NEEDS, NEEDS_BEFORE);
    assert.deepEqual(FACTS, FACTS_BEFORE);
  });

  it('need what their package.json depends on', () => {
    for (const m of MODULES) {
      const pj = JSON.parse(readFileSync(join(ROOT, 'packages', m, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
      const deps = Object.keys(pj.dependencies ?? {}).map((d) => d.replace('@panel/', '')).filter((d) => d !== 'core').sort();
      assert.deepEqual([...REGISTRY[m].needs].sort(), deps, m);
    }
  });

  for (const [name, p] of [['pammy.org', PAMMY], ['lfdln', LFDLN]] as const) {
    it(`let ${name}'s profile through, asking it what it was asked before`, () => {
      checkModules(p.modules, REGISTRY);
      checkFacts(p, REGISTRY);
      assert.deepEqual(asks(p, FACTS), asks(p, FACTS_BEFORE));
    });
  }

  it('refuse a module without one it needs, or one there is no such module', () => {
    assert.throws(() => checkModules(['comments'], REGISTRY), /comments needs/);
    assert.throws(() => checkModules(['nope' as never], REGISTRY), /no module/);
    const { help: _h, ...noHelp } = PAMMY;
    assert.throws(() => checkFacts(noHelp as SiteProfile, REGISTRY), /module help needs help/);
  });
});
