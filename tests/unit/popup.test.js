import { describe, it, expect } from 'vitest';
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

describe('enable toggle', () => {
  it('is checked by default and unchecked when disabled in storage', async () => {
    expect((await openPopup()).$('#extensionEnabled').checked).toBe(true);
    expect((await openPopup({ sync: { dstSorterEnabled: false } })).$('#extensionEnabled').checked).toBe(false);
  });

  it('persists the change and notifies the active tab', async () => {
    const { env, $, sync } = await openPopup();
    const toggle = $('#extensionEnabled');
    toggle.checked = false;
    toggle.dispatchEvent(new env.window.Event('change'));
    expect(sync.dstSorterEnabled).toBe(false);
    expect(env.chrome.tabs.sendMessage).toHaveBeenCalledWith(7, { action: 'toggle', enabled: false });
  });

  it('does not throw when the tab has no content script', async () => {
    const { env, $ } = await openPopup();
    env.chrome.tabs.sendMessage.mockImplementation(() => Promise.reject(new Error('Receiving end does not exist')));
    $('#extensionEnabled').dispatchEvent(new env.window.Event('change'));
    await env.flush();
    expect(env.errors).toEqual([]);
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

  it('records the install time on first open and does not pulse yet', async () => {
    const { $, local } = await openPopup();
    expect(local.dstInstallTimestamp).toBe(NOW);
    expect($('#reviewBtn').classList.contains('pulsing')).toBe(false);
  });

  it('pulses after 3 days of usage', async () => {
    expect((await openPopup({ local: { dstInstallTimestamp: NOW - 3 * DAY + 1000 } }))
      .$('#reviewBtn').classList.contains('pulsing')).toBe(false);
    expect((await openPopup({ local: { dstInstallTimestamp: NOW - 3 * DAY } }))
      .$('#reviewBtn').classList.contains('pulsing')).toBe(true);
  });

  it('never pulses once reviewed (flag shared with rating.js)', async () => {
    const { $ } = await openPopup({
      local: { dstInstallTimestamp: NOW - 30 * DAY },
      sync: { dstRanker_ratingGiven: true }
    });
    expect($('#reviewBtn').classList.contains('pulsing')).toBe(false);
  });

  it('click stores the shared flag, thanks the user and opens the store', async () => {
    const { env, $, sync } = await openPopup({ local: { dstInstallTimestamp: NOW - 30 * DAY } });
    const btn = $('#reviewBtn');
    btn.click();
    expect(btn.classList.contains('pulsing')).toBe(false);
    expect(btn.classList.contains('thanked')).toBe(true);
    expect(sync.dstRanker_ratingGiven).toBe(true);
    expect(env.chrome.tabs.create).toHaveBeenCalledWith({ url: btn.getAttribute('href') });
  });

  it('fails safe (no pulse, no overwrite) when local storage cannot be read', async () => {
    const env = track(await createEnv({
      url: 'https://popup.test/popup.html', html: readSource('popup.html'),
      local: { dstInstallTimestamp: NOW - 30 * DAY }
    }));
    env.chrome.storage.local.failNextGet = new Error('boom');
    env.load('popup.js');
    await env.flush();
    expect(env.document.querySelector('#reviewBtn').classList.contains('pulsing')).toBe(false);
    expect(env.chrome.storage.local.data.dstInstallTimestamp).toBe(NOW - 30 * DAY);
  });
});

// Local calendar day of the fake "now", as content.js / rating.js / popup.js write it.
function localDay(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

describe('donation badge (v2.5.0: usage days, one request at a time)', () => {
  const pulsing = ($) => $('#donateBtn').classList.contains('prompting');

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
      sync: n ? { dstDonateAckN: n } : {}
    });
    expect(pulsing($)).toBe(expected);
  });

  it('calendar age alone does not trigger it any more', async () => {
    const { $ } = await openPopup({
      local: { dstInstallTimestamp: NOW - 400 * DAY, dstUsageDays: 3 },
      sync: { dstRanker_ratingGiven: true }
    });
    expect(pulsing($)).toBe(false);
  });

  it('stays calm while the review badge pulses', async () => {
    const { $ } = await openPopup({ local: { dstInstallTimestamp: NOW - 10 * DAY, dstUsageDays: 30 } });
    expect($('#reviewBtn').classList.contains('pulsing')).toBe(true);
    expect(pulsing($)).toBe(false);
  });

  it('pulses once the user has reviewed', async () => {
    const { $ } = await openPopup({
      local: { dstInstallTimestamp: NOW - 10 * DAY, dstUsageDays: 30 },
      sync: { dstRanker_ratingGiven: true }
    });
    expect(pulsing($)).toBe(true);
  });

  it('stays calm on a day the on-page review bar was shown', async () => {
    const today = await openPopup({ local: { dstUsageDays: 30 }, sync: { dstRanker_reviewShownDay: localDay(NOW) } });
    expect(pulsing(today.$)).toBe(false);
    const yesterday = await openPopup({ local: { dstUsageDays: 30 }, sync: { dstRanker_reviewShownDay: localDay(NOW - DAY) } });
    expect(pulsing(yesterday.$)).toBe(true);
  });

  it('click acknowledges (n+1) and opens the donation page', async () => {
    const { env, $, sync } = await openPopup({ local: { dstUsageDays: 20 }, sync: { dstDonateAckN: 0 } });
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

describe('popup.html', () => {
  it('contains no inline scripts (MV3 CSP)', () => {
    const html = readSource('popup.html');
    const inline = html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || [];
    expect(inline).toEqual([]);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});
