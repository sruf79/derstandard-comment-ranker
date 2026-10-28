// Loads the real, unpacked extension into Chromium and drives it on a fixture
// forum served under a derStandard article URL.
const { test, expect, visualOrder, shadow, ARTICLE_URL } = require('./extension');

// Ratings in fixtures/forum-page.html (net = pos - neg):
// E1 +2, E2 +35, E3 -12, E4 +12 | batch 1: E5 +99, E6 -29 | batch 2: E7 0
const ALL_BALANCE_TOP = ['E5', 'E2', 'E4', 'E1', 'E7', 'E3', 'E6'];

test.describe('derStandard Comment Ranker (Chromium, unpacked)', () => {
  test('sorts the whole forum by Balance: Top after loading all postings', async ({ context, site }) => {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(site.ARTICLE_URL);

    await expect(shadow(page, '#dst-badge-bar')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__loadMoreClicks || 0), { timeout: 20000 }).toBe(2);
    await expect.poll(() => visualOrder(page), { timeout: 20000 }).toEqual(ALL_BALANCE_TOP);
    await expect(shadow(page, '#dst-progress-container')).toHaveCount(0, { timeout: 20000 });

    // Background loading must never expand reply threads.
    expect(await page.evaluate(() => window.__replyToggles || 0)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('badge clicks change the order and the mode survives a reload', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await expect.poll(() => visualOrder(page), { timeout: 20000 }).toEqual(ALL_BALANCE_TOP);

    await shadow(page, '.dst-badge-btn[data-group="timeline"]').click();
    await expect.poll(() => visualOrder(page)).toEqual(['E6', 'E3', 'E1', 'E2', 'E4', 'E5', 'E7']);
    await expect(shadow(page, '.dst-badge-btn.active')).toHaveAttribute('data-mode', 'chronological-new');

    await page.reload();
    await expect(shadow(page, '.dst-badge-btn.active')).toHaveAttribute('data-mode', 'chronological-new', { timeout: 20000 });
    await expect.poll(() => visualOrder(page), { timeout: 20000 }).toEqual(['E6', 'E3', 'E1', 'E2', 'E4', 'E5', 'E7']);
  });

  test('keyboard: badges are reachable and operable', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    const likes = shadow(page, '.dst-badge-btn[data-group="likes"]');
    await expect(likes).toBeVisible({ timeout: 20000 });
    await likes.focus();
    await page.keyboard.press('Enter');
    await expect(shadow(page, '.dst-badge-btn.active')).toHaveAttribute('data-mode', 'positive-only');
  });

  test('voter popup lists who voted, without triggering the page handler', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await expect(shadow(page, '#dst-badge-bar')).toBeVisible({ timeout: 20000 });

    await shadow(page, 'dst-posting--ratinglog[postingid="E2"]').click();
    const overlay = shadow(page, '#dst-voter-overlay');
    await expect(overlay).toBeVisible();
    await expect(shadow(page, '.dst-voter-list[data-kind="pos"] a')).toHaveText(['Anna Beispiel', 'Berta', 'Dora']);
    await expect(shadow(page, '.dst-voter-list[data-kind="neg"] a')).toHaveText(['Kritiker <b>99</b>', 'Carl']);
    expect(site.requests).toContain('https://apps.derstandard.at/forum/ratinglog?id=9002&idType=1');
    expect(await page.evaluate(() => window.__paywallClicks || 0)).toBe(0);

    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });

  test('popup toggle disables the extension on the page', async ({ context, site, extensionId }) => {
    test.skip(!extensionId, 'extension id not resolvable in this Chromium build');
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await expect(shadow(page, '#dst-badge-bar')).toBeVisible({ timeout: 20000 });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator('#extensionEnabled')).toBeChecked();
    await popup.locator('.switch').click();
    await expect(popup.locator('#extensionEnabled')).not.toBeChecked();
    expect(await popup.evaluate(() => new Promise((r) => chrome.storage.sync.get('dstSorterEnabled', r)))).toEqual({ dstSorterEnabled: false });

    await page.reload();
    await page.waitForTimeout(3000);
    await expect(shadow(page, '#dst-badge-bar')).toHaveCount(0);
  });

  test('does nothing on non-article pages without a forum', async ({ context, site }) => {
    await context.route('https://www.derstandard.at/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Home</title><h1>Startseite</h1>' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('https://www.derstandard.at/');
    await page.waitForTimeout(2000);
    expect(await page.evaluate(() => document.documentElement.style.overflowAnchor)).toBe('none');
    expect(errors).toEqual([]);
  });
});
