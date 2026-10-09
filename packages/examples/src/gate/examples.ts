// The three worked examples (docs/examples-plan.md): a guest book, a list of who
// is coming, and a pinboard. They are all one machine wearing different clothes:
// a form collects, she approves, a page shows what was approved.
//
// Each one is a real form in the gate's tables -- she can fill it in, approve her own entry
// and watch it appear -- but a fixture: it can't be deleted or renamed, only
// reset. The page the panel frames at /_pammy/examples/<kind>/ is built from the
// files in public-gate/examples/<kind>/, and the very same files become her own
// page when she asks for one ("Put this on my website").
//
// The same questions are what "New form" offers as starters.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, one, run, tx, type Db } from '@panel/core/pg';
import { cleanAnswers } from '@panel/forms/gate/forms/answers';
import { cleanItems, MAX_EXAMPLE_RESPONSES } from '@panel/forms/gate/forms/items';
import { insertValues } from '@panel/forms/gate/forms/responses';
import { type Form, formById } from '@panel/forms/gate/forms/store';
import { DEFAULT_SETTINGS, type Settings, type StoredAnswer } from '@panel/forms/shared/form-types';
import { GateError } from '@panel/core/gate/ops';

export const EXAMPLE_KINDS = ['guestbook', 'rsvp', 'pinboard'] as const;
export type ExampleKind = (typeof EXAMPLE_KINDS)[number];
export const isExampleKind = (v: unknown): v is ExampleKind => EXAMPLE_KINDS.includes(v as ExampleKind);

// A starter is what "New form" fills a new form of HERS with. The examples use
// the same lists, so what she sees on the example is what she gets.
export type Starter = { label: string; about: string; title: string; items: unknown[]; settings: Partial<Settings> };

type Sample = { daysAgo: number; answers: Record<string, unknown> };
type Example = {
  kind: ExampleKind;
  formName: string;       // the fixture's name, never hers
  pageName: string;       // what her own copy is called by default
  heading: string;        // what the panel calls it
  about: string;
  guidePart: number;      // its tutorial in 10-forms.txt, printed file by file
  samples: Sample[];
};

// ------------------------------------------------------------------ the questions
const GUESTBOOK: Starter = {
  label: 'Guest book',
  about: 'Name, where they are from and a message, shown on a page of yours once you approve them.',
  title: 'Guest book',
  items: [
    { type: 'short-text', key: 'your-name', label: 'Your name', required: true, public: true, placeholder: 'Rose' },
    { type: 'short-text', key: 'from', label: "Where you're from", public: true, placeholder: 'Bath', help: 'A town, a country, or leave it empty.' },
    { type: 'long-text', key: 'message', label: 'Your message', required: true, public: true, rows: 4, maxLength: 1000 },
    { type: 'email', key: 'email', label: "Your email (I won't show it)", help: "Only so I can write back. It is never put on the page." },
  ],
  settings: { submitText: 'Sign the book', sentText: 'Thank you for signing. Your message goes on the page once I have read it.' },
};

const RSVP: Starter = {
  label: "Who's coming",
  about: 'Are you coming, how many of you, and a private note. The page counts the yeses.',
  title: "Who's coming",
  items: [
    { type: 'short-text', key: 'your-name', label: 'Your name', required: true, public: true },
    { type: 'single-choice', key: 'coming', label: 'Are you coming?', required: true, public: true, options: ['Yes', 'No', 'Maybe'], columns: 2 },
    { type: 'number', key: 'how-many', label: 'How many of you', public: true, min: 1, max: 20, default: 1, help: 'Counting yourself.' },
    { type: 'long-text', key: 'notes', label: 'Anything I should know', public: false, rows: 3, help: 'Only I see this: allergies, running late, bringing the dog.' },
    { type: 'email', key: 'email', label: 'Your email', help: 'Only so I can let you know if anything changes.' },
  ],
  settings: { submitText: 'Send my reply', sentText: 'Thank you, your reply is in. Change your mind? Just send it again.' },
};

const PINBOARD: Starter = {
  label: 'Pinboard',
  about: 'A short note and a colour, pinned up on a board once you approve it.',
  title: 'Pinboard',
  items: [
    { type: 'short-text', key: 'your-name', label: 'Your name', required: true, public: true },
    { type: 'long-text', key: 'note', label: 'Your note', required: true, public: true, rows: 3, maxLength: 200, help: 'A couple of lines, no more.' },
    { type: 'single-choice', key: 'colour', label: 'Colour', required: true, public: true, options: ['Yellow', 'Pink', 'Mint', 'Blue'], default: 'Yellow', columns: 2 },
  ],
  settings: { submitText: 'Pin it up', sentText: 'Thank you. Your note goes up on the board once I have read it.' },
};

// Not an example of its own: just a helpful list to start a new form from.
const CONTACT: Starter = {
  label: 'Get in touch',
  about: 'The usual: name, email, phone, what it is about, and a message.',
  title: 'Get in touch',
  items: [
    { type: 'short-text', key: 'your-name', label: 'Your name', required: true },
    { type: 'email', key: 'email', label: 'Email address', required: true },
    { type: 'phone', key: 'phone', label: 'Phone number' },
    { type: 'dropdown', key: 'about', label: 'What is it about?', options: ['A question', 'A booking', 'Something else'] },
    { type: 'long-text', key: 'message', label: 'Message', required: true, rows: 5 },
  ],
  settings: {},
};

export const STARTERS: Record<'contact' | ExampleKind, Starter> = {
  contact: CONTACT, guestbook: GUESTBOOK, rsvp: RSVP, pinboard: PINBOARD,
};
export const isStarter = (v: unknown): v is keyof typeof STARTERS => typeof v === 'string' && v in STARTERS;

// ------------------------------------------------------------------ the fixtures
export const EXAMPLES: Record<ExampleKind, Example> = {
  guestbook: {
    kind: 'guestbook', formName: 'example-guest-book', pageName: 'guestbook.html', guidePart: 12,
    heading: 'Guest book', about: 'People sign it, you approve what they wrote, and it appears on the page.',
    samples: [
      { daysAgo: 11, answers: { 'your-name': 'Rose', from: 'Bath', message: 'What a lovely afternoon. Thank you for the cake, and for letting us sit in the garden so long.' } },
      { daysAgo: 6, answers: { 'your-name': 'Dilip', from: 'Bristol', message: 'Found this website looking for the church fete photographs. Wonderful to see them all again.' } },
      { daysAgo: 2, answers: { 'your-name': 'Auntie Jo', from: 'Swansea', message: 'Lovely to see the pictures of the children. Give them all a kiss from me.' } },
    ],
  },
  rsvp: {
    kind: 'rsvp', formName: 'example-rsvp', pageName: 'whos-coming.html', guidePart: 13,
    heading: "Who's coming", about: 'People reply, and the page counts the yeses. The private answers stay here.',
    samples: [
      { daysAgo: 9, answers: { 'your-name': 'Rose', coming: 'Yes', 'how-many': 2, notes: 'Bringing the pudding.' } },
      { daysAgo: 7, answers: { 'your-name': 'Dilip', coming: 'Yes', 'how-many': 1 } },
      { daysAgo: 4, answers: { 'your-name': 'Auntie Jo', coming: 'Maybe', 'how-many': 1, notes: 'Depends on the trains.' } },
      { daysAgo: 1, answers: { 'your-name': 'Sam', coming: 'No', 'how-many': 1, notes: 'Away that weekend, sorry!' } },
    ],
  },
  pinboard: {
    kind: 'pinboard', formName: 'example-pinboard', pageName: 'pinboard.html', guidePart: 14,
    heading: 'Pinboard', about: 'Short notes, pinned up in the colour the writer picked.',
    samples: [
      { daysAgo: 8, answers: { 'your-name': 'Rose', note: 'Anyone want six jars of damson jam? Too many damsons this year.', colour: 'Pink' } },
      { daysAgo: 5, answers: { 'your-name': 'Dilip', note: 'Lost: a grey cat, answers to Biscuit, very talkative. Number on the gate.', colour: 'Blue' } },
      { daysAgo: 3, answers: { 'your-name': 'Auntie Jo', note: 'Knitting group moved to Thursdays. Same room, same terrible biscuits.', colour: 'Mint' } },
      { daysAgo: 1, answers: { 'your-name': 'Sam', note: 'Thank you to whoever put the bins out while we were away!', colour: 'Yellow' } },
    ],
  },
};

export const formByFixture = async (db: Db, kind: ExampleKind): Promise<Form | undefined> => {
  const r = await one<{ id: number }>(db, 'SELECT id FROM forms WHERE fixture = ?', kind);
  return r && formById(db, r.id);
};

// Makes any example that isn't there yet, with its sample entries already
// approved. The gate runs it when it starts (a new database has none), and reset
// runs it for one that went missing.
// domain: where the sample responses say they were sent from (her website)
export async function installExamples(db: Db, now: number, domain: string) {
  await tx(db, async (q) => {
    for (const kind of EXAMPLE_KINDS) {
      if (await formByFixture(q, kind)) continue;
      const ex = EXAMPLES[kind];
      const starter = STARTERS[kind];
      const { items, usedKeys } = cleanItems(starter.items);
      const settings: Settings = { ...DEFAULT_SETTINGS, ...starter.settings };
      // On, approvable and readable by anyone from the start: these are our words,
      // not her visitors', so there is nothing here to publish on her behalf.
      const r = await one<{ id: number }>(q, `INSERT INTO forms (name, title, items, settings, used_keys, enabled, approvable, public_approved, fixture, created_at, created_by, updated_at, updated_by)
                            VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, ?, 'the examples', ?, 'the examples') RETURNING id`,
        ex.formName, starter.title, JSON.stringify(items), JSON.stringify(settings), JSON.stringify(usedKeys), kind, now, now);
      await seed(q, now, (await formById(q, r!.id))!, ex, domain);
    }
  });
}

// The sample entries: sent a few days ago, already read and approved, so the
// example's page has something on it the moment she opens it.
async function seed(db: Db, now: number, form: Form, ex: Example, domain: string) {
  for (const s of [...ex.samples].sort((a, b) => b.daysAgo - a.daysAgo)) {
    const at = now - s.daysAgo * 86400;
    const answers: StoredAnswer[] = cleanAnswers(form, s.answers, at);
    const r = await one<{ id: number }>(db, `INSERT INTO responses (form_id, form_name, page, answers, host, created_at, read_at, read_by, approved_at, approved_by)
                               VALUES (?, ?, ?, ?, ?, ?, ?, 'the examples', ?, 'the examples') RETURNING id`,
      form.id, form.name, `/_pammy/examples/${ex.kind}/`, JSON.stringify(answers), domain, at, at, at);
    await insertValues(db, r!.id, form.id, answers);
  }
}

// Reset: the questions, the wording and the switches go back to how they
// started, and every entry is replaced by the sample ones. Entries added since
// are deleted outright -- they are examples, and the panel says so before asking.
export async function resetExample(db: Db, now: number, kind: unknown, domain: string): Promise<Form> {
  if (!isExampleKind(kind)) throw new GateError('invalid', 'There is no example of that kind.');
  return tx(db, async (q) => {
    const form = await formByFixture(q, kind);
    if (!form) {
      await installExamples(q, now, domain);
      return (await formByFixture(q, kind))!;
    }
    const ex = EXAMPLES[kind];
    const starter = STARTERS[kind];
    // Back to the questions it was born with, keys and all. Anything she added
    // stays in used_keys, so a key she invented never comes back meaning
    // something else in an old entry.
    const { items } = cleanItems(starter.items);
    const usedKeys = [...new Set([...form.usedKeys, ...items.map((i) => i.key).filter((k): k is string => !!k)])];
    const settings: Settings = { ...DEFAULT_SETTINGS, ...starter.settings };
    await run(q, `UPDATE forms SET title = ?, items = ?, settings = ?, used_keys = ?, enabled = 1, approvable = 1, public_approved = 1, auto_approve = 0,
                version = version + 1, updated_at = ?, updated_by = 'the examples' WHERE id = ?`,
      starter.title, JSON.stringify(items), JSON.stringify(settings), JSON.stringify(usedKeys), now, form.id);
    await run(q, 'DELETE FROM responses WHERE form_id = ?', form.id);
    await seed(q, now, (await formById(q, form.id))!, ex, domain);
    return (await formById(q, form.id))!;
  });
}

// What the panel's Examples section shows: each example, its form, and how many
// entries are waiting to be approved.
export async function examplesState(db: Db) {
  const counts = new Map((await all<{ form_id: number | null; total: number; approved: number }>(db, `
    SELECT form_id, count(*) AS total, count(*) FILTER (WHERE approved_at IS NOT NULL) AS approved
      FROM responses WHERE trashed_at IS NULL GROUP BY form_id`)).map((r) => [r.form_id, r]));
  const examples = [];
  for (const kind of EXAMPLE_KINDS) {
    const ex = EXAMPLES[kind];
    const form = await formByFixture(db, kind);
    examples.push({
      kind, heading: ex.heading, about: ex.about, pageName: ex.pageName, guidePart: ex.guidePart,
      formId: form?.id ?? null, formName: form?.name ?? ex.formName,
      starter: kind,
      responses: form ? counts.get(form.id)?.total ?? 0 : 0,
      waiting: form ? (counts.get(form.id)?.total ?? 0) - (counts.get(form.id)?.approved ?? 0) : 0,
      switchedOn: !!form?.enabled && !!form.approvable && !!form.publicApproved,
    });
  }
  return { examples, maxResponses: MAX_EXAMPLE_RESPONSES };
}

// ------------------------------------------------------------------ the pages
// public-gate/examples/<kind>/{page.html,style.css,entries.js}, with two things
// filled in: which form the page uses, and where its two files sit next to it.
// The gate serves them as the example; the panel writes the same three files
// into a folder of her website, pointed at a form of her own.
export const EXAMPLE_FILES = ['page.html', 'style.css', 'entries.js'] as const;

export function examplePage(dir: string, kind: ExampleKind, formName: string, filesDir: string): { html: string; css: string; js: string } {
  const read = (file: string) => readFileSync(join(dir, kind, file), 'utf8');
  return {
    html: read('page.html').replaceAll('@FORM@', formName).replaceAll('@FILES@', filesDir),
    css: read('style.css'),
    js: read('entries.js'),
  };
}

// What her own copy is called: guestbook.html and guestbook-files/ beside it.
export const filesDirFor = (pageName: string) => `${pageName.replace(/\.html?$/i, '')}-files`;

export function exampleForHer(dir: string, kind: ExampleKind, formName: string, pageName: string): { path: string; content: string }[] {
  const filesDir = filesDirFor(pageName);
  const page = examplePage(dir, kind, formName, filesDir);
  return [
    { path: pageName, content: page.html },
    { path: `${filesDir}/style.css`, content: page.css },
    { path: `${filesDir}/entries.js`, content: page.js },
  ];
}