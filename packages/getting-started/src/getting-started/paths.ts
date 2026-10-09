// The paths "What would you like to do?" leads to (docs/getting-started-plan.md G3),
// and how each step knows it is done (G1): a check reads the site as it is now
// (facts.ts). A step without a check is ticked by hand ("I've done this", Q3).
//
// A path holds on to what it found -- its database, its form, its folder -- the
// first time a check finds one (`bind`), so a second one made later doesn't
// take its place. "That's not the one" puts it on the path's `not` list.
import { DB_EXAMPLES } from '@panel/examples/studio/db-examples';
import type { AreaFact, DbFact, Facts, FormFact } from './facts.ts';
import type { Answers, PathKey } from './questions.ts';

export type Links = { db?: number; form?: number; area?: number; not?: { db?: number[]; form?: number[]; area?: number[] } };
export type StepState = 'done' | 'todo' | 'unknown';
export type Result = { state: StepState; found?: string; note?: string };
export type Href = { href: string; label: string };

export type Ctx = {
  f: Facts; a: Answers; since: number; site: string;
  db?: DbFact; form?: FormFact; area?: AreaFact;
};
export type Step = {
  key: string;
  title: string;
  why: string;
  to?: (c: Ctx) => Href | null;
  guide?: Href;
  // none: the site can't tell, so it is ticked by hand
  check?: (c: Ctx) => Result | Promise<Result>;
  // asks her own database: only on the Getting started page, never on Home
  deep?: boolean;
};
export type PathDef = {
  key: PathKey;
  title: string;
  // what it is, in the fewest words: the recommendation's headline
  what: string;
  guide19: number;
  steps: (a: Answers) => Step[];
  // what the path looks for, newest first; `since` is when she started it
  find?: {
    db?: (d: DbFact, f: Facts, since: number) => boolean;
    form?: (x: FormFact, f: Facts, since: number, a: Answers) => boolean;
    area?: (x: AreaFact, f: Facts, since: number) => boolean;
  };
};

// ------------------------------------------------------------------ links to guides
const guide = (slug: string, part: number | null, label: string): Href => ({ href: `/help/${slug}${part ? `/part-${part}` : ''}`, label });
export const guide19 = (part: number): Href => guide('forms-or-a-database', part, 'Guide 19, Forms or a database?');
const FORMS = (part: number) => guide('forms', part, `Guide 10, PART ${part}`);
const DBS = (part: number) => guide('databases-in-the-control-panel', part, `Guide 14, PART ${part}`);

// ------------------------------------------------------------------ small pieces
const done = (found?: string): Result => ({ state: 'done', ...(found ? { found } : {}) });
const todo = (note?: string): Result => ({ state: 'todo', ...(note ? { note } : {}) });
const unknown = (note: string): Result => ({ state: 'unknown', note });
const quoted = (x: FormFact) => `"${x.title}" (${x.name})`;
const underArea = (page: string, a: AreaFact) => page === a.path || page.startsWith(`${a.path}/`);
const seedCount = (kind: 'recipes' | 'blog', table: string) => DB_EXAMPLES[kind].rows.filter((r) => r.table === table).length;
const appOf = (d: DbFact) => `/databases/${d.engine}/${d.name}/app`;

// ---- a database
const copyStep = (kind: 'recipes' | 'blog', noun: string): Step => ({
  key: 'copy', title: `Make your own ${noun} from the example`,
  why: 'The example comes with its tables drawn, connected and switched on, and a page that shows them. "Make my own" gives you a copy that is yours.',
  to: () => ({ href: `/databases/examples/${kind}`, label: 'Database examples' }),
  guide: DBS(16),
  check: ({ db }) => (!db ? todo() : db.active ? done(`${db.title} (${db.name})`) : todo(`${db.title} is there, but its app is switched off.`)),
});
const firstRecord = (kind: 'recipes' | 'blog', table: string, noun: string): Step => ({
  key: 'first', title: `Add a ${noun} of your own`, deep: true,
  why: `In the app's pages, "New ${noun[0]!.toUpperCase()}${noun.slice(1)}". The samples don't count: this one is yours.`,
  to: ({ db }) => (db ? { href: `/app/${db.engine}/${db.name}/${table}/new`, label: `New ${noun}` } : null),
  check: async ({ db, f }) => {
    if (!db) return todo();
    const n = await f.count(db.engine, db.name, table);
    if (n === null) return unknown(f.deep ? `${db.name} didn't answer just now.` : 'Open Getting started to check.');
    return n > (db.copiedRows ? seedCount(kind, table) : 0) ? done() : todo();
  },
});
const pageStep = (noun: string): Step => ({
  key: 'page', title: `Open your ${noun} page`,
  why: '"Make my own" put a page on your website that shows it. Open it to see it working.',
  to: ({ db, site }) => (db?.page ? { href: `https://${site}/${db.page}`, label: 'Open the page' } : null),
  check: async ({ db, f }) => {
    if (!db?.page) return todo();
    const there = await f.pageThere(db.page);
    return there === null ? unknown('The website helper did not answer just now.') : there ? done(db.page) : todo(`${db.page} is not on your website any more.`);
  },
});
const commentsStep = (table: string, noun: string): Step => ({
  key: 'comments', title: `Let readers comment on your ${noun}`,
  why: `On the ${noun} table's own page, switch on "People can comment on these". Every comment waits for your OK.`,
  to: ({ db }) => (db ? { href: `${appOf(db)}/${table}`, label: `The ${noun} table's page` } : null),
  guide: guide('comments', 7, 'Guide 20, PART 7'),
  check: async ({ db, f }) => {
    if (!db) return todo();
    const areas = f.forms.filter((x) => x.kind === 'comments' && x.contentType === table);
    const links = await f.formLinks(db.id);
    const on = areas.find((x) => links.some((l) => l.formId === x.id && l.mode === 'comments'));
    return on ? done(quoted(on)) : todo();
  },
});
const tickStep = (key: string, title: string, why: string, g: Href): Step => ({ key, title, why, guide: g, to: () => g });

// ---- a form
const makeForm = (key: string, title: string, why: string, to: Href, g?: Href): Step => ({
  key, title, why, to: () => to, ...(g ? { guide: g } : {}),
  check: ({ form }) => (form ? done(quoted(form)) : todo()),
});
const onPage = (what: string): Step => ({
  key: 'on-page', title: `Open ${what} on your website`,
  why: 'Open the page once: the panel only knows a form is on a page after someone has seen it there.',
  to: ({ form }) => (form ? { href: '/forms', label: 'Forms' } : null),
  check: ({ form }) => (!form ? todo() : form.pages[0] ? done(form.pages[0]) : todo()),
});
const publicStep: Step = {
  key: 'public', title: 'Let the page show the approved ones',
  why: 'On the form\'s card, "Anyone can read the approved responses". Only the answers you marked "Show publicly" are given out.',
  to: () => ({ href: '/forms', label: 'Forms' }), guide: FORMS(11),
  check: ({ form }) => (form?.publicApproved ? done() : todo()),
};
const showNow: Step = {
  key: 'show-now', title: 'Show new ones right away',
  why: 'On the form\'s card, "Show right away" under "New responses". You can still unapprove anything that shouldn\'t be there.',
  to: () => ({ href: '/forms', label: 'Forms' }), guide: FORMS(8),
  check: ({ form }) => (form?.autoApprove ? done() : todo()),
};
const protectPage: Step = {
  key: 'protect', title: 'Keep it for people you know',
  why: 'Protect the folder the page is in, then add the people who may open it.',
  to: () => ({ href: '/protected-folders', label: 'Protected folders' }), guide: FORMS(10),
  check: ({ form, f }) => {
    const page = form?.pages[0];
    if (!page) return todo('Open the page once first, so the panel knows which folder it is in.');
    const a = f.areas.find((x) => underArea(page, x));
    return a ? done(a.path) : todo();
  },
};
const firstApproved = (noun: string): Step => ({
  key: 'first', title: `Send the first ${noun}, and approve it`,
  why: 'Try it yourself: fill it in on the page, then approve it in Responses.',
  to: () => ({ href: '/responses', label: 'Responses' }),
  check: ({ form }) => (form && form.approved > 0 ? done() : todo()),
});
const connectStep = (table: string | null, why: string): Step => ({
  key: 'connect', title: table ? `Save its answers in your ${table} table` : 'Save its answers in your database',
  why,
  to: ({ form }) => (form ? { href: `/forms/${form.id}/database`, label: 'Save answers in a database' } : null),
  guide: FORMS(17),
  check: async ({ db, form, f }) => {
    if (!db || !form) return todo();
    const l = (await f.formLinks(db.id)).find((x) => x.formId === form.id && x.mode === 'row' && x.enabled && (!table || x.table === table));
    return l ? done(`into ${l.table}`) : todo();
  },
});

// ---- a general database
const makeDatabase: Step = {
  key: 'make', title: 'Make a database', why: 'A new, empty database, looked after by the panel.',
  to: () => ({ href: '/databases', label: 'Your databases' }), guide: DBS(3),
  check: ({ db }) => (db ? done(`${db.title} (${db.name})`) : todo()),
};
const switchOn: Step = {
  key: 'switch-on', title: 'Draw its tables, then switch the app on',
  why: 'Draw the tables on the canvas, Review and Apply, then "Switch the app on" gives you pages for adding and changing records.',
  to: ({ db }) => (db ? { href: `/databases/${db.engine}/${db.name}/canvas`, label: 'The canvas' } : null),
  guide: DBS(4),
  check: ({ db, f }) => (!db ? todo() : db.active && f.tables.some((t) => t.databaseId === db.id && t.enabled) ? done() : todo()),
};

// ------------------------------------------------------------------ the paths
const keysHave = (x: FormFact, ...keys: string[]) => keys.every((k) => x.keys.includes(k));
const ownForm = (x: FormFact) => x.kind === 'form' && !x.fixture;

export const PATHS: Record<PathKey, PathDef> = {
  blog: {
    key: 'blog', title: 'Your blog', what: 'A database: start from the blog example', guide19: 5,
    find: { db: (d) => d.copiedFrom === 'blog' },
    steps: (a) => [
      copyStep('blog', 'blog'),
      firstRecord('blog', 'posts', 'post'),
      ...(a.comments === 'yes' ? [commentsStep('posts', 'posts')] : []),
      pageStep('blog'),
      tickStep('make-it-yours', 'Make it look like yours',
        'Guide 15 (or 16, for PHP) goes through the page and its little program, so you can change how it looks and what it shows.',
        guide('a-blog-with-javascript', null, 'Guide 15, A blog with JavaScript')),
    ],
  },
  pinboard: {
    key: 'pinboard', title: 'Your pinboard', what: 'A form: start from the pinboard example', guide19: 4,
    find: { form: (x) => ownForm(x) && keysHave(x, 'note', 'colour') },
    steps: (a) => [
      makeForm('form', 'Put the pinboard on your website', 'On the Pinboard example, "Put this on my website" makes the page and a form of your own.',
        { href: '/examples/pinboard', label: 'Form examples' }, FORMS(14)),
      onPage('the pinboard page'),
      publicStep,
      ...(a.who === 'people' ? [protectPage] : []),
      ...(a.when === 'now' ? [showNow] : []),
      firstApproved('note'),
    ],
  },
  recipes: {
    key: 'recipes', title: 'Your recipe book', what: 'A database: start from the recipe book example', guide19: 6,
    find: {
      db: (d) => d.copiedFrom === 'recipes',
      form: (x, _f, _s, a) => a.friends === 'yes' && ownForm(x) && /recipe/i.test(`${x.name} ${x.title}`),
    },
    steps: (a) => [
      copyStep('recipes', 'recipe book'),
      firstRecord('recipes', 'recipes', 'recipe'),
      pageStep('recipe book'),
      ...(a.friends === 'yes' ? [
        makeForm('share-form', 'Make a "Share a recipe" form', 'Questions for the recipe\'s own fields: its title, a summary, the method, how many it serves. Put "recipe" in its name so the panel finds it.',
          { href: '/forms', label: 'Forms' }, guide19(6)),
        connectStep('recipes', 'Choose your recipe book, the recipes table, and "When I approve a response": a recipe only goes in when you approve it.'),
        onPage('the form'),
      ] : []),
    ],
  },
  contact: {
    key: 'contact', title: 'A contact form', what: 'A form', guide19: 8,
    find: { form: (x, _f, since) => ownForm(x) && x.createdAt >= since },
    steps: () => [
      makeForm('form', 'Make the form', '"New form", then pick "Get in touch" to start with its questions filled in.', { href: '/forms', label: 'Forms' }, FORMS(1)),
      onPage('the form'),
      { key: 'test', title: 'Send yourself a message', why: 'Fill it in on your page and see it arrive in Responses.',
        to: () => ({ href: '/responses', label: 'Responses' }), check: ({ form }) => (form && form.responses > 0 ? done() : todo()) },
    ],
  },
  rsvp: {
    key: 'rsvp', title: "Who's coming", what: "A form: start from the who's-coming example", guide19: 8,
    find: { form: (x) => ownForm(x) && keysHave(x, 'coming') },
    steps: (a) => [
      makeForm('form', 'Put the list on your website', 'On the "Who\'s coming" example, "Put this on my website" makes the page and a form of your own.',
        { href: '/examples/rsvp', label: 'Form examples' }, FORMS(13)),
      onPage('the page'),
      publicStep,
      ...(a.who === 'people' ? [protectPage] : []),
      firstApproved('answer'),
    ],
  },
  guestbook: {
    key: 'guestbook', title: 'A guest book', what: 'A form: start from the guest book example', guide19: 8,
    find: { form: (x) => ownForm(x) && keysHave(x, 'message', 'from') },
    steps: (a) => [
      makeForm('form', 'Put the guest book on your website', 'On the Guest book example, "Put this on my website" makes the page and a form of your own.',
        { href: '/examples/guestbook', label: 'Form examples' }, FORMS(12)),
      onPage('the page'),
      publicStep,
      ...(a.when === 'now' ? [showNow] : []),
      firstApproved('entry'),
    ],
  },
  private: {
    key: 'private', title: 'A private folder', what: 'A protected folder', guide19: 8,
    find: { area: (x, _f, since) => x.createdAt >= since },
    steps: () => [
      { key: 'protect', title: 'Protect a folder', why: 'Everything in it, and everything under it, goes behind a sign-in page.',
        to: () => ({ href: '/protected-folders', label: 'Protected folders' }), guide: guide('protected-folders', null, 'Guide 9, Protected folders'),
        check: ({ area }) => (area ? done(area.path) : todo()) },
      { key: 'person', title: 'Add someone who may open it', why: 'They get a link to choose their own password.',
        to: () => ({ href: '/people', label: 'People' }),
        check: ({ area }) => (area && area.visitors > 0 ? done() : todo()) },
      tickStep('try', 'Try signing in yourself', 'Open the folder\'s address in a private window and sign in, to see what they will see.',
        guide('protected-folders', null, 'Guide 9, Protected folders')),
    ],
  },
  media: {
    key: 'media', title: 'Media on your site', what: 'Media folders, and a page that shows them', guide19: 8,
    steps: (a) => {
      const kind = a.media === 'audio' ? 'audio' : a.media === 'documents' ? 'files' : 'images';
      const noun = a.media === 'audio' ? 'a recording' : a.media === 'documents' ? 'a document' : 'a picture';
      return [
        { key: 'upload', title: `Upload ${noun}`, why: 'Media makes the folder for you the first time you upload.',
          to: () => ({ href: '/media', label: 'Media' }), check: ({ f }) => ((f.media[kind] ?? 0) > 0 ? done() : todo()) },
        tickStep('page', 'Put it on a page', 'Guide 12 has galleries, players and lists of files that fill themselves in.',
          guide('media-on-your-pages', null, 'Guide 12, Media on your pages')),
      ];
    },
  },
  lists: {
    key: 'lists', title: 'A list for each person', what: 'A database people sign in to change', guide19: 8,
    find: { db: (d, f) => !d.example && f.tables.some((t) => t.databaseId === d.id && t.visitorArea !== null) },
    steps: (a) => [
      { key: 'example', title: 'Set up the tutorial examples', why: 'The to-do list working on the panel, to try before you build yours.',
        to: () => ({ href: '/databases/tutorial-examples', label: 'Tutorial examples' }),
        check: ({ f }) => (f.databases.some((d) => d.example === 'tutorial-todo') ? done() : todo()) },
      a.code === 'php'
        ? tickStep('guide', 'Follow guide 18', 'It builds the to-do list step by step, with PHP.', guide('a-to-do-list-with-php', null, 'Guide 18, A to-do list with PHP'))
        : tickStep('guide', 'Follow guide 17', 'It builds the to-do list step by step, with HTML and JavaScript.', guide('a-to-do-list-with-javascript', null, 'Guide 17, A to-do list with JavaScript')),
      { key: 'own', title: 'Let the people in a folder change your list', why: 'On the table\'s own page, "People signed in to a protected folder".',
        to: () => ({ href: '/databases', label: 'Your databases' }),
        check: ({ db }) => (db ? done(`${db.title} (${db.name})`) : todo()) },
    ],
  },

  // ---- from "not sure": the same steps, without an example
  form: {
    key: 'form', title: 'A form', what: 'A form', guide19: 2,
    find: { form: (x, _f, since) => ownForm(x) && x.createdAt >= since },
    steps: () => [
      makeForm('form', 'Make a form', 'Add your questions in the builder, then Save.', { href: '/forms', label: 'Forms' }, FORMS(1)),
      onPage('the form'),
      { key: 'test', title: 'Send one yourself', why: 'Fill it in on your page and see it arrive in Responses.',
        to: () => ({ href: '/responses', label: 'Responses' }), check: ({ form }) => (form && form.responses > 0 ? done() : todo()) },
    ],
  },
  database: {
    key: 'database', title: 'A database', what: 'A database', guide19: 3,
    find: { db: (d, _f, since) => !d.example && d.adoptedAt >= since },
    steps: () => [
      makeDatabase,
      switchOn,
      tickStep('show', 'Show it on a page', 'Guides 15 and 16 build a page that reads a database, step by step.',
        guide('a-blog-with-javascript', null, 'Guide 15, A blog with JavaScript')),
    ],
  },
  'database-form': {
    key: 'database-form', title: 'A database with a form', what: 'A database, and a form that saves into it', guide19: 7,
    find: {
      db: (d, _f, since) => !d.example && d.adoptedAt >= since,
      form: (x, _f, since) => ownForm(x) && x.createdAt >= since,
    },
    steps: () => [
      makeDatabase,
      switchOn,
      makeForm('form', 'Make the form', 'Questions for the fields you want filled in.', { href: '/forms', label: 'Forms' }, FORMS(1)),
      connectStep(null, 'Choose the database and the table, and "When I approve a response" to choose what goes in.'),
      onPage('the form'),
    ],
  },
  'database-signin': {
    key: 'database-signin', title: 'A database people sign in to change', what: 'A database, and a protected folder', guide19: 8,
    find: {
      db: (d, _f, since) => !d.example && d.adoptedAt >= since,
      area: (x, _f, since) => x.createdAt >= since,
    },
    steps: () => [
      makeDatabase,
      switchOn,
      { key: 'protect', title: 'Protect the folder the page will be in', why: 'The people you add there are the ones who may change it.',
        to: () => ({ href: '/protected-folders', label: 'Protected folders' }), check: ({ area }) => (area ? done(area.path) : todo()) },
      { key: 'own', title: 'Let them change it', why: 'On the table\'s own page, "People signed in to a protected folder", with an owner field so each keeps their own.',
        to: ({ db }) => (db ? { href: appOf(db), label: 'The app' } : null), guide: guide('a-to-do-list-with-javascript', null, 'Guide 17, A to-do list'),
        check: ({ db, f }) => (db && f.tables.some((t) => t.databaseId === db.id && t.visitorArea !== null) ? done() : todo()) },
    ],
  },
  comments: {
    key: 'comments', title: 'Comments on your pages', what: 'A comment area', guide19: 8,
    find: { form: (x, _f, since) => x.kind === 'comments' && !x.fixture && x.createdAt >= since },
    steps: () => [
      makeForm('area', 'Make a comment area', 'On the Comments tab, under "A new comment area".', { href: '/comments', label: 'Comments' },
        guide('comments', 2, 'Guide 20, PART 2')),
      onPage('a page with the comments on it'),
    ],
  },
};

// ------------------------------------------------------------------ holding on to what it found
const pick = <T extends { id: number }>(list: T[], held: number | undefined, not: number[] = [], ok: (x: T) => boolean): { item?: T; id?: number } => {
  if (held !== undefined) {
    const still = list.find((x) => x.id === held);
    // still there: kept. Gone (deleted): the step comes undone, and the next one found is taken.
    if (still) return { item: still, id: held };
  }
  const item = list.find((x) => !not.includes(x.id) && ok(x));
  return item ? { item, id: item.id } : {};
};

// The path's database, form and folder, found or kept, and the links to store.
export function bind(def: PathDef, f: Facts, links: Links, since: number, a: Answers): { links: Links; db?: DbFact; form?: FormFact; area?: AreaFact } {
  const out: Links = { ...(links.not ? { not: links.not } : {}) };
  const find = def.find ?? {};
  const forms = [...f.forms].sort((x, y) => y.createdAt - x.createdAt || y.id - x.id);
  const areas = [...f.areas].sort((x, y) => y.createdAt - x.createdAt || y.id - x.id);
  const db = find.db ? pick(f.databases, links.db, links.not?.db, (d) => find.db!(d, f, since)) : {};
  const form = find.form ? pick(forms, links.form, links.not?.form, (x) => find.form!(x, f, since, a)) : {};
  const area = find.area ? pick(areas, links.area, links.not?.area, (x) => find.area!(x, f, since)) : {};
  if (db.id !== undefined) out.db = db.id;
  if (form.id !== undefined) out.form = form.id;
  if (area.id !== undefined) out.area = area.id;
  return { links: out, ...(db.item ? { db: db.item } : {}), ...(form.item ? { form: form.item } : {}), ...(area.item ? { area: area.item } : {}) };
}
