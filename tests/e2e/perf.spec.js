// Performance guard for large forums: re-sorting must not freeze the page.
// Measured with the Long Tasks API (tasks > 50 ms block input and scrolling).
// Reference (headless Chromium, 2000 postings): ~70–100 ms longest task.
// The budget leaves room for slower CI machines but catches gross
// regressions such as per-comparison DOM queries on real-sized postings.
// (That the sort key is computed once per group is unit-tested exactly in
// tests/unit/sorting.test.js.)
const { test, expect, shadow } = require('./extension');

const POSTINGS = 2000;
const BUDGET_MS = 400;

async function sortedBy(page, attr) {
  return page.evaluate((attr) => {
    const main = document.querySelector('dst-forum').shadowRoot.querySelector('main.forum--main');
    const vals = Array.from(main.querySelectorAll(':scope > dst-posting[data-level="0"]'))
      .map((el) => ({ top: el.getBoundingClientRect().top, v: +el.querySelector('dst-posting--ratinglog').getAttribute(attr) }))
      .sort((a, b) => a.top - b.top)
      .map((x) => x.v);
    return vals.length && vals.every((v, i) => i === 0 || v <= vals[i - 1]);
  }, attr);
}

test(`re-sorting ${POSTINGS} postings stays within ${BUDGET_MS} ms per task`, async ({ context, site }) => {
  test.setTimeout(120000);
  const page = await context.newPage();
  await page.goto(`${site.ARTICLE_URL}?gen=${POSTINGS}`);
  await expect(shadow(page, '#dst-badge-bar .dst-badge-btn[data-group]').first()).toBeVisible({ timeout: 60000 });
  await expect(shadow(page, '#dst-progress-container')).toHaveCount(0, { timeout: 60000 });
  await page.waitForTimeout(3500); // initial load, sort and delayed re-check are done

  await page.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration));
    }).observe({ type: 'longtask' });
  });

  const results = [];
  for (const [group, check] of [['likes', 'positiveratings'], ['likes', 'negativeratings'], ['timeline', null], ['balance', null]]) {
    await page.evaluate(() => { window.__longTasks = []; });
    await shadow(page, `.dst-badge-btn[data-group="${group}"]`).click();
    await expect(shadow(page, '#dst-progress-container')).toHaveCount(0, { timeout: 30000 });
    if (check) await expect.poll(() => sortedBy(page, check)).toBe(true);
    await page.waitForTimeout(300);
    const tasks = await page.evaluate(() => window.__longTasks);
    results.push({ group, longest: Math.max(0, ...tasks) });
  }
  console.log('longest tasks per re-sort (ms):', JSON.stringify(results));
  for (const r of results) expect(r.longest, JSON.stringify(results)).toBeLessThan(BUDGET_MS);
});
