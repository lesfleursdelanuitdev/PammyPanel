// The tutorial examples (docs/tutorial-examples-plan.md): finished, working
// copies of what guides 15-18 build, on panel.pammy.org, over two databases
// the panel owns -- example_journal (guides 15 and 16) and example_todo (17 and
// 18). Their tables are exactly the ones the guides tell her to draw, made with
// the same functions as the canvas (starterTable, addRelationship), and
// test/tutorials-world.ts builds the tutorials' own test databases from these
// too, so a guide, its tests and its example can't disagree.
//
// Pure: no database, no socket, no clock. Setting them up is src/app.ts's job,
// with the same fillDatabase as the database examples.
import { starterTable, type Column, type Snapshot, type Table } from '@panel/studio/pammydb/ir';
import { addRelationship } from '@panel/studio/studio/relationships';
import type { DbExample } from './db-examples.ts';

export const TUTORIAL_KINDS = ['tutorial-journal', 'tutorial-todo'] as const;
export type TutorialKind = (typeof TUTORIAL_KINDS)[number];
export const isTutorialKind = (k: unknown): k is TutorialKind => TUTORIAL_KINDS.includes(k as TutorialKind);

export type TutorialExample = Pick<DbExample, 'engine' | 'database' | 'title' | 'heading' | 'about' | 'tables' | 'resources' | 'rows'> & {
  kind: TutorialKind;
  // the demos that use it: the folder under tutorials/, the guide, and what it is
  demos: { folder: string; guide: number; heading: string }[];
  // "Programs may change it": the to-do lists add and tick things off
  apiWrite: boolean;
  // the journal's comments (guide 15 PART 10): its own comment area, a fixture
  // like the blog example's, with some approved comments on its posts. `page`
  // is the example page they are filed under (_pammy/examples/<page>/).
  comments?: {
    area: { name: string; fixture: string; title: string; contentType: string };
    page: string;
    items: { post: string; author: string; body: string; daysAfter: number }[];
  };
};

// ------------------------------------------------------------------ what the guides tell her to draw

// "Add field": the form's own starting values, then what the guide says to change
const field = (name: string, type: Column['type'], over: Partial<Column> = {}): Column =>
  ({ name, type, required: false, default: null, sqlType: null, ...(type === 'short_text' ? { length: 255 } : {}), ...over });
// "Add table": id and the two dates come with it; fields are added after them
const table = (name: string, fields: Column[]): Table => {
  const t = starterTable(name);
  return { ...t, columns: [...t.columns, ...fields] };
};

// Guide 15, PARTS 2-3 (and guide 16, which uses the same database)
export function journalSnapshot(database = 'journal'): Snapshot {
  let s: Snapshot = {
    engine: 'postgres', database, notes: [],
    tables: [
      table('posts', [
        field('title', 'short_text', { required: true }),
        field('body', 'text'),
        field('published', 'boolean', { required: true, default: { kind: 'boolean', value: false } }),
        field('published_on', 'date'),
      ]),
      table('authors', [field('name', 'short_text', { required: true })]),
      table('topics', [field('name', 'short_text', { required: true })]),
    ],
  };
  // posts holds the connection, one (author) has many (posts), "Prevent deletion"
  s = addRelationship(s, { from: { table: 'authors', column: 'id' }, to: { table: 'posts' }, kind: 'one-to-many', onDelete: 'restrict' });
  // posts, many have many, topics: the panel makes post_topics
  s = addRelationship(s, { from: { table: 'posts', column: 'id' }, to: { table: 'topics' }, kind: 'many-to-many', onDelete: 'cascade' });
  return s;
}

// Guide 17, PART 2 (and guide 18)
export function todoSnapshot(database = 'todo'): Snapshot {
  return {
    engine: 'postgres', database, notes: [],
    tables: [table('tasks', [
      field('title', 'short_text', { required: true }),
      field('done', 'boolean', { required: true, default: { kind: 'boolean', value: false } }),
      field('owner', 'short_text'),
    ])],
  };
}

// ------------------------------------------------------------------ the examples

const post = (ref: string, title: string, body: string, published: boolean, on: string | null, author: string, topics: string[]) => [
  { table: 'posts', ref: `post:${ref}`, values: { title, body, published, published_on: on, author_id: { ref: `author:${author}` } } },
  ...topics.map((t) => ({ table: 'post_topics', values: { post_id: { ref: `post:${ref}` }, topic_id: { ref: `topic:${t}` } } })),
];

export const TUTORIAL_EXAMPLES: Record<TutorialKind, TutorialExample> = {
  'tutorial-journal': {
    kind: 'tutorial-journal',
    engine: 'postgres',
    database: 'example_journal',
    title: 'Journal (tutorial example)',
    heading: 'Journal',
    about: 'The journal from guides 15 and 16: posts with their authors and topics, one of them not published yet, and comments under each post.',
    demos: [
      { folder: 'journal', guide: 15, heading: 'A blog with HTML and JavaScript' },
      { folder: 'journal-php', guide: 16, heading: 'A blog with PHP' },
    ],
    apiWrite: false,
    comments: {
      area: { name: 'example-journal-comments', fixture: 'tutorial-journal-comments', title: 'Journal comments (tutorial example)', contentType: 'posts' },
      page: 'tutorial-journal',
      items: [
        { post: 'beans', author: 'Olivia', body: 'They look wonderful. Save me a handful for the soup?', daysAfter: 1 },
        { post: 'beans', author: 'Sam', body: 'Ours are only just through. What did you sow them in?', daysAfter: 3 },
        { post: 'lemon', author: 'Rose', body: 'Made it on Sunday. Gone by Monday.', daysAfter: 2 },
      ],
    },
    tables: journalSnapshot('example_journal').tables,
    // guide 15, PART 4: all three switched on and readable by anyone, posts
    // only where Published is yes, and the body rich text
    resources: {
      posts: { patch: { enabled: true, publicRead: true, publicOnly: 'published' }, fields: { body: { control: 'rich' } } },
      authors: { patch: { enabled: true, publicRead: true } },
      topics: { patch: { enabled: true, publicRead: true } },
    },
    rows: [
      { table: 'authors', ref: 'author:pamela', values: { name: 'Pamela' } },
      { table: 'authors', ref: 'author:olivia', values: { name: 'Olivia' } },
      { table: 'topics', ref: 'topic:garden', values: { name: 'Garden' } },
      { table: 'topics', ref: 'topic:kitchen', values: { name: 'Kitchen' } },
      { table: 'topics', ref: 'topic:travel', values: { name: 'Travel' } },
      ...post('hello', 'Hello, and welcome', '<p>This is where I write things down: the garden, the kitchen, and the odd trip.</p>', true, '2026-03-02', 'pamela', []),
      ...post('beans', 'The first beans', '<h2>What came up</h2><p>Broad beans, <strong>at last</strong>, and a row of peas behind them.</p><table><tbody><tr><th>Row</th><th>Sown</th><th>Up</th></tr><tr><td>Broad beans</td><td>March</td><td>April</td></tr><tr><td>Peas</td><td>March</td><td>April</td></tr></tbody></table>', true, '2026-04-11', 'pamela', ['garden']),
      ...post('lemon', 'Lemon cake', '<p>Olivia\'s recipe, the one with the syrup poured over while it is still warm.</p><ul><li>Two lemons</li><li>A cup of sugar</li></ul>', true, '2026-05-20', 'olivia', ['kitchen', 'garden']),
      ...post('draft', 'Not finished yet', '<p>A post that is still being written: it is not published, so it is on neither page.</p>', false, null, 'pamela', ['travel']),
    ],
  },
  'tutorial-todo': {
    kind: 'tutorial-todo',
    engine: 'postgres',
    database: 'example_todo',
    title: 'To do (tutorial example)',
    heading: 'To-do list',
    about: 'The to-do list from guides 17 and 18. Here, each account in the control panel has its own list.',
    demos: [
      { folder: 'todo', guide: 17, heading: 'A to-do list with HTML and JavaScript' },
      { folder: 'todo-php', guide: 18, heading: 'A to-do list with PHP' },
    ],
    apiWrite: true,
    tables: todoSnapshot('example_todo').tables,
    resources: { tasks: { patch: { enabled: true } } },
    rows: [],
  },
};

export const TUTORIAL_DATABASES = new Set(TUTORIAL_KINDS.map((k) => TUTORIAL_EXAMPLES[k].database));
