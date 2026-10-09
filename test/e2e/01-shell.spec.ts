import { addAuthenticator, expect, notice, test, watchForProblems } from './fixtures.ts';

test('signed out: every page goes to sign in, and back afterwards', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });          // no session
  const page = await context.newPage();
  const problems = watchForProblems(page);
  await addAuthenticator(page);
  await page.goto('/help/control-panel?q=passkey');
  await expect(page).toHaveURL('/login?next=%2Fhelp%2Fcontrol-panel%3Fq%3Dpasskey');
  await expect(page).toHaveTitle('Sign in · pammy.org panel');
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page).toHaveURL('/help/control-panel?q=passkey');
  await expect(page.getByText('Search words marked: "passkey"')).toBeVisible();

  // signing out ends this session only
  await page.getByRole('banner').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/login');
  await page.goto('/responses');
  await expect(page).toHaveURL('/login?next=%2Fresponses');
  expect(problems).toEqual([]);
  await context.close();
});

test('the menu slides in, shows what is waiting, and closes', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Home · pammy.org panel');
  await expect(page.getByTestId('menu-dot')).toBeVisible();
  const open = page.getByRole('button', { name: 'Open the menu' });
  await open.click();
  const menu = page.getByRole('dialog', { name: /pammy\.org panel/ });
  await expect(menu).toBeVisible();
  const nav = menu.getByRole('navigation', { name: 'Sections' });
  await expect(nav.getByRole('link')).toHaveText([
    'Home', /^Responses\s*2$/, 'Comments', /^Requests\s*2$/, 'Subdomains', 'File Explorer', 'Tags & categories', 'Media', 'Make media folders', 'Media examples', 'Forms', 'Form examples',
    'Your databases', 'Database users', 'Database examples', 'Tutorial examples', 'Installed software',
    'Protected folders', 'People', 'Email', 'Visitors', 'API keys',
    'Passkeys & devices', 'Accounts', 'Activity', 'Help',
  ]);
  await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Home' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(open).toBeFocused();

  await open.click();
  await nav.getByRole('link', { name: 'Subdomains' }).click();
  await expect(menu).toBeHidden();
  await expect(page).toHaveURL('/subdomains');
  await expect(page).toHaveTitle('Subdomains · pammy.org panel');

  await open.click();
  await page.getByRole('button', { name: 'Close the menu' }).click();
  await expect(menu).toBeHidden();

  // Back works like any website
  await page.goBack();
  await expect(page).toHaveURL('/');
});

test('old #addresses still work', async ({ page }) => {
  await page.goto('/#messages');
  await expect(page).toHaveURL('/responses');
  await page.goto('/#help?q=cloudflare');
  await expect(page).toHaveURL('/help?q=cloudflare');
  await page.goto('/#sites');
  await expect(page).toHaveURL('/subdomains');
  expect((await page.request.get('/nope')).status()).toBe(404);
});

test('the page nonce lets dialogs lock scrolling, and nothing else inline', async ({ page, problems }) => {
  await page.goto('/subdomains');
  await page.getByRole('button', { name: 'Open the menu' }).click();
  // the scroll lock's <style> carries the page's nonce
  const styles = await page.evaluate(() => [...document.querySelectorAll('style')].map((s) => s.nonce));
  expect(styles.length).toBeGreaterThan(0);
  expect(styles.every((n) => n && n.length === 24)).toBe(true);
  // anything without it is refused
  await page.evaluate(() => { const s = document.createElement('style'); s.textContent = 'body{background:red}'; document.head.append(s); });
  await expect.poll(() => problems.some((p) => p.includes('CSP violation: style-src'))).toBe(true);
  problems.length = 0;

  // ...but a style ATTRIBUTE is allowed, and that is the whole of the
  // loosening (src/security.ts `style-src-attr`). A nonce cannot cover an
  // attribute, so without this the progress bar could not move and the schema
  // canvas could not place a single table. Asserted right next to the refusal
  // above so the two stay a pair: attributes yes, stylesheets no.
  const width = await page.evaluate(() => {
    const el = document.createElement('div');
    el.setAttribute('style', 'width: 123px');
    document.body.append(el);
    const w = getComputedStyle(el).width;
    el.remove();
    return w;
  });
  expect(width).toBe('123px');
  expect(problems).toEqual([]);
});

test('errors are shown, and can be closed', async ({ page }) => {
  await page.goto('/subdomains');
  await page.getByLabel('Name').fill('www');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(notice(page, 'error')).toHaveText('"www" is already used by the server, so pick another name.');
  await notice(page, 'error').getByRole('button', { name: 'Close' }).click();
  await expect(notice(page, 'error')).toBeHidden();
});
