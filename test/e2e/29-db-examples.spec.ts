// The database examples in a browser (docs/db-examples-plan.md). The engines are
// stood in for by test/e2e/server.ts, and the gate is real: the page in the
// frame reads the example database through the data API with no key, which is
// the whole point of "Anyone can read these".
import { expect, notice, test } from './fixtures.ts';
import { routeGate } from './gate.ts';

test('the recipe book: set up, working in its frame, and one of her own made from it', async ({ page }) => {
  await routeGate(page);
  await page.goto('/databases/examples');
  await page.getByRole('button', { name: /^Recipe book/ }).click();
  await expect(page).toHaveURL('/databases/examples/recipes');
  await page.getByRole('button', { name: 'Set up the recipe book' }).click();
  await expect(notice(page)).toContainText('The recipe book is ready');

  // the public page, reading the database without a key
  const book = page.frameLocator('iframe[title="The Recipe book example"]');
  await expect(book.locator('.card')).toHaveCount(8);
  await expect(book.locator('.card').first()).toContainText('Banana and walnut bread');
  await expect(book.locator('.card').first()).toContainText('Nana Rose', { useInnerText: true });
  await expect(book.locator('.card img').first()).toHaveAttribute('src', './pictures/banana-bread.jpg');
  // a tag narrows it; the search box too
  await book.getByRole('button', { name: 'soup', exact: true }).click();
  await expect(book.locator('.card')).toHaveCount(1);
  await book.getByRole('button', { name: 'Everything' }).click();
  await book.getByLabel('Find a recipe').fill('lemon');
  await expect(book.locator('.card')).toHaveCount(1);
  // one recipe: its ingredients are their own table, asked for by recipe
  await book.locator('.card a').first().click();
  await expect(book.locator('.recipe .title')).toHaveText('Lemon drizzle loaf');
  await expect(book.locator('.recipe .ingredients li')).toHaveCount(6);
  await expect(book.locator('.recipe .method li').first()).toContainText('Heat the oven');

  // it is a database like any other: open, badged, and not deletable
  await page.goto('/databases');
  const row = page.getByRole('listitem').filter({ hasText: 'example_recipes' });
  await expect(row).toContainText('example');
  await expect(row.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await row.getByRole('link', { name: 'The example' }).click();
  await expect(page).toHaveURL('/databases/examples/recipes');

  // "Make my own", with the sample rows
  await page.getByLabel('Database name').fill('our_recipes');
  await page.getByLabel('Page name').fill('our-recipes.html');
  await page.getByText('Copy the sample records too').click();
  await page.getByRole('button', { name: 'Make my own recipe book' }).click();
  await expect(notice(page)).toContainText('Recipe book is yours');
  await expect(page.getByRole('link', { name: /our-recipes\.html$/ }).first()).toBeVisible();
  // hers is in the menu; the example is not
  const apps = (await (await page.request.get('/api/apps')).json()).apps as { title: string }[];
  expect(apps.map((x) => x.title)).toContain('Recipe book');
  expect(apps.map((x) => x.title)).not.toContain('Recipe book (example)');
});

test('the blog: only published posts are on the page, and each has its own', async ({ page }) => {
  await routeGate(page);
  await page.goto('/databases/examples/blog');
  await page.getByRole('button', { name: 'Set up the blog' }).click();
  await expect(notice(page)).toContainText('The blog is ready');
  const blog = page.frameLocator('iframe[title="The Blog example"]');
  // fourteen posts in the database, one not published
  await expect(blog.locator('.item')).toHaveCount(13);
  await expect(blog.locator('.item').first()).toContainText('The first frost');
  await expect(blog.locator('.posts')).not.toContainText('Plans for the autumn');
  // the list says how many comments a post has, and nothing for none
  const garden = blog.locator('.item').filter({ hasText: 'Starting a kitchen garden' });
  await expect(garden.locator('.comment-count')).toHaveText('3 comments');
  await expect(blog.locator('.item').filter({ hasText: 'Everyone warned us' }).locator('.comment-count')).toHaveText('1 comment');
  await expect(blog.locator('.item').filter({ hasText: 'The first frost' }).locator('.comment-count')).toHaveText('');
  await blog.getByRole('button', { name: 'travel' }).click();
  await expect(blog.locator('.item')).toHaveCount(2);
  await blog.getByRole('link', { name: 'A weekend by the sea' }).click();
  await expect(blog.locator('.post .title')).toHaveText('A weekend by the sea');
  await expect(blog.locator('.post .byline')).toContainText('By Jo');
  await expect(blog.locator('.post .body p')).toHaveCount(3);
  // every post has its own conversation, with nothing to set up per post
  await expect(blog.locator('.post .pammy-comment-count')).toHaveText('No comments yet.');
  await expect(blog.locator('.post .pammy-comment-form')).toBeVisible();
  await blog.getByRole('link', { name: 'All posts' }).click();
  await blog.getByRole('button', { name: 'Everything' }).click();
  await blog.getByRole('link', { name: 'Starting a kitchen garden' }).click();
  await expect(blog.locator('.post .pammy-comment')).toHaveCount(3);
  await expect(blog.locator('.post .pammy-comment-author').first()).toHaveText('Sam');
});
