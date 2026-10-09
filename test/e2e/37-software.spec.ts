// Installed software (docs/apps-plan.md phases 1-2), in a browser: the
// WordPress that was already on the server, adopted, found from the menu, how
// it is doing, and what can be done to it. test/e2e/server.ts runs the real
// software helper over a folder laid out like the server, with systemd, podman
// and nginx played along with (test/apps-world.ts fakeSystem), and listens on
// 3198 for "its database stopped".
import { confirmDialog, expect, row, test } from './fixtures.ts';

const control = async (what: string) => {
  const r = await fetch(`http://127.0.0.1:3198/${what}`, { method: 'POST' });
  if (!r.ok) throw new Error(`control ${what}: ${r.status}`);
};

test('WordPress, from the menu to how it is doing', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open the menu' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Installed software' }).click();
  await expect(page).toHaveURL('/software');
  await expect(page.getByRole('heading', { name: 'Installed software', level: 1 })).toBeVisible();

  const wp = row(page, 'WordPress');
  await expect(wp.getByTestId('software-state')).toHaveText('Working');
  await expect(wp.getByRole('link', { name: 'blog.pammy.org' })).toHaveAttribute('href', 'https://blog.pammy.org/');
  await expect(wp).toContainText('version 6.8.2');
  await expect(wp.getByRole('link', { name: 'Sign in to its admin' })).toHaveAttribute('href', 'https://blog.pammy.org/wp-admin/');

  await wp.getByRole('link', { name: 'How it’s doing' }).click();
  await expect(page).toHaveURL('/software/blog');
  await expect(page).toHaveTitle('WordPress (blog) · pammy.org panel');
  await expect(page.getByTestId('software-state')).toHaveText('Working');
  await expect(page.getByText('It is running, and it answered when the panel opened it.')).toBeVisible();
  await expect(page.getByText(/it answered in 83 ms/)).toBeVisible();
  await expect(page.getByText('On its own subdomain, blog.pammy.org')).toBeVisible();
  await expect(page.getByText('/pamela/wordpress')).toBeVisible();
  await expect(page.getByText('WordPress 6.8.2')).toBeVisible();
  await expect(page.getByText(/by momolig, before the panel looked after it/)).toBeVisible();
  await expect(page.getByText(/running, using 44 MB of memory/)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Backups' }).getByRole('listitem')).toHaveCount(2);

  // its database stops: said in her words, and Check again sees it come back
  await control('wordpress-db-stops');
  try {
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByTestId('software-state')).toHaveText('Needs a look');
    await expect(page.getByTestId('software-problems')).toHaveText('Its database is not running.');
  } finally {
    await control('wordpress-db-starts');
  }
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByTestId('software-state')).toHaveText('Working');

  await page.getByRole('link', { name: 'Installed software' }).click();
  await expect(page).toHaveURL('/software');
});

test('an address that is not installed software says so', async ({ page }) => {
  await page.goto('/software/shop');
  await expect(page.getByText('There is no such software.')).toBeVisible();
});

test('back up now, put a backup back, take it offline and bring it back', async ({ page }) => {
  await page.goto('/software/blog');
  const backups = page.getByRole('list', { name: 'Backups' });
  await expect(backups.getByRole('listitem')).toHaveCount(2);
  await expect(backups.getByRole('link', { name: 'Download' }).first()).toHaveAttribute('href', '/api/software/blog/backups/20260922T034501Z/download');

  // a backup is a job the page watches
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByTestId('software-job')).toContainText('Making a backup');
  await expect(page.getByTestId('software-job')).toBeHidden({ timeout: 15_000 });
  await expect(backups.getByRole('listitem')).toHaveCount(3);
  await expect(backups.getByRole('listitem').first()).toContainText('newest');
  await expect(row(page, 'Backup').filter({ hasText: 'Backed up (4 MB).' })).toBeVisible();

  // putting one back asks first, then for the passkey (the virtual one answers)
  await backups.getByRole('listitem').nth(1).getByRole('button', { name: 'Put this back' }).click();
  await expect(confirmDialog(page)).toContainText('A backup of how it is now is made first');
  await confirmDialog(page).getByRole('button', { name: 'Put it back' }).click();
  await expect(page.getByTestId('software-job')).toContainText('Putting a backup back');
  await expect(page.getByTestId('software-job')).toBeHidden({ timeout: 30_000 });
  await expect(row(page, 'Backup put back')).toContainText('Put back as it was on');

  // offline: asked first; then Offline, and the way back
  await page.getByRole('button', { name: 'Take it offline' }).click();
  await expect(confirmDialog(page)).toContainText('Nothing is deleted');
  await confirmDialog(page).getByRole('button', { name: 'Take it offline' }).click();
  await expect(page.getByTestId('software-state')).toHaveText('Offline', { timeout: 15_000 });
  await expect(page.getByText(/It is offline: visitors can’t see it/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back up now' })).toBeDisabled();
  await page.getByRole('button', { name: 'Bring it back online' }).click();
  await expect(page.getByTestId('software-state')).toHaveText('Working', { timeout: 15_000 });
  await expect(row(page, 'Back online')).toContainText('It is back at https://blog.pammy.org/.');
  await expect(row(page, 'Taken offline')).toContainText('It is offline. Nothing was deleted.');
});

test('a new admin password, shown once; and what it complained about', async ({ page }) => {
  await page.goto('/software/blog');
  await page.getByRole('button', { name: 'Make a new password…' }).click();
  await page.getByRole('button', { name: 'Make a new password for pamela' }).click();
  const shown = page.getByTestId('new-admin-password');
  await expect(shown).toContainText(/Username: pamela\nPassword: [A-Za-z0-9_-]{24}/);
  await expect(page.getByText('It is also in wordpress-login.txt in your home folder.')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(shown).toBeHidden();
  await expect(row(page, 'New admin password')).toContainText('A new password for pamela, also in your wordpress-login.txt.');

  await page.getByText('What it complained about lately').click();
  await expect(page.getByText(/09:01:00.*a warning/)).toBeVisible();
  await expect(page.getByText(/09:02:00.*a warning/)).toBeVisible();

  // and the activity says who did what, never the password
  await page.goto('/activity');
  await expect(page.getByText(/made a new WordPress admin password \(for pamela\)/)).toBeVisible();
  await expect(page.getByText(/took WordPress \(blog\) offline/)).toBeVisible();
});

test('move it to a folder of pammy.org, and back to its own subdomain', async ({ page }) => {
  await page.goto('/software/blog');
  await page.getByRole('button', { name: 'Move it…' }).click();
  // one of her folders: refused, in her words
  await page.getByLabel('A folder of pammy.org, like pammy.org/journal/').check();
  await page.getByLabel('Name').fill('recipes');
  await page.getByRole('button', { name: 'Move it', exact: true }).click();
  await confirmDialog(page).getByRole('button', { name: 'Move it' }).click();
  await expect(page.locator('[data-kind="error"]')).toContainText('You have a folder called "recipes"');

  await page.getByLabel('Name').fill('journal');
  await expect(page.getByText('It will be at pammy.org/journal/.')).toBeVisible();
  await page.getByRole('button', { name: 'Move it', exact: true }).click();
  await expect(confirmDialog(page)).toContainText('The old address stops working');
  await confirmDialog(page).getByRole('button', { name: 'Move it' }).click();
  await expect(page.getByTestId('software-job')).toContainText('Moving it');
  await expect(page.getByTestId('software-job')).toBeHidden({ timeout: 20_000 });
  await expect(row(page, 'Moved')).toContainText('It is now at https://pammy.org/journal/.');
  await expect(page.getByText('In a folder of pammy.org, /journal/')).toBeVisible();

  // and back, so the rest of the browser tests find it where it was
  await page.getByRole('button', { name: 'Move it…' }).click();
  await page.getByLabel('Its own subdomain, like journal.pammy.org').check();
  await page.getByLabel('Name').fill('blog');
  await page.getByRole('button', { name: 'Move it', exact: true }).click();
  await confirmDialog(page).getByRole('button', { name: 'Move it' }).click();
  await expect(page.getByTestId('software-job')).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText('On its own subdomain, blog.pammy.org')).toBeVisible();
});

// last in this file: afterwards there are two installs (38 knows)
test('install a new WordPress: the form, its steps, its password once', async ({ page }) => {
  await page.goto('/software');
  await page.getByRole('link', { name: 'Install WordPress' }).click();
  await expect(page).toHaveURL('/software/new');
  await page.getByLabel('Name', { exact: true }).fill('garden');
  await expect(page.getByText('It will be at garden.pammy.org.')).toBeVisible();
  await page.getByLabel('Its title').fill('The garden');
  await expect(page.getByLabel('Admin name')).toHaveValue('pamela');
  await page.getByRole('button', { name: 'Install it' }).click();
  await expect(confirmDialog(page)).toContainText('apps/garden-login.txt');
  await confirmDialog(page).getByRole('button', { name: 'Install it' }).click();
  await expect(page).toHaveURL('/software/garden');
  await expect(page.getByTestId('software-job')).toContainText('Installing it');
  await expect(page.getByTestId('software-job')).toBeHidden({ timeout: 60_000 });
  const pw = page.getByTestId('install-password');
  await expect(pw).toContainText(/Username: pamela\nPassword: [A-Za-z0-9_-]{24}/);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(pw).toBeHidden();
  await expect(page.getByTestId('software-state')).toHaveText('Working');
  await expect(page.getByText('On its own subdomain, garden.pammy.org')).toBeVisible();
  await expect(page.getByText('/pamela/apps/garden')).toBeVisible();
  // shown once: opening the page again doesn't show it
  await page.reload();
  await expect(page.getByTestId('software-state')).toHaveText('Working');
  await expect(pw).toHaveCount(0);
  await page.goto('/software');
  await expect(page.getByRole('list', { name: 'Installed software' }).getByRole('listitem')).toHaveCount(2);
});

// after the one above: a third install, which stops at its second step the
// first time (test/apps-world.ts), and is tried again from its page
test('an install that did not finish: Try again picks up where it stopped', async ({ page }) => {
  await page.goto('/software/new');
  await page.getByLabel('Nowhere yet').check();
  await page.getByLabel('A short name for it').fill('flaky');
  await page.getByLabel('Its title').fill('Flaky');
  await page.getByRole('button', { name: 'Install it' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Install it' }).click();
  await expect(page).toHaveURL('/software/flaky');
  await expect(page.getByTestId('software-job')).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId('software-problems')).toContainText('Installing it stopped at "Making its folders and settings"');
  await page.getByRole('link', { name: 'Try again' }).click();
  await expect(page).toHaveURL('/software/new?again=flaky');
  await expect(page.getByText('Trying flaky again.')).toBeVisible();
  await page.getByLabel('Nowhere yet').check();
  await expect(page.getByLabel('A short name for it')).toHaveValue('flaky');
  await page.getByLabel('Its title').fill('Flaky');
  await page.getByRole('button', { name: 'Install it' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Install it' }).click();
  await expect(page).toHaveURL('/software/flaky');
  await expect(page.getByTestId('software-job')).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId('install-password')).toContainText(/Password: [A-Za-z0-9_-]{24}/);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('link', { name: 'Try again' })).toHaveCount(0);
  await expect(page.getByTestId('software-problems')).toHaveCount(0);
});

// after the one above: flaky is deleted, restored, deleted again, and then for good
test('delete: to Deleted for 30 days, restore, and delete for good', async ({ page }) => {
  const typeName = async (action: string) => {
    await confirmDialog(page).getByRole('textbox').fill('flaky');
    await confirmDialog(page).getByRole('button', { name: action, exact: true }).click();
  };
  await page.goto('/software/flaky');
  await page.getByRole('button', { name: 'Delete it…' }).click();
  await expect(confirmDialog(page)).toContainText('kept for 30 days');
  await typeName('Delete it');
  await expect(page.getByTestId('software-job')).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId('software-state')).toHaveText('Deleted');
  await expect(page.getByRole('heading', { name: 'Deleted', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete it…' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Move it' })).toHaveCount(0);
  // the list keeps it apart
  await page.goto('/software');
  await expect(page.getByRole('list', { name: 'Deleted software' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('list', { name: 'Installed software' }).getByRole('listitem')).toHaveCount(2);
  await page.getByRole('link', { name: 'Restore or delete for good' }).click();
  await page.getByRole('button', { name: 'Restore it' }).click();
  await expect(page.getByTestId('software-state')).toHaveText('Offline', { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Bring it back online' })).toBeVisible();
  // again, then for good: back to the list, without it
  await page.getByRole('button', { name: 'Delete it…' }).click();
  await typeName('Delete it');
  await expect(page.getByTestId('software-state')).toHaveText('Deleted', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Delete it for good…' }).click();
  await expect(confirmDialog(page)).toContainText('can’t be brought back');
  await typeName('Delete it for good');
  await expect(page).toHaveURL('/software', { timeout: 20_000 });
  await expect(page.getByRole('list', { name: 'Installed software' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('list', { name: 'Deleted software' })).toHaveCount(0);
});
