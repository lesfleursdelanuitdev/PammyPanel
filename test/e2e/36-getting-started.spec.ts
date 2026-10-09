// Getting started (docs/getting-started-plan.md G6): from Home, answer the
// questions, get a recommendation that points to guide 19, start it, and see
// the panel tick off what is already on the site. Spec 14 already put a
// pinboard of hers on the website (recipe-notes), so the first step is done.
import { expect, notice, test } from './fixtures.ts';

test('what would you like to do? a pinboard, from Home to its steps', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('getting-started-card');
  await expect(card.getByRole('heading', { name: 'Getting started' })).toBeVisible();
  await card.getByRole('link', { name: 'What would you like to do?' }).click();
  await expect(page).toHaveURL('/getting-started');

  // one question at a time, her own projects first
  await expect(page.getByRole('group', { name: 'What would you like to do?' })).toBeVisible();
  await expect(page.locator('[data-value]').first()).toHaveText(/Start a blog/);
  await page.getByRole('button', { name: /Put up a pinboard/ }).click();
  await page.getByRole('button', { name: /Only people I know/ }).click();
  // Back takes one answer away
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('group', { name: 'Who may pin notes?' })).toBeVisible();
  await page.getByRole('button', { name: /Only people I know/ }).click();
  await page.getByRole('button', { name: /After I have read them/ }).click();

  // the recommendation, and guide 19
  const rec = page.getByTestId('recommendation');
  await expect(rec.getByRole('heading', { name: 'A form: start from the pinboard example' })).toBeVisible();
  await expect(rec.getByText('Keep it for people you know')).toBeVisible();
  await expect(rec.getByRole('link', { name: 'Guide 19, Forms or a database?' })).toHaveAttribute('href', '/help/forms-or-a-database/part-4');
  await rec.getByRole('button', { name: 'Start this' }).click();
  await expect(notice(page)).toContainText('Started: Your pinboard');

  // the steps: her pinboard from spec 14 is found, and held on to
  const path = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Your pinboard' }) });
  await expect(path.getByTestId('step-form')).toHaveAttribute('data-state', 'done');
  await expect(path.getByText('"Pinboard" (recipe-notes)').first()).toBeVisible();
  await expect(path.getByTestId('step-protect')).toHaveAttribute('data-state', /todo|done/);
  // a step can be skipped, and brought back
  await path.getByTestId('step-first').getByRole('button', { name: 'Skip this' }).click();
  await expect(path.getByTestId('step-first')).toHaveAttribute('data-state', 'skipped');
  await path.getByTestId('step-first').getByRole('button', { name: "Don't skip it" }).click();
  await expect(path.getByTestId('step-first')).toHaveAttribute('data-state', 'todo');

  // Home shows it, and remembers being closed
  await page.goto('/');
  await expect(card.getByRole('heading', { name: 'Your pinboard' })).toBeVisible();
  await card.getByRole('button', { name: 'Close Getting started' }).click();
  await expect(card.getByText(/Your pinboard: \d of \d done/)).toBeVisible();
  await page.reload();
  await expect(card.getByText(/Your pinboard: \d of \d done/)).toBeVisible();
  await card.getByRole('button', { name: 'Open Getting started' }).click();
  await expect(card.getByRole('heading', { name: 'Your pinboard' })).toBeVisible();

  // and Help leads to it too
  await page.goto('/help');
  await page.getByRole('link', { name: /Getting started: what would you like to do\?/ }).click();
  await expect(page).toHaveURL('/getting-started');

  // put away, it leaves the list
  await path.getByRole('button', { name: 'Put away' }).click();
  await expect(notice(page)).toContainText('Your pinboard is put away');
  await expect(page.getByRole('heading', { name: 'Your pinboard' })).toHaveCount(0);
});
