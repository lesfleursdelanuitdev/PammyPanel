// What guides 15-18 tell her to do, in a browser, against the pages in
// tutorials/ as the guides have her put them on her website (docs/tutorials-
// plan.md T2). Run by test/run-tutorials-test.sh, which sets up nginx, PHP and
// the gate on 127.0.0.1:<port>; the browser thinks it is on https://pammy.org
// (every request is handed to that nginx with Host: pammy.org), so the secure
// sign-in cookie and the Origin checks behave exactly as on the real site.
//   node test/tutorials-browser.ts <nginx port> <public dir>
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { callJsonLine } from '@panel/core/jsonline';

const [port, pub, examples, adminSock] = [Number(process.argv[2]), process.argv[3]!, process.argv[4]!, process.argv[5]!];
// the panel's side of the gate: approving a comment, as the Comments tab does
const gateAdmin = <T>(req: Record<string, unknown>) => callJsonLine<T>(adminSock, req, 'gate');
let pass = 0;
let fail = 0;
const ok = (label: string) => { console.log(`  ok    ${label}`); pass++; };
const bad = (label: string) => { console.log(`  FAIL  ${label}`); fail++; };
const check = (cond: unknown, label: string, why = '') => (cond ? ok(label) : bad(why ? `${label} -- ${why}` : label));

// ------------------------------------------------------------------ the browser's way to pammy.org
function toNginx(method: string, path: string, headers: Record<string, string>, body: Buffer | null, host = 'pammy.org') {
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const h: Record<string, string> = { ...headers, host, 'cf-connecting-ip': '198.51.100.20' };
    delete h[':authority'];
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          out[k] = Array.isArray(v) ? v.join('\n') : String(v);
        }
        // nginx writes its own address into an absolute redirect
        if (out.location) out.location = out.location.replace(/^http:\/\/((?:panel\.)?pammy\.org)(:\d+)?/, 'https://$1');
        resolve({ status: res.statusCode ?? 500, headers: out, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// A request straight to the test's nginx, with the context's cookies: never
// Playwright's context.request, which skips the routing above and would go to
// the real pammy.org.
async function direct(context: BrowserContext, method: string, path: string, o: { form?: Record<string, string>; origin?: string; host?: string } = {}) {
  const host = o.host ?? 'pammy.org';
  const cookie = (await context.cookies(`https://${host}`)).map((c) => `${c.name}=${c.value}`).join('; ');
  const body = o.form ? Buffer.from(new URLSearchParams(o.form).toString()) : null;
  const res = await toNginx(method, path, {
    ...(cookie ? { cookie } : {}), ...(o.origin ? { origin: o.origin } : {}),
    ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length) } : {}),
  }, body, host);
  return { status: res.status, location: res.headers.location ?? '', text: res.body.toString('utf8') };
}

async function newContext(): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.route('**/*', async (route) => {
    const r = route.request();
    const url = new URL(r.url());
    if (url.hostname !== 'pammy.org' && url.hostname !== 'panel.pammy.org') return route.abort();
    const res = await toNginx(r.method(), `${url.pathname}${url.search}`, await r.allHeaders(), r.postDataBuffer(), url.hostname);
    // Chromium follows a redirect it was handed here without routing it again
    // (so it would leave for the real internet): a page that moves on instead,
    // whose next request is routed like any other. Cookies it sets still count.
    if (res.status >= 300 && res.status < 400 && res.headers.location && r.isNavigationRequest()) {
      const to = new URL(res.headers.location, url).href.replace(/"/g, '&quot;');
      const headers: Record<string, string> = { 'content-type': 'text/html' };
      if (res.headers['set-cookie']) headers['set-cookie'] = res.headers['set-cookie'];
      return route.fulfill({ status: 200, headers, body: `<meta http-equiv="refresh" content="0; url=${to}">` });
    }
    return route.fulfill({ status: res.status, headers: res.headers, body: res.body });
  });
  return context;
}

// every console error and failed script, per page
const troubles = new Map<Page, string[]>();
async function open(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage();
  troubles.set(page, []);
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) troubles.get(page)!.push(m.text()); });
  page.on('pageerror', (e) => troubles.get(page)!.push(String(e)));
  await page.goto(path.startsWith('https://') ? path : `https://pammy.org${path}`);
  await page.waitForLoadState('networkidle');
  return page;
}
const calm = (page: Page, label: string) => check(troubles.get(page)!.length === 0, `${label}: no errors in the console`, troubles.get(page)!.join(' | '));
const texts = (page: Page, selector: string) => page.locator(selector).allTextContents().then((t) => t.map((s) => s.trim()));

async function signIn(context: BrowserContext, folder: string, user: string, password: string): Promise<Page> {
  const page = await open(context, `/${folder}/`);
  // already in (signed in once, let into this folder too)
  if (page.url() === `https://pammy.org/${folder}/`) return page;
  // no login.html in the folder: the gate's built-in sign-in page
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(`https://pammy.org/${folder}/`);
  await page.waitForLoadState('networkidle');
  return page;
}

// No real name resolves in this browser: if anything slipped past the routing,
// it fails here instead of reaching the internet.
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
try {
  const PUBLISHED = ['Lemon cake <3 & more', 'The first beans', 'Hello, and welcome'];

  // ---------------------------------------------------------------- guide 15: the journal, HTML and JavaScript
  console.log('--- 15: a blog with HTML and JavaScript');
  {
    const visitor = await newContext();
    const list = await open(visitor, '/journal/');
    await list.locator('#posts h2').first().waitFor();
    check(JSON.stringify(await texts(list, '#posts h2')) === JSON.stringify(PUBLISHED), 'the published posts, newest first (a draft is not there)', JSON.stringify(await texts(list, '#posts h2')));
    check((await texts(list, '#posts .about'))[0] === 'By Olivia · 20 May 2026', 'each with its author and a readable date', (await texts(list, '#posts .about'))[0]);
    check((await list.locator('#posts h2 a').first().innerHTML()).includes('&lt;3 &amp;'), 'a title with < and & in it is shown as words, not HTML');
    calm(list, 'index.html');

    await list.getByRole('link', { name: 'The first beans' }).click();
    await list.waitForURL(/post\.html\?id=2$/);
    await list.locator('#writing h2').waitFor();
    check(await list.locator('#title').textContent() === 'The first beans' && await list.title() === 'The first beans', 'a title in the list opens that post, with its title in the tab');
    check(await list.locator('#writing h2').textContent() === 'What came up' && await list.locator('#writing table').count() === 1, 'its rich text is shown with its heading and table');
    check(await list.locator('#topics').textContent() === 'Garden', 'and its topics');

    // guide 15 PART 10: comments under the post, from the comment area journal-comments
    await list.getByLabel('Your name').fill('Olivia');
    await list.getByLabel('Your comment').fill('Lovely beans! <b>Save me some.</b>');
    await list.getByRole('button', { name: 'Send' }).click();
    await list.getByText('Thank you. Your comment will appear here once it has been approved.').waitFor();
    ok('a comment on the post is sent, and waits for her OK');
    const sent = (await gateAdmin<{ responses: { id: number; formName: string; thread: { id: string } | null }[] }>({ op: 'responses.list', kind: 'comments' }))
      .responses.filter((r) => r.formName === 'journal-comments');
    check(sent.length === 1 && sent[0]!.thread?.id === '2', 'it is filed under post 2 (its content-id)', JSON.stringify(sent));
    await gateAdmin({ op: 'response.approve', id: sent[0]!.id, approved: true, actor: 'pamela' });
    await list.reload();
    await list.locator('pammy-comments').getByText('Lovely beans!').waitFor();
    check(await list.locator('pammy-comments').getByText('<b>Save me some.</b>', { exact: false }).count() === 1, 'approved: it is under the post, as words (a tag in it stays text)');
    const other = await open(visitor, '/journal/post.html?id=3');
    await other.locator('pammy-comments').getByLabel('Your name').waitFor();
    check(await other.locator('pammy-comments').getByText('Lovely beans!').count() === 0, 'and only under that post: each post is its own conversation');
    calm(list, 'post.html');

    const draft = await open(visitor, '/journal/post.html?id=4');
    await draft.locator('#title', { hasText: 'Not here' }).waitFor();
    check(/no record/i.test(await draft.locator('#writing').textContent() ?? ''), 'an unpublished post is not there for anyone', await draft.locator('#writing').textContent() ?? '');
    const nothing = await open(visitor, '/journal/post.html');
    await nothing.locator('#title', { hasText: 'Not here' }).waitFor();
    ok('post.html with no id says so, rather than breaking');
    await visitor.close();
  }

  // ---------------------------------------------------------------- guide 16: the journal, PHP
  console.log('--- 16: the same blog in PHP');
  {
    const visitor = await newContext();
    const list = await open(visitor, '/journal-php/');
    check(JSON.stringify(await texts(list, '#posts h2')) === JSON.stringify(PUBLISHED), 'index.php: the published posts, newest first', (await list.content()).replace(/\s+/g, ' ').slice(0, 600));
    check((await texts(list, '#posts .about'))[0] === 'By Olivia · 20 May 2026', 'with author and date');
    const html = await list.content();
    check(html.includes('Lemon cake &lt;3 &amp; more') && !html.includes('<?php'), "a title's < and & come out as words; no PHP code in the page");
    await list.getByRole('link', { name: 'The first beans' }).click();
    await list.waitForURL(/post\.php\?id=2$/);
    check(await list.locator('.writing h2').textContent() === 'What came up' && await list.locator('.writing table').count() === 1, 'post.php: its rich text with heading and table');
    check(await list.locator('.topics').textContent() === 'Garden' && await list.title() === 'The first beans', 'its topics, and its title in the tab');
    await list.locator('pammy-comments').getByText('Lovely beans!').waitFor();
    ok('post.php: the same comments (the same comment area, the same post id), with a box to write one');
    check(await list.locator('pammy-comments').getByLabel('Your comment').count() === 1, 'and the box to write one');
    for (const q of ['?id=4', '?id=abc', '']) {
      const r = await direct(visitor, 'GET', `/journal-php/post.php${q}`);
      check(r.status === 404 && r.text.includes("That post isn't here"), `post.php${q || ' (no id)'} -> 404, "That post isn't here"`, String(r.status));
    }
    const api = await direct(visitor, 'GET', '/journal-php/api.php');
    check(api.status === 200 && api.text.trim() === '', 'api.php opened on its own is an empty page', `${api.status} ${api.text.slice(0, 100)}`);
    calm(list, 'PHP pages');
    await visitor.close();
  }

  // ---------------------------------------------------------------- guide 17: the to-do list, HTML and JavaScript
  console.log('--- 17: a to-do list with HTML and JavaScript');
  {
    const stranger = await newContext();
    const out = await direct(stranger, 'GET', '/todo/');
    check(out.status === 302 && /\/_pammy\/login\?/.test(out.location), 'not signed in: the folder sends you to sign in', `${out.status} ${out.location}`);
    const apiOut = await direct(stranger, 'GET', '/_pammy/api/data/postgres/todo/tasks');
    check(apiOut.status === 401, 'and the tasks are not there without signing in', String(apiOut.status));
    await stranger.close();

    const alice = await newContext();
    const page = await signIn(alice, 'todo', 'alice', 'alice-password-123');
    await page.locator('#tasks li').first().waitFor();
    check(await page.locator('#who').textContent() === 'alice', 'signed in: "Signed in as alice" (the username: the name is only for Pamela)');
    check((await texts(page, '#tasks li'))[0] === 'Nothing to do. Well done!', 'an empty list says so');
    for (const t of ['Buy milk', 'Water the beans', 'Ring <Olivia> & Sam']) {
      await page.getByLabel('Something to do').fill(t);
      await page.getByRole('button', { name: 'Add it' }).click();
      await page.locator('#tasks li span', { hasText: t }).waitFor();
    }
    check(JSON.stringify(await texts(page, '#tasks li span')) === JSON.stringify(['Buy milk', 'Water the beans', 'Ring <Olivia> & Sam']), 'three tasks added, in order, shown as words', JSON.stringify(await texts(page, '#tasks li span')));
    await page.getByRole('checkbox', { name: 'Buy milk' }).check();
    await page.locator('#tasks li.done', { hasText: 'Buy milk' }).waitFor();
    await page.getByRole('button', { name: 'Delete Water the beans' }).click();
    await page.locator('#tasks li span', { hasText: 'Water the beans' }).waitFor({ state: 'detached' });
    await page.reload();
    await page.locator('#tasks li.done').first().waitFor();
    check(JSON.stringify(await texts(page, '#tasks li span')) === JSON.stringify(['Buy milk', 'Ring <Olivia> & Sam']) && await page.getByRole('checkbox', { name: 'Buy milk' }).isChecked(),
      'ticked and deleted, and still so after a reload (it is in the database)');
    calm(page, 'todo/index.html');
    const mine = await page.evaluate(async () => (await (await fetch('/_pammy/api/data/postgres/todo/tasks')).json()).items);
    check(mine.every((t: { owner: string }) => t.owner === 'alice'), 'every one of them has owner alice, which the page never sent');

    const bob = await newContext();
    const his = await signIn(bob, 'todo', 'bob', 'bob-password-123');
    await his.locator('#tasks li').first().waitFor();
    check(await his.locator('#who').textContent() === 'bob' && (await texts(his, '#tasks li'))[0] === 'Nothing to do. Well done!', "bob sees his own list, empty -- not Alice's");
    const tricks = await his.evaluate(async (aliceTask) => {
      const post = (path: string, values: unknown) => fetch(`/_pammy/api/data/postgres/todo/tasks${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }),
      });
      return {
        change: (await post(`/${aliceTask}/save`, { title: 'Hacked' })).status,
        remove: (await post(`/${aliceTask}/delete`, {})).status,
        read: (await fetch(`/_pammy/api/data/postgres/todo/tasks/${aliceTask}`)).status,
        made: (await (await post('/new', { title: 'Mine, honest', owner: 'alice' })).json()).item.owner,
      };
    }, mine[0].id);
    check(tricks.change === 404 && tricks.remove === 404 && tricks.read === 404, "bob can't read, change or delete Alice's task, even by asking for it", JSON.stringify(tricks));
    check(tricks.made === 'bob', 'and a task he adds is his, whatever owner he sends', tricks.made);
    await his.reload();
    await page.reload();
    await page.locator('#tasks li').first().waitFor();
    check(!(await texts(page, '#tasks li span')).includes('Mine, honest') && (await texts(page, '#tasks li span')).includes('Buy milk'), "Alice's list is untouched");
    await bob.close();

    // ---------------------------------------------------------------- guide 18: the to-do list, PHP
    console.log('--- 18: the same to-do list in PHP');
    const php = await signIn(alice, 'todo-php', 'alice', 'alice-password-123');
    check((await php.locator('.who').textContent())?.startsWith('Signed in as alice.'), 'index.php knows who is signed in');
    check(JSON.stringify(await texts(php, '#tasks li span')) === JSON.stringify(['Buy milk', 'Ring <Olivia> & Sam']), 'the same tasks as the JavaScript page (the same database)', JSON.stringify(await texts(php, '#tasks li span')));
    check(!(await texts(php, '#tasks li span')).includes('Mine, honest'), "and not bob's");
    await php.getByLabel('Something to do').fill('Post a letter');
    await php.getByRole('button', { name: 'Add it' }).click();
    await php.locator('#tasks li span', { hasText: 'Post a letter' }).waitFor();
    await php.getByRole('button', { name: 'Done: Post a letter' }).click();
    await php.locator('#tasks li.done', { hasText: 'Post a letter' }).waitFor();
    await php.getByRole('button', { name: 'Not done: Buy milk' }).click();
    await php.locator('#tasks li:not(.done)', { hasText: 'Buy milk' }).waitFor();
    await php.getByRole('button', { name: 'Delete Ring <Olivia> & Sam' }).click();
    await php.locator('#tasks li span', { hasText: 'Ring' }).waitFor({ state: 'detached' });
    check(JSON.stringify(await texts(php, '#tasks li span')) === JSON.stringify(['Buy milk', 'Post a letter']), 'added, ticked, unticked and deleted with the buttons', JSON.stringify(await texts(php, '#tasks li span')));
    check(await php.url() === 'https://pammy.org/todo-php/', 'after each button, back at the list (reloading it sends nothing twice)', php.url());
    calm(php, 'todo-php/index.php');

    const back = await open(alice, '/todo/');
    await back.locator('#tasks li.done').first().waitFor();
    check(JSON.stringify(await texts(back, '#tasks li span')) === JSON.stringify(['Buy milk', 'Post a letter']) && await back.getByRole('checkbox', { name: 'Post a letter' }).isChecked(), 'and the JavaScript page sees the same', JSON.stringify(await texts(back, '#tasks li span')));

    // someone else's task number, sent from the page: nothing happens
    const bob2 = await newContext();
    const bobPhp = await signIn(bob2, 'todo-php', 'bob', 'bob-password-123');
    const alicesId = (await back.evaluate(async () => (await (await fetch('/_pammy/api/data/postgres/todo/tasks')).json()).items))[0].id;
    // (redirect: 'manual': the answer is "back to the list", which the reload below does)
    const sent = await bobPhp.evaluate(async (id) => (await fetch('./', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ do: 'delete', id: String(id) }) })).type, alicesId);
    await bobPhp.reload();
    check(sent === 'opaqueredirect' && JSON.stringify(await texts(bobPhp, '#tasks li span')) === JSON.stringify(['Mine, honest']), "bob sees only his; sending Alice's task number deletes nothing", `${sent} ${JSON.stringify(await texts(bobPhp, '#tasks li span'))}`);
    const still = await open(alice, '/todo-php/');
    check((await texts(still, '#tasks li span')).includes('Buy milk'), "Alice's task is still there");
    // a change from another site's page
    const cross = await bobPhp.evaluate(async () => {
      const r = await fetch('/todo-php/', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'do=add&title=x' });
      return r.type;
    });
    await bobPhp.reload();
    check(cross === 'opaqueredirect' && (await texts(bobPhp, '#tasks li span')).includes('x'), '(a change from its own page is fine)', cross);
    const forged = await direct(bob2, 'POST', '/todo-php/', { form: { do: 'add', title: 'From elsewhere' }, origin: 'https://evil.example' });
    check(forged.status === 403, 'a change sent from another website is refused', String(forged.status));
    const outside = await newContext();
    const noOne = await direct(outside, 'GET', '/todo-php/');
    check(noOne.status === 302, 'not signed in: sign in first, the PHP never runs', String(noOne.status));
    const settings = await direct(bob2, 'GET', '/todo-php/settings.php');
    const key = readFileSync(join(pub, 'todo-php', 'settings.php'), 'utf8').match(/return '([^']+)'/)?.[1] ?? 'no key?';
    check(key !== 'PUT-YOUR-KEY-HERE' && settings.status === 200 && !settings.text.includes(key) && settings.text.trim() === '', 'settings.php opened in the browser: an empty page, never the key', `${settings.status} ${settings.text.slice(0, 80)}`);
    await Promise.all([alice.close(), bob2.close(), outside.close()]);
  }

  // ---------------------------------------------------------------- the panel's tutorial examples: the PHP ones (docs/tutorial-examples-plan.md)
  console.log("--- the tutorial examples' PHP pages, on panel.pammy.org");
  {
    // signed in to the panel as alice (the panel's "who" is stood in for by run-tutorials-test.sh)
    const as = async (who: string | null) => {
      const c = await newContext();
      if (who) await c.addCookies([{ name: 'panel', value: who, domain: 'panel.pammy.org', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
      return c;
    };
    const alice = await as('alice');
    const list = await open(alice, 'https://panel.pammy.org/tutorial-examples/journal-php/');
    check(JSON.stringify(await texts(list, '#posts h2')) === JSON.stringify(PUBLISHED), 'the PHP journal example: the example database\'s published posts', (await list.content()).replace(/\s+/g, ' ').slice(0, 300));
    await list.getByRole('link', { name: 'The first beans' }).click();
    await list.waitForURL(/post\.php\?id=2$/);
    check(await list.locator('.writing h2').textContent() === 'What came up', 'and one post, with its rich text');
    check(await list.locator('pammy-comments[name="example-journal-comments"][content-id="2"]').count() === 1, "its comments: the example's own comment area, for this post");
    const todo = await open(alice, 'https://panel.pammy.org/tutorial-examples/todo-php/');
    check((await todo.locator('.who').textContent())?.startsWith('Signed in as alice.'), 'the PHP to-do example: PAMMY_USER is the account signed in to the panel');
    await todo.getByLabel('Something to do').fill('Example task');
    await todo.getByRole('button', { name: 'Add it' }).click();
    await todo.locator('#tasks li span', { hasText: 'Example task' }).waitFor();
    await todo.getByRole('button', { name: 'Done: Example task' }).click();
    await todo.locator('#tasks li.done', { hasText: 'Example task' }).waitFor();
    ok('adds and ticks off, in the example database (reading example_todo, with the examples\' own key)');
    const herList = await open(alice, '/todo-php/');
    check(!(await texts(herList, '#tasks li span')).includes('Example task'), "and not in her own to-do list: the example's database is its own");
    const bob = await as('bob');
    const his = await open(bob, 'https://panel.pammy.org/tutorial-examples/todo-php/');
    check((await texts(his, '#tasks li'))[0] === 'Nothing to do. Well done!', "another account sees its own list, not alice's");
    const nobody = await as(null);
    const out = await direct(nobody, 'GET', '/tutorial-examples/todo-php/', { host: 'panel.pammy.org' });
    check(out.status === 401 && !out.text.includes('Signed in'), 'not signed in to the panel: 401, and PHP never runs', String(out.status));
    const probe = await direct(alice, 'GET', '/tutorial-examples/journal-php/probe.php', { host: 'panel.pammy.org' });
    check(probe.text.includes('user=[alice]') && probe.text.includes('cookie=[]'), "PHP is told the account, and never sees the panel's cookie", probe.text);
    check(probe.text.includes('website=no') && probe.text.includes('own=yes'), 'the examples\' pool reads only the examples, never her website', probe.text);
    const settings = await direct(alice, 'GET', '/tutorial-examples/todo-php/settings.php', { host: 'panel.pammy.org' });
    const key = readFileSync(join(examples, 'todo-php', 'settings.php'), 'utf8').match(/return '([^']+)'/)?.[1] ?? 'no key?';
    check(settings.status === 200 && settings.text.trim() === '' && !settings.text.includes(key), "settings.php: an empty page, never the examples' key");
    // (nginx resolves ../ before it looks: that is journal-php/api.php, which prints nothing)
    const dots = await direct(alice, 'GET', '/tutorial-examples/todo-php/../journal-php/api.php', { host: 'panel.pammy.org' });
    check(dots.status === 200 && dots.text.trim() === '', '../ in the address is resolved first, and reaches nothing new', `${dots.status} ${dots.text.slice(0, 60)}`);
    for (const u of ['/tutorial-examples/journal-php/api.PHP', '/tutorial-examples/journal/x.php', '/tutorial-examples/todo-php/sub/x.php', '/tutorial-examples/other/index.php']) {
      const r = await direct(alice, 'GET', u, { host: 'panel.pammy.org' });
      check(r.status === 404 && !r.text.includes('<?php'), `${u} -> 404, never run or sent`, `${r.status} ${r.text.slice(0, 60)}`);
    }
    await Promise.all([alice.close(), bob.close(), nobody.close()]);
  }
} catch (e) {
  bad(`stopped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
} finally {
  await browser.close();
}
console.log(`\n  tutorials test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
