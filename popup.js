// popup.js — derStandard Comment Ranker v4.10.0
// 4-box popup: Header (icon + title), Toggle (enable/disable), Review
// (browser-aware store link with a delayed golden pulse), and Coffee (donate).
//
// v2.0.8 UNIFIED review logic (privacy-respecting, no analytics):
//   • Install timestamp: chrome.storage.local (device-only, not synced)
//   • Review status: chrome.storage.sync with SHARED key 'dstRanker_ratingGiven'
//     (same as rating.js) → clicking review in popup OR on-page stops prompts everywhere
//   • After 3 days of usage the review badge starts a subtle golden pulse.
//   • Clicking the badge stores the flag, permanently stops the pulse, and shows
//     a brief "Danke!" confirmation.
//
// v2.4.5 recurring donation pulse (privacy-respecting, no analytics):
//   • The coffee badge auto-pulses (same look as hover) after 15 days of usage,
//     then again at exponentially growing intervals (see dstNextPulseDay below).
//   • Clicking the badge opens the donation page and "acknowledges" the current
//     15-day window, so the pulse only returns at the next +15-day boundary.
//   • This runs regardless of whether the user donated → even past donors get a
//     gentle nudge again after a while (we can't detect actual donations).

var SORT_KEY = 'dstSorterEnabled';
// v4.10.0: one switch; text and ring show the current state (green = on,
// red = off). The "Farbmarkierung" option was removed.
var toggles = document.querySelector('.toggles');
var btnExt = document.getElementById('btnExt');

function sendMessageToTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (tabs[0] && tabs[0].id) {
      chrome.tabs.sendMessage(tabs[0].id, msg).catch(function() {});
    }
  });
}

function showEnabled(on) {
  btnExt.setAttribute('aria-pressed', String(on));
  btnExt.textContent = on ? 'Erweiterung ist an' : 'Erweiterung ist aus';
}

// Load saved state (no transition for the initial state)
chrome.storage.sync.get([SORT_KEY], function(data) {
  showEnabled((data || {})[SORT_KEY] !== false);
  requestAnimationFrame(function() { toggles.classList.remove('no-anim'); });
});
chrome.storage.sync.remove('dstTintEdge'); // setting of the removed option

btnExt.addEventListener('click', function() {
  var on = btnExt.getAttribute('aria-pressed') !== 'true';
  showEnabled(on);
  chrome.storage.sync.set({ [SORT_KEY]: on });
  sendMessageToTab({ action: 'toggle', enabled: on });
});

// Coffee button — click handling + recurring pulse live in the IIFE below (v2.4.5).

// ── Review/Bewerten button — browser-aware review URL (v2.0.5) ──────────
// Mirrors the browser-detection logic from rating.js: every Chromium-based
// browser (Chrome, Brave, Edge, Opera, Vivaldi, Samsung Internet, …) gets the
// Chrome Web Store URL; only a genuine Firefox (Gecko) gets the Mozilla AMO URL.
function detectIsFirefox() {
  var ua = '';
  try {
    if (typeof navigator !== 'undefined' && navigator.userAgent) ua = navigator.userAgent;
  } catch (e) { /* noop */ }
  // 1. Any Chromium fingerprint → definitely NOT Firefox.
  if (/\b(Chrome|Chromium|CriOS|Edg|EdgA|OPR|SamsungBrowser)\b/i.test(ua)) return false;
  // 2. Genuine Firefox UA token?
  if (/\b(Firefox|FxiOS)\b/i.test(ua)) return true;
  // 3. No UA hint → trust the native WebExtension namespace (Firefox exposes browser.runtime).
  try {
    if (typeof browser !== 'undefined' && typeof browser.runtime !== 'undefined') return true;
  } catch (e) { /* noop */ }
  // 4. Fail-safe: default to the Chrome Web Store.
  return false;
}
var CHROME_STORE_REVIEW_URL = 'https://chromewebstore.google.com/detail/derstandard-comment-ranke/kcnlkimhnhlacphcnigicjkkbenhfkeb/reviews';
var AMO_REVIEW_URL = 'https://addons.mozilla.org/firefox/addon/derstandard-comment-ranker/reviews/';
var REVIEW_URL = detectIsFirefox() ? AMO_REVIEW_URL : CHROME_STORE_REVIEW_URL;

// ── Review conversion: install-time tracking + delayed golden pulse (v2.0.8) ──
// Storage keys:
//   • dstInstallTimestamp: chrome.storage.local (device-local, not synced)
//   • dstRanker_ratingGiven: chrome.storage.sync (shared with rating.js — unified flag)
var INSTALL_TS_KEY = 'dstInstallTimestamp'; // ms epoch of first popup open (local)
var REVIEWED_KEY   = 'dstRanker_ratingGiven'; // boolean: user clicked review (SYNC, unified)
var PULSE_DELAY_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

(function() {
  var reviewBtn = document.getElementById('reviewBtn');
  if (!reviewBtn) return;
  reviewBtn.href = REVIEW_URL; // keep the anchor semantic / right-click "copy link"

  // storage may be unavailable in odd contexts — fail safe (no pulse).
  var localStore = null, syncStore = null;
  try { if (chrome && chrome.storage && chrome.storage.local) localStore = chrome.storage.local; } catch (e) { /* noop */ }
  try { if (chrome && chrome.storage && chrome.storage.sync) syncStore = chrome.storage.sync; } catch (e) { /* noop */ }

  function markReviewed() {
    reviewBtn.classList.remove('pulsing'); // stop pulse immediately + permanently
    reviewBtn.classList.add('thanked');    // show "Danke!" confirmation overlay
    // UNIFIED: write to sync storage (same key as rating.js)
    if (syncStore) { try { syncStore.set({ [REVIEWED_KEY]: true }); } catch (e) { /* noop */ } }
  }

  reviewBtn.addEventListener('click', function(e) {
    e.preventDefault();
    markReviewed();
    chrome.tabs.create({ url: REVIEW_URL });
  });

  if (!localStore || !syncStore) return; // can't track → never pulse (safe default)

  // Read install timestamp from local storage, review status from sync storage
  localStore.get([INSTALL_TS_KEY], function(localData) {
    if (chrome.runtime && chrome.runtime.lastError) return; // read failed → no pulse
    localData = localData || {};

    // Record the install timestamp on the very first popup open.
    var installedAt = localData[INSTALL_TS_KEY];
    if (typeof installedAt !== 'number') {
      installedAt = Date.now();
      try { localStore.set({ [INSTALL_TS_KEY]: installedAt }); } catch (e) { /* noop */ }
    }

    // Check if already reviewed (unified flag in sync storage)
    syncStore.get([REVIEWED_KEY], function(syncData) {
      if (chrome.runtime && chrome.runtime.lastError) return;
      syncData = syncData || {};

      // Already reviewed → never pulse again.
      if (syncData[REVIEWED_KEY] === true) return;

      // Pulse only after 3 days of usage.
      if (Date.now() - installedAt >= PULSE_DELAY_MS) {
        reviewBtn.classList.add('pulsing');
      }
    });
  });
})();

// ── Donation pulse: exponential growth with b=1.5 (v2.4.6) ──────────────────
// Storage keys:
//   • dstInstallTimestamp : chrome.storage.local (device-local; shared w/ review logic)
//   • dstDonateAckN       : chrome.storage.sync  (how many times acknowledged, counter n)
// Pulse formula: Tag(n) = 30 · (1.5^n - 1)
//   → 1st pulse: day 15; 2nd: day 37.5; 3rd: day 71.25; 4th: day 121.875; …
// A click increments n, so the pulse only returns at the next calculated day.
var DONATE_URL    = 'https://buymeacoffee.com/diversion';
var DONATE_ACK_N_KEY = 'dstDonateAckN'; // SYNC — pulse counter n
var DONATE_BASE   = 1.5; // growth factor b
var DONATE_DAY_MS = 24 * 60 * 60 * 1000;

function dstNextPulseDay(n) {
  // Day for the (n+1)-th pulse = 30 · (1.5^(n+1) - 1)
  return 30 * (Math.pow(DONATE_BASE, n + 1) - 1);
}

(function() {
  var donateBtn = document.getElementById('donateBtn');
  if (!donateBtn) return;

  var localStore = null, syncStore = null;
  try { if (chrome && chrome.storage && chrome.storage.local) localStore = chrome.storage.local; } catch (e) { /* noop */ }
  try { if (chrome && chrome.storage && chrome.storage.sync) syncStore = chrome.storage.sync; } catch (e) { /* noop */ }

  donateBtn.addEventListener('click', function() {
    // Acknowledge by incrementing n, so pulse returns only at the next calculated day.
    donateBtn.classList.remove('prompting');
    if (syncStore) {
      syncStore.get([DONATE_ACK_N_KEY], function(res) {
        res = res || {}; // v2.4.10: res is undefined on storage errors
        var n = (typeof res[DONATE_ACK_N_KEY] === 'number') ? res[DONATE_ACK_N_KEY] : 0;
        try { syncStore.set({ [DONATE_ACK_N_KEY]: n + 1 }); } catch (e) { /* noop */ }
      });
    }
    chrome.tabs.create({ url: DONATE_URL });
  });

  if (!localStore || !syncStore) return; // can't track → never pulse (safe default)

  localStore.get([INSTALL_TS_KEY], function(localData) {
    if (chrome.runtime && chrome.runtime.lastError) return;
    localData = localData || {};

    // Record install time on first use (review logic may also set this key).
    var installedAt = localData[INSTALL_TS_KEY];
    if (typeof installedAt !== 'number') {
      installedAt = Date.now();
      try { localStore.set({ [INSTALL_TS_KEY]: installedAt }); } catch (e) { /* noop */ }
    }

    var usageDays = Math.floor((Date.now() - installedAt) / DONATE_DAY_MS);

    syncStore.get([DONATE_ACK_N_KEY], function(syncData) {
      if (chrome.runtime && chrome.runtime.lastError) return;
      syncData = syncData || {};
      var n = (typeof syncData[DONATE_ACK_N_KEY] === 'number') ? syncData[DONATE_ACK_N_KEY] : 0;
      var nextPulseDay = dstNextPulseDay(n);

      // Pulse when current usage >= next calculated pulse day.
      if (usageDays >= nextPulseDay) {
        donateBtn.classList.add('prompting');
      }
    });
  });
})();

// V14 Steam Animation Control for popup coffee badge
// (moved out of an inline <script> in popup.html to comply with MV3 CSP "script-src 'self'")
(function() {
  var coffeeBox = document.getElementById('donateBtn');
  if (!coffeeBox) return;
  var steamContainer = coffeeBox.querySelector('.steam-container');
  if (!steamContainer) return;
  var wisps = steamContainer.querySelectorAll('.steam-wisp');
  var hovering = false, stopTO = null;
  coffeeBox.addEventListener('mouseenter', function() {
    hovering = true;
    if (stopTO) { clearTimeout(stopTO); stopTO = null; }
    wisps.forEach(function(w) {
      w.style.animation = 'none';
      w.offsetHeight;
      w.style.animation = '';
      w.style.animationIterationCount = 'infinite';
    });
  });
  coffeeBox.addEventListener('mouseleave', function() {
    hovering = false;
    stopTO = setTimeout(function() {
      if (!hovering) {
        wisps.forEach(function(w) {
          w.style.animationIterationCount = '1';
        });
      }
    }, 7500);
  });
})();
