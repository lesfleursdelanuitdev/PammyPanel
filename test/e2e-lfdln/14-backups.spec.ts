// Settings > Backups (docs/lfdln-mariadb-plan.md B1-B4): how long the database copies are kept,
// fewer days deleting the older copies at once (server.ts's stand-in deletes three), Activity,
// and the Delete-a-database dialog saying the same number.
import { expect, notice, test } from './fixtures.ts';

test('Backups: 60 days at first; fewer asks first and deletes the older copies; the Delete dialog says so', async ({ page }) => {
  await page.goto('/backups');
  await expect(page.getByRole('heading', { name: 'Backups', level: 1 })).toBeVisible();
  await expect(page.getByText("The apps' databases (lfdln-appdb), and The Studio's MariaDB (lfdln-appmaria)")).toBeVisible();
  const days = page.getByLabel('Days');
  await expect(days).toHaveValue('60');

  await days.fill('400');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(notice(page, 'error')).toContainText('from 7 to 365');

  await days.fill('30');
  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Every copy older than 30 days is deleted now');
  await dialog.getByRole('button', { name: 'Keep them for less' }).click();
  await expect(notice(page)).toContainText('Saved: 3 older copies deleted.');
  await expect(page.getByText(/last cleared/)).toBeVisible();
  await expect(page.getByText('3 older than 30 days deleted (4.3 MB)')).toBeVisible();

  // more days: saved, nothing deleted, no question
  await days.fill('90');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(notice(page)).toContainText('Saved: kept 90 days.');

  await page.goto('/activity');
  await expect(page.getByText('chose to keep the database backups 90 days')).toBeVisible();
  await expect(page.getByText('deleted 3 database copies')).toBeVisible();

  // the Delete-a-database dialog says the same number (notebook_db is 10-studio's)
  await page.goto('/databases');
  await page.getByRole('list', { name: 'Your databases' }).getByRole('listitem').filter({ hasText: 'notebook_db' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('alertdialog')).toContainText("Last night's backup is still there for 90 days");
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
});
