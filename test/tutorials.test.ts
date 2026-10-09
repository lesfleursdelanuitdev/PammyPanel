// The tutorials, guides 15-18 (docs/tutorials-plan.md T2): the code a guide
// tells her to copy is the real code. Every file in tutorials/<folder>/ is
// printed whole in its guide, and every piece of code a guide shows is a piece
// of one of those files, word for word -- so the files test/run-tutorials-test.sh
// runs in a browser and in PHP are exactly what she copies. A change to a file
// that isn't made in its guide too (or the other way round) fails here.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseGuide, type Block } from '@panel/help/help';
import { journalCatalog, journalSnapshot, todoCatalog, todoSnapshot } from './tutorials-world.ts';
import { DEMO_FOLDERS, demoFiles } from '@panel/examples/tutorial-demos';
import { TUTORIAL_EXAMPLES } from '@panel/examples/studio/tutorial-examples';

const HERE = join(import.meta.dirname, '..');
const GUIDES = join(HERE, '..');
const TUTORIALS: { guide: string; name: string; folder: string }[] = [
  { guide: 'blog-with-javascript-guide.txt', name: '15-a-blog-with-javascript.txt', folder: 'journal' },
  { guide: 'blog-with-php-guide.txt', name: '16-a-blog-with-php.txt', folder: 'journal-php' },
  { guide: 'todo-with-javascript-guide.txt', name: '17-a-to-do-list-with-javascript.txt', folder: 'todo' },
  { guide: 'todo-with-php-guide.txt', name: '18-a-to-do-list-with-php.txt', folder: 'todo-php' },
];

// Examples that explain PHP itself rather than show a piece of a file (guide 16,
// PART 2 and IF SOMETHING GOES WRONG). Anything else that looks like code must
// be in a file.
const ILLUSTRATIONS = [
  "<?php\n$name = 'Pamela';\n?>\n<p>Hello, <?= $name ?>!</p>",
  "<?php ini_set('display_errors', '1'); ?>",
];

// Looks like code: a tag or PHP at the start of a line, a line ending in ;,
// or JavaScript/PHP words. An address, a field list or a sample answer doesn't.
const CODE_LIKE = /^\s*<[A-Za-z!?/]|;\s*$|\bfunction\b|\bconst\b|=>|\$[A-Za-z_]/m;

function codeBlocks(blocks: Block[]): string[] {
  return blocks.flatMap((b): string[] => {
    switch (b.t) {
      case 'code': return [b.text];
      case 'ol': case 'ul': return b.items.flatMap(codeBlocks);
      case 'dl': return b.items.flatMap((i) => codeBlocks(i.body));
      case 'table': return b.rows.flatMap((r) => codeBlocks(r.value));
      default: return [];
    }
  });
}

const dedent = (lines: string[]) => {
  const n = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => (l.trim() ? l.slice(n) : ''));
};
// Lines a to b of a file, with their common indent taken off -- the way the
// guide prints a piece of it.
const isPieceOf = (block: string, file: string) => {
  const want = block.split('\n');
  const lines = file.replace(/\n$/, '').split('\n');
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (dedent(lines.slice(i, i + want.length)).join('\n') === block) return true;
  }
  return false;
};

describe('the tutorials: what a guide prints is the real code', () => {
  const map = readFileSync(join(GUIDES, 'guides.map'), 'utf8');

  for (const t of TUTORIALS) {
    const guide = parseGuide(t.name, readFileSync(join(GUIDES, t.guide), 'utf8'));
    const blocks = guide.sections.flatMap((s) => codeBlocks(s.blocks));
    const dir = join(HERE, 'tutorials', t.folder);
    const files = readdirSync(dir).sort().map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));

    it(`${t.name}: is on the Help tab and in her instructions folder`, () => {
      assert.match(map, new RegExp(`^${t.guide.replace('.', '\\.')}\\s+${t.name.replace(/\./g, '\\.')}$`, 'm'));
    });

    it(`${t.name}: prints every file in tutorials/${t.folder}/ whole`, () => {
      for (const f of files) {
        assert.ok(blocks.includes(f.text.replace(/\n$/, '')), `${t.folder}/${f.name} is not printed whole in ${t.guide}`);
      }
    });

    it(`${t.name}: every piece of code it shows is word for word from those files`, () => {
      for (const b of blocks.filter((x) => CODE_LIKE.test(x))) {
        if (ILLUSTRATIONS.includes(b)) continue;
        assert.ok(files.some((f) => isPieceOf(b, f.text)), `in ${t.guide}, this is in none of tutorials/${t.folder}/:\n${b}`);
      }
    });
  }

  it('the files the guides say are the same are the same', () => {
    const f = (p: string) => readFileSync(join(HERE, 'tutorials', p), 'utf8');
    assert.equal(f('journal-php/style.css'), f('journal/style.css'), 'guide 16, PART 6: the same as guide 15\'s');
    assert.ok(f('todo-php/style.css').startsWith(f('todo/style.css')), 'guide 18, PART 6: guide 17\'s, with more at the end');
    assert.match(f('todo-php/settings.php'), /return 'PUT-YOUR-KEY-HERE';/, 'guide 18, PART 3: she puts her key there');
  });

  it('the guides name every table and field the tests draw, and the code asks for what the panel really makes', () => {
    const text = (g: string) => readFileSync(join(GUIDES, g), 'utf8');
    for (const [s, g] of [[journalSnapshot(), 'blog-with-javascript-guide.txt'], [todoSnapshot(), 'todo-with-javascript-guide.txt']] as const) {
      for (const table of s.tables) {
        assert.ok(text(g).includes(table.name), `${g} names ${table.name}`);
        for (const c of table.columns) {
          if (['id', 'created_at', 'updated_at', 'post_id', 'topic_id'].includes(c.name)) continue;
          assert.ok(text(g).includes(c.name), `${g} names ${table.name}.${c.name}`);
        }
      }
    }
    // what the code relies on, as the panel would push it to the gate
    const posts = journalCatalog().resources.find((r) => r.slug === 'posts')!;
    assert.deepEqual(posts.refs, [{ column: 'author_id', name: 'author', to: 'authors' }], 'post.author.label');
    assert.deepEqual(posts.many!.map((m) => m.name), ['topics'], 'post.topics[].label');
    assert.deepEqual(posts.rich, ['body'], 'answer.rich.includes(\'body\')');
    assert.deepEqual(posts.public, { only: 'published' });
    assert.ok(posts.sortable.includes('published_on'), '?sort=published_on');
    const tasks = todoCatalog(7).resources.find((r) => r.slug === 'tasks')!;
    assert.deepEqual(tasks.visitors, { area: 7, owner: 'owner' });
    assert.ok(tasks.columns.includes('owner'), '&where.owner= (guide 18)');
  });

  // docs/tutorial-examples-plan.md: the panel's examples are these files, with
  // only the example's database and its key changed
  it("the panel's tutorial examples: the same files, but for the example database and its key", () => {
    const key = 'pammy_ak_TESTKEY_abc-123';
    const made = demoFiles(join(HERE, 'tutorials'), key);
    const changedLines = new Map<string, string[]>();
    for (const folder of DEMO_FOLDERS) {
      for (const name of readdirSync(join(HERE, 'tutorials', folder))) {
        const f = made.find((x) => x.folder === folder && x.name === name);
        assert.ok(f, `${folder}/${name} is in the example`);
        const was = readFileSync(join(HERE, 'tutorials', folder, name), 'utf8').split('\n');
        const now = f.content.split('\n');
        assert.equal(now.length, was.length, `${folder}/${name}: the same lines`);
        const diff = now.filter((l, i) => l !== was[i]);
        if (diff.length) changedLines.set(`${folder}/${name}`, diff);
      }
    }
    assert.deepEqual(Object.fromEntries(changedLines), {
      'journal/journal.js': ["const POSTS = '/_pammy/api/data/postgres/example_journal/posts';"],
      'journal-php/api.php': ["const JOURNAL = '/_pammy/api/data/postgres/example_journal';"],
      'journal/post.js': ["  comments.setAttribute('name', 'example-journal-comments');"],
      'journal-php/post.php': ['    <pammy-comments name="example-journal-comments" content-id="<?= (int) $post[\'id\'] ?>" order="oldest"></pammy-comments>'],
      'todo/todo.js': ["const TASKS = '/_pammy/api/data/postgres/example_todo/tasks';"],
      'todo-php/tasks.php': ["const TASKS = '/_pammy/api/data/postgres/example_todo/tasks';"],
      'todo-php/settings.php': [`return '${key}';`],
    });
    // the one file of its own: a signed-out page, for the to-do lists' "Sign out" link
    assert.deepEqual(made.filter((f) => !readdirSync(join(HERE, 'tutorials', f.folder)).includes(f.name)).map((f) => `${f.folder}/${f.name}`),
      ['todo/logout.html', 'todo-php/logout.html']);
    assert.throws(() => demoFiles(join(HERE, 'tutorials'), "x'; system('id'); '"), /letters, digits/);
    // and the examples' databases are the guides' tables, under the examples' names
    assert.deepEqual(TUTORIAL_EXAMPLES['tutorial-journal'].tables, journalSnapshot('example_journal').tables);
    assert.deepEqual(TUTORIAL_EXAMPLES['tutorial-todo'].tables, todoSnapshot('example_todo').tables);
    assert.deepEqual([TUTORIAL_EXAMPLES['tutorial-journal'].database, TUTORIAL_EXAMPLES['tutorial-todo'].database], ['example_journal', 'example_todo']);
  });

  // The panel writes them under its own sandbox (pammy-panel.service), where
  // RestrictSUIDSGID=yes refuses asking for the setgid bit (EPERM: the first
  // live set-up failed on exactly that) and the umask is 077. Run the writer
  // under those, in a setgid folder like the installer's: folders and files
  // must come out in the folder's group, readable by it. Needs user systemd.
  it("the panel's tutorial examples are written under the panel's own sandbox, readable by PHP's group", (t) => {
    if (spawnSync('systemd-run', ['--user', '--wait', '--collect', '-q', '/bin/true']).status !== 0) return t.skip('no user systemd here');
    const group = spawnSync('id', ['-gn']).stdout.toString().trim();
    const dir = mkdtempSync(join(tmpdir(), 'pammy-demos-'));
    try {
      const into = join(dir, 'examples');
      mkdirSync(into);
      spawnSync('chmod', ['2750', into]);
      const script = join(dir, 'run.mjs');
      writeFileSync(script, `const m = await import(${JSON.stringify(join(HERE, 'src', 'tutorial-demos.ts'))});
for (let i = 0; i < 2; i++) m.writeDemos(${JSON.stringify(into)}, m.demoFiles(${JSON.stringify(join(HERE, 'tutorials'))}, 'pammy_test_key'));`);
      const r = spawnSync('systemd-run', ['--user', '--wait', '--collect', '-q', '-p', 'UMask=0077', '-p', 'RestrictSUIDSGID=yes', '-p', 'NoNewPrivileges=yes',
        '-p', 'SystemCallFilter=@system-service', '-p', 'SystemCallFilter=~@privileged', process.execPath, '--disable-warning=ExperimentalWarning', script]);
      assert.equal(r.status, 0, r.stderr.toString());
      assert.deepEqual(readdirSync(into).sort(), [...DEMO_FOLDERS].sort(), 'the four folders, and nothing left over from putting them back');
      for (const folder of DEMO_FOLDERS) {
        const d = statSync(join(into, folder));
        assert.equal((d.mode & 0o7777).toString(8), '2750', `${folder}: setgid, the group may read`);
        for (const name of readdirSync(join(into, folder))) {
          const f = statSync(join(into, folder, name));
          assert.equal((f.mode & 0o777).toString(8), '640', `${folder}/${name}`);
          assert.equal(f.gid, statSync(into).gid, `${folder}/${name} is in the folder's group (${group})`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
