// The schema designer's thinking, with no database in sight: the IR and what it
// refuses, the diff (which is where a rename stops being a delete and an add),
// the two dialect printers from one patch, and the drift hash.
//
// The live engines are test/pammydb.test.ts's job. Everything here is pure, so
// it runs in milliseconds and can afford to be picky.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { patchSql, statements } from '@panel/studio/pammydb/ddl';
import { PammyDbError } from '@panel/studio/pammydb/ident';
import {
  canAlter, checkSnapshot, COLUMN_TYPES, snapshotHash, starterTable, TYPE_NAMES, typeLabel,
  type Column, type Snapshot, type Table,
} from '@panel/studio/pammydb/ir';
import { checkPatch, checkStep, destructive, ordered, type Step } from '@panel/studio/pammydb/patch';
import { describe as describeStep, diff, plan } from '@panel/studio/studio/diff';
import { checkDraft, readDraft, renamesDone, schemaView } from '@panel/studio/studio/schema';
import {
  checkLayout, emptyLayout, forget, placed, readLayout, renamedIn, tidy, type Layout,
} from '@panel/studio/studio/layout';
import {
  addRelationship, checkSpec, checkWhere, isJunction, junctionName, KINDS, ON_DELETE,
  ON_DELETE_NAMES, referenceName, relationships, removeRelationship, setOnDelete, singular, type Spec,
} from '@panel/studio/studio/relationships';
import {
  canBeRich, checkFieldPatch, checkOrder, checkResourcePatch, checkVisitors, CONTROL_NAMES, CONTROLS, refuseIfBlind, resourceViews,
  type FieldRow, type ResourceRow,
} from '@panel/studio/studio/resources';
import {
  buildGet, buildList, buildSetLinks, buildUpdate, checkLinks, checkQuery, checkValues, checkWhere as checkWhereRow,
  likeEscape, type RowQuery,
} from '@panel/studio/pammydb/rows';
import {
  abilityMissing, keyOf, listQuery, pickFilterable, pickQuery, readable, richAsWords, richForEditing, valuesFor,
} from '@panel/studio/studio/records';
import { cleanRich } from '@panel/studio/studio/rich-text';
import { withCommentLink, withCommentTables } from '@panel/comments/studio/comments-tables';
import { buildCatalog, readCatalog } from '@panel/studio/studio/catalog';
import { impactOf } from '@panel/studio/studio/impact';
import { allow, type AppKey, type CatalogRow } from '@panel/studio/gate/studio';
import { AccountError } from '@panel/core/accounts';
import * as web from '../packages/studio/web/lib/schema.ts';
import { DB_EXAMPLE_KINDS, DB_EXAMPLES, exampleSnapshot, seedExample } from '@panel/examples/studio/db-examples';

const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof PammyDbError) return e.code; throw e; }
  return 'no error';
};

const snapshot = (tables: Table[]): Snapshot => ({ engine: 'postgres', database: 'blog', tables, notes: [] });

const column = (name: string, over: Partial<Column> = {}): Column =>
  ({ name, type: 'text', required: false, default: null, ...over });

const table = (name: string, columns: Column[], over: Partial<Table> = {}): Table =>
  ({ name, columns, primaryKey: [], uniques: [], foreignKeys: [], indexes: [], ...over });

// ------------------------------------------------------------------ the IR

describe('the schema model', () => {
  it('reads a table back, and puts the fields in the order they were given', () => {
    const t = checkSnapshot({ tables: [starterTable('recipes')] }, 'postgres', 'blog');
    assert.deepEqual(t.tables[0]!.columns.map((c) => c.name), ['id', 'created_at', 'updated_at']);
    assert.deepEqual(t.tables[0]!.primaryKey, ['id']);
    assert.equal(t.tables[0]!.columns[0]!.identity, true);
  });

  it('refuses a name a database would not take, and says so in her words', () => {
    const bad = (name: string) => checkSnapshot({ tables: [table(name, [column('a')])] }, 'postgres', 'blog');
    assert.equal(code(() => bad('Recipes')), 'invalid');
    assert.equal(code(() => bad('my-recipes')), 'invalid');
    assert.equal(code(() => bad('2026')), 'invalid');
    assert.equal(code(() => bad('drop table x')), 'invalid');
    assert.match(
      // quoting is never the thing standing between her and an injection: the
      // name is refused long before anything is composed
      (() => { try { bad('a"; DROP TABLE users; --'); return ''; } catch (e) { return (e as Error).message; } })(),
      /lowercase letters, digits and underscores/);
  });

  it('refuses a table with no fields, two fields of one name, or a key that is not there', () => {
    assert.equal(code(() => checkSnapshot({ tables: [table('t', [])] }, 'postgres', 'blog')), 'invalid');
    assert.equal(code(() => checkSnapshot({ tables: [table('t', [column('a'), column('a')])] }, 'postgres', 'blog')), 'invalid');
    assert.equal(code(() => checkSnapshot({ tables: [table('t', [column('a')], { primaryKey: ['b'] })] }, 'postgres', 'blog')), 'invalid');
    assert.equal(code(() => checkSnapshot({ tables: [table('t', [column('a')]), table('t', [column('b')])] }, 'postgres', 'blog')), 'invalid');
  });

  it('only lets a field fill itself in when it is a whole number and the key', () => {
    const bad = (c: Column, primaryKey: string[]) =>
      checkSnapshot({ tables: [table('t', [c], { primaryKey })] }, 'postgres', 'blog');
    assert.equal(code(() => bad(column('id', { type: 'text', identity: true }), ['id'])), 'invalid');
    assert.equal(code(() => bad(column('id', { type: 'integer', identity: true }), [])), 'invalid');
    assert.doesNotThrow(() => bad(column('id', { type: 'integer', identity: true }), ['id']));
  });

  it('refuses a starting value it would have to escape, and keeps one it cannot write down', () => {
    const withDefault = (d: unknown) => checkSnapshot({ tables: [table("t", [{ ...column("a"), default: d as never }])] }, "postgres", "blog");
    assert.equal(code(() => withDefault({ kind: 'text', value: "it's" })), 'invalid');
    assert.equal(code(() => withDefault({ kind: 'text', value: 'a\\b' })), 'invalid');
    assert.equal(code(() => withDefault({ kind: 'now' })), 'invalid', '"now" is not a text field\'s starting value');
    assert.doesNotThrow(() => withDefault({ kind: 'text', value: 'Untitled (draft)' }));
    // read back from an engine: carried, and the field is left alone because of it
    const kept = withDefault({ kind: 'raw', sql: 'nextval(\'x\')' });
    assert.deepEqual(kept.tables[0]!.columns[0]!.default, { kind: 'raw', sql: "nextval('x')" });
    assert.equal(canAlter(kept.tables[0]!.columns[0]!), false);
  });

  it('is the same hash for the same schema, and a different one for any change', () => {
    const a = snapshot([starterTable('recipes')]);
    const b = snapshot([starterTable('recipes')]);
    assert.equal(snapshotHash(a), snapshotHash(b));
    // notes are about the connection, not the schema, so they do not count
    assert.equal(snapshotHash({ ...a, notes: ['something'] }), snapshotHash(a));
    const changed = snapshot([{ ...starterTable('recipes'), columns: [...starterTable('recipes').columns, column('title')] }]);
    assert.notEqual(snapshotHash(changed), snapshotHash(a));
  });
});

// ------------------------------------------------------------------ the diff

describe('what she drew, minus what is there', () => {
  const live = snapshot([table('posts', [
    column('id', { type: 'integer', required: true, identity: true }),
    column('title', { required: true }),
    column('nickname'),
  ], { primaryKey: ['id'] })]);

  it('a renamed field is a rename, not a delete and an add', () => {
    const draft = snapshot([table('posts', [
      column('id', { type: 'integer', required: true, identity: true }),
      { ...column('headline', { required: true }), was: 'title' },
      column('nickname'),
    ], { primaryKey: ['id'] })]);
    const steps = diff(live, draft);
    assert.deepEqual(steps, [{ kind: 'rename-column', table: 'posts', column: 'title', to: 'headline' }]);
    assert.match(describeStep(steps[0]!).line, /Rename posts.title to headline/);
  });

  it('a field with a different name and no `was` really is a delete and an add', () => {
    const draft = snapshot([table('posts', [
      column('id', { type: 'integer', required: true, identity: true }),
      column('headline', { required: true }),
      column('nickname'),
    ], { primaryKey: ['id'] })]);
    assert.deepEqual(diff(live, draft).map((s) => s.kind), ['drop-column', 'add-column']);
  });

  it('puts the steps in dependency order, whatever order she made them in', () => {
    const steps: Step[] = [
      { kind: 'add-foreign-key', table: 'a', foreignKey: { name: 'fk', columns: ['b_id'], references: { table: 'b', columns: ['id'] }, onDelete: 'restrict' } },
      { kind: 'rename-table', table: 'a', to: 'aa' },
      { kind: 'create-table', table: table('b', [column('id')]) },
      { kind: 'drop-column', table: 'a', column: 'old' },
      { kind: 'add-column', table: 'a', column: column('b_id', { type: 'integer' }) },
    ];
    assert.deepEqual(ordered(steps).map((s) => s.kind),
      ['drop-column', 'create-table', 'add-column', 'add-foreign-key', 'rename-table']);
  });

  it('writes every step in the name the engine has now, because renames run last', () => {
    // she renames the table AND adds a field to it in one go
    const draft = snapshot([table('articles', [
      column('id', { type: 'integer', required: true, identity: true }),
      column('title', { required: true }),
      column('nickname'),
      column('subtitle'),
    ], { primaryKey: ['id'], was: 'posts' })]);
    const steps = diff(live, draft);
    assert.deepEqual(steps.map((s) => s.kind), ['add-column', 'rename-table']);
    assert.equal((steps[0] as { table: string }).table, 'posts', 'the field is added to the name it still has');
  });

  it('a must-be-different rule follows a renamed field', () => {
    const draft = snapshot([table('posts', [
      column('id', { type: 'integer', required: true, identity: true }),
      { ...column('headline', { required: true }), was: 'title' },
      column('nickname'),
    ], { primaryKey: ['id'], uniques: [{ name: 'posts_headline_key', columns: ['headline'] }] })]);
    const steps = diff(live, draft);
    const unique = steps.find((s) => s.kind === 'add-unique') as { unique: { columns: string[] } };
    assert.deepEqual(unique.unique.columns, ['title'], 'named as the engine has it, because the rename is later');
    assert.ok(steps.indexOf(steps.find((s) => s.kind === 'rename-column')!) > steps.indexOf(steps.find((s) => s.kind === 'add-unique')!));
  });

  it('leaves a field the panel did not make exactly as it is', () => {
    const odd = snapshot([table('t', [column('tags', { type: 'other', sqlType: 'text[]' })])]);
    // something tries to turn it into text
    const draft = snapshot([table('t', [column('tags', { type: 'text', sqlType: 'text[]' })])]);
    assert.deepEqual(diff(odd, draft), [], 'no step is proposed for a field it cannot describe');
  });

  it('knows which steps cost something', () => {
    assert.equal(destructive({ kind: 'drop-table', table: 't' }), true);
    assert.equal(destructive({ kind: 'drop-column', table: 't', column: 'c' }), true);
    assert.equal(destructive({ kind: 'add-column', table: 't', column: column('c') }), false);
    const narrower: Step = { kind: 'alter-column', table: 't', column: column('c', { type: 'short_text', length: 10 }), from: column('c') };
    assert.equal(destructive(narrower), true);
    const optional: Step = { kind: 'alter-column', table: 't', column: column('c', { required: false }), from: column('c', { required: true }) };
    assert.equal(destructive(optional), false, 'making a field optional loses nothing');
    const required: Step = { kind: 'alter-column', table: 't', column: column('c', { required: true }), from: column('c') };
    assert.equal(destructive(required), true, 'making one required can be refused by rows that are empty');
  });

  it('says what each step costs, in her words', () => {
    const p = plan(live, snapshot([table('posts', [
      column('id', { type: 'integer', required: true, identity: true }),
      column('title', { required: true }),
    ], { primaryKey: ['id'] })]));
    assert.equal(p.destructive, true);
    assert.match(p.changes[0]!.line, /Remove posts.nickname/);
    assert.match(p.changes[0]!.warning!, /deleted with it/);
  });

  it('a new table is one step, and its relationships are their own', () => {
    const draft = snapshot([...live.tables, table('comments', [
      column('id', { type: 'integer', required: true, identity: true }),
      column('post_id', { type: 'integer', required: true }),
    ], {
      primaryKey: ['id'],
      foreignKeys: [{ name: 'comments_post_id_fkey', columns: ['post_id'], references: { table: 'posts', columns: ['id'] }, onDelete: 'cascade' }],
    })]);
    const steps = diff(live, draft);
    assert.deepEqual(steps.map((s) => s.kind), ['create-table', 'add-foreign-key']);
    assert.deepEqual((steps[0] as { table: Table }).table.foreignKeys, []);
    // and the helper insists on that, whatever the panel sent
    assert.equal(code(() => checkStep({ kind: 'create-table', table: { ...table('x', [column('a')]), foreignKeys: [{ name: 'f', columns: ['a'], references: { table: 'y', columns: ['b'] }, onDelete: 'restrict' }] } })), 'invalid');
  });
});

// ------------------------------------------------------------------ the printers

describe('one patch, two dialects', () => {
  const recipes = table('recipes', [
    { ...column('id', { type: 'integer', required: true, identity: true }) },
    column('title', { type: 'short_text', length: 120, required: true }),
    column('body'),
    column('servings', { type: 'integer', default: { kind: 'number', value: 4 } }),
    column('price', { type: 'decimal', precision: 8, scale: 2 }),
    column('vegetarian', { type: 'boolean', default: { kind: 'boolean', value: false } }),
    column('made_on', { type: 'date' }),
    column('made_at', { type: 'timestamptz', required: true, default: { kind: 'now' } }),
    column('ref', { type: 'uuid' }),
  ], { primaryKey: ['id'], uniques: [{ name: 'recipes_title_key', columns: ['title'] }] });

  it('makes a table the way each engine spells it', () => {
    assert.deepEqual(statements('postgres', { kind: 'create-table', table: recipes }), [
      'CREATE TABLE "recipes" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY NOT NULL, '
      + '"title" VARCHAR(120) NOT NULL, "body" TEXT, "servings" INTEGER DEFAULT 4, '
      + '"price" NUMERIC(8, 2), "vegetarian" BOOLEAN DEFAULT FALSE, "made_on" DATE, '
      + '"made_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "ref" UUID, '
      + 'PRIMARY KEY ("id"), CONSTRAINT "recipes_title_key" UNIQUE ("title"))',
    ]);
    assert.deepEqual(statements('mariadb', { kind: 'create-table', table: recipes }), [
      'CREATE TABLE `recipes` (`id` INT AUTO_INCREMENT NOT NULL, '
      + '`title` VARCHAR(120) NOT NULL, `body` TEXT, `servings` INT DEFAULT 4, '
      + '`price` DECIMAL(8, 2), `vegetarian` TINYINT(1) DEFAULT 0, `made_on` DATE, '
      + '`made_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `ref` CHAR(36), '
      + 'PRIMARY KEY (`id`), CONSTRAINT `recipes_title_key` UNIQUE (`title`)) ENGINE=InnoDB',
    ]);
  });

  it('changes a field in three statements on Postgres and one on MariaDB', () => {
    const step: Step = {
      kind: 'alter-column',
      table: 'recipes',
      column: column('title', { type: 'short_text', length: 200, required: false, default: { kind: 'text', value: 'Untitled' } }),
      from: column('title', { type: 'text', required: true }),
    };
    assert.deepEqual(statements('postgres', step), [
      'ALTER TABLE "recipes" ALTER COLUMN "title" TYPE VARCHAR(200) USING "title"::VARCHAR(200)',
      'ALTER TABLE "recipes" ALTER COLUMN "title" DROP NOT NULL',
      'ALTER TABLE "recipes" ALTER COLUMN "title" SET DEFAULT \'Untitled\'',
    ]);
    // MariaDB restates the whole field, which is why the printer is given both
    // sides of the change and not just the new one
    assert.deepEqual(statements('mariadb', step), [
      'ALTER TABLE `recipes` MODIFY COLUMN `title` VARCHAR(200) DEFAULT \'Untitled\'',
    ]);
  });

  it('restates AUTO_INCREMENT when MariaDB changes a field that has it', () => {
    const step: Step = {
      kind: 'alter-column',
      table: 'recipes',
      column: column('id', { type: 'integer', required: true, identity: true, default: { kind: 'number', value: 0 } }),
      from: column('id', { type: 'integer', required: true, identity: true }),
    };
    assert.match(statements('mariadb', step)[0]!, /AUTO_INCREMENT/, 'MODIFY without it would quietly take it off');
  });

  it('drops a must-be-different rule the way each engine keeps it', () => {
    assert.deepEqual(statements('postgres', { kind: 'drop-unique', table: 't', unique: 'u' }), ['ALTER TABLE "t" DROP CONSTRAINT "u"']);
    assert.deepEqual(statements('mariadb', { kind: 'drop-unique', table: 't', unique: 'u' }), ['ALTER TABLE `t` DROP INDEX `u`']);
    assert.deepEqual(statements('postgres', { kind: 'drop-foreign-key', table: 't', foreignKey: 'f' }), ['ALTER TABLE "t" DROP CONSTRAINT "f"']);
    assert.deepEqual(statements('mariadb', { kind: 'drop-foreign-key', table: 't', foreignKey: 'f' }), ['ALTER TABLE `t` DROP FOREIGN KEY `f`']);
    assert.deepEqual(statements('postgres', { kind: 'rename-table', table: 'a', to: 'b' }), ['ALTER TABLE "a" RENAME TO "b"']);
    assert.deepEqual(statements('mariadb', { kind: 'rename-table', table: 'a', to: 'b' }), ['RENAME TABLE `a` TO `b`']);
  });

  it('will not write a field it did not make, or a starting value it cannot say', () => {
    assert.equal(code(() => statements('postgres', { kind: 'add-column', table: 't', column: column('x', { type: 'other', sqlType: 'text[]' }) })), 'invalid');
    assert.equal(code(() => statements('mariadb', { kind: 'add-column', table: 't', column: { ...column('x'), default: { kind: 'raw', sql: 'uuid()' } } })), 'invalid');
    // but leaving it alone is fine: an unchanged raw starting value is not a change
    const same: Step = {
      kind: 'alter-column', table: 't',
      column: { ...column('x', { required: true }), default: { kind: 'raw', sql: 'uuid()' } },
      from: { ...column('x'), default: { kind: 'raw', sql: 'uuid()' } },
    };
    assert.deepEqual(statements('postgres', same), ['ALTER TABLE "t" ALTER COLUMN "x" SET NOT NULL']);
  });

  it('refuses a patch bigger than it will do in one go, and an empty one', () => {
    assert.equal(code(() => checkPatch([])), 'invalid');
    assert.equal(code(() => checkPatch(Array.from({ length: 201 }, () => ({ kind: 'drop-table', table: 't' })))), 'invalid');
    assert.equal(checkPatch([{ kind: 'drop-table', table: 't' }]).length, 1);
  });

  it('will not turn a field into one that fills itself in', () => {
    assert.equal(code(() => checkStep({
      kind: 'alter-column', table: 't',
      column: { ...column('id', { type: 'integer', identity: true }) },
      from: column('id', { type: 'integer' }),
    })), 'invalid');
  });

  it('prints the whole patch in the order it runs', () => {
    const sql = patchSql('postgres', checkPatch([
      { kind: 'rename-table', table: 'a', to: 'b' },
      { kind: 'drop-column', table: 'a', column: 'x' },
    ]));
    assert.deepEqual(sql, ['ALTER TABLE "a" DROP COLUMN "x"', 'ALTER TABLE "a" RENAME TO "b"']);
  });
});

// ------------------------------------------------------------------ the draft

describe('the draft the panel keeps', () => {
  const current = snapshot([table('posts', [column('id', { type: 'integer', required: true })], { primaryKey: ['id'] })]);
  const hash = snapshotHash(current);
  const row = (draft: Snapshot, basedOn = hash) => ({
    database_id: 1, draft_json: JSON.stringify(draft), based_on: basedOn, updated_at: 100, updated_by: 'pamela',
  });

  it('without a draft, the page shows the database and has nothing to apply', () => {
    const view = schemaView({ engine: 'postgres', database: 'blog', current, currentHash: hash, row: undefined });
    assert.equal(view.hasDraft, false);
    assert.equal(view.plan.steps.length, 0);
    assert.equal(view.drift, false, 'nothing was built on an older reading, so nothing can have drifted');
  });

  it('notices the database moved under a draft', () => {
    const draft = snapshot([...current.tables, table('comments', [column('id', { type: 'integer' })])]);
    const same = schemaView({ engine: 'postgres', database: 'blog', current, currentHash: hash, row: row(draft) });
    assert.equal(same.drift, false);
    assert.equal(same.plan.steps.length, 1);
    const moved = schemaView({ engine: 'postgres', database: 'blog', current, currentHash: 'ffffffffffffffffffffffffffffffff', row: row(draft) });
    assert.equal(moved.drift, true);
  });

  it('a draft that no longer parses is no draft, not a broken page', () => {
    assert.equal(readDraft({ ...row(current), draft_json: '{oh dear' }, 'postgres', 'blog'), null);
    assert.equal(readDraft({ ...row(current), draft_json: '{"tables":[{"name":"NOPE","columns":[]}]}' }, 'postgres', 'blog'), null);
    const view = schemaView({ engine: 'postgres', database: 'blog', current, currentHash: hash, row: { ...row(current), draft_json: 'x' } });
    assert.equal(view.hasDraft, false);
    assert.deepEqual(view.draft, current);
  });

  it('will not save a drawing without saying which reading it was made from', () => {
    assert.throws(() => checkDraft({ draft: current }, 'postgres', 'blog'), /which version/);
    assert.throws(() => checkDraft({ draft: current, basedOn: 'nope' }, 'postgres', 'blog'), /which version/);
    assert.doesNotThrow(() => checkDraft({ draft: current, basedOn: hash }, 'postgres', 'blog'));
  });
});

// ------------------------------------------------------------------ the two copies of the model

// The web app is a separate Vite root with no path into ../src, so the parts of
// the IR the pages need are written out again in web/src/lib/schema.ts. This is
// what stops the two drifting: a kind of field on the page that the helper would
// refuse is a bug she would meet as "the panel does not know that kind of field"
// after drawing a whole table.
describe('the page and the helper agree about what a field can be', () => {
  it('the same list of kinds, with the same words for them', () => {
    assert.deepEqual([...web.COLUMN_TYPES], [...COLUMN_TYPES]);
    assert.deepEqual(web.TYPE_NAMES, TYPE_NAMES);
  });

  it('the same name rule and the same starting-value alphabet', () => {
    const ir = readFileSync(join(import.meta.dirname, '..', 'packages', 'studio', 'src', 'pammydb', 'ir.ts'), 'utf8');
    const ident = readFileSync(join(import.meta.dirname, '..', 'packages', 'studio', 'src', 'pammydb', 'ident.ts'), 'utf8');
    assert.ok(ident.includes(`export const NAME_RE = ${web.NAME_RE.toString()};`), 'NAME_RE');
    assert.ok(ir.includes(`export const DEFAULT_TEXT_RE = ${web.DEFAULT_TEXT_RE.toString()};`), 'DEFAULT_TEXT_RE');
  });

  it('describe a field the same way', () => {
    const c = { name: 'title', type: 'short_text' as const, length: 120, required: true, default: null };
    assert.equal(web.typeLabel(c), typeLabel(c));
    assert.equal(web.canAlter({ ...c, type: 'other', sqlType: 'text[]' }), canAlter({ ...c, type: 'other', sqlType: 'text[]' }));
  });

  it('start a new table with the same fields', () => {
    assert.deepEqual(web.starterTable('recipes').columns.map((c) => [c.name, c.type, c.required]),
      starterTable('recipes').columns.map((c) => [c.name, c.type, c.required]));
    assert.deepEqual(web.starterTable('recipes').primaryKey, starterTable('recipes').primaryKey);
  });

  it('refuse a name for the same reasons', () => {
    for (const n of ['', 'Recipes', '2026', 'a-b', 'a'.repeat(64)]) {
      assert.equal(web.newIdentProblem(n, 'table') === null, false, n);
    }
    assert.equal(web.newIdentProblem('blog_posts', 'table'), null);
  });

  // The relationship words are written out in both places: the page offers the
  // three choices, the panel enforces them. If they ever drifted, she would be
  // promised something the server would refuse.
  it('offer the same three things to do when a row is deleted, in the same words', () => {
    assert.deepEqual(Object.keys(web.ON_DELETE_NAMES).sort(), [...ON_DELETE].sort());
    assert.deepEqual(web.ON_DELETE_NAMES, ON_DELETE_NAMES);
    assert.deepEqual(Object.keys(web.ON_DELETE_HINTS).sort(), [...ON_DELETE].sort(),
      'every choice she is offered says what it does to her rows');
    assert.deepEqual(Object.keys(web.KIND_NAMES).sort(), [...KINDS].sort());
  });
});

describe('where she put the rectangles', () => {
  const t = (name: string) => table(name, [column('id', { type: 'integer', required: true })], { primaryKey: ['id'] });
  const three = snapshot([t('posts'), t('comments'), t('authors')]);

  it('a first visit lays every table out, and none on top of another', () => {
    const l = placed(three, emptyLayout());
    assert.deepEqual(Object.keys(l.tables).sort(), ['authors', 'comments', 'posts']);
    const seen = new Set(Object.values(l.tables).map((s) => `${s.x},${s.y}`));
    assert.equal(seen.size, 3, 'three tables, three different places');
  });

  it('keeps where she dragged one, and puts a new one below rather than on top', () => {
    const dragged: Layout = { manyToMany: 'simple', tables: { posts: { x: 40, y: 900 }, comments: { x: 0, y: 0 }, authors: { x: 320, y: 0 } } };
    const withNew = snapshot([...three.tables, t('tags')]);
    const l = placed(withNew, dragged);
    assert.deepEqual(l.tables.posts, { x: 40, y: 900 }, 'she put it there');
    // the new one starts on the row below everything already placed, so it
    // cannot land under a table she arranged on purpose
    assert.ok(l.tables.tags!.y > 900, `a new table went to ${JSON.stringify(l.tables.tags)}`);
    const taken = Object.entries(l.tables).filter(([n]) => n !== 'tags').map(([, s]) => `${s.x},${s.y}`);
    assert.ok(!taken.includes(`${l.tables.tags!.x},${l.tables.tags!.y}`), 'and not on top of one');
  });

  it('tidying up moves everything back into rows', () => {
    const messy: Layout = { manyToMany: 'simple', tables: { posts: { x: 4000, y: -2000 } } };
    const l = tidy(three);
    assert.notDeepEqual(l.tables.posts, messy.tables.posts);
    assert.deepEqual(l.tables.posts, { x: 0, y: 0 }, 'the first table in the database starts the first row');
  });

  it('forgets a table that is gone, and keeps one that was only renamed', () => {
    const before: Layout = { manyToMany: 'simple', tables: { posts: { x: 10, y: 20 }, comments: { x: 30, y: 40 } } };
    const after = forget(before, snapshot([t('posts')]));
    assert.deepEqual(after.tables, { posts: { x: 10, y: 20 } }, 'the deleted one stops taking up room');
  });

  // Read the way everything from a browser is read. Nothing here reaches SQL,
  // but a layout is still a document from outside and must not be trusted.
  it('reads a layout from the browser field by field', () => {
    const l = checkLayout({
      tables: {
        good: { x: 1.6, y: -2.4 },
        'not a name': { x: 0, y: 0 },
        'drop table x': { x: 0, y: 0 },
        missing: { x: 'over there' },
        nothing: null,
        far: { x: 1e9, y: -1e9 },
      },
    });
    assert.deepEqual(l.tables.good, { x: 2, y: -2 }, 'rounded: a position is a place, not a measurement');
    assert.deepEqual(Object.keys(l.tables).sort(), ['far', 'good'], 'names no database would take are not keys');
    assert.ok(Math.abs(l.tables.far!.x) <= 100_000, 'one runaway drag cannot put a table where she can never find it');
  });

  it('a layout that no longer parses is no layout, not a crash', () => {
    assert.deepEqual(readLayout(undefined).tables, {});
    assert.deepEqual(readLayout({ database_id: 1, layout_json: 'not json', updated_at: 0, updated_by: '' }).tables, {},
      'the page still opens, and a first visit lays it out again');
  });
});

describe('relationships, in her words', () => {
  const id = () => column('id', { type: 'integer', required: true, identity: true });
  const users = table('users', [id(), column('name')], { primaryKey: ['id'] });
  const posts = table('posts', [id(), column('title')], { primaryKey: ['id'] });
  const groups = table('groups', [id(), column('name')], { primaryKey: ['id'] });
  const two = snapshot([users, posts]);
  const spec = (over: Partial<Spec> = {}): Spec => ({
    from: { table: 'users', column: 'id' }, to: { table: 'posts' },
    kind: 'one-to-many', onDelete: 'restrict', ...over,
  });
  const problem = (fn: () => unknown): string => {
    try { fn(); } catch (e) { if (e instanceof AccountError) return e.message; throw e; }
    return 'no error';
  };

  it('one user has many posts: a field is added on the many side', () => {
    const s = addRelationship(two, spec());
    const p = s.tables.find((t) => t.name === 'posts')!;
    assert.ok(p.columns.some((c) => c.name === 'user_id'), 'the reference field is named after what it points at');
    const made = p.columns.find((c) => c.name === 'user_id')!;
    assert.equal(made.type, 'integer', 'it mirrors the field it points at');
    assert.equal(made.identity, false, 'two tables cannot both be filling in the same number');
    assert.equal(made.required, false);
    assert.deepEqual(p.foreignKeys[0]!.references, { table: 'users', columns: ['id'] });
    assert.equal(p.foreignKeys[0]!.onDelete, 'restrict', 'the safe default');
    assert.deepEqual(relationships(s).map((r) => r.line), ['One user has many posts'],
      'her words, from docs/databases-plan.md D8 -- the one side is singular');
    assert.equal(relationships(s)[0]!.kind, 'one-to-many');
  });

  it('one user has one profile: the same, plus a must-be-different rule', () => {
    const s = addRelationship(two, spec({ kind: 'one-to-one' }));
    const p = s.tables.find((t) => t.name === 'posts')!;
    assert.deepEqual(p.uniques.map((u) => u.columns), [['user_id']],
      'one-to-one is a one-to-many that may only happen once');
    assert.equal(relationships(s)[0]!.kind, 'one-to-one', 'and it reads back as one-to-one');
    assert.equal(relationships(s)[0]!.line, 'One user has one post', 'both sides singular');
  });

  it('many users have many groups: a connecting table is made, and read back as one line', () => {
    const s = addRelationship(snapshot([users, groups]), spec({ to: { table: 'groups' }, kind: 'many-to-many' }));
    const j = s.tables.find((t) => t.name === 'user_groups')!;
    assert.ok(j, 'named the way the plan writes it');
    assert.deepEqual(j.primaryKey, ['user_id', 'group_id'], 'both together, so a pair cannot be connected twice');
    assert.equal(j.foreignKeys.length, 2);
    assert.ok(j.columns.every((c) => c.required), 'neither half of a connection can be missing');
    assert.ok(isJunction(j), 'and it is the shape the canvas can hide again');

    const r = relationships(s);
    assert.equal(r.length, 1, 'one relationship, not two references into a table she never asked for');
    assert.equal(r[0]!.line, 'Many users have many groups');
    assert.equal(r[0]!.junction, 'user_groups');
  });

  it('she can name the connecting table herself', () => {
    const s = addRelationship(snapshot([users, groups]),
      spec({ to: { table: 'groups' }, kind: 'many-to-many', junction: 'memberships' }));
    assert.ok(s.tables.some((t) => t.name === 'memberships'));
  });

  // What must NOT reach the draft. Each one is a sentence she could act on,
  // which is the whole reason this is checked here and not left to the engine.
  it('refuses a pair that could not work, and says why', () => {
    assert.match(problem(() => addRelationship(two, spec({ from: { table: 'users', column: 'name' } }))),
      /not the primary key and is not marked as must-be-different/);
    assert.match(problem(() => addRelationship(two, spec({ from: { table: 'nope', column: 'id' } }))),
      /no table called nope/);
    assert.match(problem(() => addRelationship(two, spec({ from: { table: 'users', column: 'nope' } }))),
      /no field called nope/);

    // a field that already exists but holds a different kind of thing
    const clash = snapshot([users, table('posts', [id(), column('user_id', { type: 'text' })], { primaryKey: ['id'] })]);
    assert.match(problem(() => addRelationship(clash, spec())), /different kinds of thing/);

    // "keep them but remove the connection" cannot empty a required field
    const needed = snapshot([users, table('posts', [id(), column('user_id', { type: 'integer', required: true })], { primaryKey: ['id'] })]);
    assert.match(problem(() => addRelationship(needed, spec({ onDelete: 'set null' }))), /is required, so it cannot be emptied/);

    // and the same relationship twice is a mistake, not a second relationship
    const once = addRelationship(two, spec());
    assert.match(problem(() => addRelationship(once, spec())), /already points at something/);
  });

  it('a connecting table cannot land on a name that is taken', () => {
    const taken = snapshot([users, groups, table('user_groups', [id()], { primaryKey: ['id'] })]);
    assert.match(problem(() => addRelationship(taken, spec({ to: { table: 'groups' }, kind: 'many-to-many' }))),
      /already a table called user_groups/);
  });

  it('a table with its own columns is not a hidden connection', () => {
    // the line between "a junction with an added_at" and "an order line": one is
    // storage she never asked for, the other is a table losing it would cost her
    const link = (extras: Column[]) => table('order_items', [
      column('order_id', { type: 'integer', required: true }),
      column('item_id', { type: 'integer', required: true }),
      ...extras,
    ], {
      primaryKey: ['order_id', 'item_id'],
      foreignKeys: [
        { name: 'a', columns: ['order_id'], references: { table: 'orders', columns: ['id'] }, onDelete: 'restrict' },
        { name: 'b', columns: ['item_id'], references: { table: 'items', columns: ['id'] }, onDelete: 'restrict' },
      ],
    });
    assert.equal(isJunction(link([])), true);
    assert.equal(isJunction(link([column('added_at', { type: 'timestamptz' })])), true, 'a note beside the connection is still a connection');
    assert.equal(isJunction(link([column('quantity', { type: 'integer', required: true })])), false,
      'something that must be filled in is a table in its own right');
  });

  it('changing what happens on delete keeps the connecting table and what is in it', () => {
    const s = addRelationship(snapshot([users, groups]), spec({ to: { table: 'groups' }, kind: 'many-to-many' }));
    // she has since added a note beside the pair; rebuilding the relationship
    // would have thrown it away, which is why this is its own operation
    const withNote = {
      ...s,
      tables: s.tables.map((x) => (x.name !== 'user_groups' ? x : {
        ...x, columns: [...x.columns, column('added_at', { type: 'timestamptz' })],
      })),
    };
    const changed = setOnDelete(withNote, relationships(withNote)[0]!.at, 'cascade');
    const j = changed.tables.find((x) => x.name === 'user_groups')!;
    assert.ok(j.columns.some((c) => c.name === 'added_at'), 'her column is still there');
    assert.deepEqual(j.foreignKeys.map((f) => f.onDelete), ['cascade', 'cascade'], 'both halves change together');
    assert.equal(relationships(changed)[0]!.junction, 'user_groups');
  });

  it('will not offer to empty a field that must be filled in', () => {
    const needed = snapshot([users, table('posts', [id(), column('user_id', { type: 'integer', required: true })], {
      primaryKey: ['id'],
      foreignKeys: [{ name: 'fk', columns: ['user_id'], references: { table: 'users', columns: ['id'] }, onDelete: 'restrict' }],
    })]);
    assert.match(problem(() => setOnDelete(needed, [{ table: 'posts', foreignKey: 'fk' }], 'set null')),
      /is required, so it cannot be emptied/);
    // and the other two are fine
    assert.equal(setOnDelete(needed, [{ table: 'posts', foreignKey: 'fk' }], 'cascade')
      .tables.find((x) => x.name === 'posts')!.foreignKeys[0]!.onDelete, 'cascade');
  });

  it('a connection that is no longer there says so rather than doing nothing', () => {
    assert.match(problem(() => setOnDelete(two, [{ table: 'posts', foreignKey: 'gone' }], 'cascade')),
      /not in your drawing any more/);
  });

  it('removing a many-to-many takes its connecting table with it', () => {
    const s = addRelationship(snapshot([users, groups]), spec({ to: { table: 'groups' }, kind: 'many-to-many' }));
    const back = removeRelationship(s, relationships(s)[0]!.at);
    assert.deepEqual(back.tables.map((t) => t.name), ['users', 'groups'], 'the table it invented goes too');
    assert.deepEqual(relationships(back), []);
  });

  it('removing a plain relationship leaves the field, and only drops the connection', () => {
    const s = addRelationship(two, spec());
    const back = removeRelationship(s, relationships(s)[0]!.at);
    const p = back.tables.find((t) => t.name === 'posts')!;
    assert.deepEqual(p.foreignKeys, []);
    assert.ok(p.columns.some((c) => c.name === 'user_id'),
      'the field stays: her rows are in it, and taking it away is a separate decision');
  });

  it('reads the gesture from the browser field by field', () => {
    assert.match(problem(() => checkSpec({ from: { table: 'users', column: 'id' }, to: { table: 'posts' }, kind: 'sideways', onDelete: 'restrict' })),
      /kind of relationship/);
    assert.match(problem(() => checkSpec({ from: { table: 'users', column: 'id' }, to: { table: 'posts' }, kind: 'one-to-many', onDelete: 'explode' })),
      /what should happen/);
    assert.match(problem(() => checkSpec({ from: { table: 'drop table x', column: 'id' }, to: { table: 'posts' }, kind: 'one-to-many', onDelete: 'restrict' })),
      /could not read which table/);
    assert.match(problem(() => checkWhere({ at: [] })), /which relationship/);
    assert.deepEqual(checkSpec({ from: { table: 'users', column: 'id' }, to: { table: 'posts', column: '' }, kind: 'one-to-many', onDelete: 'restrict' }).to,
      { table: 'posts', column: undefined }, 'an empty field means "work the name out"');
  });
});

describe('one plural rule, used for names and for her words', () => {
  it('only the obvious cases, because a wrong guess is worse than no guess', () => {
    for (const [plural, want] of [
      ['users', 'user'], ['categories', 'category'], ['addresses', 'address'],
      ['boxes', 'box'], ['dishes', 'dish'], ['people', 'people'],
      // already singular although they end in -s: without these she is told
      // "One statu has many orders"
      ['status', 'status'], ['press', 'press'], ['analysis', 'analysis'], ['data', 'data'],
    ] as const) {
      assert.equal(singular(plural), want, plural);
    }
  });

  it('and the names built from it are the ones the plan writes out', () => {
    assert.equal(referenceName('users', 'id'), 'user_id');
    assert.equal(referenceName('categories', 'id'), 'category_id');
    assert.equal(junctionName('users', 'groups'), 'user_groups');
  });
});

describe('what her tables mean', () => {
  const id = () => column('id', { type: 'integer', required: true, identity: true });
  const rows = (over: Partial<ResourceRow> = {}): ResourceRow => ({
    table_name: 'blog_posts', enabled: null, singular: '', plural: '', icon: '', description: '',
    title_field: '', sort_field: '', sort_dir: 'asc',
    can_create: true, can_view: true, can_edit: true, can_delete: true,
    can_duplicate: true, can_search: true, can_sort: true, can_filter: false,
    on_delete: 'follow', ...over,
  });
  const posts = table('blog_posts', [
    id(),
    column('title', { type: 'short_text', length: 120, required: true }),
    column('body', { type: 'text' }),
    column('search_vector', { type: 'other', sqlType: 'tsvector' }),
    column('author_id', { type: 'integer' }),
  ], {
    primaryKey: ['id'],
    foreignKeys: [{ name: 'fk', columns: ['author_id'], references: { table: 'authors', columns: ['id'] }, onDelete: 'restrict' }],
  });
  const authors = table('authors', [id(), column('name', { type: 'short_text', required: true })], { primaryKey: ['id'] });
  const s = snapshot([posts, authors]);
  const view = (t: string, rs: ResourceRow[] = [], fs: FieldRow[] = []) =>
    resourceViews(s, rs, fs).find((r) => r.table === t)!;

  it('guesses her words from the table name, and says it is guessing', () => {
    const v = view('blog_posts');
    assert.equal(v.singular, 'Blog Post');
    assert.equal(v.plural, 'Blog Posts');
    assert.equal(v.decided, false, 'she has not said yes or no yet');
    assert.equal(v.enabled, true, 'but an ordinary table is worth offering as managed');
  });

  it('names a record by something she can read, never by the id', () => {
    assert.equal(view('blog_posts').titleField, 'title');
    assert.equal(view('authors').titleField, 'name', 'name wins over anything else');
  });

  it('a field is labelled in her words, and a reference by what it points at', () => {
    const f = (n: string) => view('blog_posts').fields.find((x) => x.name === n)!;
    assert.equal(f('title').label, 'Title');
    assert.equal(f('author_id').label, 'Author', 'she picks an author, not a number');
    assert.equal(f('author_id').control, 'picker');
    assert.equal(f('author_id').reference, 'authors');
    assert.equal(f('body').control, 'paragraph');
    assert.equal(f('title').control, 'line');
  });

  it('says what the database keeps it as, so the two are never confused', () => {
    const f = (n: string) => view('blog_posts').fields.find((x) => x.name === n)!;
    assert.equal(f('title').storedAs, 'Short text (120)');
    assert.equal(f('search_vector').storedAs, 'tsvector', 'a kind the panel does not offer says so plainly');
    assert.equal(f('search_vector').control, 'text', 'and is left as it is');
  });

  it('short text is searched by default and long text is not', () => {
    const f = (n: string) => view('blog_posts').fields.find((x) => x.name === n)!;
    assert.equal(f('title').searchable, true);
    assert.equal(f('body').searchable, false, 'searching every paragraph is slow and noisy (11.1)');
  });

  // The three kinds, and why two of them are off to begin with.
  it('a connecting table is offered but left out, because it is plumbing', () => {
    const junction = table('blog_post_categories', [
      column('blog_post_id', { type: 'integer', required: true }),
      column('category_id', { type: 'integer', required: true }),
    ], {
      primaryKey: ['blog_post_id', 'category_id'],
      foreignKeys: [
        { name: 'a', columns: ['blog_post_id'], references: { table: 'blog_posts', columns: ['id'] }, onDelete: 'cascade' },
        { name: 'b', columns: ['category_id'], references: { table: 'categories', columns: ['id'] }, onDelete: 'cascade' },
      ],
    });
    const v = resourceViews(snapshot([posts, authors, junction]), [], []).find((r) => r.table === 'blog_post_categories')!;
    assert.equal(v.kind, 'connection');
    assert.equal(v.enabled, false, 'she never asked for this table and should not have to think about it');
    assert.match(v.note!, /behind the scenes/);
  });

  it('somebody else\'s plumbing is offered but left out too, and she may still tick it', () => {
    const machinery = ['schema_migrations', 'sessions', 'wp_options', 'page_cache', 'alembic_version'];
    const tables = machinery.map((n) => table(n, [id()], { primaryKey: ['id'] }));
    const views = resourceViews(snapshot(tables), [], []);
    for (const v of views) {
      assert.equal(v.kind, 'machinery', v.table);
      assert.equal(v.enabled, false, v.table);
    }
    // WordPress is not special-cased beyond the name: wp_posts is her blog
    const wp = resourceViews(snapshot([table('wp_posts', [id()], { primaryKey: ['id'] })]), [], [])[0]!;
    assert.equal(wp.kind, 'thing', 'she can manage her blog from here if she wants to');
  });

  it('what she saved wins, and a row is the only thing that means she decided', () => {
    const v = view('blog_posts', [rows({ enabled: false, singular: 'Article', plural: 'Articles' })]);
    assert.equal(v.enabled, false);
    assert.equal(v.decided, true);
    assert.equal(v.singular, 'Article');
    // an empty override is not an override: renaming the table still re-guesses
    const blank = view('blog_posts', [rows({ enabled: true, singular: '', plural: '' })]);
    assert.equal(blank.singular, 'Blog Post', 'nothing stored means inference speaks');
  });

  it('a stored field she has since removed is ignored rather than shown', () => {
    const v = view('blog_posts', [], [{
      table_name: 'blog_posts', field_name: 'gone_away', exposed: false, label: 'Gone', help: '',
      control: 'line', show_in_list: false, searchable: false, filterable: false, form_order: 0,
    }]);
    assert.ok(!v.fields.some((f) => f.name === 'gone_away'), 'inference is the list; storage only overrides');
  });

  it('a title field she has since removed falls back to a guess', () => {
    const v = view('blog_posts', [rows({ title_field: 'gone_away' })]);
    assert.equal(v.titleField, 'title', 'rather than naming every record after nothing');
  });

  it('making a copy needs being able to add', () => {
    const v = view('blog_posts', [rows({ can_create: false, can_duplicate: true })]);
    assert.equal(v.can.duplicate, false, 'duplicate is create plus a copy (11.1)');
  });

  // The window. Hiding the wrong thing would leave her a page of blanks.
  it('will not let her hide her way to a page of blanks', () => {
    const v = view('blog_posts');
    const problem = (fn: () => unknown): string => {
      try { fn(); } catch (e) { if (e instanceof AccountError) return e.message; throw e; }
      return 'no error';
    };
    assert.match(problem(() => refuseIfBlind(v, 'title', { exposed: false })), /named by title/);
    // the key is not part of the window anyway, so hiding it costs nothing
    assert.equal(problem(() => refuseIfBlind(v, 'id', { exposed: false })), 'no error');
    // and a hidden field cannot be searched: it is not a window
    const hidden = view('blog_posts', [], [{
      table_name: 'blog_posts', field_name: 'body', exposed: false, label: '', help: '',
      control: '', show_in_list: false, searchable: false, filterable: false, form_order: 2,
    }]);
    assert.match(problem(() => refuseIfBlind(hidden, 'body', { searchable: true })), /hidden cannot be searched/);
  });

  it('reads what arrives from the browser field by field', () => {
    assert.deepEqual(checkResourcePatch({ enabled: 'yes', singular: '  Article  ', nonsense: 1 }),
      { singular: 'Article' }, 'a tick that is not a tick is not a tick');
    assert.deepEqual(checkResourcePatch({ can: { edit: false, fly: true } }), { can: { edit: false } });
    assert.deepEqual(checkResourcePatch({ sortDir: 'sideways' }), {});
    assert.deepEqual(checkFieldPatch({ control: 'telepathy' }), {});
    assert.deepEqual(checkFieldPatch({ control: 'tick', exposed: false }), { control: 'tick', exposed: false });
  });

  // docs/tutorials-plan.md V1-V3
  it('people signed in to a folder: a text field says whose each one is, it stays shown, and it goes to the gate', () => {
    assert.deepEqual(checkResourcePatch({ visitorArea: 7, visitorOwner: 'title' }), { visitorArea: 7, visitorOwner: 'title' });
    assert.deepEqual(checkResourcePatch({ visitorArea: null, visitorOwner: '' }), { visitorArea: null, visitorOwner: '' });
    assert.throws(() => checkResourcePatch({ visitorArea: -1 }), AccountError);
    assert.throws(() => checkResourcePatch({ visitorOwner: 'Bad name' }), AccountError);
    const v = view('blog_posts');
    assert.throws(() => checkVisitors(v, { visitorOwner: 'author_id' }), /Only a text field/);
    assert.throws(() => checkVisitors(v, { visitorOwner: 'id' }), AccountError);
    checkVisitors(v, { visitorArea: 7, visitorOwner: 'title' });
    // "each their own" and "anyone can read them all" can't both be on
    const open = view('blog_posts', [rows({ public_read: true })]);
    assert.throws(() => checkVisitors(open, { visitorArea: 7, visitorOwner: 'title' }), /Anyone can read/);
    const owned = view('blog_posts', [rows({ visitor_area: 7, visitor_owner: 'title' })]);
    assert.deepEqual([owned.visitorArea, owned.visitorOwner], [7, 'title']);
    assert.throws(() => checkVisitors(owned, { publicRead: true }), /Anyone can read/);
    assert.throws(() => refuseIfBlind(owned, 'title', { exposed: false }), /hide the rule/);
    // an owner field renamed away (or no longer text) lets the folder in to nothing, rather than to everyone's
    const gone = view('blog_posts', [rows({ visitor_area: 7, visitor_owner: 'author_id' })]);
    assert.deepEqual([gone.visitorArea, gone.visitorOwner], [null, null]);
    const cat = buildCatalog(resourceViews(s, [rows({ enabled: true, visitor_area: 7, visitor_owner: 'title' })], []));
    assert.deepEqual(cat.resources.find((r) => r.table === 'blog_posts')!.visitors, { area: 7, owner: 'title' });
  });
});

describe('asking for rows', () => {
  const q = (over: Partial<RowQuery> = {}): RowQuery => ({
    table: 'recipes', columns: ['id', 'title'], limit: 20, offset: 0,
    order: null, search: null, filters: [], ...over,
  });

  it('every value is a parameter, and every name is quoted', () => {
    const { rows } = buildList('postgres', q({
      search: { columns: ['title'], text: "'; DROP TABLE recipes; --" },
      filters: [{ kind: 'equals', column: 'servings', value: 4 }],
    }));
    assert.ok(rows.text.includes('"recipes"."title"'), 'identifiers are quoted');
    assert.ok(!rows.text.includes('DROP TABLE'), 'the text she typed is nowhere in the statement');
    assert.ok(rows.params.some((p) => String(p).includes('DROP TABLE')), '...it is a parameter');
    assert.ok(rows.text.includes('$1'), 'and Postgres placeholders are numbered');
  });

  it('the same query, MariaDB\'s way', () => {
    const { rows } = buildList('mariadb', q({ filters: [{ kind: 'equals', column: 'servings', value: 4 }] }));
    assert.ok(rows.text.includes('`recipes`.`title`'));
    assert.ok(rows.text.includes('?') && !rows.text.includes('$1'));
    assert.deepEqual(rows.params, [4, 20, 0]);
  });

  it('a search for a per cent sign is a search for a per cent sign', () => {
    // % and _ mean something to LIKE; without escaping, "100%" would match
    // anything starting with 100
    assert.equal(likeEscape('100%'), '100\\%');
    assert.equal(likeEscape('a_b'), 'a\\_b');
    assert.equal(likeEscape('back\\slash'), 'back\\\\slash');
    const { rows } = buildList('postgres', q({ search: { columns: ['title'], text: '100%' } }));
    assert.ok(rows.params.includes('%100\\%%'));
    assert.ok(rows.text.includes("ESCAPE '\\'"));
  });

  it('always sorted by something, or page 2 may hold what page 1 did', () => {
    const { rows } = buildList('postgres', q({ order: { column: 'title', dir: 'desc' } }));
    assert.ok(rows.text.includes('ORDER BY "recipes"."title" DESC'));
  });

  it('counts the same rows it lists, so "8 of 32" means the same 8', () => {
    const { rows, count } = buildList('postgres', q({ filters: [{ kind: 'contains', column: 'title', text: 'cake' }] }));
    assert.ok(count.text.includes('count(*)'));
    assert.ok(count.text.includes('LIKE'), 'the narrowing is in both');
    assert.deepEqual(count.params, ['%cake%'], 'and only the narrowing: no limit or offset');
    assert.deepEqual(rows.params, ['%cake%', 20, 0]);
  });

  it('refuses a name no database would take, rather than quoting it', () => {
    const bad = (fn: () => unknown) => {
      try { fn(); } catch (e) { if (e instanceof PammyDbError) return e.code; throw e; }
      return 'no error';
    };
    assert.equal(bad(() => checkQuery({ table: 'drop table x', columns: ['id'] })), 'invalid');
    assert.equal(bad(() => checkQuery({ table: 'recipes', columns: ['a"b'] })), 'invalid');
    assert.equal(bad(() => checkQuery({ table: 'recipes', columns: [] })), 'invalid');
    assert.equal(bad(() => checkValues({ 'x; --': 1 })), 'invalid');
    assert.equal(bad(() => checkWhereRow({})), 'invalid');
  });

  it('will not hand back her whole table because a request asked for it', () => {
    assert.equal(checkQuery({ table: 'recipes', columns: ['id'], limit: 1_000_000 }).limit, 200);
    assert.equal(checkQuery({ table: 'recipes', columns: ['id'] }).limit, 20);
    assert.equal(checkQuery({ table: 'recipes', columns: ['id'], offset: -5 }).offset, 0);
  });

  it('an update with nothing to change is not an update', () => {
    assert.equal(buildUpdate('postgres', 'recipes', {}, { id: 1 }), null);
    const u = buildUpdate('postgres', 'recipes', { title: 'x' }, { id: 1 })!;
    assert.ok(u.text.startsWith('UPDATE "recipes" SET "title" = $1'));
    assert.deepEqual(u.params, ['x', 1]);
  });

  it('a null is IS NULL, not = null, which matches nothing', () => {
    const g = buildGet('postgres', 'recipes', ['id'], { tags: null });
    assert.ok(g.text.includes('IS NULL'));
    assert.deepEqual(g.params, []);
  });
});

describe('the Resource window, on the way in and out', () => {
  const id = () => column('id', { type: 'integer', required: true, identity: true });
  const t = table('people', [
    id(),
    column('name', { type: 'short_text', required: true }),
    column('secret', { type: 'text' }),
  ], { primaryKey: ['id'] });
  const s = snapshot([t]);
  const hidden: FieldRow = {
    table_name: 'people', field_name: 'secret', exposed: false, label: '', help: '',
    control: '', show_in_list: false, searchable: false, filterable: false, form_order: 2,
  };
  const view = (fs: FieldRow[] = [hidden]) => resourceViews(s, [], fs).find((r) => r.table === 'people')!;
  const problem = (fn: () => unknown): string => {
    try { fn(); } catch (e) { if (e instanceof AccountError) return e.message; throw e; }
    return 'no error';
  };

  it('a hidden field is never read', () => {
    assert.deepEqual(readable(view()), ['id', 'name'], 'being in the database is not permission to read');
    assert.deepEqual(readable(view([])), ['id', 'name', 'secret'], 'and it is read once she shows it');
  });

  it('a hidden field cannot be written, and is refused rather than ignored', () => {
    // quietly dropping half of what someone sent is how data goes missing
    assert.match(problem(() => valuesFor(view(), { values: { secret: 'x' } }, 'edit')), /hidden, so it cannot be filled in/);
    assert.match(problem(() => valuesFor(view(), { values: { nope: 'x' } }, 'edit')), /no field called nope/);
    assert.deepEqual(valuesFor(view(), { values: { name: 'Olivia' } }, 'edit'), { name: 'Olivia' });
  });

  it('the key is not something a form may change', () => {
    assert.deepEqual(valuesFor(view(), { values: { id: 99, name: 'x' } }, 'edit'), { name: 'x' },
      'changing it would make "this record" mean something else half way through');
    assert.deepEqual(valuesFor(view(), { values: { id: null, name: 'x' } }, 'create'), { name: 'x' },
      'and on a new one the engine fills it in');
  });

  it('a sort or a search on a hidden field is dropped, not honoured', () => {
    const q = listQuery(view(), { page: 1, search: 'x', sort: { column: 'secret', dir: 'asc' }, filters: [] });
    assert.notEqual(q.order!.column, 'secret');
    // `name` is short text, so it is searched by default; `secret` is hidden,
    // so it is not searched however the request asks
    assert.deepEqual(q.search, { columns: ['name'], text: 'x' });
    assert.ok(!q.columns.includes('secret'));
    // and once she shows it, it is still not searchable until she says so
    assert.deepEqual(listQuery(view([]), { page: 1, search: 'x', sort: null, filters: [] }).search,
      { columns: ['name'], text: 'x' }, 'long text is not searched by default (11.1)');
  });

  it('pages are offsets of twenty, from one', () => {
    assert.equal(listQuery(view(), { page: 1, search: '', sort: null, filters: [] }).offset, 0);
    assert.equal(listQuery(view(), { page: 3, search: '', sort: null, filters: [] }).offset, 40);
  });

  it('a table with nothing to tell rows apart says so instead of guessing', () => {
    const keyless = snapshot([table('notes', [column('body', { type: 'text' })])]);
    const r = resourceViews(keyless, [], []).find((x) => x.table === 'notes')!;
    assert.match(problem(() => keyOf(r)), /no field that tells one record from another/);
  });

  it('an ability that is off is a refusal, not a hidden button', () => {
    const off = resourceViews(s, [{
      table_name: 'people', enabled: true, singular: '', plural: '', icon: '', description: '',
      title_field: '', sort_field: '', sort_dir: 'asc',
      can_create: false, can_view: true, can_edit: true, can_delete: false,
      can_duplicate: false, can_search: true, can_sort: true, can_filter: false, on_delete: 'follow',
    }], []).find((r) => r.table === 'people')!;
    assert.match(abilityMissing(off, 'create')!.message, /cannot be added here/);
    assert.match(abilityMissing(off, 'delete')!.message, /cannot be deleted here/);
    assert.equal(abilityMissing(off, 'edit'), null);
  });
});

describe('what the gate is told, and what it lets through', () => {
  const id = () => column('id', { type: 'integer', required: true, identity: true });
  const posts = table('blog_posts', [
    id(), column('title', { type: 'short_text', required: true }), column('secret', { type: 'text' }),
  ], { primaryKey: ['id'] });
  const keyless = table('notes', [column('body', { type: 'text' })]);
  const s = snapshot([posts, keyless]);
  const hidden: FieldRow = {
    table_name: 'blog_posts', field_name: 'secret', exposed: false, label: '', help: '',
    control: '', show_in_list: false, searchable: false, filterable: false, form_order: 2,
  };
  const on = (over: Partial<ResourceRow> = {}): ResourceRow => ({
    table_name: 'blog_posts', enabled: true, singular: '', plural: '', icon: '', description: '',
    title_field: '', sort_field: '', sort_dir: 'asc',
    can_create: true, can_view: true, can_edit: true, can_delete: true,
    can_duplicate: true, can_search: true, can_sort: true, can_filter: false,
    on_delete: 'follow', ...over,
  });
  const cat = (rows: ResourceRow[] = [on()], fields: FieldRow[] = [hidden]) =>
    buildCatalog(resourceViews(s, rows, fields));

  it('the catalog carries only what is exposed', () => {
    const c = cat();
    const r = c.resources.find((x) => x.table === 'blog_posts')!;
    assert.deepEqual(r.columns, ['id', 'title'], 'a hidden field is not in the catalog at all');
    assert.deepEqual(r.key, ['id']);
    assert.equal(r.slug, 'blog-posts', 'the address is her words, not the table name');
  });

  it('something with nothing to tell its rows apart is left out of the API', () => {
    const c = buildCatalog(resourceViews(s, [on(), { ...on(), table_name: 'notes' }], []));
    assert.ok(!c.resources.some((r) => r.table === 'notes'),
      'there would be no honest way to point at one of its records');
  });

  it('a table she does not manage is not in the catalog', () => {
    const c = buildCatalog(resourceViews(s, [on({ enabled: false })], []));
    assert.deepEqual(c.resources.map((r) => r.table), []);
  });

  it('a table she has never said yes to is not in the catalog, whatever inference guesses', () => {
    // no row at all: inference calls blog_posts a thing, so `enabled` is true --
    // but that is a proposal on the Application tab, not a yes
    const guessed = resourceViews(s, [], []).find((r) => r.table === 'blog_posts')!;
    assert.equal(guessed.enabled, true);
    assert.equal(guessed.decided, false);
    assert.deepEqual(buildCatalog(resourceViews(s, [], [])).resources, []);
    // a row with her answer still open is the same
    assert.deepEqual(buildCatalog(resourceViews(s, [on({ enabled: null })], [])).resources, []);
  });

  it('a catalog that will not parse means nothing is exposed, not everything', () => {
    assert.deepEqual(readCatalog('not json').resources, []);
    assert.deepEqual(readCatalog('{"resources":"all"}').resources, []);
    // and a resource missing its key is dropped rather than trusted
    assert.deepEqual(readCatalog('{"resources":[{"slug":"x","table":"x","columns":["a"],"key":[],"searchable":[],"sortable":[],"can":{}}]}').resources, []);
  });

  // The three gates, in order (src/gate/studio.ts allow).
  const row = (over: Partial<CatalogRow> = {}): CatalogRow => ({
    database_id: 7, engine: 'postgres', name: 'blog', api_read: true, api_write: true,
    catalog_json: JSON.stringify(cat()), updated_at: 0, ...over,
  });
  const key = (over: Partial<AppKey> = {}): AppKey => ({
    id: 1, databaseId: 7, label: 'website', prefix: 'pammy_app_x', resources: 'all', canWrite: true,
    createdAt: 0, createdBy: null, lastUsedAt: null, revokedAt: null, ...over,
  });

  it('the switch comes first, and says which switch', () => {
    const noRead = allow(row({ api_read: false }), key(), 'blog-posts', false, 'view');
    assert.equal(noRead.ok, false);
    assert.equal((noRead as { status: number }).status, 403, 'not a 404: she has simply not switched it on');
    assert.match((noRead as { message: string }).message, /read by programs/);
    const noWrite = allow(row({ api_write: false }), key(), 'blog-posts', true, 'create');
    assert.match((noWrite as { message: string }).message, /changed by programs/);
    // and reading still works when only writing is off
    assert.equal(allow(row({ api_write: false }), key(), 'blog-posts', false, 'view').ok, true);
  });

  it('no key, the wrong database\'s key, or a read-only key', () => {
    assert.equal((allow(row(), null, 'blog-posts', false, 'view') as { status: number }).status, 401);
    assert.equal((allow(row(), key({ databaseId: 8 }), 'blog-posts', false, 'view') as { status: number }).status, 401);
    const ro = allow(row(), key({ canWrite: false }), 'blog-posts', true, 'create');
    assert.match((ro as { message: string }).message, /can read, but not change/);
    const narrow = allow(row(), key({ resources: ['other-things'] }), 'blog-posts', false, 'view');
    assert.match((narrow as { message: string }).message, /does not reach this part/);
  });

  // The one that matters: a key cannot outlive a decision she made.
  it('a key that says write cannot delete once she turns Delete off', () => {
    const before = allow(row(), key(), 'blog-posts', true, 'delete');
    assert.equal(before.ok, true, 'it could a moment ago');
    const after = allow(row({ catalog_json: JSON.stringify(cat([on({ can_delete: false })])) }), key(), 'blog-posts', true, 'delete');
    assert.equal(after.ok, false);
    assert.match((after as { message: string }).message, /set up so that cannot be done/);
    // the key itself has not changed, and can still read
    assert.equal(allow(row({ catalog_json: JSON.stringify(cat([on({ can_delete: false })])) }), key(), 'blog-posts', false, 'view').ok, true);
  });

  it('a kind of thing that is not in the catalog is simply not there', () => {
    assert.equal((allow(row(), key(), 'nothing-like-this', false, 'view') as { status: number }).status, 404);
    assert.equal((allow(undefined, key(), 'blog-posts', false, 'view') as { status: number }).status, 404);
  });
});

describe('what a change does to an app that is switched on', () => {
  const on = { active: true, title: 'Kitchen', programs: true };
  const managed = [{ table: 'recipes', plural: 'Recipes' }, { table: 'guests', plural: 'Guests' }];
  const col = column('note', { type: 'text' });

  it('says nothing more when the app is off', () => {
    assert.equal(impactOf([{ kind: 'drop-table', table: 'recipes' }], { ...on, active: false }, managed), null);
  });

  it('names each thing the app manages that the changes reach, by its worst change', () => {
    const i = impactOf([
      { kind: 'add-column', table: 'recipes', column: col },
      { kind: 'rename-table', table: 'recipes', to: 'dishes' },
      { kind: 'drop-column', table: 'guests', column: 'phone' },
      { kind: 'drop-table', table: 'scribbles' },
    ], on, managed)!;
    assert.deepEqual(i.touched, [
      { table: 'recipes', plural: 'Recipes', how: 'renamed' },
      { table: 'guests', plural: 'Guests', how: 'changed' },
    ], 'scribbles is not something the app manages, so it is not named');
    assert.equal(i.title, 'Kitchen');
    assert.equal(i.programs, true);
  });

  it('a table going is worse than anything else happening to it', () => {
    const i = impactOf([
      { kind: 'drop-column', table: 'guests', column: 'phone' },
      { kind: 'drop-table', table: 'guests' },
    ], on, managed)!;
    assert.deepEqual(i.touched.map((t) => t.how), ['goes']);
  });

  it('a new table is listed as new, and is not something the app already manages', () => {
    const i = impactOf([{ kind: 'create-table', table: table('menus', [column('id', { type: 'integer', required: true })]) }], on, managed)!;
    assert.deepEqual(i.touched, []);
    assert.deepEqual(i.added, ['menus']);
  });
});

// ------------------------------------------------------------------ the canvas's table menu

describe('renaming, copying and deleting a whole table', () => {
  const id = () => column('id', { type: 'integer', required: true, identity: true });
  const cooks = table('cooks', [id(), column('name')], { primaryKey: ['id'] });
  const recipes = table('recipes', [id(), column('title'), column('cook_id', { type: 'integer' }), column('based_on', { type: 'integer' })], {
    primaryKey: ['id'],
    uniques: [{ name: 'recipes_title_key', columns: ['title'] }],
    foreignKeys: [
      { name: 'recipes_cook_id_fkey', columns: ['cook_id'], references: { table: 'cooks', columns: ['id'] }, onDelete: 'restrict' },
      { name: 'recipes_based_on_fkey', columns: ['based_on'], references: { table: 'recipes', columns: ['id'] }, onDelete: 'set null' },
    ],
    indexes: [{ name: 'recipes_title_idx', columns: ['title'], unique: false }],
  });
  const now = snapshot([cooks, recipes]);

  it('renaming a table others point at is one rename, not the connections thrown away and made again', () => {
    const tables = web.renamedTable(now, now.tables, 'cooks', 'chefs');
    assert.equal(tables.find((t) => t.name === 'chefs')!.was, 'cooks');
    assert.equal(tables.find((t) => t.name === 'recipes')!.foreignKeys[0]!.references.table, 'chefs', 'she sees it point at the new name');
    const steps = diff(now, snapshot(tables as Table[]));
    assert.deepEqual(steps, [{ kind: 'rename-table', table: 'cooks', to: 'chefs' }]);
  });

  it('a new table pointing at a renamed one points at the name the engine still has, because renames run last', () => {
    const renamed = web.renamedTable(now, now.tables, 'cooks', 'chefs') as Table[];
    const menus = table('menus', [id(), column('chef_id', { type: 'integer' })], {
      primaryKey: ['id'],
      foreignKeys: [{ name: 'menus_chef_id_fkey', columns: ['chef_id'], references: { table: 'chefs', columns: ['id'] }, onDelete: 'restrict' }],
    });
    const steps = diff(now, snapshot([...renamed, menus]));
    assert.deepEqual(steps.map((x) => x.kind), ['create-table', 'add-foreign-key', 'rename-table']);
    const fk = steps.find((x) => x.kind === 'add-foreign-key') as Extract<Step, { kind: 'add-foreign-key' }>;
    assert.equal(fk.foreignKey.references.table, 'cooks');
  });

  it('renaming back to the old name is no change at all, and a table only in the drawing has no old name', () => {
    const there = web.renamedTable(now, now.tables, 'cooks', 'chefs');
    const back = web.renamedTable(now, there, 'chefs', 'cooks');
    assert.equal(back.find((t) => t.name === 'cooks')!.was, undefined);
    assert.deepEqual(diff(now, snapshot(back as Table[])), []);
    const drawn = [...now.tables, table('notes', [id()], { primaryKey: ['id'] })];
    assert.equal(web.renamedTable(now, drawn, 'notes', 'jottings').find((t) => t.name === 'jottings')!.was, undefined);
  });

  it('deleting a table takes the connections to it along, so the engine can drop it', () => {
    assert.deepEqual(web.pointingAt(now.tables, 'cooks'), [{ table: 'recipes', columns: ['cook_id'] }]);
    assert.deepEqual(web.pointingAt(now.tables, 'recipes'), [], 'its connection to itself goes with it and is not named');
    const left = web.withoutTable(now.tables, 'cooks') as Table[];
    assert.deepEqual(left.map((t) => t.name), ['recipes']);
    assert.deepEqual(left[0]!.foreignKeys.map((f) => f.name), ['recipes_based_on_fkey']);
    assert.ok(left[0]!.columns.some((c) => c.name === 'cook_id'), 'the field stays');
    assert.deepEqual(diff(now, snapshot(left)).map((x) => x.kind), ['drop-foreign-key', 'drop-table']);
  });

  it('a copy has the design and names its own rules, and points at itself where the original did', () => {
    assert.equal(web.copyName(now.tables, 'recipes'), 'recipes_copy');
    assert.equal(web.copyName([...now.tables, table('recipes_copy', [id()])], 'recipes'), 'recipes_copy_2');
    const made = web.clonedTable(recipes, 'recipes_copy');
    assert.ok('table' in made);
    const t = made.table;
    assert.deepEqual(t.columns.map((c) => c.name), ['id', 'title', 'cook_id', 'based_on']);
    assert.deepEqual(t.uniques, [{ name: 'recipes_copy_title_key', columns: ['title'] }]);
    assert.deepEqual(t.foreignKeys.map((f) => [f.name, f.references.table]),
      [['recipes_copy_cook_id_fkey', 'cooks'], ['recipes_copy_based_on_fkey', 'recipes_copy']]);
    assert.deepEqual(t.indexes, [], 'the panel does not make indexes');
    assert.deepEqual(made.left, []);
    // and it is a table the helper takes and the diff makes
    const checked = checkSnapshot(snapshot([...now.tables, t as Table]), 'postgres', 'blog');
    assert.deepEqual(diff(now, checked).map((x) => x.kind), ['create-table', 'add-foreign-key', 'add-foreign-key']);
  });

  it('a copy leaves out what the panel cannot write down, and says so', () => {
    const odd = table('odd', [id(), column('tags', { type: 'other', sqlType: 'text[]' }), column('note')], {
      primaryKey: ['id'], uniques: [{ name: 'odd_tags_key', columns: ['tags'] }],
    });
    const made = web.clonedTable(odd, 'odd_copy');
    assert.ok('table' in made);
    assert.deepEqual(made.table.columns.map((c) => c.name), ['id', 'note']);
    assert.deepEqual(made.table.uniques, []);
    assert.deepEqual(made.left, ['tags']);
    const keyed = table('keyed', [column('code', { type: 'other', sqlType: 'citext', required: true })], { primaryKey: ['code'] });
    assert.ok('problem' in web.clonedTable(keyed, 'keyed_copy'));
  });

  it('two connected tables going at once lose their connection first, so the engine can drop them', () => {
    // disconnecting a many-to-many (its connecting table goes) and deleting one side
    const tags = table('tags', [id()], { primaryKey: ['id'] });
    const junction = table('recipe_tags', [column('recipe_id', { type: 'integer', required: true }), column('tag_id', { type: 'integer', required: true })], {
      primaryKey: ['recipe_id', 'tag_id'],
      foreignKeys: [
        { name: 'recipe_tags_recipe_id_fkey', columns: ['recipe_id'], references: { table: 'recipes', columns: ['id'] }, onDelete: 'cascade' },
        { name: 'recipe_tags_tag_id_fkey', columns: ['tag_id'], references: { table: 'tags', columns: ['id'] }, onDelete: 'cascade' },
      ],
    });
    const had = snapshot([cooks, recipes, tags, junction]);
    const steps = diff(had, snapshot([cooks, recipes]));
    assert.deepEqual(steps, [
      { kind: 'drop-foreign-key', table: 'recipe_tags', foreignKey: 'recipe_tags_tag_id_fkey' },
      { kind: 'drop-table', table: 'tags' },
      { kind: 'drop-table', table: 'recipe_tags' },
    ], 'only the link between two tables that are both going; recipes stays, so its link goes with its table');
  });

  it('a many-to-many reads the same way round after the engine has listed its links by name', () => {
    const labels = table('labels', [id()], { primaryKey: ['id'] });
    const junction = table('recipe_labels', [column('recipe_id', { type: 'integer', required: true }), column('label_id', { type: 'integer', required: true })], {
      primaryKey: ['recipe_id', 'label_id'],
      // alphabetical, as the engine gives them back: label before recipe
      foreignKeys: [
        { name: 'recipe_labels_label_id_fkey', columns: ['label_id'], references: { table: 'labels', columns: ['id'] }, onDelete: 'cascade' },
        { name: 'recipe_labels_recipe_id_fkey', columns: ['recipe_id'], references: { table: 'recipes', columns: ['id'] }, onDelete: 'cascade' },
      ],
    });
    const [r] = relationships(snapshot([recipes, labels, junction])).filter((x) => x.junction);
    assert.equal(r!.line, 'Many recipes have many labels');
  });

  it('after an Apply, knows which renames the engine really has', () => {
    const steps: Step[] = [
      { kind: 'rename-column', table: 'recipes', column: 'title', to: 'headline' },
      { kind: 'rename-table', table: 'recipes', to: 'dishes' },
      { kind: 'rename-table', table: 'cooks', to: 'chefs' },
    ];
    const dishes = { ...recipes, name: 'dishes', columns: recipes.columns.map((c) => (c.name === 'title' ? { ...c, name: 'headline' } : c)) };
    // MariaDB stopped before the last one
    assert.deepEqual(renamesDone(steps, snapshot([cooks, dishes])), {
      tables: [{ from: 'recipes', to: 'dishes' }],
      fields: [{ table: 'dishes', from: 'title', to: 'headline' }],
    });
    assert.deepEqual(renamesDone(steps, now), { tables: [], fields: [] });
  });

  it('a renamed table keeps its place on the canvas', () => {
    const layout: Layout = { tables: { cooks: { x: 10, y: 20 }, recipes: { x: 400, y: 20 } }, manyToMany: 'simple' };
    const drawn = snapshot([{ ...cooks, name: 'chefs', was: 'cooks' }, recipes]);
    assert.deepEqual(renamedIn(layout, drawn, 'cooks', 'chefs', { x: 10, y: 20 })!.tables,
      { recipes: { x: 400, y: 20 }, chefs: { x: 10, y: 20 } });
    // a table she never dragged has no stored spot: the page says where it was drawn
    assert.deepEqual(renamedIn(emptyLayout(), drawn, 'cooks', 'chefs', { x: 5, y: 6 })!.tables, { chefs: { x: 5, y: 6 } });
    assert.equal(renamedIn(layout, now, 'cooks', 'chefs', { x: 1, y: 1 }), null, 'not while the drawing still has the old name');
    assert.equal(renamedIn(layout, drawn, 'cooks', 'chefs', 'here'), null);
  });
});

// ------------------------------------------------------------------ the two database examples

describe('the database examples (docs/db-examples-plan.md)', () => {
  for (const kind of DB_EXAMPLE_KINDS) {
    const ex = DB_EXAMPLES[kind];
    it(`${kind}: is a drawing the Database Manager could have made`, () => {
      const s = exampleSnapshot(ex, ex.engine, ex.database);
      const checked = checkSnapshot(JSON.parse(JSON.stringify(s)), ex.engine, ex.database);
      assert.equal(checked.tables.length, ex.tables.length);
      const steps = diff({ engine: ex.engine, database: ex.database, tables: [], notes: [] }, checked);
      assert.ok(steps.every((x) => x.kind === 'create-table' || x.kind === 'add-foreign-key'), 'only making things');
      // its many-to-many is read back as one, so the canvas tucks the connecting table away
      assert.equal(relationships(checked).filter((r) => r.junction).length, 1);
    });

    it(`${kind}: its app settings name real tables and fields, and the page's tables are public`, () => {
      const s = exampleSnapshot(ex, ex.engine, ex.database);
      for (const [t, { patch, fields }] of Object.entries(ex.resources)) {
        const table = s.tables.find((x) => x.name === t);
        assert.ok(table, t);
        const has = (c: string) => table!.columns.some((x) => x.name === c);
        for (const k of ['titleField', 'sortField', 'publicOnly'] as const) if (patch[k]) assert.ok(has(patch[k]!), `${t}.${patch[k]}`);
        for (const f of Object.keys(fields ?? {})) assert.ok(has(f), `${t}.${f}`);
        // the comments tables are not read by the page (it reads the comment
        // area); every other table is
        const commentsTable = t === 'comments' || t.endsWith('comment_threads');
        assert.equal(patch.publicRead === true, !commentsTable, `${t} ${commentsTable ? 'is not' : 'is'} read by the public page`);
      }
      // what the gate is pushed: every public table, with its connections
      const rows = Object.entries(ex.resources).map(([t, { patch }]) => ({
        table_name: t, enabled: true, singular: patch.singular ?? '', plural: patch.plural ?? '', icon: '', description: '',
        title_field: patch.titleField ?? '', sort_field: patch.sortField ?? '', sort_dir: patch.sortDir ?? 'asc',
        can_create: true, can_view: true, can_edit: true, can_delete: true, can_duplicate: true, can_search: true, can_sort: true, can_filter: true,
        on_delete: 'follow' as const, public_read: true, public_only: patch.publicOnly ?? '',
      }));
      const catalog = buildCatalog(resourceViews(s, rows, []));
      const main = catalog.resources.find((r) => r.table === (kind === 'recipes' ? 'recipes' : 'posts'))!;
      assert.equal(main.refs!.length, 1, 'the cook / the author');
      assert.equal(main.many!.length, 1, 'the tags / the topics');
      assert.deepEqual(main.public, { only: kind === 'blog' ? 'published' : null });
    });

    it(`${kind}: its sample comments are on real posts, and most posts have none (docs/comments-plan.md)`, async () => {
      if (!ex.comments) return;
      const ids = new Map<string, unknown>();
      let next = 1;
      await seedExample(ex, 'pictures/', async () => next++, ids as Map<string, never>);
      const on = new Set(ex.comments.items.map((c) => c.post));
      for (const post of on) assert.ok(ids.has(`post:${post}`), `${post} is a post`);
      const posts = [...ids.keys()].filter((k) => k.startsWith('post:')).length;
      assert.ok(posts >= 12, `a blog with enough posts to show it (${posts})`);
      assert.ok(on.size <= posts / 2, 'most posts have no comments');
      assert.equal(ex.comments.area.contentType, 'posts');
      assert.ok(exampleSnapshot(ex, ex.engine, ex.database).tables.some((t) => t.name === 'post_comment_threads'));
    });

    it(`${kind}: its sample rows go in in an order that works, with no ids of their own`, async () => {
      const made: { table: string; values: Record<string, unknown> }[] = [];
      let next = 100;
      const n = await seedExample(ex, 'pictures/', async (table, values) => { made.push({ table, values }); return next++; });
      assert.equal(n, ex.rows.length);
      assert.ok(made.every((m) => !('id' in m.values)), 'the engine gives the ids (X4)');
      for (const p of ex.pictures) {
        assert.ok(existsSync(join(import.meta.dirname, '..', 'public-gate', 'examples', kind, 'pictures', p)), p);
      }
      if (kind === 'recipes') {
        assert.ok(made.some((m) => m.table === 'recipes' && m.values.picture === 'pictures/pancakes.jpg'));
      } else {
        assert.ok(made.some((m) => m.table === 'posts' && m.values.published === false), 'one unpublished post, to show the rule');
      }
    });
  }
});

// ------------------------------------------------------------------ the record picker (docs/record-picker-plan.md)

describe('the record picker', () => {
  it('replaces a record\'s pairs in two statements, letting only "already there" through', () => {
    const pg = buildSetLinks('postgres', 'recipe_tags', 'recipe_id', 7, 'tag_id', [1, 3]);
    assert.equal(pg.remove.text, 'DELETE FROM "recipe_tags" WHERE "recipe_id" = $1 AND "tag_id" NOT IN ($2, $3)');
    assert.deepEqual(pg.remove.params, [7, 1, 3]);
    assert.equal(pg.add!.text, 'INSERT INTO "recipe_tags" ("recipe_id", "tag_id") VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING');
    const maria = buildSetLinks('mariadb', 'recipe_tags', 'recipe_id', 7, 'tag_id', [1]);
    assert.match(maria.add!.text, /ON DUPLICATE KEY UPDATE `recipe_id` = `recipe_id`$/);
    assert.doesNotMatch(maria.add!.text, /IGNORE/, 'a bad id is still an error, never quietly dropped');
    // nothing chosen: every pair goes, nothing is added
    const none = buildSetLinks('postgres', 'recipe_tags', 'recipe_id', 7, 'tag_id', []);
    assert.equal(none.remove.text, 'DELETE FROM "recipe_tags" WHERE "recipe_id" = $1');
    assert.equal(none.add, null);
  });

  it('reads set-links as carefully as any other row op', () => {
    const ok = checkLinks({ table: 'recipe_tags', here: 'recipe_id', id: 7, there: 'tag_id', ids: [1, '1', 3, null, ''] });
    assert.deepEqual(ok.ids, [1, 3], 'each once, and nothing empty');
    assert.equal(code(() => checkLinks({ table: 'recipe_tags; drop', here: 'recipe_id', id: 7, there: 'tag_id', ids: [] })), 'invalid');
    assert.equal(code(() => checkLinks({ table: 'recipe_tags', here: 'recipe_id', id: null, there: 'tag_id', ids: [] })), 'invalid');
    assert.equal(code(() => checkLinks({ table: 'recipe_tags', here: 'recipe_id', id: 1, there: 'tag_id', ids: Array(1001).fill(1) })), 'invalid');
  });

  // the recipes, as the picker for an ingredient's recipe reads them
  const recipes = table('recipes', [
    column('id', { type: 'integer', required: true, identity: true }), column('title', { type: 'short_text', length: 120 }),
    column('method'), column('secret'), column('vegetarian', { type: 'boolean' }), column('minutes', { type: 'integer' }),
  ], { primaryKey: ['id'] });
  const view = () => resourceViews(snapshot([recipes]), [], [
    { table_name: 'recipes', field_name: 'secret', exposed: false, label: '', help: '', control: '', show_in_list: false, searchable: false, filterable: false, form_order: 3 },
  ])[0]!;

  it('filters only in a way that fits the field, and never on a hidden one', () => {
    const r = view();
    assert.deepEqual(pickFilterable(r).map((f) => f.name), ['title', 'vegetarian', 'minutes'], 'no long writing, no hidden field, no key');
    const q = pickQuery(r, {
      page: 1, search: 'lemon', sort: null, filters: [
        { kind: 'equals', column: 'vegetarian', value: true },
        { kind: 'range', column: 'minutes', from: 10, to: 30 },
        { kind: 'contains', column: 'title', text: 'cake' },
        { kind: 'equals', column: 'secret', value: 'x' },          // hidden
        { kind: 'contains', column: 'minutes', text: '3' },        // not how a number is filtered
        { kind: 'contains', column: 'method', text: 'bake' },      // long writing
      ],
    });
    assert.deepEqual(q.filters.map((f) => `${f.kind}:${f.column}`), ['equals:vegetarian', 'range:minutes', 'contains:title']);
    assert.deepEqual(q.search, { columns: ['title'], text: 'lemon' }, 'searches what is searchable, even with Search switched off for the list');
    assert.ok(!q.columns.includes('secret'));
    assert.deepEqual(q.order, { column: 'title', dir: 'asc' }, 'by name, so the list reads like one');
  });
});

// ------------------------------------------------------------------ rich text (docs/rich-text-plan.md)

describe('rich text in the app', () => {
  const id = () => column('id', { type: 'integer', required: true, identity: true });
  const posts = table('posts', [
    id(),
    column('title', { type: 'short_text', length: 120, required: true }),
    column('body', { type: 'text' }),
    column('notes', { type: 'text' }),
    column('author_id', { type: 'integer' }),
  ], {
    primaryKey: ['id'],
    foreignKeys: [{ name: 'fk', columns: ['author_id'], references: { table: 'authors', columns: ['id'] }, onDelete: 'restrict' }],
  });
  const authors = table('authors', [id(), column('name', { type: 'short_text', required: true })], { primaryKey: ['id'] });
  const s = snapshot([posts, authors]);
  const field = (name: string, over: Partial<FieldRow> = {}): FieldRow => ({
    table_name: 'posts', field_name: name, exposed: true, label: '', help: '', control: '',
    show_in_list: true, searchable: false, filterable: false, form_order: 0, ...over,
  });
  const richBody = field('body', { control: 'rich' });
  const view = (fs: FieldRow[] = [richBody], snap: Snapshot = s) => resourceViews(snap, [], fs).find((r) => r.table === 'posts')!;
  const problem = (fn: () => unknown): string => {
    try { fn(); } catch (e) { if (e instanceof AccountError) return e.message; throw e; }
    return 'no error';
  };

  it('is a choice the page and the panel both know, by the same name', () => {
    assert.deepEqual([...web.CONTROLS], [...CONTROLS]);
    assert.equal(CONTROL_NAMES.rich, 'Rich text');
    assert.equal(web.CONTROL_NAMES.rich, 'Rich text');
    assert.deepEqual(checkFieldPatch({ control: 'rich' }), { control: 'rich' });
  });

  it('is never worked out: a long text field is "A few lines" until she says (T2)', () => {
    assert.equal(view([]).fields.find((f) => f.name === 'body')!.control, 'paragraph');
    assert.equal(view().fields.find((f) => f.name === 'body')!.control, 'rich');
  });

  it('only fits long text: not short text, the key or a connection (T1, T14)', () => {
    const v = view([]);
    const f = (n: string) => v.fields.find((x) => x.name === n)!;
    assert.equal(canBeRich(f('body')), true);
    assert.equal(canBeRich(f('title')), false);
    assert.equal(canBeRich(f('id')), false);
    assert.equal(canBeRich(f('author_id')), false);
    for (const n of ['title', 'id', 'author_id']) {
      assert.match(problem(() => refuseIfBlind(v, n, { control: 'rich' })), /Only long text can hold formatting/, n);
      assert.equal(web.canBeRich(f(n)), false, `the page does not offer it on ${n} either`);
    }
    assert.equal(problem(() => refuseIfBlind(v, 'body', { control: 'rich' })), 'no error');
    assert.equal(web.canBeRich(f('body')), true);
  });

  it('is not kept on a field that stopped being long text (the Studio changed its type)', () => {
    const changed = snapshot([
      table('posts', [id(), column('body', { type: 'short_text', length: 200 })], { primaryKey: ['id'] }),
    ]);
    assert.equal(view([richBody], changed).fields.find((f) => f.name === 'body')!.control, 'line');
  });

  it('cleans what a form sends, whatever it is (T6)', () => {
    const v = view();
    assert.deepEqual(valuesFor(v, { values: { body: '<p>Hello <b>there</b></p><script>alert(1)</script><img src=x onerror=alert(1)>' } }, 'edit'),
      { body: '<p>Hello <strong>there</strong></p>' });
    assert.deepEqual(valuesFor(v, { values: { body: '<p><a href="javascript:alert(1)">click</a></p>' } }, 'edit'), { body: '<p>click</p>' });
    // writing with no tags in it becomes paragraphs; an empty editor is nothing (T10, T11)
    assert.deepEqual(valuesFor(v, { values: { body: 'One\n\nTwo <3' } }, 'edit'), { body: '<p>One</p><p>Two &lt;3</p>' });
    assert.deepEqual(valuesFor(v, { values: { body: '<p></p>' } }, 'create'), { body: null });
    // only the field she marked: the other long text is kept exactly as sent
    assert.deepEqual(valuesFor(v, { values: { notes: '<b>as typed</b>' } }, 'edit'), { notes: '<b>as typed</b>' });
    assert.match(problem(() => valuesFor(v, { values: { body: 42 } }, 'edit')), /could not read what you put in Body/);
    assert.match(problem(() => valuesFor(v, { values: { body: `<table><tr>${'<td>x</td>'.repeat(31)}</tr></table>` } }, 'edit')),
      /^Body: A table can have at most 30 columns/);
    assert.match(problem(() => valuesFor(v, { values: { body: 'x'.repeat(500_001) } }, 'edit')), /too long to store/);
  });

  it('gives the editor clean HTML, and a list the words alone (T7, T15)', () => {
    const v = view();
    assert.deepEqual(richForEditing(v, { id: 1, body: 'Plain\n\nwriting', notes: '<b>x</b>' }),
      { id: 1, body: '<p>Plain</p><p>writing</p>', notes: '<b>x</b>' });
    assert.deepEqual(richForEditing(v, { id: 1, body: '<p>ok</p><script>x</script>' }), { id: 1, body: '<p>ok</p>' });
    assert.deepEqual(richAsWords(v, [{ id: 1, body: '<h2>Title</h2><p>one &amp; two</p>', notes: '<b>x</b>' }]),
      [{ id: 1, body: 'Title one & two', notes: '<b>x</b>' }]);
    const cut = richAsWords(v, [{ id: 1, body: `<p>${'word '.repeat(100)}</p>` }])[0]!.body as string;
    assert.ok(cut.length <= 201 && cut.endsWith('…'), cut);
  });

  it('tells the gate which fields are rich text, and only ones it shows (T13)', () => {
    const on: ResourceRow = {
      table_name: 'posts', enabled: true, singular: '', plural: '', icon: '', description: '',
      title_field: '', sort_field: '', sort_dir: 'asc',
      can_create: true, can_view: true, can_edit: true, can_delete: true,
      can_duplicate: true, can_search: true, can_sort: true, can_filter: false, on_delete: 'follow',
    };
    const cat = (fs: FieldRow[]) => buildCatalog(resourceViews(s, [on], fs)).resources.find((r) => r.table === 'posts')!;
    assert.deepEqual(cat([richBody]).rich, ['body']);
    assert.deepEqual(cat([]).rich, []);
    assert.deepEqual(cat([field('body', { control: 'rich', exposed: false })]).rich, []);
  });

  it('the blog example writes its posts in rich text the cleaner keeps exactly, one with a table (Q6)', async () => {
    const ex = DB_EXAMPLES.blog;
    assert.equal(ex.resources.posts!.fields!.body!.control, 'rich');
    const bodies: string[] = [];
    await seedExample(ex, 'pictures/', async (t, values) => { if (t === 'posts') bodies.push(values.body as string); return bodies.length; });
    assert.ok(bodies.length > 0);
    for (const b of bodies) assert.equal(cleanRich(b), b, 'stored as the cleaner would have stored it');
    assert.ok(bodies.some((b) => b.includes('<table>')), 'one post shows a table');
  });
});

// ------------------------------------------------------------------ the order of the form (docs/field-order-plan.md)

describe('the order of the form', () => {
  const id = () => column('id', { type: 'integer', required: true, identity: true });
  const posts = table('posts', [
    id(), column('author_id', { type: 'integer' }), column('title', { type: 'short_text', length: 80 }), column('body', { type: 'text' }),
  ], {
    primaryKey: ['id'],
    foreignKeys: [{ name: 'fk', columns: ['author_id'], references: { table: 'authors', columns: ['id'] }, onDelete: 'restrict' }],
  });
  const authors = table('authors', [id(), column('name', { type: 'short_text', length: 80 })], { primaryKey: ['id'] });
  let s = snapshot([posts, authors, table('topics', [id(), column('name', { type: 'short_text', length: 40 })], { primaryKey: ['id'] })]);
  s = addRelationship(s, { from: { table: 'posts', column: 'id' }, to: { table: 'topics' }, kind: 'many-to-many', onDelete: 'cascade' });
  const row = (order: string[] | string): ResourceRow => ({
    table_name: 'posts', enabled: true, singular: '', plural: '', icon: '', description: '', title_field: '', sort_field: '', sort_dir: 'asc',
    can_create: true, can_view: true, can_edit: true, can_delete: true, can_duplicate: true, can_search: true, can_sort: true, can_filter: false,
    on_delete: 'follow', field_order: typeof order === 'string' ? order : JSON.stringify(order),
  });
  const touched = (name: string, formOrder = 0): FieldRow => ({
    table_name: 'posts', field_name: name, exposed: true, label: 'Changed', help: '', control: '',
    show_in_list: true, searchable: false, filterable: false, form_order: formOrder,
  });
  const view = (rs: ResourceRow[] = [], fs: FieldRow[] = []) => resourceViews(s, rs, fs).find((r) => r.table === 'posts')!;
  const names = (v: ReturnType<typeof view>) => v.fields.map((f) => f.name);

  it('keeps the table\'s own order until she chooses one -- whatever a stored form_order says (the bug)', () => {
    assert.deepEqual(names(view()), ['id', 'author_id', 'title', 'body']);
    // before: renaming Body stored form_order 0 and put it at the top
    assert.deepEqual(names(view([], [touched('body')])), ['id', 'author_id', 'title', 'body']);
    assert.deepEqual(view().fieldOrder, ['id', 'author_id', 'title', 'body', 'many:topics'], 'a many-to-many after the fields');
    assert.equal(view().ordered, false);
  });

  it('follows her order, with what it does not name after it in column order (O4, O6)', () => {
    const v = view([row(['title', 'many:topics', 'body'])]);
    assert.deepEqual(v.fieldOrder, ['title', 'many:topics', 'body', 'id', 'author_id']);
    assert.deepEqual(names(v), ['title', 'body', 'id', 'author_id']);
    assert.equal(v.ordered, true);
    // a name that is no longer there, or unreadable JSON, is simply not an order
    assert.deepEqual(view([row(['gone', 'body'])]).fieldOrder.slice(0, 2), ['body', 'id']);
    assert.deepEqual(view([row('not json')]).fieldOrder, ['id', 'author_id', 'title', 'body', 'many:topics']);
  });

  it('the catalog follows it too (O7)', () => {
    const c = buildCatalog(resourceViews(s, [row(['title', 'body'])], [])).resources.find((r) => r.table === 'posts')!;
    assert.deepEqual(c.columns.slice(0, 2), ['title', 'body']);
  });

  it('checks what the page sends: its own fields and many-to-manys, none twice (O8)', () => {
    const v = view();
    const problem = (b: unknown) => { try { checkOrder(v, b); return 'no error'; } catch (e) { return (e as Error).message; } };
    assert.deepEqual(checkOrder(v, { order: ['body', 'many:topics'] }), ['body', 'many:topics']);
    assert.deepEqual(checkOrder(v, { order: [] }), []);
    assert.match(problem({ order: ['body', 'body'] }), /twice/);
    assert.match(problem({ order: ['name'] }), /not one of the fields/, 'a field of another table');
    assert.match(problem({ order: ['many:authors'] }), /not one of the fields/);
    assert.match(problem({ order: 'body' }), /could not read/);
  });

  it('the database examples name only real fields, and start with the title (O9)', () => {
    for (const kind of DB_EXAMPLE_KINDS) {
      const ex = DB_EXAMPLES[kind];
      const snap = checkSnapshot(JSON.parse(JSON.stringify(exampleSnapshot(ex, ex.engine, ex.database))), ex.engine, ex.database);
      for (const [t, { order }] of Object.entries(ex.resources)) {
        if (!order) continue;
        const v = resourceViews(snap, [{ ...row(order), table_name: t }], []).find((r) => r.table === t)!;
        assert.deepEqual(v.fieldOrder.slice(0, order.length), order, `${kind}.${t}`);
        assert.equal(order[0], 'title');
      }
    }
  });
});

// ------------------------------------------------------------------ comments tables (docs/comments-plan.md C8-C11)

describe('the comments tables', () => {
  const posts = starterTable('posts');
  const base: Snapshot = { engine: 'postgres', database: 'blog', tables: [posts], notes: [] };

  it('draws the two shared tables once, as a drawing the Database Manager could have made (C8, A3)', () => {
    const s = withCommentTables(base);
    assert.deepEqual(s.tables.map((t) => t.name), ['posts', 'comment_threads', 'comments']);
    assert.deepEqual(withCommentTables(s).tables.length, 3, 'drawing it again adds nothing');
    const checked = checkSnapshot(JSON.parse(JSON.stringify(s)), 'postgres', 'blog');
    const steps = diff({ ...base }, checked);
    assert.ok(steps.every((x) => x.kind === 'create-table' || x.kind === 'add-foreign-key'), 'only making things');
    const threads = s.tables.find((t) => t.name === 'comment_threads')!;
    assert.deepEqual(threads.uniques, [{ name: 'comment_threads_thing_key', columns: ['area', 'content_type', 'content_id'] }], 'one conversation per thing');
    const comments = s.tables.find((t) => t.name === 'comments')!;
    assert.deepEqual(comments.uniques[0]!.columns, ['response_id'], 'a comment is only ever one row');
    assert.equal(comments.foreignKeys[0]!.onDelete, 'cascade');
    for (const engine of ['postgres', 'mariadb'] as const) {
      assert.ok(patchSql(engine, steps).length > 0, `${engine} can print it`);
    }
  });

  it("links a table whose records can be commented on, one conversation each, of the key's own kind (C10, C11)", () => {
    const s = withCommentLink(base, 'posts');
    const link = s.tables.find((t) => t.name === 'post_comment_threads')!;
    assert.ok(link, 'named after one of them');
    assert.deepEqual(link.columns.map((c) => c.name).slice(0, 3), ['id', 'post_id', 'thread_id']);
    assert.equal(link.columns.find((c) => c.name === 'post_id')!.type, 'integer');
    assert.deepEqual(link.uniques[0]!.columns, ['post_id']);
    assert.deepEqual(link.foreignKeys.map((f) => [f.references.table, f.onDelete]), [['posts', 'cascade'], ['comment_threads', 'cascade']]);
    assert.ok(!isJunction(link), 'not a many-to-many: a comment belongs to one thing');
    assert.ok(s.tables.some((t) => t.name === 'comments'), 'and the shared tables come with it');
    checkSnapshot(JSON.parse(JSON.stringify(s)), 'mariadb', 'blog');
    assert.throws(() => withCommentLink(base, 'nope'), /no table called nope/);
    const composite = { ...base, tables: [{ ...starterTable('pairs'), primaryKey: ['id', 'created_at'] }] };
    assert.throws(() => withCommentLink(composite, 'pairs'), /more than one field/);
  });
});
