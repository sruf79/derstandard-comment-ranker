// popup.js — derStandard Comment Ranker v4.21.0
// Popup: header (logo + title), on/off switch, review (browser-aware store
// link with a delayed golden ring) and coffee (donate).
//
// v2.0.8 UNIFIED review logic (privacy-respecting, no analytics):
//   • Install timestamp: chrome.storage.local (device-only, not synced)
//   • Review status: chrome.storage.sync with SHARED key 'dstRanker_ratingGiven'
//     (same as rating.js) → clicking review in popup OR on-page stops prompts everywhere
//   • After 3 days of usage the review badge starts a subtle golden pulse.
//   • Clicking the badge stores the flag and permanently stops the pulse.
//
// v4.21.0 reach first: the review badge pulses after 5 USAGE days (same rule
// as the on-page bar in rating.js, incl. its growing snooze and the stop
// after 3 dismissals); the coffee only once the review request is settled
// (rated or dismissed 3×), and a due coffee pulse lasts at most 3 usage days
// (content.js then counts it as seen). New "Weiterempfehlen" button: copies
// a short text with both store links (Android: the system share sheet).
//
// v4.20.0 recurring donation pulse (privacy-respecting, no analytics):
//   • The coffee badge auto-pulses (same look as hover) after 10 USAGE days
//     (days on which content.js sorted a forum), then again at exponentially
//     growing intervals (see dstNextPulseDay below).
//   • Never together with a review request: not while the review badge pulses
//     and not on a day the on-page review bar (rating.js) was shown.
//   • Clicking the badge opens the donation page and counts as acknowledged,
//     so the pulse only returns at the next calculated usage day.
//   • This runs regardless of whether the user donated → even past donors get a
//     gentle nudge again after a while (we can't detect actual donations).

var SORT_KEY = 'dstSorterEnabled';
// v4.10.0: one switch; text and ring show the current state (green = on,
// red = off). The "Farbmarkierung" option was removed.
var toggles = document.querySelector('.toggles');
var btnExt = document.getElementById('btnExt');

// v4.12.2: focus rings only once the keyboard is used (see popup.html)
document.addEventListener('keydown', function(e) {
  if (e.key === 'Tab') document.body.classList.add('kbd');
}, true);

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

btnExt.addEventListener('click', function() {
  var on = btnExt.getAttribute('aria-pressed') !== 'true';
  showEnabled(on);
  btnExt.classList.remove('flash');
  void btnExt.offsetWidth; // restart the flash on quick repeated clicks
  btnExt.classList.add('flash');
  chrome.storage.sync.set({ [SORT_KEY]: on });
  sendMessageToTab({ action: 'toggle', enabled: on });
});

// v4.18.0: glass look or flat design (applies to the popup and the site)
var FLAT_KEY = 'dstFlat';
var btnDesign = document.getElementById('btnDesign');
function showFlat(flat) {
  btnDesign.setAttribute('aria-pressed', String(flat));
  btnDesign.textContent = flat ? 'Design: Flach' : 'Design: Glas';
  document.body.classList.toggle('flat', flat);
}
chrome.storage.sync.get([FLAT_KEY], function(data) {
  showFlat((data || {})[FLAT_KEY] === true);
});
btnDesign.addEventListener('click', function() {
  var flat = btnDesign.getAttribute('aria-pressed') !== 'true';
  showFlat(flat);
  chrome.storage.sync.set({ [FLAT_KEY]: flat });   // the page follows via storage.onChanged
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
var REVIEWED_KEY   = 'dstRanker_ratingGiven'; // boolean: user clicked review (SYNC, unified)
var DISMISS_COUNT_KEY = 'dstRanker_dismissCount';   // SYNC — written by rating.js
var DISMISSED_AT_KEY  = 'dstRanker_dismissedAtDay'; // LOCAL — written by rating.js
var USAGE_DAYS_KEY_R  = 'dstUsageDays';             // LOCAL — written by content.js
var REVIEW_FIRST_DAYS = 5;
var REVIEW_SNOOZE_DAYS = [0, 7, 21];
var REVIEW_MAX_DISMISS = 3;

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

// Same rule as reviewDue() in rating.js.
function reviewDue(usageDays, rated, dismissCount, dismissedAtDay) {
  if (rated) return false;
  if (dismissCount >= REVIEW_MAX_DISMISS) return false;
  if (usageDays < REVIEW_FIRST_DAYS) return false;
  if (dismissCount > 0 && usageDays < (dismissedAtDay || 0) + REVIEW_SNOOZE_DAYS[dismissCount]) return false;
  return true;
}

// Rated, or asked often enough: the coffee may take its turn.
function reviewSettled(rated, dismissCount) {
  return rated === true || dismissCount >= REVIEW_MAX_DISMISS;
}

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
    // UNIFIED: write to sync storage (same key as rating.js)
    if (syncStore) { try { syncStore.set({ [REVIEWED_KEY]: true }); } catch (e) { /* noop */ } }
  }

  reviewBtn.addEventListener('click', function(e) {
    e.preventDefault();
    markReviewed();
    chrome.tabs.create({ url: REVIEW_URL });
  });

  if (!localStore || !syncStore) return; // can't track → never pulse (safe default)

  // v4.21.0: pulse when the review is due by usage days (as the on-page bar)
  localStore.get([USAGE_DAYS_KEY_R, DISMISSED_AT_KEY], function(localData) {
    if (chrome.runtime && chrome.runtime.lastError) return; // read failed → no pulse
    localData = localData || {};
    syncStore.get([REVIEWED_KEY, DISMISS_COUNT_KEY], function(syncData) {
      if (chrome.runtime && chrome.runtime.lastError) return;
      syncData = syncData || {};
      if (reviewDue(num(localData[USAGE_DAYS_KEY_R]), syncData[REVIEWED_KEY] === true,
        num(syncData[DISMISS_COUNT_KEY]), localData[DISMISSED_AT_KEY])) {
        reviewBtn.classList.add('pulsing');
      }
    });
  });
})();

// ── Donation pulse: usage days, exponential growth with b=1.5 (v4.20.0) ─────
// Storage keys (shared with content.js / rating.js):
//   • dstUsageDays             : chrome.storage.local (usage days on this device)
//   • dstDonateAckN            : chrome.storage.sync  (how many times acknowledged, counter n)
//   • dstRanker_reviewShownDay : chrome.storage.sync  (day the on-page review bar was shown)
// Pulse formula: usage day(n) = 20 · (1.5^(n+1) - 1), n = clicks so far
//   → 1st pulse: day 10; 2nd: day 25; 3rd: day 47.5; 4th: day 81.25; …
// A click increments n, so the pulse only returns at the next calculated day.
var DONATE_URL    = 'https://buymeacoffee.com/diversion';
var DONATE_ACK_N_KEY = 'dstDonateAckN'; // SYNC — pulse counter n
var USAGE_DAYS_KEY = 'dstUsageDays';    // LOCAL — written by content.js
var REVIEW_SHOWN_DAY_KEY = 'dstRanker_reviewShownDay'; // SYNC — written by rating.js
var DONATE_BASE   = 1.5; // growth factor b
var PULSE_N_KEY = 'dstDonatePulseN';      // LOCAL — written by content.js
var PULSE_FROM_KEY = 'dstDonatePulseFrom'; // LOCAL — written by content.js
var PULSE_DAYS = 3;

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

  donateBtn.href = DONATE_URL;
  donateBtn.addEventListener('click', function(e) {
    e.preventDefault();
    // Acknowledge by incrementing n, so pulse returns only at the next calculated day.
    donateBtn.classList.remove('prompting');
    if (!syncStore) { chrome.tabs.create({ url: DONATE_URL }); return; }
    // v4.10.1: the new tab closes the popup — open it only after the counter
    // is written, otherwise the write was often lost
    syncStore.get([DONATE_ACK_N_KEY], function(res) {
      res = res || {}; // v2.4.10: res is undefined on storage errors
      var n = (typeof res[DONATE_ACK_N_KEY] === 'number') ? res[DONATE_ACK_N_KEY] : 0;
      try { syncStore.set({ [DONATE_ACK_N_KEY]: n + 1 }); } catch (e2) { /* noop */ }
      chrome.tabs.create({ url: DONATE_URL });
    });
  });

  if (!localStore || !syncStore) return; // can't track → never pulse (safe default)

  localStore.get([USAGE_DAYS_KEY, PULSE_N_KEY, PULSE_FROM_KEY], function(localData) {
    if (chrome.runtime && chrome.runtime.lastError) return;
    localData = localData || {};
    var usageDays = num(localData[USAGE_DAYS_KEY]);

    syncStore.get([DONATE_ACK_N_KEY, REVIEWED_KEY, DISMISS_COUNT_KEY, REVIEW_SHOWN_DAY_KEY], function(syncData) {
      if (chrome.runtime && chrome.runtime.lastError) return;
      syncData = syncData || {};
      var n = num(syncData[DONATE_ACK_N_KEY]);

      // v4.21.0: the review request comes first; and never on a day the
      // on-page review bar was shown.
      if (!reviewSettled(syncData[REVIEWED_KEY], num(syncData[DISMISS_COUNT_KEY]))) return;
      if (syncData[REVIEW_SHOWN_DAY_KEY] === dstToday()) return;
      if (usageDays < dstNextPulseDay(n)) return;
      // v4.21.0: the pulse window of this n is over after 3 usage days
      // (content.js counts it as seen on the next page view)
      if (localData[PULSE_N_KEY] === n && typeof localData[PULSE_FROM_KEY] === 'number' &&
          usageDays >= localData[PULSE_FROM_KEY] + PULSE_DAYS) return;
      donateBtn.classList.add('prompting');
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

// ── v4.21.0: "Weiterempfehlen" — reach over donations ─────────────────────
// Copies a short text with both store links (the friend may use the other
// browser). On Android the system share sheet opens instead (WhatsApp, Signal,
// …). Nothing is sent anywhere by the extension itself.
var SHARE_TITLE = 'derStandard Comment Ranker';
var SHARE_TEXT = 'derStandard Comment Ranker: Postings im derStandard-Forum sortieren ' +
  'und sehen, wer wie bewertet hat. Gratis-Erweiterung für Chrome und Firefox (auch Android).\n' +
  'Chrome: https://chromewebstore.google.com/detail/kcnlkimhnhlacphcnigicjkkbenhfkeb\n' +
  'Firefox: https://addons.mozilla.org/firefox/addon/derstandard-comment-ranker/';

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function() { return true; }, function() { return copyFallback(text); });
    }
  } catch (e) { /* noop */ }
  return Promise.resolve(copyFallback(text));
}

function copyFallback(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { /* noop */ }
  ta.remove();
  return ok;
}

(function() {
  var shareBtn = document.getElementById('shareBtn');
  if (!shareBtn) return;
  var label = shareBtn.querySelector('.share-text');
  var resetTO = null;
  function confirm(text) {
    label.textContent = text;
    shareBtn.classList.add('done');
    if (resetTO) clearTimeout(resetTO);
    resetTO = setTimeout(function() {
      label.textContent = 'Weiterempfehlen';
      shareBtn.classList.remove('done');
    }, 2500);
  }
  shareBtn.addEventListener('click', function() {
    var ua = '';
    try { ua = navigator.userAgent || ''; } catch (e) { /* noop */ }
    if (/Android/i.test(ua) && navigator.share) {
      navigator.share({ title: SHARE_TITLE, text: SHARE_TEXT }).catch(function() {});
      return;
    }
    copyText(SHARE_TEXT).then(function(ok) {
      confirm(ok ? 'Text mit Link kopiert ✓' : 'Kopieren nicht möglich');
    });
  });
})();
