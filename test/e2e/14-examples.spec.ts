// The worked examples: the page in its frame is the real one, served by the
// gate on its own port, so signing the guest book here really does put an entry
// in Responses -- and approving it really does put it on the page.
import { routeGate } from './gate.ts';
import { expect, notice, test } from './fixtures.ts';

test.beforeEach(async ({ page }) => routeGate(page));

test('the guest book example works end to end: sign it, approve it, see it', async ({ page }) => {
  await page.goto('/examples');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Form examples');
  await page.getByRole('button', { name: /Guest book/ }).click();
  await expect(page).toHaveURL('/examples/guestbook');

  // the live page, in its frame
  const frame = page.frameLocator('iframe[title="The Guest book example"]');
  await expect(frame.getByRole('heading', { name: 'Guest book' })).toBeVisible();
  await expect(frame.getByText('What a lovely afternoon')).toBeVisible();          // a sample entry, already approved
  await expect(frame.getByText('Rose')).toBeVisible();

  // its tutorial is a click away, and it is the right one
  await expect(page.getByRole('link', { name: /Part 12 of the Forms guide: a guest book/ })).toHaveAttribute('href', '/help/forms/part-12');

  // sign it, as a visitor would
  await frame.getByLabel('Your name').fill('Auntie Vi');
  await frame.getByLabel('Your message').fill('Hello from the panel!');
  await frame.getByRole('button', { name: 'Sign the book' }).click();
  await expect(frame.getByText('Thank you for signing')).toBeVisible();

  // it is waiting in Responses, and not on the page yet
  await page.reload();
  await expect(page.frameLocator('iframe[title="The Guest book example"]').getByText('Hello from the panel!')).toHaveCount(0);
  await expect(page.getByText('1 response waiting to be approved')).toBeVisible();

  await page.getByRole('link', { name: 'Responses' }).first().click();
  await expect(page.getByText('Auntie Vi')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(notice(page)).toContainText('Approved');

  // and now it is on the page
  await page.goto('/examples/guestbook');
  await expect(page.frameLocator('iframe[title="The Guest book example"]').getByText('Hello from the panel!')).toBeVisible();
});

test('put an example on her website, and put the example back as it was', async ({ page }) => {
  await page.goto('/examples/pinboard');
  const frame = page.frameLocator('iframe[title="The Pinboard example"]');
  await expect(frame.getByText('damson jam')).toBeVisible();

  // her own copy: a new form of hers, in a folder she picks
  await page.getByRole('combobox', { name: 'Which folder' }).fill('recipes');
  await page.getByRole('option', { name: /recipes/ }).first().click();
  await page.getByLabel('Page name').fill('notes.html');
  await page.getByLabel('Name for the new form').fill('recipe-notes');
  await page.getByRole('button', { name: 'Put it on my website' }).click();
  await expect(page.getByRole('heading', { name: "It's on your website" })).toBeVisible();
  await expect(page.getByRole('link', { name: /\/recipes\/notes\.html$/ })).toBeVisible();
  await expect(page.getByText('Anyone can read the approved responses')).toBeVisible();

  // it is hers now: an ordinary form, on the Forms tab, with the example's questions
  await page.goto('/forms');
  const card = page.locator('article').filter({ hasText: 'recipe-notes' });
  await expect(card.getByText('Pinboard')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Delete' })).toBeVisible();

  // the example itself can never be deleted, only put back
  const example = page.locator('article').filter({ hasText: 'example-pinboard' });
  await expect(example.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await example.getByRole('button', { name: 'Put it back as it was' }).click();
  await page.getByRole('button', { name: 'Put it back' }).click();
  await expect(notice(page)).toContainText('back as it was');
});

test('the guide prints each example, with a preview and a Copy button', async ({ page }) => {
  await page.goto('/help/forms/part-12');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tutorial: a guest book');

  // the three files are named, and printed
  await expect(page.getByText('guestbook-files/entries.js').first()).toBeVisible();
  const blocks = page.locator('pre');
  await expect(blocks).toHaveCount(3);
  await expect(blocks.first()).toContainText('<pammy-form name="guest-book">');

  // copying gives the file exactly as it ships
  await blocks.first().locator('..').getByRole('button', { name: 'Copy' }).click();
  await expect(notice(page)).toHaveText('Code copied.');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('<script src="/_pammy/forms.js" defer></script>');
  expect(copied).toContain('href="guestbook-files/style.css"');
  expect(copied).not.toContain('@FORM@');

  // and the live example itself, in the guide
  await page.getByRole('button', { name: 'Show preview' }).click();
  await expect(page.frameLocator('iframe[title="Preview of guestbook"]').getByText('What a lovely afternoon')).toBeVisible();

  // the other two tutorials print their own three files as well
  for (const [part, heading, name] of [
    [13, "Tutorial: a list of who's coming", 'whos-coming'],
    [14, 'Tutorial: a pinboard', 'pinboard'],
  ] as const) {
    await page.goto(`/help/forms/part-${part}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    const files = page.locator('pre').filter({ hasText: /<!doctype html>|^\/\* Example|^\/\/ / });
    await expect(files).toHaveCount(3);
    await expect(files.first()).toContainText(`<pammy-form name="${name}">`);
    await expect(page.getByText(`${name}-files/entries.js`).first()).toBeVisible();
  }
});
