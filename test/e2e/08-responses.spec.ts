import { expect, notice, test } from './fixtures.ts';

test('read, approve, filter, trash and restore responses', async ({ page }) => {
  await page.goto('/responses');
  const list = page.getByRole('list', { name: 'Responses', exact: true });
  const priya = list.getByRole('listitem').filter({ hasText: 'Loved the lemon cake.' });
  const sam = list.getByRole('listitem').filter({ hasText: 'Can I book a cooking class?' });
  await expect(list.getByRole('listitem').first()).toContainText('Priya');                // newest first
  await expect(priya.getByText('unread', { exact: true })).toBeVisible();
  await expect(sam.getByRole('link', { name: 'sam@example.com' })).toHaveAttribute('href', 'mailto:sam@example.com');
  await expect(sam.getByRole('link', { name: '+44 7700 900456' })).toHaveAttribute('href', 'tel:+447700900456');
  await expect(priya).toContainText('(left empty)');
  await expect(sam.getByRole('link', { name: 'Reply by email' })).toHaveAttribute('href', /^mailto:sam@example\.com\?subject=Re%3A/);

  await priya.getByRole('button', { name: 'Mark as read' }).click();
  await expect(priya.getByText('unread', { exact: true })).toBeHidden();
  await expect(priya).toContainText('read by pamela');

  // approving: only for a form whose responses can be approved (the sample form's can)
  await priya.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(notice(page)).toHaveText('Approved.');
  await expect(priya).toContainText('approved by pamela');
  await page.getByLabel('Form', { exact: true }).selectOption({ label: 'Sample contact form' });
  await expect(page).toHaveURL('/responses?form=1');
  await page.getByLabel('Approved', { exact: true }).selectOption('approved');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.getByLabel('Approved', { exact: true }).selectOption('waiting');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('Can I book a cooking class?');
  await page.getByLabel('Approved', { exact: true }).selectOption('');
  await priya.getByRole('button', { name: 'Unapprove' }).click();
  await expect(notice(page)).toHaveText('No longer approved.');

  await page.getByLabel('Show', { exact: true }).selectOption('unread');
  await expect(priya).toBeHidden();
  await expect(sam).toBeVisible();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(notice(page)).toHaveText('1 response marked as read.');
  await expect(list).toHaveText('Nothing unread.');
  await page.getByLabel('Show', { exact: true }).selectOption('read');
  await expect(priya).toBeVisible();
  await page.getByLabel('Show', { exact: true }).selectOption('');

  await sam.getByRole('button', { name: 'Move to trash' }).click();
  await expect(notice(page)).toHaveText('Moved to the trash. You can restore it for 30 days.');
  await expect(sam).toBeHidden();
  await page.locator('summary', { hasText: 'Trash' }).click();
  const trashed = page.getByRole('list', { name: 'Trashed responses' }).getByRole('listitem');
  await expect(trashed).toContainText('moved to the trash by pamela');
  await trashed.getByText('Show the answers').click();
  await expect(trashed).toContainText('Can I book a cooking class?');
  await trashed.getByRole('button', { name: 'Restore' }).click();
  await expect(notice(page)).toHaveText('Response restored.');
  await expect(sam).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open the menu' }).getByTestId('menu-dot')).toBeHidden();

  // the examples' entries are in the list too, marked as what they are
  await page.getByLabel('Form', { exact: true }).selectOption({ label: 'All forms' });
  const example = list.getByRole('listitem').filter({ hasText: 'What a lovely afternoon' });
  await expect(example.getByText('example', { exact: true })).toBeVisible();
  await expect(example).toContainText('Guest book');
});

test('an API key is made once, shown once and can be revoked', async ({ page }) => {
  await page.goto('/api-keys');
  await page.getByRole('button', { name: 'New key' }).click();
  await page.getByLabel('What it is for').fill("Olivia's website");
  await page.getByLabel('Which responses').selectOption('approved');
  await page.getByRole('button', { name: 'Make the key' }).click();
  await expect(page.getByTestId('new-api-key')).toHaveText(/^pammy_[A-Za-z0-9_-]{43}$/);
  const list = page.getByRole('list', { name: 'API keys' });
  await expect(list).toContainText("Olivia's website");
  await expect(list).toContainText('approved only');
  await expect(list).toContainText('every form');
  // a key for a media folder too (docs/media-api-plan.md M6), and no forms
  await page.getByRole('button', { name: 'New key' }).click();
  await page.getByLabel('What it is for').fill('Gallery program');
  await page.getByLabel('Which forms').selectOption('none');
  await expect(page.getByLabel('Which responses')).toHaveCount(0);
  await page.getByLabel('Which media folders').selectOption('all');
  await page.getByRole('button', { name: 'Make the key' }).click();
  await expect(page.getByTestId('new-api-key')).toHaveText(/^pammy_/);
  await expect(list.getByRole('listitem').filter({ hasText: 'Gallery program' })).toContainText('every media folder');
  await expect(list.getByRole('listitem').filter({ hasText: 'Gallery program' })).toContainText('no forms');
  await list.getByRole('listitem').filter({ hasText: "Olivia's website" }).getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(notice(page)).toHaveText('"Olivia\'s website" was revoked.');
  await expect(list.getByText('revoked', { exact: true })).toBeVisible();
});
