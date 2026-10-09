// Rich text in a browser (docs/rich-text-plan.md), on the blog example 29 set
// up: the choice on the field settings, writing a post with a heading, a list,
// a link and a table, pasting from a word processor, and the example page
// showing the formatting. The fixture fails the test on any CSP violation --
// which is what proves the editor's styles are not added as a <style> the
// panel's policy would refuse.
import { expect, notice, test, confirmDialog } from './fixtures.ts';
import { routeGate } from './gate.ts';

const APP = '/app/mariadb/example_blog/posts';

test('rich text: chosen per field, and only where it fits', async ({ page }) => {
  await page.goto('/databases/mariadb/example_blog/app/posts');
  await expect(page.locator('#ctl-body')).toHaveValue('rich');
  // short text and connections are never offered it
  await expect(page.locator('#ctl-title option[value="rich"]')).toHaveCount(0);
  await expect(page.locator('#ctl-author_id option[value="rich"]')).toHaveCount(0);
  await expect(page.locator('#ctl-summary option[value="rich"]')).toHaveCount(1, { timeout: 1000 });

  // switching back to plain writing asks first, and No leaves it alone (T12)
  await page.locator('#ctl-body').selectOption('paragraph');
  await expect(confirmDialog(page)).toContainText('Stop using rich text for Body?');
  await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#ctl-body')).toHaveValue('rich');
});

test('rich text: a post with a heading, a list, a link and a table, saved clean and opened again', async ({ page }) => {
  await page.goto(`${APP}/new`);
  await page.getByLabel('Title').fill('Rich post');
  await page.getByLabel('Address').fill('rich-post');
  const body = page.getByRole('textbox', { name: 'Body' });
  const tools = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(body).toBeVisible();

  await body.click();
  await tools.getByLabel('Paragraph style').selectOption('h2');
  // choosing a style hands the writing its focus back
  await expect(body).toBeFocused();
  await page.keyboard.type('What we planted');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Four beds, ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('all new');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.press('Enter');
  await tools.getByRole('button', { name: 'Bulleted list' }).click();
  await page.keyboard.type('herbs');
  await page.keyboard.press('Enter');
  await page.keyboard.type('salad');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  // a link, with no words selected: the sheet asks for the words too
  await tools.getByRole('button', { name: 'Add a link' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a link' });
  await sheet.getByLabel('Where it goes').fill('javascript:alert(1)');
  await sheet.getByRole('button', { name: 'Add the link' }).click();
  await expect(sheet).toContainText('A link can go to a web address');
  await sheet.getByLabel('Where it goes').fill('example.org');
  await sheet.getByLabel('Words to show').fill('our supplier');
  await sheet.getByRole('button', { name: 'Add the link' }).click();
  await expect(sheet).toBeHidden();
  await expect(body.getByRole('link', { name: 'our supplier' })).toHaveAttribute('href', 'https://example.org');

  // a table: inserted with a header row, then a row added from its choices
  await page.keyboard.press('Enter');
  await tools.getByRole('button', { name: 'Add a table' }).click();
  await expect(body.locator('table tr')).toHaveCount(3);
  await page.keyboard.type('Bed');
  await tools.getByRole('button', { name: 'Table choices' }).click();
  await page.getByRole('dialog', { name: 'Table' }).getByRole('button', { name: 'Add a row below' }).click();
  await expect(body.locator('table tr')).toHaveCount(4);

  await page.getByRole('button', { name: /Add this Post/ }).click();
  await expect(notice(page)).toContainText('Post added.');

  // what was stored: the cleaner's HTML, with the link's rel decided by the panel
  const list = await (await page.request.get('/api/app/mariadb/example_blog/posts?search=Rich%20post')).json();
  const id = list.items.find((x: { title: string }) => x.title === 'Rich post').id;
  const one = await (await page.request.get(`/api/app/mariadb/example_blog/posts/one?id=${id}`)).json();
  const html = one.row.body as string;
  expect(html).toContain('<h2>What we planted</h2>');
  expect(html).toContain('<strong>all new</strong>');
  expect(html).toMatch(/<ul><li><p>herbs<\/p><\/li><li><p>salad<\/p><\/li><\/ul>/);
  expect(html).toContain('<a href="https://example.org" rel="noopener noreferrer nofollow">our supplier</a>');
  expect(html).toMatch(/<table><tbody><tr><th><p>Bed<\/p><\/th>/);
  expect(html).not.toMatch(/style=|colgroup|min-width/);
  // and the list shows words, not HTML
  expect(list.items.find((x: { id: number }) => x.id === id).body).toMatch(/^What we planted Four beds, all new herbs salad our supplier Bed/);

  // opened again: the same, in the editor
  await page.goto(`${APP}/edit?id=${id}`);
  await expect(body.getByRole('heading', { name: 'What we planted' })).toBeVisible();
  await expect(body.locator('table tr')).toHaveCount(4);
  await expect(body.locator('li')).toHaveText(['herbs', 'salad']);

  await page.request.post('/api/app/mariadb/example_blog/posts/delete', { data: { where: { id } }, headers: { origin: new URL(page.url()).origin } });
});

test('rich text: pasting from a word processor keeps the list and drops the colours and pictures', async ({ page }) => {
  await page.goto(`${APP}/new`);
  const body = page.getByRole('textbox', { name: 'Body' });
  await body.click();
  await body.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/html', '<meta charset="utf-8"><p class="MsoNormal" style="color:red"><span style="font-family:\'Comic Sans MS\'">Coloured words</span></p>'
      + '<ul><li style="mso-list:l0">kept</li></ul><img src="https://tracker.example/pixel.gif"><script>window.pasted = 1</script>');
    data.setData('text/plain', 'Coloured words\nkept');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(body.locator('li')).toHaveText(['kept']);
  await expect(body).toContainText('Coloured words');
  const inside = await body.innerHTML();
  expect(inside).not.toMatch(/style=|<img|<span|MsoNormal|<script/);
  expect(await page.evaluate(() => (window as unknown as { pasted?: number }).pasted)).toBeUndefined();
});

test('rich text: the blog example shows a post\'s formatting, its table included', async ({ page }) => {
  await routeGate(page);
  await page.goto('/databases/examples/blog');
  const blog = page.frameLocator('iframe[title="The Blog example"]');
  await blog.getByRole('link', { name: 'Starting a kitchen garden' }).click();
  await expect(blog.locator('.post .title')).toHaveText('Starting a kitchen garden');
  await expect(blog.locator('.post .body h3')).toHaveText('What went where');
  await expect(blog.locator('.post .body table tr')).toHaveCount(5);
  await expect(blog.locator('.post .body strong')).toHaveText('Ideas welcome.');
  // the writing itself is still paragraphs, three of them before the table
  await expect(blog.locator('.post .body > p')).toHaveCount(3);
});
