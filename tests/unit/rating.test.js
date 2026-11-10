import { describe, it, expect } from 'vitest';
import { createEnv, DAY, DEFAULT_NOW } from '../helpers/env.js';
import { track } from '../helpers/setup.js';
import { buildForum } from '../helpers/forum.js';

const NOW = DEFAULT_NOW;
const CHROME_URL = 'https://chromewebstore.google.com/detail/derstandard-comment-ranke/kcnlkimhnhlacphcnigicjkkbenhfkeb/reviews';
const AMO_URL = 'https://addons.mozilla.org/firefox/addon/derstandard-comment-ranker/reviews/';

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  samsung: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0',
  neutral: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)'
};

// v4.21.0: the bar is due after 5 USAGE days (dstUsageDays, local, written by
// content.js) and appears only in a helpful moment (content.js sets
// data-dst-moment / fires 'dst-helpful-moment').
const DUE_LOCAL = { dstUsageDays: 5 };

async function run({ sync = {}, local = DUE_LOCAL, badgeBar = true, moment = true, url, userAgent, browserGlobal } = {}) {
  const env = track(await createEnv({ sync, local, url, userAgent, browserGlobal }));
  const { main, shadow } = buildForum(env.document, { postings: [{ id: 'A' }] });
  if (badgeBar) {
    const bar = env.document.createElement('div');
    bar.id = 'dst-badge-bar';
    main.insertBefore(bar, main.firstChild);
  }
  if (moment) env.document.documentElement.setAttribute('data-dst-moment', '1');
  const r = env.load('rating.js');
  await env.tick(1000); // main() starts 1s after load
  await env.flush();
  const bar = () => shadow.querySelector('#dst-feedback-bar');
  return { env, r, shadow, main, bar, data: env.chrome.storage.sync.data, localData: env.chrome.storage.local.data };
}

describe('reviewDue (v4.21.0)', () => {
  it.each([
    // usage days, rated, dismissals, usage day of the last ✕, due
    [4, false, 0, undefined, false],
    [5, false, 0, undefined, true],
    [50, true, 0, undefined, false],
    [11, false, 1, 5, false], [12, false, 1, 5, true],     // 1st ✕: +7
    [32, false, 2, 12, false], [33, false, 2, 12, true],   // 2nd ✕: +21
    [500, false, 3, 33, false]                             // 3rd ✕: never again
  ])('%i days, rated=%s, %i dismissals (at %s) → %s', async (days, rated, count, at, due) => {
    const env = track(await createEnv({}));
    expect(env.load('rating.js').reviewDue(days, rated, count, at)).toBe(due);
  });
});

describe('feedback bar timing', () => {
  it('stays hidden before 5 usage days, whatever the calendar says', async () => {
    const { bar, data } = await run({ local: { dstUsageDays: 4 }, sync: { dstRanker_installDate: NOW - 300 * DAY } });
    expect(bar()).toBeNull();
    expect(data.dstRanker_reviewShownDay).toBeUndefined();
  });

  it('appears from 5 usage days, right after the badge bar, with a dismiss button', async () => {
    const { bar, main } = await run();
    expect(bar()).not.toBeNull();
    expect(main.querySelector('#dst-badge-bar').nextElementSibling).toBe(bar());
    expect(bar().style.order).toBe('-1');
    expect(bar().querySelectorAll('.dst-fdbk-star')).toHaveLength(5);
    expect(bar().querySelector('.dst-fdbk-dismiss')).not.toBeNull();
  });

  it('waits for a moment in which the extension has just helped', async () => {
    const { env, bar } = await run({ moment: false });
    await env.tick(20000);
    expect(bar()).toBeNull();
    env.document.dispatchEvent(new env.window.Event('dst-helpful-moment'));
    await env.flush();
    expect(bar()).not.toBeNull();
  });

  it('never appears again once rated', async () => {
    const { bar } = await run({ local: { dstUsageDays: 50 }, sync: { dstRanker_ratingGiven: true } });
    expect(bar()).toBeNull();
  });

  it('dismissals snooze with growing gaps (7, then 21 usage days) and stop after the 3rd', async () => {
    const at = (days, count, last) => run({ local: { dstUsageDays: days, dstRanker_dismissedAtDay: last }, sync: { dstRanker_dismissCount: count } });
    expect((await at(11, 1, 5)).bar()).toBeNull();
    expect((await at(12, 1, 5)).bar()).not.toBeNull();
    expect((await at(32, 2, 12)).bar()).toBeNull();
    expect((await at(33, 2, 12)).bar()).not.toBeNull();
    expect((await at(900, 3, 33)).bar()).toBeNull();
  });

  it('a ✕ from before v4.21 counts as the first dismissal, snoozing from today', async () => {
    const { bar, data, localData } = await run({ local: { dstUsageDays: 40 }, sync: { dstRanker_lastDismissed: NOW - 30 * DAY } });
    expect(bar()).toBeNull();
    expect(data.dstRanker_dismissCount).toBe(1);
    expect(localData.dstRanker_dismissedAtDay).toBe(40);
    expect((await run({ local: { dstUsageDays: 47, dstRanker_dismissedAtDay: 40 }, sync: { dstRanker_lastDismissed: NOW - 30 * DAY, dstRanker_dismissCount: 1 } })).bar()).not.toBeNull();
  });

  it('stars are real buttons with labels (keyboard accessible)', async () => {
    const { bar } = await run();
    const stars = Array.from(bar().querySelectorAll('.dst-fdbk-star'));
    expect(stars.map((s) => s.tagName)).toEqual(Array(5).fill('BUTTON'));
    expect(stars[0].getAttribute('aria-label')).toBe('1 Stern – Schlecht');
    expect(stars[4].getAttribute('aria-label')).toBe('5 Sterne – Perfekt');
  });

  it('does nothing without a badge bar (extension inactive / no forum)', async () => {
    const { env, bar } = await run({ badgeBar: false });
    await env.tick(16000);
    expect(bar()).toBeNull();
  });

  it('does nothing outside derstandard', async () => {
    const { data, bar } = await run({ url: 'https://example.com/story/1' });
    expect(bar()).toBeNull();
    expect(data).toEqual({});
  });

  it('never injects the bar twice', async () => {
    const { env, r, shadow } = await run();
    await r.main();
    await env.flush();
    expect(shadow.querySelectorAll('#dst-feedback-bar')).toHaveLength(1);
    expect(shadow.querySelectorAll('#dst-feedback-css')).toHaveLength(1);
  });

  it('writes nothing when storage cannot be read', async () => {
    const env = track(await createEnv({ sync: { dstRanker_lastDismissed: NOW - 30 * DAY }, local: { dstUsageDays: 40 } }));
    const r = env.load('rating.js');
    env.chrome.storage.sync.failNextGet = new Error('sync disabled');
    await r.main();
    expect(env.chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(env.chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

describe('feedback bar interaction', () => {
  async function shown(opts = {}) {
    return run(opts);
  }

  it.each([4, 5])('%i stars opens the store review page and hides the bar forever', async (stars) => {
    const { env, bar, data, shadow } = await shown({ userAgent: UA.chrome });
    bar().querySelector(`.dst-fdbk-star[data-value="${stars}"]`).click();
    expect(env.window.open).toHaveBeenCalledWith(CHROME_URL, '_blank');
    await env.flush();
    expect(data.dstRanker_ratingGiven).toBe(true);
    const active = Array.from(shadow.querySelectorAll('.dst-fdbk-star.active')).map((s) => s.dataset.value);
    expect(active).toHaveLength(stars);
    await env.tick(2600);
    expect(bar()).toBeNull();
  });

  it.each([1, 2, 3])('%i stars does not open the store but still counts as rated', async (stars) => {
    const { env, bar, data } = await shown();
    bar().querySelector(`.dst-fdbk-star[data-value="${stars}"]`).click();
    await env.flush();
    expect(env.window.open).not.toHaveBeenCalled();
    expect(data.dstRanker_ratingGiven).toBe(true);
  });

  it('ignores further clicks after rating', async () => {
    const { env, bar } = await shown();
    const stars = bar().querySelectorAll('.dst-fdbk-star');
    stars[4].click();
    stars[4].click();
    expect(env.window.open).toHaveBeenCalledTimes(1);
  });

  it('dismiss counts the dismissal, remembers the usage day and removes the bar', async () => {
    const { env, bar, data, localData } = await shown({ local: { dstUsageDays: 12, dstRanker_dismissedAtDay: 5 }, sync: { dstRanker_dismissCount: 1 } });
    bar().querySelector('.dst-fdbk-dismiss').click();
    await env.flush();
    expect(data.dstRanker_dismissCount).toBe(2);
    expect(localData.dstRanker_dismissedAtDay).toBe(12);
    expect(data.dstRanker_ratingGiven).toBeUndefined();
    await env.tick(400);
    expect(bar()).toBeNull();
  });

  it('hover previews the stars up to the pointer', async () => {
    const { env, bar } = await shown();
    const star = bar().querySelector('.dst-fdbk-star[data-value="3"]');
    star.dispatchEvent(new env.window.Event('mouseenter'));
    const preview = () => Array.from(bar().querySelectorAll('.dst-fdbk-star.hover-preview')).map((x) => x.dataset.value);
    expect(preview()).toEqual(['1', '2', '3']);
    star.dispatchEvent(new env.window.Event('mouseleave'));
    expect(preview()).toEqual([]);
  });
});

describe('review URL / browser detection', () => {
  it.each([
    ['chrome', UA.chrome, false, CHROME_URL],
    ['edge', UA.edge, false, CHROME_URL],
    ['samsung', UA.samsung, false, CHROME_URL],
    ['firefox', UA.firefox, false, AMO_URL],
    ['firefox android', UA.firefoxAndroid, false, AMO_URL],
    ['neutral UA + browser.runtime', UA.neutral, true, AMO_URL],
    ['neutral UA', UA.neutral, false, CHROME_URL],
    // A leaked `browser` polyfill must never turn a Chromium browser into Firefox.
    ['chrome + browser polyfill', UA.chrome, true, CHROME_URL]
  ])('%s → store', async (name, userAgent, browserGlobal, url) => {
    const env = track(await createEnv({ userAgent, browserGlobal }));
    expect(env.load('rating.js').getReviewURL()).toBe(url);
  });
});

describe('old storage keys', () => {
  it('leftovers of the removed one-time migrations do not matter', async () => {
    const { bar } = await run({ sync: {
      dstRanker_installDate: NOW - 10 * DAY, dstRanker_v1915Reset: false, dstRanker_v1916Reset: false
    } });
    expect(bar()).not.toBeNull();
  });
});
