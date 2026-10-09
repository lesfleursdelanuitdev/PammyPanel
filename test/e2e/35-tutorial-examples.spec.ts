// The tutorial examples in a browser (docs/tutorial-examples-plan.md): the
// finished pages of guides 15 and 17 on the panel's own address, framed on its
// page, asking the panel -- which asks the real gate -- for the example
// databases. The engines are stood in for by test/e2e/server.ts. The PHP ones
// (16, 18) need nginx and PHP: test/run-tutorials-test.sh drives those.
import { expect, notice, test } from './fixtures.ts';

test('the tutorial examples: set up, the journal and the to-do list working in their frames, on the panel only', async ({ page }) => {
  // no nginx or PHP here: the PHP examples' frames get a stand-in (run-tutorials-test.sh has the real thing)
  await page.route(/\/tutorial-examples\/(journal|todo)-php\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>PHP example</p>' }));
  await page.goto('/databases/tutorial-examples');
  await expect(page.getByRole('heading', { name: 'Tutorial examples', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Set up the tutorial examples' }).click();
  await expect(notice(page)).toContainText('The tutorial examples are ready');

  // guide 15: the published posts, newest first, and one of them opened
  const journal = page.frameLocator('iframe[title="A blog with HTML and JavaScript (example)"]');
  await expect(journal.locator('#posts h2')).toHaveText(['Lemon cake', 'The first beans', 'Hello, and welcome']);
  await expect(journal.locator('#posts .about').first()).toHaveText('By Olivia · 20 May 2026');
  await journal.getByRole('link', { name: 'The first beans' }).click();
  await expect(journal.locator('#title')).toHaveText('The first beans');
  await expect(journal.locator('#writing h2')).toHaveText('What came up');
  await expect(journal.locator('#writing table')).toHaveCount(1);
  await expect(journal.locator('#topics')).toHaveText('Garden');
  // its comments: the example's own comment area, with its sample comments, and a box to write one
  const comments = journal.locator('pammy-comments[name="example-journal-comments"]');
  await expect(comments.getByText('They look wonderful. Save me a handful for the soup?')).toBeVisible();
  await expect(comments.getByText('Ours are only just through.', { exact: false })).toBeVisible();
  await comments.getByLabel('Your name').fill('Pamela');
  await comments.getByLabel('Your comment').fill('Trying the comments out.');
  await comments.getByRole('button', { name: 'Send' }).click();
  await expect(comments.getByText('Thank you. Your comment will appear here once it has been approved.')).toBeVisible();
  // only that area goes through the panel
  expect((await page.request.get('/_pammy/comments/some-other-area?page=/x&content=1')).status()).toBe(404);

  // guide 17: a list of one's own, as the account signed in to the panel
  const todo = page.frameLocator('iframe[title="A to-do list with HTML and JavaScript (example)"]');
  await expect(todo.locator('#who')).toHaveText('pamela');
  await expect(todo.locator('#tasks li')).toHaveText(['Nothing to do. Well done!']);
  await todo.getByLabel('Something to do').fill('Water the beans');
  await todo.getByRole('button', { name: 'Add it' }).click();
  await expect(todo.locator('#tasks li span')).toHaveText(['Water the beans']);
  await todo.getByRole('checkbox', { name: 'Water the beans' }).check();
  await expect(todo.locator('#tasks li.done')).toHaveCount(1);
  await page.reload();
  await expect(page.frameLocator('iframe[title="A to-do list with HTML and JavaScript (example)"]').locator('#tasks li.done span')).toHaveText(['Water the beans']);

  // what the frames ask, asked directly: an owner sent along is ignored, and a
  // task that isn't this account's is not there
  const api = '/_pammy/api/data/postgres/example_todo/tasks';
  const made = await (await page.request.post(`${api}/new`, { data: { values: { title: 'Not yours', owner: 'someone-else' } }, headers: { origin: new URL(page.url()).origin } })).json();
  expect(made.item.owner).toBe('pamela');
  const list = await (await page.request.get(`${api}?where.owner=someone-else`)).json();
  expect(list.items.every((t: { owner: string }) => t.owner === 'pamela')).toBe(true);
  expect((await page.request.get(`${api}/99999`)).status()).toBe(404);
  // the pages themselves only for someone signed in to the panel, and never a .php file as text
  expect((await page.request.get('/tutorial-examples/todo-php/settings.php')).status()).toBe(404);
  expect((await page.request.get('/tutorial-examples/journal/..%2F..%2Fetc/passwd')).status()).toBe(404);
  // (a context of its own, and without this test's sign-in)
  const outside = await page.context().browser()!.newContext({ storageState: { cookies: [], origins: [] } });
  const stranger = await outside.request.get(new URL('/tutorial-examples/journal/', page.url()).href);
  expect(stranger.status()).toBe(401);
  expect((await outside.request.get(new URL(`${api}`, page.url()).href)).status()).toBe(401);
  await outside.close();

  // its databases are the panel's examples: badged, not deletable, not in the menu
  await page.goto('/databases');
  const row = page.getByRole('listitem').filter({ hasText: 'example_journal' });
  await expect(row).toContainText('example');
  await expect(row.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await row.getByRole('link', { name: 'The example' }).click();
  await expect(page).toHaveURL('/databases/tutorial-examples');
  const apps = (await (await page.request.get('/api/apps')).json()).apps as { title: string }[];
  expect(apps.map((x) => x.title)).not.toContain('Journal (tutorial example)');
});
