// Performance guard for large forums: re-sorting must not freeze the page.
// Measured with the Long Tasks API (tasks > 50 ms block input and scrolling).
// Reference, headless Chromium, 2000 postings:
//   v2.4.10 ~70–100 ms, v4.19.8 ~260–400 ms longest task.
// The 4.x cards make the layout after a re-sort about 3–4× more expensive;
// profiling shows the time is layout itself (forced first by fitSortBar,
// otherwise by the scroll anchor or the next frame), not a single CSS rule.
// The budget catches gross regressions such as per-comparison DOM queries.
// (That the sort key is computed once per group is unit-tested exactly in
// tests/unit/sorting.test.js.)
const { test, expect, shadow, segment, waitLoaded } = require('./extension');

const POSTINGS = 2000;
const BUDGET_MS = 600;

// Pure order check: postings with votes of the chosen side first, by fewest
// votes of the other side; postings without votes of the chosen side last.
async function pureSorted(page, side) {
  return page.evaluate((side) => {
    const main = document.querySelector('dst-forum').shadowRoot.querySelector('main.forum--main');
    const rows = Array.from(main.querySelectorAll(':scope > dst-posting[data-level="0"]'))
      .map((el) => {
        const r = el.querySelector('dst-posting--ratinglog');
        const pos = +r.getAttribute('positiveratings'), neg = +r.getAttribute('negativeratings');
        return { top: el.getBoundingClientRect().top, mine: side === 'pos' ? pos : neg, other: side === 'pos' ? neg : pos };
      })
      .sort((a, b) => a.top - b.top);
    let seenNone = false;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].mine === 0) { seenNone = true; continue; }
      if (seenNone) return false;                                        // "none" must be last
      if (i > 0 && rows[i - 1].mine !== 0 && rows[i].other < rows[i - 1].other) return false;
    }
    return rows.length > 0;
  }, side);
}

test(`re-sorting ${POSTINGS} postings stays within ${BUDGET_MS} ms per task`, async ({ context, site }) => {
  test.setTimeout(120000);
  const page = await context.newPage();
  await page.goto(`${site.ARTICLE_URL}?gen=${POSTINGS}`);
  await waitLoaded(page, 60000);
  await page.waitForTimeout(3500); // initial load, sort and delayed re-check are done

  await page.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration));
    }).observe({ type: 'longtask' });
  });

  const results = [];
  for (const [group, check] of [['likes', 'pos'], ['likes', 'neg'], ['timeline', null], ['balance', null]]) {
    await page.evaluate(() => { window.__longTasks = []; });
    await segment(page, group).click();
    await page.waitForTimeout(500); // the re-sort starts after the slide (460 ms)
    if (check) await expect.poll(() => pureSorted(page, check)).toBe(true);
    await page.waitForTimeout(300);
    const tasks = await page.evaluate(() => window.__longTasks);
    results.push({ group, longest: Math.max(0, ...tasks) });
  }
  console.log('longest tasks per re-sort (ms):', JSON.stringify(results));
  for (const r of results) expect(r.longest, JSON.stringify(results)).toBeLessThan(BUDGET_MS);
});
