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

// Storage of an existing user (v4.x has no one-time migrations any more).
function migrated(extra) {
  return { ...extra };
}

async function run({ sync = {}, badgeBar = true, url, userAgent, browserGlobal } = {}) {
  const env = track(await createEnv({ sync, url, userAgent, browserGlobal }));
  const { main, shadow } = buildForum(env.document, { postings: [{ id: 'A' }] });
  if (badgeBar) {
    const bar = env.document.createElement('div');
    bar.id = 'dst-badge-bar';
    main.insertBefore(bar, main.firstChild);
  }
  const r = env.load('rating.js');
  await env.tick(1000); // main() starts 1s after load
  await env.flush();
  const bar = () => shadow.querySelector('#dst-feedback-bar');
  return { env, r, shadow, main, bar, data: env.chrome.storage.sync.data };
}

describe('feedback bar timing', () => {
  it('first page load only records the install date', async () => {
    const { bar, data } = await run();
    expect(bar()).toBeNull();
    expect(data).toEqual({ dstRanker_installDate: NOW + 1000 });
  });

  it('stays hidden during the first 3 days', async () => {
    const { bar } = await run({ sync: migrated({ dstRanker_installDate: NOW - 3 * DAY + 60 * 1000 }) });
    expect(bar()).toBeNull();
  });

  it('appears after 3 days, right after the badge bar, with a dismiss button', async () => {
    const { bar, main } = await run({ sync: migrated({ dstRanker_installDate: NOW - 3 * DAY }) });
    expect(bar()).not.toBeNull();
    expect(main.querySelector('#dst-badge-bar').nextElementSibling).toBe(bar());
    expect(bar().style.order).toBe('-1');
    expect(bar().querySelectorAll('.dst-fdbk-star')).toHaveLength(5);
    expect(bar().querySelector('.dst-fdbk-dismiss')).not.toBeNull();
  });

  it('never appears again once rated', async () => {
    const { bar } = await run({ sync: migrated({ dstRanker_installDate: NOW - 30 * DAY, dstRanker_ratingGiven: true }) });
    expect(bar()).toBeNull();
  });

  it('every dismissal snoozes the bar for 3 days (v3.1.0)', async () => {
    const base = { dstRanker_installDate: NOW - 30 * DAY };
    expect((await run({ sync: migrated({ ...base, dstRanker_lastDismissed: NOW - 3 * DAY + 60000 }) })).bar()).toBeNull();
    const later = await run({ sync: migrated({ ...base, dstRanker_lastDismissed: NOW - 3 * DAY }) });
    expect(later.bar()).not.toBeNull();
  });

  it('the dismiss button is always there, also after many dismissals', async () => {
    const { bar } = await run({ sync: migrated({
      dstRanker_installDate: NOW - 30 * DAY, dstRanker_dismissCount: 7, dstRanker_lastDismissed: NOW - 10 * DAY
    }) });
    expect(bar().querySelector('.dst-fdbk-dismiss')).not.toBeNull();
  });

  it('stars are real buttons with labels (keyboard accessible)', async () => {
    const { bar } = await run({ sync: migrated({ dstRanker_installDate: NOW - 30 * DAY }) });
    const stars = Array.from(bar().querySelectorAll('.dst-fdbk-star'));
    expect(stars.map((s) => s.tagName)).toEqual(Array(5).fill('BUTTON'));
    expect(stars[0].getAttribute('aria-label')).toBe('1 Stern – Schlecht');
    expect(stars[4].getAttribute('aria-label')).toBe('5 Sterne – Perfekt');
  });

  it('does nothing without a badge bar (extension inactive / no forum)', async () => {
    const { env, bar } = await run({ badgeBar: false, sync: migrated({ dstRanker_installDate: NOW - 30 * DAY }) });
    await env.tick(16000);
    expect(bar()).toBeNull();
  });

  it('does nothing outside derstandard', async () => {
    const { data, bar } = await run({ url: 'https://example.com/story/1' });
    expect(bar()).toBeNull();
    expect(data).toEqual({});
  });

  it('never injects the bar twice', async () => {
    const { env, r, shadow } = await run({ sync: migrated({ dstRanker_installDate: NOW - 30 * DAY }) });
    await r.main();
    await env.flush();
    expect(shadow.querySelectorAll('#dst-feedback-bar')).toHaveLength(1);
    expect(shadow.querySelectorAll('#dst-feedback-css')).toHaveLength(1);
  });

  it('writes nothing when storage cannot be read', async () => {
    const env = track(await createEnv({ sync: { dstRanker_installDate: NOW - 30 * DAY } }));
    const r = env.load('rating.js');
    env.chrome.storage.sync.failNextGet = new Error('sync disabled');
    await r.main();
    expect(env.chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(env.chrome.storage.sync.remove).not.toHaveBeenCalled();
  });
});

describe('feedback bar interaction', () => {
  async function shown(opts = {}) {
    return run({ ...opts, sync: migrated({ dstRanker_installDate: NOW - 10 * DAY, ...(opts.sync || {}) }) });
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

  it('dismiss stores the timestamp and removes the bar', async () => {
    const { env, bar, data } = await shown();
    bar().querySelector('.dst-fdbk-dismiss').click();
    await env.flush();
    expect(data.dstRanker_lastDismissed).toBe(env.window.Date.now());
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
