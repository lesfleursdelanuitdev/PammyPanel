import { expect, test } from './fixtures.ts';

test('home is a dashboard of what is waiting, with the newest responses and requests', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^(Good (morning|afternoon|evening)|Hello), Pamela$/);
  await expect(page.getByTestId('waiting-summary')).toHaveText('2 unread responses and 2 requests are waiting.');

  await expect(page.getByTestId('stat-responses')).toHaveText('2');
  await expect(page.getByTestId('stat-requests')).toHaveText('2');
  await expect(page.getByRole('link', { name: 'Unread responses: 2' })).toHaveAttribute('href', '/responses');
  await expect(page.getByRole('link', { name: 'Waiting requests: 2' })).toHaveAttribute('href', '/requests');
  await expect(page.getByRole('link', { name: /^Protected folders: \d+$/ })).toContainText(/can sign in/);

  const messages = page.getByRole('list', { name: 'New responses' }).getByRole('listitem');
  await expect(messages).toHaveCount(2);
  await expect(messages.first()).toContainText('Priya');               // newest first
  await expect(messages.first()).toContainText('Loved the lemon cake.');
  await expect(messages.nth(1)).toContainText('Sam Lee');
  const requests = page.getByRole('list', { name: 'Waiting requests' }).getByRole('listitem');
  await expect(requests.filter({ hasText: 'Rose Smith' })).toContainText('Wants to open "family"');
  await expect(requests.filter({ hasText: 'auntie.jo' })).toContainText('Forgot their password');
  await expect(page.getByRole('link', { name: 'Make a subdomain' })).toHaveAttribute('href', '/subdomains');
  // a fresh world looks after no databases yet: one quiet line, not an empty
  // panel (docs/databases-plan.md 16; spec 28 sees it once there are some)
  await expect(page.getByRole('link', { name: 'Make a database' })).toHaveAttribute('href', '/databases');

  await messages.first().getByRole('link').click();
  await expect(page).toHaveURL('/responses?form=1');
  await page.goBack();

  await page.getByLabel('Look something up in your guides').fill('sign-in page');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL('/help?q=sign-in%20page');
  await expect(page.getByText(/^\d+ places? in your guides\.$/)).toBeVisible();
});
