// Tags & categories on a service's things (docs/catalog-plan.md step 5): the switch, a
// kind's items from the service's signed list, a use's label made, an item tagged and the
// list filtered by it, Everywhere's labels, and off. The demo service's list and manifest
// are stood in for (test/e2e-lfdln/server.ts); the services helper is the real one.
import { confirmDialog, expect, notice, row, test } from './fixtures.ts';

test('switch a service on, tag one of its things, filter by it, and switch it off', async ({ page }) => {
  await page.goto('/catalog');
  await expect(page.getByRole('heading', { name: 'Tags & categories', level: 1 })).toBeVisible();
  const demo = row(page, /^Demo app/).first();
  await expect(demo).toContainText('tags off');
  await demo.getByRole('switch', { name: "Let me tag Demo app's things" }).click();
  await expect(notice(page)).toContainText('Tags are on for Demo app.');
  await expect(demo).toContainText('Topics: 3 things, 0 with tags');

  await demo.getByRole('link', { name: 'Topics' }).click();
  await expect(page.getByRole('heading', { name: 'Topics', level: 1 })).toBeVisible();
  const items = page.getByRole('list', { name: 'Topics', exact: true });
  await expect(items.getByRole('listitem')).toHaveCount(3);
  await expect(items).toContainText('Linear equations');

  // the sub-scopes, from the list's "section"
  await page.getByRole('combobox', { name: 'Only the ones in' }).selectOption({ label: 'Polynomials (2)' });
  await expect(items.getByRole('listitem')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Only the ones in' }).selectOption({ label: 'All of them' });

  // what "featured" means to the service, and making it
  await expect(page.getByText('Demo app gives #featured a meaning: Question of the day')).toBeVisible();
  await page.getByRole('button', { name: 'Make it' }).click();
  await expect(notice(page)).toContainText('Made the tag "featured".');
  await expect(page.getByRole('list', { name: 'Tags of Topics' })).toContainText('Question of the day');

  // tag one
  const lin = items.getByRole('listitem').filter({ hasText: 'Linear equations' });
  await lin.getByText('Tags and categories').click();
  await lin.getByRole('combobox', { name: 'Add a tag' }).fill('featured');
  await lin.getByRole('button', { name: 'Save the tags' }).click();
  await expect(notice(page)).toContainText('Saved.');
  await expect(lin).toContainText('#featured');
  await expect(lin.getByRole('link', { name: 'open it' })).toHaveAttribute('href', 'https://demo.example/practice/lin-eq');

  await page.getByRole('combobox', { name: 'Only the ones with this tag or category' }).selectOption({ label: '#featured' });
  await expect(items.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '1 of them match' })).toBeVisible();

  // Everywhere's labels, on the same page as the services
  await page.goto('/catalog');
  await page.getByRole('textbox', { name: 'Name' }).fill('Shared one');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(notice(page)).toContainText('Made the tag "shared-one".');
  await expect(page.getByRole('list', { name: 'Tags everywhere' })).toContainText('#shared-one');

  // off: it says what goes first
  await row(page, /^Demo app/).first().getByRole('switch', { name: "Let me tag Demo app's things" }).click();
  await expect(confirmDialog(page)).toContainText('The tags and categories come off 1 thing');
  await confirmDialog(page).getByRole('button', { name: 'Switch off' }).click();
  await expect(notice(page)).toContainText('Tags are off for Demo app.');
  await expect(row(page, /^Demo app/).first()).toContainText('tags off');
  await expect(page.getByRole('list', { name: 'Tags everywhere' })).toContainText('#shared-one');
});
