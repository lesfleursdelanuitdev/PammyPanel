import { readFileSync } from 'node:fs';
import { confirmDialog, expect, notice, test } from './fixtures.ts';

// pammy.org itself isn't part of this test server: the preview page and the
// form component come straight from public-gate/, as the gate serves them.
const gateFile = (path: string) => readFileSync(new URL(`../../public-gate/${path}`, import.meta.url), 'utf8');

test.beforeEach(async ({ page }) => {
  await page.route('**/_pammy/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/_pammy/forms.js') return route.fulfill({ contentType: 'text/javascript', body: gateFile('forms.js') });
    if (path === '/_pammy/form-preview') {
      const origin = new URL(page.url()).origin;
      return route.fulfill({ contentType: 'text/html', body: gateFile('page.html')
        .replace('/_pammy/login.js', '/_pammy/forms.js')
        .replace('@TITLE@', 'Preview')
        .replace('@ELEMENT@', `<pammy-form preview panel="${origin}">
          <template class="pammy-thanks"><h2>Thank you!</h2><p>See you on the 3rd.</p></template>
        </pammy-form>`) });
    }
    return route.fulfill({ status: 404, body: 'not here' });
  });
});

test('make a form, build it by tapping, preview it, duplicate it and put it in the trash', async ({ page }) => {
  await page.goto('/forms');
  await expect(page.getByRole('link', { name: 'How forms work' })).toHaveAttribute('href', '/help/forms');
  const cards = page.locator('article');
  await expect(cards.filter({ hasText: 'Sample contact form' })).toContainText('sample-contact-form');

  // a name is needed first, and it has rules
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Olivias Form');
  await page.getByRole('button', { name: 'Make it' }).click();
  await expect(notice(page, 'error')).toContainText('Lowercase letters, digits and hyphens');
  await page.getByLabel('Name', { exact: true }).fill('olivias-form');
  await page.getByRole('button', { name: 'Make it' }).click();
  await expect(page).toHaveURL(/\/forms\/\d+$/);

  // the builder: add by clicking, settings on the right, move and remove
  await page.getByLabel('Form title').fill('Olivia is 8');
  await page.getByRole('button', { name: 'Name First and last name' }).click();
  const items = page.getByTestId('form-item');
  await expect(items).toHaveCount(1);
  await page.getByLabel('Label (the question)').fill('Who is coming?');
  await page.getByLabel('Must be answered').check();
  await expect(items.first()).toContainText('Who is coming?');

  await page.getByRole('button', { name: 'Several choices Tick as many as they like' }).click();
  await expect(items).toHaveCount(2);
  await page.getByLabel('Label (the question)').fill('What will you bring?');
  await page.getByRole('textbox', { name: 'Choices' }).fill('Cake\nDrinks\nGames');
  await expect(items.nth(1)).toContainText('Cake, Drinks, Games');
  await items.nth(1).getByRole('button', { name: 'Move "What will you bring?" up' }).click();
  await expect(items.first()).toContainText('What will you bring?');
  await items.first().getByRole('button', { name: 'Duplicate "What will you bring?"' }).click();
  await expect(items).toHaveCount(3);
  await items.nth(1).getByRole('button', { name: 'Remove "What will you bring?"' }).click();
  await expect(items).toHaveCount(2);

  // saving is what makes it live; leaving with changes asks first
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByTestId('builder-bar').getByRole('button', { name: 'Save' }).click();
  await expect(notice(page)).toHaveText('Saved. Your pages show it now.');
  await expect(page.getByText('Unsaved changes')).toBeHidden();
  await expect(items.first()).toContainText('what-will-you-bring');      // its name in the API, made from the label

  await page.getByTestId('builder-bar').getByRole('button', { name: 'Preview' }).click();
  const preview = page.frameLocator('iframe[title="Preview of the form"]');
  await expect(preview.getByText('What will you bring?')).toBeVisible();
  await expect(preview.getByRole('checkbox', { name: 'Cake' })).toBeVisible();
  await preview.getByRole('button', { name: 'Send' }).click();       // a preview never sends anything
  await expect(preview.getByText('Please fill in "Who is coming?"')).toBeVisible();
  // her own thank-you markup replaces the form once it's filled in
  await preview.getByLabel('First name').fill('Jo');
  await preview.getByLabel('Last name').fill('Smith');
  await preview.getByRole('button', { name: 'Send' }).click();
  await expect(preview.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  await expect(preview.getByText('See you on the 3rd.')).toBeVisible();
  await page.getByTestId('builder-bar').getByRole('button', { name: 'Back to editing' }).click();
  await page.getByTestId('builder-bar').getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL('/forms');

  // the code for a page, the switches, a copy, and the trash
  const card = cards.filter({ hasText: 'Olivia is 8' });
  await expect(card).toContainText(/number \d+ \(for the API\)/);      // the id the API uses
  await card.getByRole('button', { name: 'Code for a page' }).click();
  await expect(card).toContainText('<pammy-form name="olivias-form"></pammy-form>');
  await card.getByRole('button', { name: 'After sending' }).click();
  await expect(card).toContainText('thanks="thank-you.html"');
  await expect(card).toContainText('<template class="pammy-thanks">');
  await card.getByRole('button', { name: 'Show approved answers' }).click();
  await expect(card).toContainText('/_pammy/api/forms/');
  await expect(card).toContainText('textContent');
  await expect(card).toContainText("response.answers['what-will-you-bring']");   // her own question's name
  await card.getByLabel('Responses can be approved').click();
  await expect(notice(page)).toHaveText('You can now approve its responses.');
  await expect(card).toContainText('responses are approved');

  await card.getByRole('button', { name: 'Duplicate' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByLabel('Name for the copy')).toHaveValue('olivias-form-copy');
  await dialog.getByRole('button', { name: 'Make the copy' }).click();
  await expect(page).toHaveURL(/\/forms\/\d+$/);          // the copy opens, ready to change
  await expect(page.getByTestId('builder-bar')).toContainText('olivias-form-copy');
  await page.goto('/forms');
  await expect(cards.filter({ hasText: 'olivias-form-copy' })).toContainText('responses are approved');

  await cards.filter({ hasText: 'olivias-form-copy' }).getByRole('button', { name: 'Delete' }).click();
  await expect(confirmDialog(page)).toContainText('stays taken until it\'s gone for good');
  await confirmDialog(page).getByRole('button', { name: 'Move to the trash' }).click();
  await expect(notice(page)).toContainText('is in the trash.');
  await page.locator('summary', { hasText: 'Trash' }).click();
  await page.getByRole('list', { name: 'Forms in the trash' }).getByRole('button', { name: 'Restore' }).click();
  await expect(notice(page)).toHaveText('"olivias-form-copy" is back.');
});
