// Getting started (docs/getting-started-plan.md G6), without a server: every
// answer leads to a recommendation, every button and guide link goes somewhere
// real, and each check reads the site the way the plan says.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { DbFact, Facts, FormFact } from '@panel/getting-started/getting-started/facts';
import { bind, PATHS, type Ctx, type Links } from '@panel/getting-started/getting-started/paths';
import { cleanAnswers, GOAL, nextQuestion, recommend, type Answers } from '@panel/getting-started/getting-started/questions';
import { pathView, recommendation } from '@panel/getting-started/getting-started/view';
import type { StartedPath } from '@panel/getting-started/getting-started/store';
import { parseGuide } from '@panel/help/help';
import { PAGE_PATHS } from '@panel/files/panel/pages-list';

// ------------------------------------------------------------------ the site, made up
const db = (o: Partial<DbFact> = {}): DbFact => ({
  id: 1, engine: 'postgres', name: 'our_blog', title: 'Our blog', active: true, adoptedAt: 100,
  example: null, copiedFrom: 'blog', page: 'kitchen/blog.html', copiedRows: true, ...o,
});
const form = (o: Partial<FormFact> = {}): FormFact => ({
  id: 7, name: 'pinboard', title: 'Pinboard', kind: 'form', contentType: null, fixture: null, enabled: true,
  publicApproved: false, autoApprove: false, createdAt: 100, responses: 0, approved: 0, pages: [], keys: ['your-name', 'note', 'colour'], ...o,
});
const facts = (o: Partial<Facts> = {}): Facts => ({
  deep: true, databases: [], tables: [], forms: [], areas: [], media: {},
  formLinks: async () => [], pageThere: async () => true, count: async () => 0, ...o,
});
const started = (path: StartedPath['path'], answers: Answers, o: Partial<StartedPath> = {}): StartedPath => ({
  id: 1, path, answers, links: {}, startedBy: 'pamela', startedAt: 50, finishedAt: null, putAwayAt: null, steps: {}, ...o,
});
const states = async (p: StartedPath, f: Facts) => Object.fromEntries((await pathView(p, f, 'pammy.org')).view.steps.map((s) => [s.key, s.state]));

// ------------------------------------------------------------------ every answer
// Every combination of answers the questions allow, in the order they are asked.
function everyAnswer(): Answers[] {
  const out: Answers[] = [];
  const walk = (a: Answers) => {
    const q = nextQuestion(a);
    if (!q) { out.push(a); return; }
    for (const o of q.options) walk({ ...a, [q.key]: o.value });
  };
  walk({});
  return out;
}

const setup = join(import.meta.dirname, '..', '..');
const guides = readFileSync(join(setup, 'guides.map'), 'utf8').split('\n').map((l) => l.trim().split(/\s+/))
  .filter(([src, dst]) => src && dst && !src.startsWith('#'))
  .map(([src, dst]) => parseGuide(dst!, readFileSync(join(setup, src!), 'utf8')));
const slugOf = (file: string) => file.replace(/^\d+-|\.txt$/g, '');
const pageRe = (p: string) => new RegExp(`^${p.replace(/:[a-z]+/g, '[^/]+')}$`);

function realHref(href: string) {
  if (href.startsWith('https://pammy.org/')) return;
  const [path] = href.split(/[?#]/);
  const help = path!.match(/^\/help\/([a-z0-9-]+)(?:\/part-(\d+))?$/);
  if (help) {
    const g = guides.find((x) => slugOf(x.file) === help[1]);
    assert.ok(g, `${href}: no guide ${help[1]}`);
    if (help[2]) assert.ok(g.sections.some((s) => s.part === Number(help[2])), `${href}: guide ${help[1]} has no PART ${help[2]}`);
    return;
  }
  assert.ok(PAGE_PATHS.some((p) => pageRe(p).test(path!)), `${href} is not one of the panel's pages`);
}

describe('the questions', () => {
  const all = everyAnswer();

  it('start with "What would you like to do?", her own projects first (D6)', () => {
    assert.equal(nextQuestion({}), GOAL);
    assert.deepEqual(GOAL.options.slice(0, 3).map((o) => o.value), ['blog', 'pinboard', 'recipes']);
  });

  it('every answer ends in a recommendation with steps, and guide 19 (D5)', () => {
    assert.ok(all.length > 20, `${all.length} ways through`);
    for (const a of all) {
      const r = recommendation(a);
      assert.ok(r.steps.length >= 2, JSON.stringify(a));
      assert.ok(r.why.length > 20);
      assert.match(r.guide19.href, /^\/help\/forms-or-a-database\/part-\d$/);
      realHref(r.guide19.href);
    }
  });

  it('every path can be reached', () => {
    const reached = new Set(all.map((a) => recommend(a).path));
    assert.deepEqual([...reached].sort(), Object.keys(PATHS).sort());
  });

  it('"not sure" asks guide 19\'s question, and one more only where it matters', () => {
    assert.equal(nextQuestion({ goal: 'not-sure' })?.key, 'writes');
    assert.equal(nextQuestion({ goal: 'not-sure', writes: 'visitors' })?.key, 'later');
    assert.equal(nextQuestion({ goal: 'not-sure', writes: 'me' }), null);
    assert.equal(recommend({ goal: 'not-sure', writes: 'visitors', later: 'no' }).path, 'form');
    assert.equal(recommend({ goal: 'not-sure', writes: 'visitors', later: 'yes' }).path, 'database-form');
    assert.equal(recommend({ goal: 'not-sure', writes: 'me' }).path, 'database');
  });

  it('follow-ups change the steps', () => {
    const keys = (a: Answers) => PATHS[recommend(a).path].steps(a).map((s) => s.key);
    assert.ok(keys({ goal: 'blog', comments: 'yes' }).includes('comments'));
    assert.ok(!keys({ goal: 'blog', comments: 'no' }).includes('comments'));
    assert.ok(keys({ goal: 'pinboard', who: 'people', when: 'now' }).includes('protect'));
    assert.ok(keys({ goal: 'pinboard', who: 'people', when: 'now' }).includes('show-now'));
    assert.ok(!keys({ goal: 'pinboard', who: 'anyone', when: 'after' }).includes('protect'));
    assert.deepEqual(keys({ goal: 'recipes', friends: 'yes' }).slice(-3), ['share-form', 'connect', 'on-page']);
  });

  it('only the answers the questions asked are kept, and a wrong one is asked again', () => {
    assert.deepEqual(cleanAnswers({ goal: 'blog', comments: 'yes', who: 'people', evil: 'x' }), { goal: 'blog', comments: 'yes' });
    assert.deepEqual(cleanAnswers({ goal: 'nope' }), {});
    assert.equal(nextQuestion({ goal: 'blog', comments: 'perhaps' })?.key, 'comments');
  });

  it('every button and guide link, on every path, goes to a real page or guide part', async () => {
    const f = facts({ databases: [db()], forms: [form()] });
    for (const a of all) {
      const def = PATHS[recommend(a).path];
      const c: Ctx = { f, a, since: 0, site: 'pammy.org', db: db(), form: form(), area: { id: 1, path: 'club', createdAt: 1, visitors: 0 } };
      for (const s of def.steps(a)) {
        const to = s.to?.(c);
        if (to) realHref(to.href);
        if (s.guide) realHref(s.guide.href);
        // a step the site can't see must still say where to go
        if (!s.check) assert.ok(to || s.guide, `${def.key}/${s.key}`);
      }
    }
  });
});

// ------------------------------------------------------------------ the checks
describe('progress is read from the site (G1)', () => {
  it('the blog: its copy, a post of her own, comments, and its page', async () => {
    const p = started('blog', { goal: 'blog', comments: 'yes' });
    assert.deepEqual(await states(p, facts()), { copy: 'todo', first: 'todo', comments: 'todo', page: 'todo', 'make-it-yours': 'todo' });

    // the example's sample posts don't count; one more does
    const samples = (await import('@panel/examples/studio/db-examples')).DB_EXAMPLES.blog.rows.filter((r) => r.table === 'posts').length;
    let n = samples;
    const f = facts({
      databases: [db()],
      forms: [form({ id: 9, name: 'our-blog-comments', kind: 'comments', contentType: 'posts', keys: [] })],
      formLinks: async () => [{ formId: 9, table: 'comments', enabled: true, when: 'approved', mode: 'comments' }],
      count: async () => n,
    });
    assert.deepEqual(await states(p, f), { copy: 'done', first: 'todo', comments: 'done', page: 'done', 'make-it-yours': 'todo' });
    n = samples + 1;
    assert.equal((await states(p, f)).first, 'done');
    // without the samples, the first post is the first record
    n = 1;
    assert.equal((await states(p, { ...f, databases: [db({ copiedRows: false })] })).first, 'done');
  });

  it('what needs her database says "can\'t tell" on Home, and when she doesn\'t answer', async () => {
    const p = started('blog', { goal: 'blog', comments: 'no' });
    assert.equal((await states(p, facts({ deep: false, databases: [db()], count: async () => null }))).first, 'unknown');
    const v = (await pathView(p, facts({ databases: [db()], count: async () => null }), 'pammy.org')).view;
    assert.match(v.steps.find((s) => s.key === 'first')!.note!, /didn't answer/);
  });

  it('a step comes undone when the thing is gone', async () => {
    const p = started('blog', { goal: 'blog', comments: 'no' });
    assert.equal((await states(p, facts({ databases: [db()], pageThere: async () => false }))).page, 'todo');
    assert.equal((await states(p, facts({ databases: [db({ active: false })] }))).copy, 'todo');
  });

  it('the pinboard: its form, on a page, public, protected, shown at once, the first note', async () => {
    const p = started('pinboard', { goal: 'pinboard', who: 'people', when: 'now' });
    const f = facts({
      forms: [form({ pages: ['club/pinboard.html'], publicApproved: true, autoApprove: true, approved: 1 })],
      areas: [{ id: 3, path: 'club', createdAt: 60, visitors: 2 }],
    });
    assert.deepEqual(await states(p, f), { form: 'done', 'on-page': 'done', public: 'done', protect: 'done', 'show-now': 'done', first: 'done' });
    // an example's own form is not hers
    assert.equal((await states(p, facts({ forms: [form({ fixture: 'pinboard' })] }))).form, 'todo');
    // a folder that isn't the page's doesn't count
    assert.equal((await states(p, { ...f, areas: [{ id: 3, path: 'clubs', createdAt: 60, visitors: 2 }] })).protect, 'todo');
  });

  it('recipes from friends: the form must save into the recipes table', async () => {
    const p = started('recipes', { goal: 'recipes', friends: 'yes' });
    const share = form({ id: 11, name: 'share-a-recipe', title: 'Share a recipe', keys: ['title', 'method'], pages: ['recipes.html'] });
    const f = facts({ databases: [db({ copiedFrom: 'recipes', name: 'my_recipes' })], forms: [share] });
    assert.equal((await states(p, f)).connect, 'todo');
    const linked = { ...f, formLinks: async () => [{ formId: 11, table: 'recipes', enabled: true, when: 'approved', mode: 'row' }] };
    assert.deepEqual((await states(p, linked)), { copy: 'done', first: 'todo', page: 'done', 'share-form': 'done', connect: 'done', 'on-page': 'done' });
  });

  it('skipped and ticked by hand; a tick by hand never overrides a check', async () => {
    const p = started('private', { goal: 'private' }, { steps: {
      person: { state: 'skipped', by: 'pamela', at: 1 },
      try: { state: 'done-by-hand', by: 'pamela', at: 1 },
      protect: { state: 'done-by-hand', by: 'pamela', at: 1 },
    } });
    const v = (await pathView(p, facts(), 'pammy.org')).view;
    assert.deepEqual(v.steps.map((s) => [s.key, s.state, s.canTick]), [['protect', 'todo', false], ['person', 'skipped', false], ['try', 'done-by-hand', true]]);
    assert.equal(v.next, 'protect');
    assert.equal(v.finished, false);
  });

  it('a check that throws says "can\'t tell", and nothing else breaks', async () => {
    const p = started('blog', { goal: 'blog', comments: 'yes' });
    const v = (await pathView(p, facts({ databases: [db()], formLinks: async () => { throw new Error('gate down'); } }), 'pammy.org')).view;
    assert.equal(v.steps.find((s) => s.key === 'comments')!.state, 'unknown');
    assert.equal(v.steps.find((s) => s.key === 'copy')!.state, 'done');
  });
});

describe('holding on to what it found', () => {
  const def = PATHS.contact;
  const a = { goal: 'contact' };
  const since = 100;

  it('takes the newest made since she started, and keeps it when a newer one comes', () => {
    const old = form({ id: 1, name: 'old', createdAt: 50 });
    const mine = form({ id: 2, name: 'mine', createdAt: 150 });
    const f = facts({ forms: [old, mine] });
    const first = bind(def, f, {}, since, a);
    assert.equal(first.form?.id, 2);
    const later = bind(def, facts({ forms: [old, mine, form({ id: 3, name: 'newer', createdAt: 200 })] }), first.links, since, a);
    assert.equal(later.form?.id, 2);
  });

  it('"That\'s not the one" moves on to the next, and a deleted one is let go', () => {
    const f = facts({ forms: [form({ id: 2, createdAt: 150 }), form({ id: 3, createdAt: 200 })] });
    const links: Links = { not: { form: [3] } };
    assert.equal(bind(def, f, links, since, a).form?.id, 2);
    assert.equal(bind(def, facts({ forms: [form({ id: 3, createdAt: 200 })] }), { form: 2 }, since, a).form?.id, 3);
    assert.equal(bind(def, facts(), { form: 2 }, since, a).form, undefined);
  });
});
