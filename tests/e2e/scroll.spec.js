// Scroll stability: while the extension loads more postings in the background
// and re-sorts, whatever the reader is looking at must not move. Positions are
// sampled every animation frame, so short jumps are caught as well.
const { test, expect, shadow } = require('./extension');

const BASE = 'https://www.derstandard.at/story/3000000999999/testartikel';
// 30 postings rendered, 3 more batches of 20 loaded in the background.
const LOADING = '?gen=30&batches=3&size=20&delay=600';
const TOLERANCE = 2; // px

// Starts recording the viewport position of `target` every frame.
// target: { posting: id } | { footer: true } | { article: true }
async function track(page, target) {
  await page.evaluate((target) => {
    const find = () => {
      if (target.footer) return document.getElementById('page-footer');
      if (target.article) return document.querySelector('article h1');
      const main = document.querySelector('dst-forum').shadowRoot.querySelector('main.forum--main');
      return main.querySelector(`dst-posting--ratinglog[postingid="${target.posting}"]`).closest('dst-posting');
    };
    const start = find().getBoundingClientRect().top;
    window.__track = { start, maxDelta: 0, samples: 0, worst: null };
    const loop = () => {
      const top = find().getBoundingClientRect().top;
      const d = Math.abs(top - start);
      window.__track.samples++;
      if (d > window.__track.maxDelta) {
        window.__track.maxDelta = d;
        window.__track.worst = { top, at: performance.now() };
      }
      window.__trackRaf = requestAnimationFrame(loop);
    };
    loop();
  }, target);
}

async function stopTracking(page) {
  return page.evaluate(() => {
    cancelAnimationFrame(window.__trackRaf);
    return window.__track;
  });
}

// The root posting currently shown at `rank` (0 = first) in visual order.
async function postingAtRank(page, rank) {
  return page.evaluate((rank) => {
    const main = document.querySelector('dst-forum').shadowRoot.querySelector('main.forum--main');
    return Array.from(main.querySelectorAll(':scope > dst-posting[data-level="0"]'))
      .map((el) => ({ el, top: el.getBoundingClientRect().top }))
      .sort((a, b) => a.top - b.top)[rank].el
      .querySelector('dst-posting--ratinglog').getAttribute('postingid');
  }, rank);
}

async function scrollPostingTo(page, id, y) {
  await page.evaluate(({ id, y }) => {
    const main = document.querySelector('dst-forum').shadowRoot.querySelector('main.forum--main');
    const el = main.querySelector(`dst-posting--ratinglog[postingid="${id}"]`).closest('dst-posting');
    window.scrollBy(0, el.getBoundingClientRect().top - y);
  }, { id, y });
}

async function waitForLoadingDone(page) {
  await expect.poll(() => page.evaluate(() => window.__loadMoreClicks || 0), { timeout: 30000 }).toBe(3);
  await expect(shadow(page, '#dst-progress-container')).toHaveCount(0, { timeout: 30000 });
  await expect.poll(() => page.evaluate(() => document.querySelector('dst-forum').shadowRoot
    .querySelectorAll('main.forum--main > dst-posting[data-level="0"]').length)).toBe(90);
  await page.waitForTimeout(3500); // final re-sort + delayed rating re-check (3 s)
}

for (const [name, ctxOptions] of [
  ['desktop', { viewport: { width: 1280, height: 900 } }],
  ['mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }]
]) {
  test.describe(`scroll stability (${name})`, () => {
    test.use({ ctxOptions });

    test('reader inside the forum keeps their posting in place while everything loads and re-sorts', async ({ context, site }) => {
      const page = await context.newPage();
      await page.goto(BASE + LOADING);
      await expect(shadow(page, '#dst-badge-bar')).toBeVisible({ timeout: 20000 });
      const id = await postingAtRank(page, 12);
      await scrollPostingTo(page, id, 150);
      await track(page, { posting: id });

      await waitForLoadingDone(page);
      const t = await stopTracking(page);
      expect(t.samples).toBeGreaterThan(30);
      expect(t.maxDelta, JSON.stringify(t)).toBeLessThanOrEqual(TOLERANCE);
    });

    test('reader in the article above the forum is not moved', async ({ context, site }) => {
      const page = await context.newPage();
      await page.goto(BASE + LOADING + '&article=3000');
      await page.evaluate(() => window.scrollTo(0, 600));
      await expect.poll(() => page.evaluate(() => !!document.querySelector('dst-forum').shadowRoot
        .querySelector('#dst-badge-bar')), { timeout: 20000 }).toBe(true);
      const scrollY = await page.evaluate(() => window.scrollY);
      await track(page, { article: true });

      await waitForLoadingDone(page);
      const t = await stopTracking(page);
      expect(t.maxDelta, JSON.stringify(t)).toBeLessThanOrEqual(TOLERANCE);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    });

    // Reader below the forum: background loading appends postings above them.
    // The reader reaches the footer before loading starts (the extension
    // deliberately does not compensate if the reader scrolls while a batch is
    // in flight).
    async function footerRun(page, extra) {
      await page.goto(BASE + LOADING + '&moreAfter=2500' + extra);
      await expect(shadow(page, '#dst-badge-bar')).toBeVisible({ timeout: 20000 });
      await page.evaluate(() => document.getElementById('page-footer').scrollIntoView());
      expect(await page.evaluate(() => window.__loadMoreClicks || 0)).toBe(0);
      await track(page, { footer: true });
      await waitForLoadingDone(page);
      return stopTracking(page);
    }

    test('reader below the forum (footer) stays in place while the forum grows', async ({ context, site }) => {
      const t = await footerRun(await context.newPage(), '&keepMore=1');
      expect(t.maxDelta, JSON.stringify(t)).toBeLessThanOrEqual(TOLERANCE);
    });

    // KNOWN GAP: when the native "Weitere Postings laden" button disappears
    // after the last batch, a reader below the forum moves up by its height
    // (~21 px). The extension anchors the bottom of main.forum--main, and in
    // this fixture the button sits outside it. Unverified where the live site
    // puts the button. test.fail() turns red once this is compensated.
    test('KNOWN GAP: footer also stays when the load-more button disappears', async ({ context, site }) => {
      test.fail();
      const t = await footerRun(await context.newPage(), '');
      expect(t.maxDelta, JSON.stringify(t)).toBeLessThanOrEqual(TOLERANCE);
    });
  });
}
