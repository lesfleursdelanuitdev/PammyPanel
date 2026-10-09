// The contract-suite kit (docs/ci-plan.md, T2; docs/module-contracts-plan.md, "The 18
// contracts"): a contract's suite is written once and run against every implementation of it,
// on each engine it touches, with test/pammydb-harness.ts's throwaway Postgres 17 and
// MariaDB 11.4 (the live images, test/engine-images.ts).
//
//   runContractSuite(rowsSuite, studioDriver)                 // both engines, the default
//   runContractSuite(rowsSuite, someImpl, ['postgres'])       // refused: rule 14 wants both...
//   runContractSuite(rowsSuite, { ...someImpl, oneEngine: 'Neon is Postgres only' }, ['postgres'])
//
// Module rule 14 ("anything for databases works on Postgres and MariaDB and is tested on both")
// is the default here: running on one engine has to say why. One pair of engines per test
// process (node --test runs each file in its own), started on first use and stopped when the
// last suite of the file is done. Each suite gets, per engine, a database name of its own that
// no other suite in the process uses, and the engines' admins to make what it needs.
import { after, before, describe, it } from 'node:test';
import { startEngines, type Engines } from './pammydb-harness.ts';
import type { EngineName } from './engine-images.ts';

export type { EngineName };
export const BOTH: readonly EngineName[] = ['postgres', 'mariadb'];

export type ContractCtx = {
  engine: EngineName;
  engines: Engines;        // endpoints (the studio's login) and the engines' own admins
  scratch: string;         // a database name for this suite on this engine, not yet made
};

export type ContractSuite<I> = {
  contract: string;        // as module-contracts-plan.md names it, e.g. "data store adapter (rows)"
  // once per engine, before its cases: make the scratch database, tables, rows
  setUp?: (impl: I, ctx: ContractCtx) => Promise<void>;
  // in order; each is one test, named "<case> (<engine>)"
  cases: Record<string, (impl: I, ctx: ContractCtx) => Promise<void>>;
};

export type ContractImpl<I> = {
  name: string;
  make: (ctx: ContractCtx) => I | Promise<I>;
  close?: (impl: I) => Promise<void>;
  // the reason an implementation is for one engine only (an external store, say)
  oneEngine?: string;
};

// --- the engines, shared by every suite in this process
let shared: Promise<Engines> | null = null;
let users = 0;
let scratchN = 0;

function engines(): Promise<Engines> {
  shared ??= startEngines();
  return shared;
}

async function letGo() {
  if (--users > 0 || !shared) return;
  const e = shared;
  shared = null;
  (await e.catch(() => null))?.stop();
}

// what a suite is allowed to be run on; throws before a single engine is started
export function checkEngines(engineList: readonly EngineName[], impl: { name: string; oneEngine?: string }): EngineName[] {
  const list = [...new Set(engineList)];
  if (!list.length) throw new Error(`${impl.name}: a contract suite needs at least one engine`);
  for (const x of list) if (!BOTH.includes(x)) throw new Error(`${impl.name}: no engine called ${x}`);
  if (list.length < BOTH.length && !impl.oneEngine) {
    throw new Error(`${impl.name}: runs on ${list.join(', ')} only -- module rule 14 wants both engines; say why with oneEngine`);
  }
  return list;
}

export function runContractSuite<I>(suite: ContractSuite<I>, impl: ContractImpl<I>, engineList: readonly EngineName[] = BOTH): void {
  const list = checkEngines(engineList, impl);
  users++;      // counted when registered, so the engines last until the file's last suite is done
  const slug = suite.contract.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24);

  describe(`contract: ${suite.contract} -- ${impl.name}`, () => {
    let e: Engines;
    before(async () => { e = await engines(); });
    after(letGo);

    for (const engine of list) {
      describe(engine, () => {
        let made: I | undefined;
        let ctx: ContractCtx;
        before(async () => {
          ctx = { engine, engines: e, scratch: `ck_${slug}_${engine === 'postgres' ? 'pg' : 'my'}_${++scratchN}` };
          made = await impl.make(ctx);
          await suite.setUp?.(made, ctx);
        });
        after(async () => { if (made !== undefined) await impl.close?.(made); });

        for (const [name, run] of Object.entries(suite.cases)) {
          it(`${name} (${engine})`, () => run(made as I, ctx));
        }
      });
    }
  });
}
