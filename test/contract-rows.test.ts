// The first suite written with the contract kit (docs/ci-plan.md, T2): the rows half of the
// data store adapter (docs/module-contracts-plan.md contract 1), which grows out of today's
// Studio Driver at C6-min. Run here against the Driver with each site's name rules, on both
// engines; at C6-min the lfdln Backend and the external stores join as implementations.
import assert from 'node:assert/strict';
import { LFDLN_HELPER } from '@panel/lfdln/studio-site';
import type { Driver } from '@panel/studio/pammydb/driver';
import { createMariaDriver } from '@panel/studio/pammydb/maria';
import { createPgDriver } from '@panel/studio/pammydb/pg';
import { runContractSuite, type ContractImpl, type ContractSuite } from './contract-kit.ts';

const recipes = {
  name: 'recipes',
  columns: [
    { name: 'id', type: 'integer' as const, required: true, identity: true, default: null },
    { name: 'title', type: 'short_text' as const, length: 120, required: true, default: null },
    { name: 'servings', type: 'integer' as const, required: false, default: null },
  ],
  primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [],
};
const BACK = ['id', 'title', 'servings'];
const page = (over: object = {}) => ({ table: 'recipes', columns: BACK, limit: 20, offset: 0, order: { column: 'id', dir: 'asc' as const }, search: null, filters: [], ...over });

const rows: ContractSuite<Driver> = {
  contract: 'data store adapter (rows)',
  async setUp(d, { scratch }) {
    await d.create(scratch);
    const r = await d.apply(scratch, [{ kind: 'create-table', table: recipes }]);
    assert.equal(r.failed, null, 'the table was made');
  },
  cases: {
    'says it is answering, with a version': async (d) => {
      const s = await d.state();
      assert.equal(s.ok, true);
      assert.ok(s.version, 'a version');
    },
    'the table it was given is there, as given': async (d, { scratch }) => {
      const t = (await d.introspect(scratch)).tables.find((x) => x.name === 'recipes');
      assert.deepEqual(t?.columns.map((c) => c.name), ['id', 'title', 'servings']);
      assert.deepEqual(t?.primaryKey, ['id']);
    },
    'adds a row and gives the key the engine filled in': async (d, { scratch }) => {
      const made = await d.insertRow(scratch, 'recipes', { title: 'Pancakes', servings: 4 }, BACK);
      assert.ok(Number(made.id) > 0);
      assert.equal(made.title, 'Pancakes');
    },
    'reads it back, changes it, leaves the rest alone': async (d, { scratch }) => {
      const id = Number((await d.insertRow(scratch, 'recipes', { title: 'Soup', servings: 2 }, ['id'])).id);
      assert.equal((await d.getRow(scratch, 'recipes', BACK, { id }))?.title, 'Soup');
      const changed = await d.updateRow(scratch, 'recipes', { title: 'Tomato soup' }, { id }, BACK);
      assert.equal(changed?.title, 'Tomato soup');
      assert.equal(Number(changed?.servings), 2);
      assert.equal(await d.updateRow(scratch, 'recipes', { title: 'x' }, { id: id + 1000 }, BACK), null, 'no such row: null, not a made-up one');
    },
    // The search box and the 'contains' filter both ignore case on both engines (contains was
    // a plain LIKE, matching case on Postgres only: found by this suite, docs/ci-plan.md T2).
    'searches and counts a page the same way on both engines': async (d, { scratch }) => {
      for (const title of ['Bread', 'Brownies', 'Salad']) await d.insertRow(scratch, 'recipes', { title, servings: 1 }, ['id']);
      const p = await d.listRows(scratch, page({ search: { columns: ['title'], text: 'BR' } }));
      assert.deepEqual(p.items.map((r) => r.title), ['Bread', 'Brownies'], 'the search ignores case');
      assert.equal(p.total, 2);
      const exact = await d.listRows(scratch, page({ filters: [{ kind: 'contains', column: 'title', text: 'bR' }] }));
      assert.deepEqual(exact.items.map((r) => r.title), ['Bread', 'Brownies'], 'contains ignores case too');
      assert.equal((await d.listRows(scratch, page({ limit: 1 }))).items.length, 1);
    },
    'deletes, and says when there was nothing to delete': async (d, { scratch }) => {
      const id = Number((await d.insertRow(scratch, 'recipes', { title: 'Gone' }, ['id'])).id);
      assert.equal(await d.deleteRow(scratch, 'recipes', { id }), true);
      assert.equal(await d.deleteRow(scratch, 'recipes', { id }), false);
      assert.equal(await d.getRow(scratch, 'recipes', BACK, { id }), null);
    },
  },
};

const studioDriver = (site: string, rules?: typeof LFDLN_HELPER.rules): ContractImpl<Driver> => ({
  name: `the Studio's driver (${site})`,
  make: ({ engine, engines }) => engine === 'postgres'
    ? createPgDriver(engines.postgres, rules?.postgres)
    : createMariaDriver(engines.mariadb, rules?.mariadb),
  close: (d) => d.close(),
});

runContractSuite(rows, studioDriver('pammy.org'));
runContractSuite(rows, studioDriver('lfdln', LFDLN_HELPER.rules));
