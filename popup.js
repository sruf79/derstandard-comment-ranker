// popup.js — derStandard Comment Ranker v2.5.0
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
// v2.5.0 recurring donation pulse (privacy-respecting, no analytics):
//   • The coffee badge auto-pulses (same look as hover) after 10 USAGE days
//     (days on which content.js sorted a forum), then again at exponentially
//     growing intervals (see dstNextPulseDay below).
//   • Never together with a review request: not while the review badge pulses
//     and not on a day the on-page review bar (rating.js) was shown.
//   • Clicking the badge opens the donation page and increments the counter n,
//     so the pulse only returns at the next calculated usage day.
//   • This runs regardless of whether the user donated → even past donors get a
//     gentle nudge again after a while (we can't detect actual donations).

var SORT_KEY = 'dstSorterEnabled';
var toggle = document.getElementById('extensionEnabled');

function sendMessageToTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (tabs[0] && tabs[0].id) {
      chrome.tabs.sendMessage(tabs[0].id, msg).catch(function() {});
    }
  });
}

// Load saved state
chrome.storage.sync.get([SORT_KEY], function(data) {
  toggle.checked = data[SORT_KEY] !== false;
});

// Handle toggle
toggle.addEventListener('change', function() {
  var enabled = toggle.checked;
  chrome.storage.sync.set({ [SORT_KEY]: enabled });
  sendMessageToTab({ action: 'toggle', enabled: enabled });
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

// ── Donation pulse: usage days, exponential growth with b=1.5 (v2.5.0) ───────
// Storage keys (shared with content.js / rating.js):
//   • dstUsageDays             : chrome.storage.local (usage days on this device)
//   • dstDonateAckN            : chrome.storage.sync  (how many times acknowledged, counter n)
//   • dstRanker_reviewShownDay : chrome.storage.sync  (day the on-page review bar was shown)
// Pulse formula: usage day(n) = 20 · (1.5^n - 1)
//   → 1st pulse: day 10; 2nd: day 25; 3rd: day 47.5; 4th: day 81.25; …
// A click increments n, so the pulse only returns at the next calculated day.
var DONATE_URL    = 'https://buymeacoffee.com/diversion';
var DONATE_ACK_N_KEY = 'dstDonateAckN'; // SYNC — pulse counter n
var USAGE_DAYS_KEY = 'dstUsageDays';    // LOCAL — written by content.js
var REVIEW_SHOWN_DAY_KEY = 'dstRanker_reviewShownDay'; // SYNC — written by rating.js
var DONATE_BASE   = 1.5; // growth factor b

function dstNextPulseDay(n) {
  // Usage day for the (n+1)-th pulse = 20 · (1.5^(n+1) - 1)
  return 20 * (Math.pow(DONATE_BASE, n + 1) - 1);
}

function dstToday() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
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

  localStore.get([USAGE_DAYS_KEY, INSTALL_TS_KEY], function(localData) {
    if (chrome.runtime && chrome.runtime.lastError) return;
    localData = localData || {};
    var usageDays = (typeof localData[USAGE_DAYS_KEY] === 'number') ? localData[USAGE_DAYS_KEY] : 0;
    var installedAt = localData[INSTALL_TS_KEY];

    syncStore.get([DONATE_ACK_N_KEY, REVIEWED_KEY, REVIEW_SHOWN_DAY_KEY], function(syncData) {
      if (chrome.runtime && chrome.runtime.lastError) return;
      syncData = syncData || {};
      var n = (typeof syncData[DONATE_ACK_N_KEY] === 'number') ? syncData[DONATE_ACK_N_KEY] : 0;

      // One request at a time: the review badge pulses (same rule as above),
      // or the on-page review bar was shown today → keep the coffee calm.
      var reviewPulsing = syncData[REVIEWED_KEY] !== true &&
        typeof installedAt === 'number' && Date.now() - installedAt >= PULSE_DELAY_MS;
      if (reviewPulsing || syncData[REVIEW_SHOWN_DAY_KEY] === dstToday()) return;

      // Pulse when current usage >= next calculated pulse day.
      if (usageDays >= dstNextPulseDay(n)) {
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
