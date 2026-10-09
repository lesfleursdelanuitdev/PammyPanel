import { confirmDialog, expect, notice, row, test } from './fixtures.ts';

test('make a subdomain, move it to the trash, and restore it', async ({ page }) => {
  await page.goto('/subdomains');
  const name = page.getByLabel('Name');
  await name.fill('Cakes');
  await expect(page.getByText('Use lowercase letters only.')).toBeVisible();
  await name.fill('cakes');
  await expect(page.getByText('It will be live at https://cakes.pammy.org/ and https://pammy.org/cakes/')).toBeVisible();
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(notice(page)).toContainText('Created. cakes.pammy.org is live now');
  await expect(name).toHaveValue('');

  const folders = page.getByRole('list', { name: 'Your folders' });
  const cakes = folders.getByRole('listitem').filter({ hasText: /^cakes/ });
  await expect(cakes.getByText('subdomain', { exact: true })).toBeVisible();
  await expect(cakes.getByRole('link', { name: 'cakes.pammy.org' })).toHaveAttribute('href', 'https://cakes.pammy.org/');
  await expect(folders.getByRole('listitem').filter({ hasText: 'Old Stuff' })).toContainText('no subdomain (name has capitals or symbols)');

  await cakes.getByRole('button', { name: 'Move to trash' }).click();
  await expect(confirmDialog(page)).toContainText('Its addresses stop working straight away');
  await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(cakes).toBeVisible();
  await cakes.getByRole('button', { name: 'Move to trash' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Move to trash' }).click();
  await expect(notice(page)).toHaveText('"cakes" moved to the trash.');
  await expect(cakes).toBeHidden();

  const trash = page.getByRole('list', { name: 'Trash' });
  await trash.getByRole('listitem').filter({ hasText: 'cakes' }).getByRole('button', { name: 'Restore' }).click();
  await expect(notice(page)).toHaveText('"cakes" is back.');
  await expect(trash).toContainText('The trash is empty.');
});

test('restoring over a folder with the same name asks for another name', async ({ page }) => {
  await page.goto('/subdomains');
  const make = async () => {
    await page.getByLabel('Name').fill('pies');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(notice(page)).toContainText('Created.');
  };
  await make();
  await row(page, /^pies/).getByRole('button', { name: 'Move to trash' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Move to trash' }).click();
  await expect(notice(page)).toHaveText('"pies" moved to the trash.');
  await make();
  await page.getByRole('list', { name: 'Trash' }).getByRole('button', { name: 'Restore' }).click();
  await expect(confirmDialog(page)).toContainText('There\'s already a folder called "pies"');
  await expect(confirmDialog(page).getByLabel('Restore it under this name')).toHaveValue('pies-restored');
  await confirmDialog(page).getByRole('button', { name: 'Restore' }).click();
  await expect(notice(page)).toHaveText('"pies-restored" is back.');
  await expect(page.getByRole('list', { name: 'Your folders' })).toContainText('pies-restored');
});

test('a temporary home page for a folder with none: made in her words, changed, removed', async ({ page }) => {
  await page.goto('/subdomains');
  const folders = page.getByRole('list', { name: 'Your folders' });
  const drafts = folders.getByRole('listitem').filter({ hasText: /^blog-drafts/ });
  await expect(drafts.getByText('no home page')).toBeVisible();
  await expect(drafts.getByText('visitors see "403 Forbidden" there')).toBeVisible();
  // not offered where it can't be a subdomain, nor where there is a page of hers
  await expect(folders.getByRole('listitem').filter({ hasText: 'Old Stuff' }).getByRole('button', { name: 'Make a temporary page' })).toHaveCount(0);
  await expect(folders.getByRole('listitem').filter({ hasText: /^recipes/ }).getByRole('button', { name: 'Make a temporary page' })).toHaveCount(0);

  await drafts.getByRole('button', { name: 'Make a temporary page' }).click();
  await drafts.getByRole('button', { name: 'Under construction' }).click();
  await expect(drafts.getByLabel('Heading')).toHaveValue('Under construction');
  await drafts.getByLabel('Heading').fill('Drafts, soon');
  await drafts.getByLabel('What it says').fill('Nothing to read yet.');
  await expect(drafts.getByLabel('Its look')).toHaveValue('plain');
  await drafts.getByRole('button', { name: 'Make the page' }).click();
  await expect(notice(page)).toContainText('"blog-drafts" has a temporary home page now.');
  await expect(drafts.getByText('temporary page', { exact: true })).toBeVisible();

  // her words come back to change them
  await drafts.getByRole('button', { name: 'Change the words' }).click();
  await expect(drafts.getByLabel('Heading')).toHaveValue('Drafts, soon');
  await expect(drafts.getByLabel('What it says')).toHaveValue('Nothing to read yet.');
  await drafts.getByRole('button', { name: 'Cancel' }).click();

  // and it goes again, leaving the folder as it was
  await drafts.getByRole('button', { name: 'Remove the temporary page' }).click();
  await expect(notice(page)).toContainText('The temporary page is gone.');
  await expect(drafts.getByText('no home page')).toBeVisible();
});
