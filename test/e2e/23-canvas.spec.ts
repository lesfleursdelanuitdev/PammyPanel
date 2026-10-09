// The schema canvas in a browser (docs/databases-plan.md 6). The engines are
// stood in for by test/e2e/server.ts; what is real here is the part she
// touches -- that the drawing is the same one the Tables list edits, that where
// she puts a table is remembered, and that none of it reaches her database.
import { confirmDialog, expect, notice, test } from './fixtures.ts';

// By the node's own id, not by its text: a table's rectangle lists its fields,
// so `hasText: 'tags'` also matches a `recipes` table that HAS a tags field --
// which silently made a test think the table was already there.
const node = (page: import('@playwright/test').Page, name: string) =>
  page.locator(`.react-flow__node[data-id="${name}"]`);

// Same lesson as 22-designing-tables: wait for the page to be drawn before
// looking for anything on it. count() never waits.
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
  await expect(node(page, 'recipes')).toBeVisible();
};

// Where the table sits in the DRAWING, not on the screen. The canvas fits the
// whole schema into view when it opens, so the viewport moves whenever the
// drawing's outline changes -- screen pixels would say a table had moved when
// only the zoom had. React Flow puts the viewport transform on the parent and
// each node's own place in its own transform, which is the one that is saved.
const at = async (page: import('@playwright/test').Page, name: string) => {
  const transform = await node(page, name).evaluate((el) => (el as HTMLElement).style.transform);
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform);
  if (!m) throw new Error(`${name} has no place on the canvas: ${transform}`);
  return { x: Number(m[1]), y: Number(m[2]) };
};

// A drag is given in screen pixels; how far that moves the table in the drawing
// depends on the zoom, so the tests ask "did it move a lot" rather than "by
// exactly this much".
const MOVED = 40;

const drag = async (page: import('@playwright/test').Page, name: string, dx: number, dy: number) => {
  const box = await node(page, name).boundingBox();
  if (!box) throw new Error(`${name} is not on the canvas`);
  // the title bar: dragging from a field row works too, but this is what she does
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + 12 + dy, { steps: 12 });
  await page.mouse.up();
};

test('the canvas draws the same tables the list has, and says what is in them', async ({ page }) => {
  await open(page);
  // the rectangle shows the few facts the plan asks for, and not the rest
  const recipes = node(page, 'recipes');
  await expect(recipes).toContainText('id');
  await expect(recipes).toContainText('title');
  await expect(recipes).toContainText('Whole number');

  // clicking one picks it; the Fields page is on its menu
  await recipes.click();
  await expect(recipes).toHaveClass(/selected/);
  await recipes.getByRole('button', { name: 'Options for recipes' }).click();
  await page.getByRole('menuitem', { name: 'Open the Fields page' }).click();
  await expect(page).toHaveURL(/\/databases\/postgres\/family_recipes\/tables\/recipes$/);
  await expect(page.getByRole('list', { name: 'Fields' })).toContainText('title');
});

test('where she puts a table is remembered, and tidying up puts it back', async ({ page }) => {
  await open(page);
  const before = await at(page, 'recipes');
  await drag(page, 'recipes', 180, 140);
  const dropped = await at(page, 'recipes');
  expect(Math.abs(dropped.x - before.x)).toBeGreaterThan(MOVED);

  // it is written down on its own, without her pressing anything
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(node(page, 'recipes')).toBeVisible();
  const afterReload = await at(page, 'recipes');
  expect(Math.abs(afterReload.x - dropped.x)).toBeLessThan(2);
  expect(Math.abs(afterReload.y - dropped.y)).toBeLessThan(2);

  // and "tidy up" is how she gets the neat rows back
  await page.getByRole('button', { name: 'Tidy up' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Tidy it up' }).click();
  await expect(notice(page)).toContainText('Tidied up.');
  await expect.poll(async () => (await at(page, 'recipes')).x).not.toBe(afterReload.x);
});

// React Flow hides a node it has not measured (and every line to it). Nodes
// rebuilt on each frame of a drag lose their measured size, so the whole canvas
// blinked while she dragged. Watched with a MutationObserver because a blink is
// a frame long: no assertion after the drop would ever see it.
test('dragging a table does not make the drawing blink', async ({ page }) => {
  await open(page);
  await page.getByRole('application', { name: 'Schema canvas' }).evaluate((root) => {
    const w = window as unknown as { blinks: string[] };
    w.blinks = [];
    const lines = root.querySelectorAll('.react-flow__edge').length;
    new MutationObserver(() => {
      for (const n of root.querySelectorAll<HTMLElement>('.react-flow__node')) {
        if (n.style.visibility === 'hidden') w.blinks.push(`hidden: ${n.dataset.id}`);
      }
      const now = root.querySelectorAll('.react-flow__edge').length;
      if (now < lines) w.blinks.push(`lines: ${now} of ${lines}`);
    }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  });
  const before = await at(page, 'recipes');
  await drag(page, 'recipes', 160, 90);
  expect(Math.abs((await at(page, 'recipes')).x - before.x)).toBeGreaterThan(MOVED);
  expect(await page.evaluate(() => (window as unknown as { blinks: string[] }).blinks)).toEqual([]);

  // and picking or unpicking afterwards (which redraws every rectangle) leaves
  // the dragged one where she put it, not where the last save came back with
  const dropped = await at(page, 'recipes');
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await node(page, 'recipes').click();
  await expect(node(page, 'recipes')).toHaveClass(/selected/);
  const after = await at(page, 'recipes');
  // saved positions are whole pixels, so within one of where she let go
  expect(Math.abs(after.x - dropped.x)).toBeLessThan(2);
  expect(Math.abs(after.y - dropped.y)).toBeLessThan(2);
});

test('a table added on the canvas is the same drawing the list has', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Add table' }).click();
  const ask = page.getByRole('alertdialog');
  await ask.getByRole('textbox').fill('shopping');
  await ask.getByRole('button', { name: 'Add it' }).click();
  await expect(notice(page)).toContainText('Nothing has changed in the database yet.');
  await expect(node(page, 'shopping')).toBeVisible();

  // the very same change, seen from the other surface
  await page.getByRole('link', { name: 'Tables list' }).click();
  await expect(page.getByRole('list', { name: 'Tables' })).toContainText('shopping');
  await expect(page.getByText('Not applied yet')).toBeVisible();

  // put it back so the next run of this file starts where this one did
  await page.getByRole('button', { name: 'Throw them away' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Throw it away' }).click();
  await expect(notice(page)).toContainText('Back to what the database really has.');
});

test('throwing the drawing away does not move her tables back', async ({ page }) => {
  // the reason positions live beside the draft rather than inside it
  await open(page);
  await drag(page, 'recipes', 150, 90);
  const dropped = await at(page, 'recipes');
  await page.waitForTimeout(1200);

  await page.getByRole('button', { name: 'Add table' }).click();
  const ask = page.getByRole('alertdialog');
  await ask.getByRole('textbox').fill('scribble');
  await ask.getByRole('button', { name: 'Add it' }).click();
  await expect(node(page, 'scribble')).toBeVisible();

  await page.goto('/databases/postgres/family_recipes');
  await page.getByRole('button', { name: 'Throw them away' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Throw it away' }).click();
  await expect(notice(page)).toContainText('Back to what the database really has.');

  await page.goto('/databases/postgres/family_recipes/canvas');
  await expect(node(page, 'recipes')).toBeVisible();
  const after = await at(page, 'recipes');
  expect(Math.abs(after.x - dropped.x)).toBeLessThan(2);
  expect(Math.abs(after.y - dropped.y)).toBeLessThan(2);

  // tidy up again so this file leaves the canvas as it found it
  await page.getByRole('button', { name: 'Tidy up' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Tidy it up' }).click();
  await expect(notice(page)).toContainText('Tidied up.');
});

// The menu in a rectangle's corner: everything on it is a change to the
// drawing, the same as on the Tables list, and nothing reaches the database.
const menu = async (page: import('@playwright/test').Page, name: string, item: string) => {
  await node(page, name).getByRole('button', { name: `Options for ${name}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
};

test('a table\'s menu adds a field through a small form', async ({ page }) => {
  await open(page);
  // pressing the menu is a press, not the start of a drag
  const before = await at(page, 'recipes');
  await menu(page, 'recipes', 'Add field');
  expect(await at(page, 'recipes')).toEqual(before);

  const form = page.getByRole('dialog', { name: 'Add a field to recipes' });
  await expect(form).toBeVisible();
  // a name it already has is said in the window, which stays open
  await form.getByLabel('Field name').fill('title');
  await form.getByRole('button', { name: 'Add field' }).click();
  await expect(form.getByRole('alert')).toContainText('recipes already has a field called title');

  await form.getByLabel('Field name').fill('rating');
  await form.getByLabel('What goes in it').selectOption({ label: 'Whole number' });
  await form.getByText('Has to be filled in').click();
  // recipes is in the database, so required-with-nothing-to-start-with is warned about
  await expect(form).toContainText('can only be added while recipes is empty');
  await form.getByLabel('Starts out as').selectOption({ label: 'Something I type' });
  await expect(form).not.toContainText('can only be added while recipes is empty');
  await form.getByLabel('Which value').fill('3');
  await form.getByRole('button', { name: 'Add field' }).click();
  await expect(form).toBeHidden();
  await expect(notice(page)).toContainText('rating is in recipes in your drawing');
  await expect(node(page, 'recipes')).toContainText('rating');

  // it is the same drawing the Fields page has, starting value and all
  await page.goto('/databases/postgres/family_recipes/tables/recipes');
  const rating = page.getByRole('listitem').filter({ has: page.getByText('rating', { exact: true }) });
  await expect(rating).toContainText('has to be filled in');
  await expect(rating).toContainText('starts out as 3');

  await page.goto('/databases/postgres/family_recipes');
  await page.getByRole('button', { name: 'Throw them away' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Throw it away' }).click();
  await expect(notice(page)).toContainText('Back to what the database really has.');
});

test('a table\'s menu copies, renames and deletes tables in the drawing', async ({ page }) => {
  await open(page);

  // a copy of the design, without the field kind the panel cannot make
  await menu(page, 'recipes', 'Make a copy');
  const ask = confirmDialog(page);
  await expect(ask.getByRole('textbox')).toHaveValue('recipes_copy');
  await ask.getByRole('button', { name: 'Make the copy' }).click();
  await expect(notice(page)).toContainText('tags is a kind of field the panel does not make');
  // placed where there is room, and brought into view even if that is off screen
  await expect(node(page, 'recipes_copy')).toBeInViewport();
  await expect(node(page, 'recipes_copy')).toContainText('servings');
  await expect(node(page, 'recipes_copy')).not.toContainText('tags');

  // renamed where it stands
  const was = await at(page, 'recipes_copy');
  await menu(page, 'recipes_copy', 'Rename');
  await confirmDialog(page).getByRole('textbox').fill('dishes');
  await confirmDialog(page).getByRole('button', { name: 'Rename it' }).click();
  await expect(node(page, 'dishes')).toBeVisible();
  await expect(node(page, 'recipes_copy')).toHaveCount(0);
  const now = await at(page, 'dishes');
  expect(Math.abs(now.x - was.x)).toBeLessThan(2);
  expect(Math.abs(now.y - was.y)).toBeLessThan(2);

  // one that was never made just comes out of the drawing
  await menu(page, 'dishes', 'Delete table');
  await expect(confirmDialog(page)).toContainText('never made');
  await confirmDialog(page).getByRole('button', { name: 'Take it out' }).click();
  await expect(node(page, 'dishes')).toHaveCount(0);

  // one that is in the database says what deleting it costs, and can be let off
  await menu(page, 'recipes', 'Delete table');
  await expect(confirmDialog(page)).toContainText('every row in recipes is deleted');
  await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(node(page, 'recipes')).toBeVisible();

  // renaming a table in the database is a rename, not a table thrown away
  await menu(page, 'recipes', 'Rename');
  await confirmDialog(page).getByRole('textbox').fill('meals');
  await confirmDialog(page).getByRole('button', { name: 'Rename it' }).click();
  await expect(node(page, 'meals')).toBeVisible();
  await page.getByRole('link', { name: 'Tables list' }).click();
  await expect(page.getByRole('list', { name: 'Changes' })).toContainText('Rename the table recipes to meals');
  await expect(page.getByRole('list', { name: 'Changes' })).not.toContainText('Remove the table');

  await page.getByRole('button', { name: 'Throw them away' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Throw it away' }).click();
  await expect(notice(page)).toContainText('Back to what the database really has.');
});
