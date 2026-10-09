// Connecting tables in a browser (docs/databases-plan.md 7). The engines are
// stood in for by test/e2e/server.ts; what is real here is the gesture, her
// words for the three kinds, and that a connecting table stays out of her way
// until she asks to see it.
import { confirmDialog, expect, notice, test } from './fixtures.ts';

// By the node's own id, not by its text: a table's rectangle lists its fields,
// so `hasText: 'tags'` also matches a `recipes` table that HAS a tags field --
// which silently made a test think the table was already there.
const node = (page: import('@playwright/test').Page, name: string) =>
  page.locator(`.react-flow__node[data-id="${name}"]`);
const connections = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Connections' });

const open = async (page: import('@playwright/test').Page) => {
  await page.goto('/databases');
  await expect(page.getByRole('list', { name: 'Your databases' })).toBeVisible();
  const adopt = page.getByRole('listitem').filter({ hasText: 'family_recipes' })
    .getByRole('button', { name: 'Look after this one' });
  if (await adopt.count()) {
    await adopt.first().click();
    await expect(notice(page)).toContainText('looking after family_recipes');
  }
  await page.goto('/databases/postgres/family_recipes/canvas');
  await expect(page.getByRole('application', { name: 'Schema canvas' })).toBeVisible();
};

// This file brings its own tables rather than leaning on what another spec
// applied: a test that only passes when its neighbours ran first is the kind
// that fails for a reason you then have to go and find.
const ensure = async (page: import('@playwright/test').Page, name: string) => {
  // the canvas has to have drawn before counting what is on it
  await expect(node(page, 'recipes')).toBeVisible();
  if (await node(page, name).count()) return;
  await page.getByRole('button', { name: 'Add table' }).click();
  const ask = page.getByRole('alertdialog');
  await ask.getByRole('textbox').fill(name);
  await ask.getByRole('button', { name: 'Add it' }).click();
  await expect(node(page, name).first()).toBeVisible();
};

// leave the drawing as this file found it
const discard = async (page: import('@playwright/test').Page) => {
  await page.goto('/databases/postgres/family_recipes');
  // Wait for the page before counting. count() never waits, so on a page that
  // is still loading this quietly found no button, skipped the cleanup, and
  // left the next test a draft it did not expect.
  await expect(page.getByRole('list', { name: 'Tables' })).toBeVisible();
  const throwAway = page.getByRole('button', { name: 'Throw them away' });
  if (await throwAway.count()) {
    await throwAway.click();
    await confirmDialog(page).getByRole('button', { name: 'Throw it away' }).click();
    await expect(notice(page)).toContainText('Back to what the database really has.');
  }
  await expect(page.getByText('Not applied yet')).toBeHidden();
};

const connect = async (page: import('@playwright/test').Page, o: {
  from: string; to: string; kind: RegExp; onDelete?: string; junction?: string;
}) => {
  await page.getByRole('button', { name: 'Connect tables' }).click();
  await page.getByLabel('Which table does the connection point at?').selectOption(o.from);
  await page.getByLabel('Which table holds the connection?').selectOption(o.to);
  await page.getByLabel('What kind of connection?').selectOption({ label: await page
    .getByLabel('What kind of connection?').locator('option').filter({ hasText: o.kind }).first().innerText() });
  if (o.onDelete) await page.getByLabel(/^When a .* is deleted$/).selectOption({ label: o.onDelete });
  if (o.junction) await page.getByLabel('What should the connecting table be called?').fill(o.junction);
  await page.getByRole('button', { name: 'Draw the connection' }).click();
};

test('one recipe has many guests: the field is made for her', async ({ page }) => {
  await open(page);
  await ensure(page, 'guests');
  await connect(page, { from: 'recipes', to: 'guests', kind: /has many/ });
  await expect(notice(page)).toContainText('Nothing has changed in the database yet.');
  await expect(connections(page)).toContainText('One recipe has many guests');
  // she never had to think about the field, and it is on the list of changes
  await expect(connections(page)).toContainText('guests.recipe_id points at recipes.id');
  await expect(page.getByText('Not applied yet')).toBeVisible();

  // and it is drawn: a line from guests (many) to recipes (one). React Flow
  // draws no line to a rectangle without ends for it, which is how every
  // connection went undrawn while the list still had them.
  const drawn = page.locator('.react-flow__edge');
  await expect(drawn).toHaveCount(1);
  const path = drawn.locator('path.react-flow__edge-path');
  await expect(path).toHaveAttribute('marker-start', /end-many/);
  await expect(path).toHaveAttribute('marker-end', /end-one/);
  // picking one of its tables picks its lines out too
  await node(page, 'guests').click();
  await expect(path).toHaveAttribute('marker-end', /end-one-picked/);

  // and the same connection, seen from the table's own page
  await page.goto('/databases/postgres/family_recipes/tables/guests');
  await expect(page.getByRole('list', { name: 'Fields' })).toContainText('recipe_id');
  await expect(connections(page)).toContainText('One recipe has many guests');
  await discard(page);
});

test('a pair that could not work is explained, not accepted', async ({ page }) => {
  await open(page);
  // `title` is not the key and is not must-be-different, so it cannot say which
  // row is meant -- and she is told that instead of being left to press Apply
  await page.getByRole('button', { name: 'Connect tables' }).click();
  await page.getByLabel('Which table does the connection point at?').selectOption('recipes');
  const field = page.getByLabel('Which field says which row?');
  await expect(field).toHaveValue('id');
  await expect(field.locator('option')).toHaveCount(1);
  // only what can really identify a row is offered
  await expect(field.locator('option')).toHaveText(['id']);
});

test('many recipes have many tags: the connecting table stays out of her way', async ({ page }) => {
  await open(page);
  await ensure(page, 'tags');
  await connect(page, { from: 'recipes', to: 'tags', kind: /have many/, junction: 'recipe_tags' });
  await expect(connections(page)).toContainText('Many recipes have many tags');
  await expect(connections(page)).toContainText('through recipe_tags');

  // tucked away: the table she did not ask for is not on the drawing, and one
  // line with "many" at both ends stands in for it
  await expect(node(page, 'recipe_tags')).toHaveCount(0);
  await expect(node(page, 'recipes').first()).toBeVisible();
  const line = page.locator('.react-flow__edge path.react-flow__edge-path');
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAttribute('marker-start', /end-many/);
  await expect(line).toHaveAttribute('marker-end', /end-many/);

  // ...until she asks to see it, and hiding it never deleted it
  await page.getByRole('button', { name: 'Show connecting tables' }).click();
  await expect(notice(page)).toContainText('Showing every table');
  await expect(node(page, 'recipe_tags')).toHaveCount(1);
  // the real two lines, each "many" at the connecting table and "one" at the other end
  await expect(line).toHaveCount(2);

  // remembered per database, so it is still showing after a reload
  await page.reload();
  await expect(node(page, 'recipe_tags')).toHaveCount(1);
  await page.getByRole('button', { name: 'Tuck connecting tables away' }).click();
  await expect(node(page, 'recipe_tags')).toHaveCount(0);

  // and disconnecting says what it costs, because that table holds her pairs
  await connections(page).getByRole('button', { name: 'Disconnect' }).first().click();
  await expect(confirmDialog(page)).toContainText('recipe_tags is deleted');
  await confirmDialog(page).getByRole('button', { name: 'Add it to the changes' }).click();
  await expect(connections(page)).not.toContainText('Many recipes have many tags');
  await discard(page);
});

test('what happens when a row is deleted is hers to choose', async ({ page }) => {
  await open(page);
  await ensure(page, 'guests');
  await connect(page, { from: 'recipes', to: 'guests', kind: /has many/ });
  const row = connections(page).getByRole('listitem').filter({ hasText: 'One recipe has many guests' });
  // the safe one by default: nothing is quietly deleted on her behalf
  await expect(row.getByRole('combobox')).toHaveValue('restrict');
  await row.getByRole('combobox').selectOption('cascade');
  await expect(notice(page)).toContainText('Saved.');
  await expect(row.getByRole('combobox')).toHaveValue('cascade');
  await discard(page);
});

test('a table\'s menu on the canvas connects it to another', async ({ page }) => {
  await open(page);
  await ensure(page, 'guests');
  await node(page, 'guests').getByRole('button', { name: 'Options for guests' }).click();
  await page.getByRole('menuitem', { name: 'Connect to another table' }).click();
  const ask = page.getByRole('dialog', { name: 'Connect two tables' });
  // it starts from the table she asked from
  await expect(ask.getByLabel('Which table holds the connection?')).toHaveValue('guests');
  await ask.getByLabel('Which table does the connection point at?').selectOption('recipes');
  await ask.getByRole('button', { name: 'Draw the connection' }).click();
  await expect(ask).toBeHidden();
  await expect(connections(page)).toContainText('One recipe has many guests');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await discard(page);
});
