import { describe, it, expect, vi } from 'vitest';
import { createEnv, readSource, DAY, DEFAULT_NOW } from '../helpers/env.js';
import { track } from '../helpers/setup.js';

const NOW = DEFAULT_NOW;
const CHROME_URL = 'https://chromewebstore.google.com/detail/derstandard-comment-ranke/kcnlkimhnhlacphcnigicjkkbenhfkeb/reviews';
const AMO_URL = 'https://addons.mozilla.org/firefox/addon/derstandard-comment-ranker/reviews/';

async function openPopup({ sync = {}, local = {}, userAgent } = {}) {
  const env = track(await createEnv({
    url: 'https://popup.test/popup.html',
    html: readSource('popup.html'),
    sync,
    local,
    userAgent
  }));
  env.load('popup.js');
  await env.flush();
  const $ = (sel) => env.document.querySelector(sel);
  return { env, $, sync: env.chrome.storage.sync.data, local: env.chrome.storage.local.data };
}

describe('on/off switch', () => {
  const state = ($) => [$('#btnExt').getAttribute('aria-pressed'), $('#btnExt').textContent];

  it('shows "an" by default and "aus" when disabled in storage', async () => {
    expect(state((await openPopup()).$)).toEqual(['true', 'Erweiterung ist an']);
    expect(state((await openPopup({ sync: { dstSorterEnabled: false } })).$)).toEqual(['false', 'Erweiterung ist aus']);
  });

  it('a click persists the change, flashes and notifies the active tab', async () => {
    const { env, $, sync } = await openPopup();
    $('#btnExt').click();
    expect(state($)).toEqual(['false', 'Erweiterung ist aus']);
    expect($('#btnExt').classList.contains('flash')).toBe(true);
    expect(sync.dstSorterEnabled).toBe(false);
    expect(env.chrome.tabs.sendMessage).toHaveBeenCalledWith(7, { action: 'toggle', enabled: false });
    $('#btnExt').click();
    expect(sync.dstSorterEnabled).toBe(true);
  });

  it('does not throw when the tab has no content script', async () => {
    const { env, $ } = await openPopup();
    env.chrome.tabs.sendMessage.mockImplementation(() => Promise.reject(new Error('Receiving end does not exist')));
    $('#btnExt').click();
    await env.flush();
    expect(env.errors).toEqual([]);
  });
});

describe('design switch (v4.18.0)', () => {
  it('shows glass by default and flat when stored', async () => {
    const glass = await openPopup();
    expect(glass.$('#btnDesign').textContent).toBe('Design: Glas');
    const flat = await openPopup({ sync: { dstFlat: true } });
    expect(flat.$('#btnDesign').textContent).toBe('Design: Flach');
    expect(flat.env.document.body.classList.contains('flat')).toBe(true);
  });

  it('a click stores the choice for the page', async () => {
    const { $, sync } = await openPopup();
    $('#btnDesign').click();
    expect(sync.dstFlat).toBe(true);
    expect($('#btnDesign').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('keyboard focus rings', () => {
  it('appear only once Tab is used', async () => {
    const { env } = await openPopup();
    expect(env.document.body.classList.contains('kbd')).toBe(false);
    env.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Tab' }));
    expect(env.document.body.classList.contains('kbd')).toBe(true);
  });
});

describe('review badge', () => {
  it.each([
    ['Chrome', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', CHROME_URL],
    ['Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', AMO_URL]
  ])('links to the right store on %s', async (name, userAgent, url) => {
    const { $ } = await openPopup({ userAgent });
    expect($('#reviewBtn').getAttribute('href')).toBe(url);
  });

  const reviewPulsing = ($) => $('#reviewBtn').classList.contains('pulsing');

  it('pulses from 5 usage days (v4.21.0), not by calendar age', async () => {
    expect(reviewPulsing((await openPopup({ local: { dstUsageDays: 4, dstInstallTimestamp: NOW - 300 * DAY } })).$)).toBe(false);
    expect(reviewPulsing((await openPopup({ local: { dstUsageDays: 5 } })).$)).toBe(true);
  });

  it('follows the on-page snooze: growing gaps, none after the 3rd dismissal', async () => {
    const at = async (days, count, last) => reviewPulsing((await openPopup({
      local: { dstUsageDays: days, dstRanker_dismissedAtDay: last }, sync: { dstRanker_dismissCount: count }
    })).$);
    expect(await at(11, 1, 5)).toBe(false);
    expect(await at(12, 1, 5)).toBe(true);
    expect(await at(32, 2, 12)).toBe(false);
    expect(await at(33, 2, 12)).toBe(true);
    expect(await at(900, 3, 33)).toBe(false);
  });

  it('never pulses once reviewed (flag shared with rating.js)', async () => {
    const { $ } = await openPopup({
      local: { dstUsageDays: 30 },
      sync: { dstRanker_ratingGiven: true }
    });
    expect(reviewPulsing($)).toBe(false);
  });

  it('click stores the shared flag and opens the store', async () => {
    const { env, $, sync } = await openPopup({ local: { dstUsageDays: 30 } });
    const btn = $('#reviewBtn');
    btn.click();
    expect(btn.classList.contains('pulsing')).toBe(false);
    expect(sync.dstRanker_ratingGiven).toBe(true);
    expect(env.chrome.tabs.create).toHaveBeenCalledWith({ url: btn.getAttribute('href') });
  });

  it('fails safe (no pulse, no write) when local storage cannot be read', async () => {
    const env = track(await createEnv({
      url: 'https://popup.test/popup.html', html: readSource('popup.html'),
      local: { dstUsageDays: 30 }
    }));
    env.chrome.storage.local.failNextGet = new Error('boom');
    env.load('popup.js');
    await env.flush();
    expect(env.document.querySelector('#reviewBtn').classList.contains('pulsing')).toBe(false);
    expect(env.chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

// Local calendar day of the fake "now", as content.js / rating.js / popup.js write it.
function localDay(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

describe('donation badge (usage days, review first, 3-day window)', () => {
  const pulsing = ($) => $('#donateBtn').classList.contains('prompting');
  const RATED = { dstRanker_ratingGiven: true };

  it('dstNextPulseDay follows 20·(1.5^(n+1) − 1) usage days', async () => {
    const { env } = await openPopup();
    const f = env.window.dstNextPulseDay;
    expect([0, 1, 2, 3].map(f)).toEqual([10, 25, 47.5, 81.25]);
    for (let n = 0; n < 10; n++) expect(f(n + 1)).toBeGreaterThan(f(n));
  });

  it.each([
    [0, 9, false],
    [0, 10, true],
    [1, 24, false],
    [1, 25, true],
    [2, 47, false],
    [2, 48, true]
  ])('n=%i, %i usage days → pulsing=%s', async (n, days, expected) => {
    const { $ } = await openPopup({
      local: { dstUsageDays: days },
      sync: n ? { ...RATED, dstDonateAckN: n } : RATED
    });
    expect(pulsing($)).toBe(expected);
  });

  it('waits until the review request is settled: rated or dismissed three times (v4.21.0)', async () => {
    expect(pulsing((await openPopup({ local: { dstUsageDays: 30 } })).$)).toBe(false);
    expect(pulsing((await openPopup({ local: { dstUsageDays: 30 }, sync: { dstRanker_dismissCount: 2 } })).$)).toBe(false);
    expect(pulsing((await openPopup({ local: { dstUsageDays: 30 }, sync: { dstRanker_dismissCount: 3 } })).$)).toBe(true);
    expect(pulsing((await openPopup({ local: { dstUsageDays: 30 }, sync: RATED })).$)).toBe(true);
  });

  it('a due pulse lasts 3 usage days (window started by content.js)', async () => {
    const at = async (days) => pulsing((await openPopup({
      local: { dstUsageDays: days, dstDonatePulseN: 0, dstDonatePulseFrom: 10 }, sync: RATED
    })).$);
    expect(await at(12)).toBe(true);
    expect(await at(13)).toBe(false);
    // a window of an earlier n does not count
    expect(pulsing((await openPopup({
      local: { dstUsageDays: 30, dstDonatePulseN: 0, dstDonatePulseFrom: 10 }, sync: { ...RATED, dstDonateAckN: 1 }
    })).$)).toBe(true);
  });

  it('calendar age alone does not trigger it any more', async () => {
    const { $ } = await openPopup({
      local: { dstInstallTimestamp: NOW - 400 * DAY, dstUsageDays: 3 },
      sync: { dstRanker_ratingGiven: true }
    });
    expect(pulsing($)).toBe(false);
  });

  it('stays calm while the review badge pulses', async () => {
    const { $ } = await openPopup({ local: { dstUsageDays: 30 } });
    expect($('#reviewBtn').classList.contains('pulsing')).toBe(true);
    expect(pulsing($)).toBe(false);
  });

  it('stays calm on a day the on-page review bar was shown', async () => {
    const today = await openPopup({ local: { dstUsageDays: 30 }, sync: { ...RATED, dstRanker_reviewShownDay: localDay(NOW) } });
    expect(pulsing(today.$)).toBe(false);
    const yesterday = await openPopup({ local: { dstUsageDays: 30 }, sync: { ...RATED, dstRanker_reviewShownDay: localDay(NOW - DAY) } });
    expect(pulsing(yesterday.$)).toBe(true);
  });

  it('click acknowledges (n+1) and opens the donation page', async () => {
    const { env, $, sync } = await openPopup({ local: { dstUsageDays: 20 }, sync: { ...RATED, dstDonateAckN: 0 } });
    const btn = $('#donateBtn');
    expect(btn.classList.contains('prompting')).toBe(true);
    btn.click();
    await env.flush();
    expect(btn.classList.contains('prompting')).toBe(false);
    expect(sync.dstDonateAckN).toBe(1);
    expect(env.chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://buymeacoffee.com/diversion' });
  });

  it('treats a corrupt counter as 0', async () => {
    const { env, $, sync } = await openPopup({ sync: { dstDonateAckN: 'x' } });
    $('#donateBtn').click();
    await env.flush();
    expect(sync.dstDonateAckN).toBe(1);
  });

  it('does not count usage days itself (only content.js does)', async () => {
    const { local } = await openPopup({ local: { dstUsageDays: 4 } });
    expect(local.dstUsageDays).toBe(4);
    expect(local.dstLastUsageDay).toBeUndefined();
  });
});

describe('share button (v4.21.0)', () => {
  const STORE_LINES = [
    'Chrome: https://chromewebstore.google.com/detail/kcnlkimhnhlacphcnigicjkkbenhfkeb',
    'Firefox: https://addons.mozilla.org/firefox/addon/derstandard-comment-ranker/'
  ];

  it('copies a short text with both store links and confirms it', async () => {
    const { env, $ } = await openPopup();
    const writeText = env.window.navigator.clipboard
      ? (env.window.navigator.clipboard.writeText = vi.fn(async () => {}))
      : null;
    if (!writeText) {
      const fn = vi.fn(async () => {});
      Object.defineProperty(env.window.navigator, 'clipboard', { value: { writeText: fn }, configurable: true });
    }
    $('#shareBtn').click();
    await env.flush();
    const text = env.window.navigator.clipboard.writeText.mock.calls[0][0];
    for (const line of STORE_LINES) expect(text).toContain(line);
    expect(text).toMatch(/^derStandard Comment Ranker: /);
    expect($('#shareBtn .share-text').textContent).toBe('Text mit Link kopiert ✓');
    expect($('#shareBtn').classList.contains('done')).toBe(true);
    await env.tick(2500);
    expect($('#shareBtn .share-text').textContent).toBe('Weiterempfehlen');
  });

  it('opens the system share sheet on Android', async () => {
    const { env, $ } = await openPopup({ userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0' });
    const share = vi.fn(async () => {});
    Object.defineProperty(env.window.navigator, 'share', { value: share, configurable: true });
    $('#shareBtn').click();
    await env.flush();
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0].text).toContain(STORE_LINES[1]);
    expect($('#shareBtn .share-text').textContent).toBe('Weiterempfehlen');
  });

  it('falls back to execCommand when the clipboard API is missing', async () => {
    const { env, $ } = await openPopup();
    Object.defineProperty(env.window.navigator, 'clipboard', { value: undefined, configurable: true });
    env.document.execCommand = vi.fn(() => true);
    $('#shareBtn').click();
    await env.flush();
    expect(env.document.execCommand).toHaveBeenCalledWith('copy');
    expect($('#shareBtn .share-text').textContent).toBe('Text mit Link kopiert ✓');
  });
});

describe('popup.html', () => {
  it('contains no inline scripts (MV3 CSP)', () => {
    const html = readSource('popup.html');
    const inline = html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || [];
    expect(inline).toEqual([]);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});
