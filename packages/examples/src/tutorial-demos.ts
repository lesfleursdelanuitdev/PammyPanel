// The tutorial examples' pages (docs/tutorial-examples-plan.md): the files of
// tutorials/<folder>/, exactly as guides 15-18 print them, with only these
// changed -- the database is the example's (example_journal, example_todo), not
// the one she will make, the journal's comment area is the example's
// (example-journal-comments), and the PHP to-do list's settings.php holds the
// example's own key. Written into the examples' folder, which PHP reads
// (pammy-php's second pool) and the panel serves the rest of.
//
// test/tutorials.test.ts checks that nothing else differs.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEMO_FOLDERS = ['journal', 'journal-php', 'todo', 'todo-php'] as const;
export type DemoFolder = (typeof DEMO_FOLDERS)[number];
export const isDemoFolder = (f: unknown): f is DemoFolder => DEMO_FOLDERS.includes(f as DemoFolder);

// what changes, and where it must be found (each exactly once)
const CHANGES: { folder: DemoFolder; file: string; from: string; to: (key: string) => string }[] = [
  { folder: 'journal', file: 'journal.js', from: "'/_pammy/api/data/postgres/journal/posts'", to: () => "'/_pammy/api/data/postgres/example_journal/posts'" },
  { folder: 'journal-php', file: 'api.php', from: "'/_pammy/api/data/postgres/journal'", to: () => "'/_pammy/api/data/postgres/example_journal'" },
  // the comments: the example's own comment area, never the one she makes
  { folder: 'journal', file: 'post.js', from: "comments.setAttribute('name', 'journal-comments');", to: () => "comments.setAttribute('name', 'example-journal-comments');" },
  { folder: 'journal-php', file: 'post.php', from: '<pammy-comments name="journal-comments"', to: () => '<pammy-comments name="example-journal-comments"' },
  { folder: 'todo', file: 'todo.js', from: "'/_pammy/api/data/postgres/todo/tasks'", to: () => "'/_pammy/api/data/postgres/example_todo/tasks'" },
  { folder: 'todo-php', file: 'tasks.php', from: "'/_pammy/api/data/postgres/todo/tasks'", to: () => "'/_pammy/api/data/postgres/example_todo/tasks'" },
  { folder: 'todo-php', file: 'settings.php', from: "'PUT-YOUR-KEY-HERE'", to: (key) => `'${key}'` },
];

// In her folder, logout.html is the sign-in page the folder came with. In the
// example there is nothing to sign out of but the control panel.
const LOGOUT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signed out</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <h1>Signed out</h1>
    <p>In your own protected folder, this page signs people out. In the example you
      are the account you use for the control panel, and you stay signed in.</p>
    <p><a href="./">Back to the list</a></p>
  </main>
</body>
</html>
`;

export type DemoFile = { folder: DemoFolder; name: string; content: string };

export function demoFiles(tutorialsDir: string, todoKey: string): DemoFile[] {
  if (!/^[A-Za-z0-9_-]+$/.test(todoKey)) throw new Error('an app key is letters, digits, _ and - only');
  const out: DemoFile[] = [];
  for (const folder of DEMO_FOLDERS) {
    for (const name of readdirSync(join(tutorialsDir, folder)).sort()) {
      let content = readFileSync(join(tutorialsDir, folder, name), 'utf8');
      for (const c of CHANGES.filter((x) => x.folder === folder && x.file === name)) {
        if (content.split(c.from).length !== 2) throw new Error(`${folder}/${name} no longer has ${c.from} exactly once`);
        content = content.replace(c.from, c.to(todoKey));
      }
      out.push({ folder, name, content });
    }
    if (folder === 'todo' || folder === 'todo-php') out.push({ folder, name: 'logout.html', content: LOGOUT });
  }
  for (const c of CHANGES) {
    if (!out.some((f) => f.folder === c.folder && f.name === c.file)) throw new Error(`tutorials/${c.folder}/${c.file} is missing`);
  }
  return out;
}

// Into <dir>/<folder>/, each folder swapped in whole. <dir> is the panel's, in
// PHP's group, setgid (deploy/install-panel.sh), so every folder made in it is
// setgid and PHP's group too -- the kernel does that. The panel never asks for
// the setgid bit itself: pammy-panel.service has RestrictSUIDSGID=yes, which
// refuses it (EPERM), so folders are made 750 and files 640 under a umask of
// 027 (the service's own is 077, which would leave PHP nothing to read).
export function writeDemos(dir: string, files: DemoFile[]): void {
  const umask = process.umask(0o027);
  try {
    for (const folder of DEMO_FOLDERS) {
      const fresh = join(dir, `.${folder}.new`);
      rmSync(fresh, { recursive: true, force: true });
      mkdirSync(fresh, { mode: 0o750 });
      for (const f of files.filter((x) => x.folder === folder)) {
        writeFileSync(join(fresh, f.name), f.content, { mode: 0o640 });
      }
      const old = join(dir, `.${folder}.old`);
      rmSync(old, { recursive: true, force: true });
      try { renameSync(join(dir, folder), old); } catch { /* the first time */ }
      renameSync(fresh, join(dir, folder));
      rmSync(old, { recursive: true, force: true });
    }
  } finally {
    process.umask(umask);
  }
}

export function removeDemos(dir: string, folders: readonly DemoFolder[]): void {
  for (const folder of folders) rmSync(join(dir, folder), { recursive: true, force: true });
}
