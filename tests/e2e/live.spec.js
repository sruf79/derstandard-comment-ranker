// Live smoke test against the real derstandard.at — an early warning when the
// site changes the forum DOM or its GraphQL payload. Opt-in only:
//
//   DST_LIVE=1 DST_PROFILE=/path/to/chromium-profile npm run test:live
//
// derstandard.at shows a consent wall to new visitors. The test never answers
// it; point DST_PROFILE at a Chromium user-data dir in which you have already
// made your choice (run once with HEADED=1 and decide yourself). Without one,
// the test is skipped when the consent page appears.
// Optional: DST_ARTICLE=<story URL> to test a specific article.
const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext(process.env.DST_PROFILE || '', {
      channel: 'chromium',
      headless: !process.env.HEADED,
      locale: 'de-AT',
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`]
    });
    await use(context);
    await context.close();
  }
});

test.skip(!process.env.DST_LIVE, 'live test is opt-in (DST_LIVE=1)');
test.setTimeout(180000);

async function openArticleWithForum(page) {
  if (process.env.DST_ARTICLE) {
    await page.goto(process.env.DST_ARTICLE, { waitUntil: 'domcontentloaded' });
  } else {
    await page.goto('https://www.derstandard.at/', { waitUntil: 'domcontentloaded' });
  }
  test.skip(page.url().includes('/consent/'), 'consent wall shown — use DST_PROFILE with a decided consent');
  if (!process.env.DST_ARTICLE) {
    const links = await page.$$eval('a[href*="/story/"]', (as) => [...new Set(as.map((a) => a.href))].slice(0, 10));
    for (const link of links) {
      await page.goto(link, { waitUntil: 'domcontentloaded' });
      if (await page.locator('dst-forum').count()) return;
    }
    test.skip(true, 'no article with a forum found on the home page');
  }
}

test('extension still understands the live forum DOM', async ({ context }) => {
  const page = await context.newPage();
  await openArticleWithForum(page);

  // The forum is lazy; scroll until the extension has injected its badge bar.
  const bar = page.locator('dst-forum').locator('#dst-badge-bar');
  for (let i = 0; i < 30 && !(await bar.count()); i++) {
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(700);
  }
  await expect(bar, 'badge bar not injected — forum DOM may have changed').toBeVisible({ timeout: 30000 });

  // Every selector the extension depends on must still match.
  const dom = await page.evaluate(() => {
    const forum = document.querySelector('dst-forum');
    const sr = forum.shadowRoot;
    const main = sr.querySelector('main.forum--main');
    const roots = main ? main.querySelectorAll(':scope > dst-posting[data-level="0"]') : [];
    const rated = Array.from(roots).filter((p) => p.querySelector('dst-posting--ratinglog[postingid][positiveratings][negativeratings]'));
    return {
      header: !!sr.querySelector('.forum--header'),
      main: !!main,
      roots: roots.length,
      rated: rated.length,
      count: !!(sr.querySelector('.forum--postingcount') || document.querySelector('.js-forum-postingcount, .article-postingcount'))
    };
  });
  expect(dom.header, '.forum--header').toBe(true);
  expect(dom.main, 'main.forum--main').toBe(true);
  expect(dom.roots, 'root postings').toBeGreaterThan(0);
  expect(dom.rated, 'postings with dst-posting--ratinglog').toBe(dom.roots);
  expect(dom.count, 'posting count element').toBe(true);

  // Likes: Top must produce non-increasing positive ratings in visual order.
  await page.locator('dst-forum').locator('.dst-badge-btn[data-group="likes"]').click();
  await page.waitForTimeout(1500);
  const positives = await page.evaluate(() => {
    const main = document.querySelector('dst-forum').shadowRoot.querySelector('main.forum--main');
    return Array.from(main.querySelectorAll(':scope > dst-posting[data-level="0"]'))
      .filter((el) => getComputedStyle(el).display !== 'none' && !el.hasAttribute('pinned'))
      .map((el) => ({ top: el.getBoundingClientRect().top, pos: +el.querySelector('dst-posting--ratinglog').getAttribute('positiveratings') }))
      .sort((a, b) => a.top - b.top)
      .map((x) => x.pos)
      .slice(0, 30);
  });
  for (let i = 1; i < positives.length; i++) expect(positives[i]).toBeLessThanOrEqual(positives[i - 1]);

  // The voter popup needs the GraphQL id mapping captured by forum-hook.js.
  const rating = page.locator('dst-forum').locator('dst-posting--ratinglog').first();
  await rating.scrollIntoViewIfNeeded();
  await rating.click();
  const overlay = page.locator('dst-forum').locator('#dst-voter-overlay');
  await expect(overlay).toBeVisible();
  await expect(page.locator('dst-forum').locator('.dst-voter-error'), 'voter popup failed (GraphQL ids or ratinglog changed?)')
    .toHaveCount(0, { timeout: 10000 });
  await expect(page.locator('dst-forum').locator('.dst-voter-progress--done')).toBeVisible({ timeout: 30000 });
});
