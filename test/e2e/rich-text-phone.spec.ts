// The rich-text editor on a phone (docs/rich-text-plan.md T21-T25), in the
// phone project (Pixel 7, touch). What an emulator cannot prove -- a real
// on-screen keyboard, autocorrect, swipe typing, dictation (T26) -- is on the
// run sheet as a check by hand on a real iPhone and Android phone.
import { expect, test } from './fixtures.ts';

const NEW_POST = '/app/mariadb/example_blog/posts/new';

test('on a phone the rich-text editor fits, with one row of big buttons and 16px writing', async ({ page }) => {
  await page.goto(NEW_POST);
  const body = page.getByRole('textbox', { name: 'Body' });
  const tools = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(body).toBeVisible();

  // 16px, or iPhone Safari zooms the page when she taps in (T21)
  expect(await body.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), 'the writing').toBeGreaterThanOrEqual(16);

  // one row: the everyday ones and More; the rest wait under More (T23)
  const names = await tools.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(names).toEqual(['Paragraph style', 'Bold', 'Italic', 'Bulleted list', 'Add a link', 'Add a table', 'More']);
  const [row, fits] = await tools.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(row, 'the row fits without scrolling').toBeLessThanOrEqual(fits);
  const boxes = await tools.getByRole('button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height, top: r.top })));
  for (const b of boxes) {
    expect(b.w, 'at least 44px wide').toBeGreaterThanOrEqual(44);
    expect(b.h, 'and 44px tall').toBeGreaterThanOrEqual(44);
  }
  expect(new Set(boxes.map((b) => Math.round(b.top))).size, 'all on one row').toBe(1);
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, 'the page does not scroll sideways').toBeLessThanOrEqual(width);
});

test('on a phone the paragraph style is chosen from a sheet', async ({ page }) => {
  await page.goto(NEW_POST);
  const body = page.getByRole('textbox', { name: 'Body' });
  await body.tap();
  await page.keyboard.type('A title');
  await page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Paragraph style' }).tap();
  await page.getByRole('dialog', { name: 'Paragraph style' }).getByRole('button', { name: 'Heading', exact: true }).tap();
  await expect(body.getByRole('heading', { name: 'A title' })).toBeVisible();
});

test('on a phone the toolbar keeps the writing focused, and More opens from the bottom of the screen', async ({ page }) => {
  await page.goto(NEW_POST);
  const body = page.getByRole('textbox', { name: 'Body' });
  const tools = page.getByRole('toolbar', { name: 'Formatting' });
  await body.tap();
  await page.keyboard.type('Soft and ');
  // a tap on Bold does not take the focus: the keyboard would close (T23)
  await tools.getByRole('button', { name: 'Bold' }).tap();
  await expect(body).toBeFocused();
  await page.keyboard.type('bold');
  await expect(body.locator('strong')).toHaveText('bold');

  await tools.getByRole('button', { name: 'More' }).tap();
  const more = page.getByRole('dialog', { name: 'More' });
  await expect(more).toBeVisible();
  const [box, vp] = [await more.boundingBox(), page.viewportSize()!];
  expect(Math.round(box!.width)).toBe(vp.width);
  expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(vp.height - 1);
  for (const b of await more.getByRole('button').all()) {
    const r = await b.boundingBox();
    expect(r!.height).toBeGreaterThanOrEqual(44);
  }
  await more.getByRole('button', { name: 'Numbered list' }).tap();
  await expect(more).toBeHidden();
  await expect(body.locator('ol li')).toHaveCount(1);
});

test('on a phone a wide table scrolls inside the box, not the page', async ({ page }) => {
  await page.goto(NEW_POST);
  const body = page.getByRole('textbox', { name: 'Body' });
  const tools = page.getByRole('toolbar', { name: 'Formatting' });
  await body.tap();
  await tools.getByRole('button', { name: 'Add a table' }).tap();
  await expect(body.locator('table tr')).toHaveCount(3);
  // wider than the screen: seven columns
  for (let i = 0; i < 4; i++) {
    await tools.getByRole('button', { name: 'Table choices' }).tap();
    await page.getByRole('dialog', { name: 'Table' }).getByRole('button', { name: 'Add a column on the right' }).tap();
  }
  await expect(body.locator('table tr').first().locator('th')).toHaveCount(7);
  const table = body.locator('table');
  const [inner, shown] = await table.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(inner, 'the table is wider than its box').toBeGreaterThan(shown);
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, 'but the page is not').toBeLessThanOrEqual(width);
});

test('on a phone the link sheet has the address keyboard and big targets', async ({ page }) => {
  await page.goto(NEW_POST);
  const body = page.getByRole('textbox', { name: 'Body' });
  await body.tap();
  await page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Add a link' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Add a link' });
  const where = sheet.getByLabel('Where it goes');
  await expect(where).toHaveAttribute('inputmode', 'url');
  expect(await where.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), 'the address box').toBeGreaterThanOrEqual(16);
  expect((await sheet.getByRole('button', { name: 'Add the link' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await where.fill('/garden.html');
  await sheet.getByLabel('Words to show').fill('the garden page');
  await sheet.getByRole('button', { name: 'Add the link' }).tap();
  await expect(body.getByRole('link', { name: 'the garden page' })).toHaveAttribute('href', '/garden.html');
});

test('on a phone the toolbar stays in reach down a long post', async ({ page }) => {
  await page.goto(NEW_POST);
  const body = page.getByRole('textbox', { name: 'Body' });
  const tools = page.getByRole('toolbar', { name: 'Formatting' });
  await body.tap();
  for (let i = 0; i < 40; i++) { await page.keyboard.type(`Paragraph ${i}`); await page.keyboard.press('Enter'); }
  await expect(body.locator('p')).toHaveCount(41);
  // down to the middle of the long post, well below where the toolbar began
  await body.evaluate((el) => { const r = el.getBoundingClientRect(); window.scrollBy(0, r.top + r.height / 2); });
  await expect(tools).toBeInViewport();
  const top = (await tools.boundingBox())!.y;
  expect(top, 'just under the panel\'s header').toBeGreaterThanOrEqual(55);
  expect(top).toBeLessThanOrEqual(60);
});
