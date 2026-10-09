import { request as httpRequest } from 'node:http';
import { expect, notice, test } from './fixtures.ts';
import { routeGate } from './gate.ts';

// Ask the gate (test/e2e/server.ts runs it on 3197) the way a page on her site would.
const gateJson = (path: string) => new Promise<{ status: number; json: any }>((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port: 3197, path, headers: { host: 'pammy.org', 'x-pammy-base': '/', 'x-real-ip': '198.51.100.9' } }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => { let json: any = null; try { json = JSON.parse(body); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, json }); });
  });
  req.on('error', reject);
  req.end();
});

test('the media examples run on the example folder, and "Put this on my website" makes one showing her own tag', async ({ page }) => {
  await routeGate(page);
  await page.goto('/media/examples');
  for (const name of ['Gallery', 'Slide show', 'Documents', 'Music player']) await expect(page.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();

  // the gallery, working in its frame: pictures, and one opens big
  await page.getByRole('button', { name: /^Gallery/ }).click();
  await expect(page).toHaveURL('/media/examples/gallery');
  const frame = page.frameLocator('iframe[title="The Gallery example"]');
  await expect(frame.locator('.gallery li')).toHaveCount(5);
  await expect(frame.locator('.gallery img').first()).toHaveAttribute('alt', /sky|hills/);
  await frame.locator('.gallery button').first().click();
  await expect(frame.locator('.lightbox')).toBeVisible();
  await expect(frame.locator('.lightbox figcaption')).not.toBeEmpty();
  await frame.locator('.lightbox .next').click();
  await frame.locator('.lightbox .close').click();

  // the music player lists its songs, each with its cover
  await page.goto('/media/examples/music');
  const player = page.frameLocator('iframe[title="The Music player example"]');
  await expect(player.locator('.songs li')).toHaveCount(3);
  await expect(player.locator('.playing')).toHaveText('Evening hum');      // by file name
  await expect(player.locator('.cover')).toHaveAttribute('src', /media-demo\/thumbs\//);

  // her own: tag a picture in recipes, and put a gallery of that tag on her website
  const items = await page.request.get('/api/media/items?scope=%2Frecipes&kind=images&q=.');      // a search: every folder inside
  const ids = (await items.json()).items.map((i: { id: number }) => i.id);
  expect(ids.length).toBeGreaterThan(0);
  const tagged = await page.request.post('/api/media/items/labels', { data: { ids, add: { tags: ['on-show'] } }, headers: { origin: new URL(page.url()).origin } });
  expect(tagged.status()).toBe(200);
  await page.goto('/media/examples/gallery');
  await page.getByLabel('Media folder').selectOption({ label: 'recipes' });
  await page.getByRole('checkbox', { name: `#on-show (${ids.length}) – not switched on` }).click();
  await page.getByLabel('Page name').fill('on-show.html');
  await page.getByRole('button', { name: 'Put it on my website' }).click();
  await expect(notice(page)).toHaveText('Your page is on your website.');
  await expect(page.getByRole('link', { name: /\/recipes\/on-show\.html$/ }).first()).toBeVisible();
  // nothing shows until the tag is switched on, then it does (the panel publishes; the gate reads)
  expect((await gateJson('/_pammy/api/media/in/recipes/t/on-show')).status).toBe(404);
  await page.getByRole('button', { name: 'Switch it on for /recipes/t/on-show' }).click();
  await expect(notice(page)).toHaveText('Switched on for /recipes/t/on-show.');
  await expect.poll(async () => (await gateJson('/_pammy/api/media/in/recipes/t/on-show?kind=images')).json?.total, { timeout: 10_000 }).toBe(ids.length);

  // and the Tags & categories page shows the switch on
  await page.goto('/media/tags?folder=recipes');
  await expect(page.getByRole('listitem').filter({ hasText: '#on-show' })).toContainText('anyone can list its files');
});

test('a file\'s title and "what it shows" reach the media API', async ({ page }) => {
  await page.goto('/media?folder=recipes&kind=images&in=trip');
  await page.getByRole('button', { name: 'Open cake.png' }).click();
  const details = page.getByRole('dialog', { name: 'cake.png' });
  await details.getByLabel('Title', { exact: true }).fill('Lemon cake');
  await details.getByLabel('What it shows').fill('A slice of lemon cake on a plate');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(notice(page)).toHaveText('Saved.');
  await expect.poll(async () => {
    const files = (await gateJson('/_pammy/api/media/in/recipes/t/on-show?kind=images')).json?.files ?? [];
    return files.find((f: { name: string }) => f.name === 'cake.png')?.alt;
  }, { timeout: 10_000 }).toBe('A slice of lemon cake on a plate');
});
