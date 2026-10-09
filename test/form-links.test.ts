// Forms into a database (docs/form-to-database-plan.md): the rules on their
// own -- what fits where, whether a link is complete, and the row a response
// makes. The gate's writer and the panel's routes are in gate.test.ts and
// panel.test.ts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StoredAnswer } from '@panel/forms/shared/form-types';
import {
  buildValues, checkLinkShape, fits, FormLinkError, linkProblems, suggestPairs, type Question, type TargetField,
} from '@panel/form-links/studio/form-links';

const f = (type: TargetField['type'], over: Partial<TargetField> = {}): TargetField => ({ type, required: false, defaulted: false, ...over });

const FIELDS: Record<string, TargetField> = {
  title: f('short_text', { length: 20, required: true }),
  method: f('text', { rich: true }),
  servings: f('integer'),
  price: f('decimal'),
  vegetarian: f('boolean', { required: true, defaulted: true }),
  shared: f('boolean', { required: true }),
  made_on: f('date'),
  at: f('time'),
  sent_at: f('timestamptz'),
  cook_first: f('short_text', { length: 40 }),
  notes: f('text'),
};

const QUESTIONS: Question[] = [
  { key: 'recipe-name', label: 'Recipe name', type: 'short-text', required: true },
  { key: 'method', label: 'Method', type: 'long-text', required: false },
  { key: 'how-many', label: 'How many people', type: 'number', required: false },
  { key: 'vegetarian', label: 'Vegetarian', type: 'checkbox', required: false },
  { key: 'your-name', label: 'Your name', type: 'name', required: false, parts: ['first', 'last'] },
  { key: 'tags', label: 'Tags', type: 'multiple-choice', required: false },
  { key: 'email', label: 'Email', type: 'email', required: true },
];

const answers: StoredAnswer[] = [
  { key: 'recipe-name', label: 'Recipe name', type: 'short-text', value: 'Lemon loaf' },
  { key: 'method', label: 'Method', type: 'long-text', value: 'Mix.\n\nBake <b>well</b>.' },
  { key: 'how-many', label: 'How many people', type: 'number', value: 6 },
  { key: 'vegetarian', label: 'Vegetarian', type: 'checkbox', value: true },
  { key: 'your-name', label: 'Your name', type: 'name', value: { first: 'Olivia', last: 'Rose' } },
  { key: 'tags', label: 'Tags', type: 'multiple-choice', value: ['baking', 'summer'] },
  { key: 'email', label: 'Email', type: 'email', value: 'o@example.org' },
];
const meta = { sentAt: 1_790_000_000, page: 'recipes/share.html', sender: null };

describe('what fits where (F5)', () => {
  it('each kind of answer into the kinds of field it can go into, and no others', () => {
    assert.equal(fits('short-text', undefined, f('short_text')), true);
    assert.equal(fits('long-text', undefined, f('text', { rich: true })), true);
    assert.equal(fits('short-text', undefined, f('integer')), false);
    assert.equal(fits('number', undefined, f('decimal')), true);
    assert.equal(fits('number', undefined, f('text')), false);
    assert.equal(fits('rating', undefined, f('integer')), true);
    assert.equal(fits('date', undefined, f('date')), true);
    assert.equal(fits('date', undefined, f('timestamptz')), false);
    assert.equal(fits('time', undefined, f('time')), true);
    assert.equal(fits('checkbox', undefined, f('boolean')), true);
    assert.equal(fits('checkbox', undefined, f('text')), false);
    assert.equal(fits('multiple-choice', undefined, f('text')), true);
    assert.equal(fits('name', 'first', f('short_text')), true);
    assert.equal(fits('name', 'line1', f('short_text')), false, 'a street is not part of a name');
    assert.equal(fits('address', 'postcode', f('short_text')), true);
    assert.equal(fits('name', undefined, f('text')), true, 'the whole name as one line');
    assert.equal(fits('email', 'first', f('text')), false, 'only names and addresses have parts');
  });
});

describe('a link that is not complete is refused (F7)', () => {
  it('names what is missing, in her words', () => {
    const p = linkProblems({ pairs: [], fixed: [] }, QUESTIONS, FIELDS);
    assert.ok(p.some((x) => /^title has to be filled in: pair it/.test(x)));
    assert.ok(p.some((x) => /^shared has to be filled in/.test(x)));
    assert.ok(!p.some((x) => x.startsWith('vegetarian')), 'it has a default');
  });

  it('a required field needs a required question, or a fixed value', () => {
    const optional = linkProblems({ pairs: [{ key: 'method', field: 'title' }], fixed: [{ field: 'shared', value: false }] },
      QUESTIONS, { ...FIELDS, title: f('short_text', { required: true }) });
    assert.ok(optional.some((x) => /title has to be filled in, but its question may be left empty/.test(x)));
    const ok = linkProblems({ pairs: [{ key: 'recipe-name', field: 'title' }], fixed: [{ field: 'shared', value: false }] }, QUESTIONS, FIELDS);
    assert.deepEqual(ok, []);
    // a tick box always has an answer, yes or no
    assert.deepEqual(linkProblems({ pairs: [{ key: 'recipe-name', field: 'title' }, { key: 'vegetarian', field: 'shared' }], fixed: [] }, QUESTIONS, FIELDS), []);
  });

  it('refuses what does not fit, two answers in one field, and names that are gone', () => {
    const p = linkProblems({
      pairs: [{ key: 'recipe-name', field: 'servings' }, { key: 'email', field: 'notes' }, { key: 'method', field: 'notes' }, { key: 'gone', field: 'title' }, { key: 'recipe-name', field: 'nope' }],
      fixed: [{ field: 'shared', value: 'yes' }],
    }, QUESTIONS, FIELDS);
    assert.ok(p.some((x) => /Recipe name can't go into servings/.test(x)));
    assert.ok(p.some((x) => /Two answers go into notes/.test(x)));
    assert.ok(p.some((x) => /no longer has \(gone\)/.test(x)));
    assert.ok(p.some((x) => /nope, which is not one of this table's fields/.test(x)));
    assert.ok(p.some((x) => /fixed value doesn't fit shared/.test(x)));
  });
});

describe('the row a response makes (F5, F6)', () => {
  const link = {
    pairs: [
      { key: 'recipe-name', field: 'title' }, { key: 'method', field: 'method' }, { key: 'how-many', field: 'servings' },
      { key: 'vegetarian', field: 'vegetarian' }, { key: 'your-name', part: 'first', field: 'cook_first' }, { key: 'tags', field: 'notes' },
    ],
    fixed: [{ field: 'shared', value: false }, { field: 'sent_at', from: 'sent-at' as const }, { field: 'made_on', from: 'sent-at' as const }],
  };

  it('turns each answer into its field', () => {
    assert.deepEqual(buildValues(link, answers, meta, FIELDS), {
      title: 'Lemon loaf',
      method: '<p>Mix.</p><p>Bake &lt;b&gt;well&lt;/b&gt;.</p>',     // rich text: paragraphs, words as words
      servings: 6,
      vegetarian: true,
      cook_first: 'Olivia',
      notes: 'baking, summer',
      shared: false,
      sent_at: new Date(1_790_000_000_000).toISOString(),
      made_on: new Date(1_790_000_000_000).toISOString().slice(0, 10),
    });
  });

  it('says in words what cannot be written, rather than writing something else', () => {
    const long = [{ ...answers[0]!, value: 'A very long recipe name indeed' }];
    assert.throws(() => buildValues({ pairs: [{ key: 'recipe-name', field: 'title' }], fixed: [] }, long, meta, FIELDS),
      (e: unknown) => e instanceof FormLinkError && /longer than title can hold \(20 letters\)/.test(e.message));
    assert.throws(() => buildValues({ pairs: [{ key: 'how-many', field: 'servings' }], fixed: [] }, [{ ...answers[2]!, value: 2.5 }], meta, FIELDS),
      /not a whole number/);
    assert.throws(() => buildValues({ pairs: [{ key: 'recipe-name', field: 'title' }], fixed: [] }, [], meta, FIELDS),
      /title has to be filled in/);
    assert.throws(() => buildValues({ pairs: [{ key: 'recipe-name', field: 'gone' }], fixed: [] }, answers, meta, FIELDS),
      /gone is not one of the table's fields any more/);
  });

  it('a whole name is one line with spaces, a whole address with commas', () => {
    assert.deepEqual(buildValues({ pairs: [{ key: 'your-name', field: 'notes' }], fixed: [] }, answers, meta, FIELDS), { notes: 'Olivia Rose' });
    const addr: StoredAnswer = { key: 'where', label: 'Where', type: 'address', value: { line1: '1 High St', town: 'Leeds' } };
    assert.deepEqual(buildValues({ pairs: [{ key: 'where', field: 'notes' }], fixed: [] }, [addr], meta, FIELDS), { notes: '1 High St, Leeds' });
  });

  it('leaves an empty answer out when the field has a default of its own', () => {
    assert.deepEqual(buildValues({ pairs: [{ key: 'vegetarian', field: 'vegetarian' }], fixed: [] }, [], meta, FIELDS), {});
  });
});

describe('reading a link, and the first guess', () => {
  it('refuses a shape it cannot trust', () => {
    assert.throws(() => checkLinkShape({ table: 'Bad Name', when: 'approved', pairs: [], fixed: [] }), /which table/);
    assert.throws(() => checkLinkShape({ table: 'recipes', when: 'sometimes', pairs: [], fixed: [] }), /when to save/);
    assert.throws(() => checkLinkShape({ table: 'recipes', when: 'approved', pairs: [{ key: 'x', field: 'a; DROP' }], fixed: [] }), /a pair/);
    assert.throws(() => checkLinkShape({ table: 'recipes', when: 'approved', pairs: [], fixed: [{ field: 'a', value: { x: 1 } }] }), /a fixed value/);
    assert.deepEqual(checkLinkShape({ table: 'recipes', when: 'arrived', pairs: [{ key: 'your-name', part: 'first', field: 'cook' }], fixed: [{ field: 'at', from: 'sent-at' }] }),
      { table: 'recipes', when: 'arrived', pairs: [{ key: 'your-name', part: 'first', field: 'cook' }], fixed: [{ field: 'at', from: 'sent-at' }], enabled: true });
  });

  it('suggests a field with the question\'s name, when it fits', () => {
    assert.deepEqual(suggestPairs(QUESTIONS, FIELDS), [
      { key: 'method', field: 'method' }, { key: 'vegetarian', field: 'vegetarian' },
    ]);
    assert.deepEqual(suggestPairs([{ key: 'title', label: 'Title', type: 'number', required: true }], FIELDS), [], 'a name alone is not enough');
  });
});
