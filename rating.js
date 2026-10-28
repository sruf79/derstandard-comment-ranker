// ═══════════════════════════════════════════════════════════════════════
//  rating.js — derStandard Comment Ranker v2.1.0
//  Smart review prompt for the Chrome Web Store / AMO
//
//  v2.1.0 LIMITED DISMISSALS (Option A):
//  - Bar appears after 3 days
//  - User can dismiss ("Maybe later") MAX 2 times → bar reappears after 3 days
//  - After 2nd dismiss: ✕ button disappears, bar stays PERMANENTLY until rated
//  - Rating (1-5★) → bar disappears forever
//
//  v2.0.8 UNIFIED REVIEW LOGIC + ADBLOCKER-RESISTANT:
//  - Uses SHARED storage key 'dstRanker_ratingGiven' (chrome.storage.sync)
//    with popup.js → clicking review in EITHER location stops prompts in BOTH
//  - CSS classes renamed from "rating"/"rate" to "feedback"/"fdbk" to avoid
//    common adblocker filters (e.g., EasyList blocks elements with "rating")
//
//  ISOLATION GUARANTEE:
//  - This file has ZERO dependencies on content.js
//  - content.js is NOT modified — sorting logic is 100% untouched
//  - If this file is removed, the extension works exactly as before
//
//  CROSS-BROWSER:
//  - Uses chrome.storage.sync (works in Chrome + Firefox MV3)
//  - No browser.* API needed — chrome.* is the universal MV3 standard
//  - Async/await with Promise wrappers for chrome.storage
//  - Browser-detection for correct review URL (Chrome Web Store vs AMO)
//
//  TIMING & DISMISS LOGIC:
//  - First prompt: 3 days after first page load (installDate)
//  - Dismiss 1-2: re-prompt after 3 days
//  - After dismiss #2: bar becomes permanent (no ✕ button)
//  - Star click (ratingGiven=true): NEVER show again
// ═══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Storage keys (own namespace, no conflicts with content.js) ──
  const KEYS = {
    INSTALL_DATE:    'dstRanker_installDate',
    RATING_GIVEN:    'dstRanker_ratingGiven',
    LAST_DISMISSED:  'dstRanker_lastDismissed',
    DISMISS_COUNT:   'dstRanker_dismissCount',
    // One-time reset marker for v1.9.15 — see runV1915Reset()
    V1915_RESET:     'dstRanker_v1915Reset',
    // One-time reset marker for v1.9.16 — see runV1916Reset()
    V1916_RESET:     'dstRanker_v1916Reset',
    // v2.5.0: day ('YYYY-MM-DD') the bar was last shown. content.js and
    // popup.js keep the coffee badge calm on that day (one request at a time).
    SHOWN_DAY:       'dstRanker_reviewShownDay',
  };

  const DELAY_FIRST_PROMPT  = 3 * 24 * 60 * 60 * 1000;  // 3 days in ms
  const DELAY_AFTER_DISMISS = 3 * 24 * 60 * 60 * 1000;  // 3 days in ms
  const MAX_DISMISSALS      = 2;                         // Max times user can dismiss

  // ── Browser-detection for correct review URL ────────────────────
  // GOAL: every Chromium-based browser (Chrome, Brave, Edge, Opera, Vivaldi,
  //       Samsung Internet, …) MUST get the Chrome Web Store URL; only a
  //       genuine Firefox (Gecko) must get the Mozilla AMO URL.
  //
  // ROBUST, defense-in-depth detection (v1.9.17):
  //   1. PRIMARY signal — User-Agent. ALL Chromium browsers carry a
  //      "Chrome"/"Chromium"/"CriOS" token (Edge adds "Edg", Opera "OPR",
  //      Vivaldi keeps "Chrome", Brave deliberately masquerades as plain
  //      Chrome). If any Chromium token is present → NOT Firefox, full stop.
  //      This guarantees Brave & friends can never be mis-detected as Firefox
  //      even if some polyfill were to leak a `browser` global into the page.
  //   2. Only if NO Chromium token is present do we treat it as Firefox —
  //      confirmed by a "Firefox"/"FxiOS" UA token OR the native `browser.*`
  //      WebExtension namespace (Firefox exposes `browser.runtime`; Chromium
  //      does not, natively).
  //   3. Fail-safe default: if everything is inconclusive we fall back to the
  //      Chrome Web Store (the larger user base, and the store that 404'd
  //      historically — better to send the rare unknown case there).
  function detectIsFirefox() {
    var ua = '';
    try {
      if (typeof navigator !== 'undefined' && navigator.userAgent) ua = navigator.userAgent;
    } catch (e) { /* noop */ }

    // 1. Any Chromium fingerprint → definitely NOT Firefox.
    if (/\b(Chrome|Chromium|CriOS|Edg|EdgA|OPR|SamsungBrowser)\b/i.test(ua)) return false;

    // 2. Genuine Firefox UA token?
    if (/\b(Firefox|FxiOS)\b/i.test(ua)) return true;

    // 3. No UA hint either way → trust the native WebExtension namespace.
    //    Firefox exposes `browser.runtime`; Chromium browsers do not (natively).
    try {
      if (typeof browser !== 'undefined' && typeof browser.runtime !== 'undefined') return true;
    } catch (e) { /* noop */ }

    // 4. Fail-safe: default to the Chrome Web Store.
    return false;
  }
  const IS_FIREFOX = detectIsFirefox();

  // Chrome Web Store review URL — MUST include slug + extension ID, plus the
  // /reviews path so the user lands directly on the rating form.
  // (Previously this was a slug-only placeholder WITHOUT the ID, which 404'd /
  //  redirected to the store homepage — users could never actually rate.)
  const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/derstandard-comment-ranke/kcnlkimhnhlacphcnigicjkkbenhfkeb/reviews';
  // Firefox AMO review URL — verified correct (HTTP 200). Slug only, NO ID needed
  // (unlike Chrome). The locale is intentionally omitted: AMO auto-redirects per
  // the browser's Accept-Language (e.g. German Firefox → /de/, English → /en-US/).
  const AMO_URL = 'https://addons.mozilla.org/firefox/addon/derstandard-comment-ranker/reviews/';

  function getReviewURL() {
    return IS_FIREFOX ? AMO_URL : CHROME_STORE_URL;
  }

  // ── Promise wrapper for chrome.storage.sync ─────────────────────
  // IMPORTANT: rejects on a genuine read error (instead of silently
  // resolving {}). This prevents main() from mistaking a transient
  // storage failure for a "first install" and overwriting installDate.
  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.get(keys, (data) => {
          const lastErr = (typeof chrome !== 'undefined' &&
                           chrome.runtime && chrome.runtime.lastError);
          if (lastErr) return reject(lastErr);
          resolve(data || {});
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.set(obj, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.remove(keys, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  // ── One-time reset for v1.9.15 ──────────────────────────────────
  // BACKGROUND: Until v1.9.13 the Chrome Web Store review URL was broken
  // (missing extension ID → 404). Existing users therefore COULD NOT rate,
  // even if they wanted to. v1.9.14 fixed the link. To give every existing
  // user a fresh chance to rate, this migration runs EXACTLY ONCE:
  //   • clears ratingGiven + lastDismissed (so the prompt is eligible again)
  //   • resets installDate to "now" (fresh 3-day countdown)
  //   • sets the v1915Reset flag so it never runs again
  //
  // RETURNS: true if storage is in a usable state and main() may continue;
  //          false if storage could not be read (→ main() should abort and
  //          touch nothing, exactly like a transient read failure).
  async function runV1915Reset() {
    let state;
    try {
      state = await storageGet([KEYS.V1915_RESET, KEYS.INSTALL_DATE]);
    } catch (e) {
      // Storage unreadable → signal main() to abort without writing anything.
      return false;
    }

    // Already migrated → nothing to do, continue normally.
    if (state[KEYS.V1915_RESET]) return true;

    if (!state[KEYS.INSTALL_DATE]) {
      // No installDate yet = brand-new install (NOT an update from an older
      // version). Nothing to reset; just mark the flag so this migration is
      // considered done and never fires later. main() will set installDate.
      await storageSet({ [KEYS.V1915_RESET]: true });
      return true;
    }

    // installDate exists but flag is absent = update from an older version
    // (<= v1.9.14). Perform the one-time reset.
    await storageRemove([KEYS.RATING_GIVEN, KEYS.LAST_DISMISSED]);
    await storageSet({
      [KEYS.INSTALL_DATE]: Date.now(),
      [KEYS.V1915_RESET]:  true,
    });
    return true;
  }

  // ── One-time reset for v1.9.16 ──────────────────────────────────
  // PROBLEM with v1.9.15: it reset installDate to Date.now(), which RE-STARTED
  // the 3-day countdown for EVERY existing user. Because Chrome rolls out
  // auto-updates gradually over several days, almost no Chrome user had crossed
  // the fresh 3-day threshold within the first days after release — so the
  // prompt barely appeared and ratings stalled.
  //
  // FIX: back-date installDate so that existing, not-yet-rated users become
  // eligible for the prompt IMMEDIATELY on their next forum visit (no second
  // 3-day wait). They are long-time users — they don't need another grace
  // period. Brand-new installs and users who already rated are left untouched.
  //
  // Runs EXACTLY ONCE (guarded by V1916_RESET). Same robustness contract as
  // runV1915Reset(): returns false only if storage is unreadable.
  async function runV1916Reset() {
    let state;
    try {
      state = await storageGet([
        KEYS.V1916_RESET,
        KEYS.INSTALL_DATE,
        KEYS.RATING_GIVEN,
      ]);
    } catch (e) {
      return false; // Storage unreadable → abort, write nothing.
    }

    // Already migrated → nothing to do.
    if (state[KEYS.V1916_RESET]) return true;

    // No installDate = brand-new install → don't back-date, just mark done.
    // main() will set installDate and the normal 3-day grace applies.
    if (!state[KEYS.INSTALL_DATE]) {
      await storageSet({ [KEYS.V1916_RESET]: true });
      return true;
    }

    // Already rated → never disturb; just mark the flag.
    if (state[KEYS.RATING_GIVEN]) {
      await storageSet({ [KEYS.V1916_RESET]: true });
      return true;
    }

    // Existing, not-yet-rated user → back-date installDate so the 3-day gate
    // is already satisfied, and clear any active "Maybe later" snooze so the
    // prompt can show on the very next forum page.
    await storageRemove([KEYS.LAST_DISMISSED]);
    await storageSet({
      [KEYS.INSTALL_DATE]: Date.now() - DELAY_FIRST_PROMPT - (24 * 60 * 60 * 1000), // ~4 days ago
      [KEYS.V1916_RESET]:  true,
    });
    return true;
  }

  // ── Wait for the badge bar to exist (proves extension is active) ──
  function waitForBadgeBar(maxWait = 15000) {
    return new Promise((resolve) => {
      const start = Date.now();

      function check() {
        const forum = document.querySelector('dst-forum');
        if (forum && forum.shadowRoot) {
          const bar = forum.shadowRoot.querySelector('#dst-badge-bar');
          if (bar) return resolve(bar);
        }
        if (Date.now() - start > maxWait) return resolve(null);
        setTimeout(check, 500);
      }

      check();
    });
  }

  // ── CSS for the feedback bar (injected once into <head>) ──────────
  // v2.0.8: Renamed from "rating" to "feedback" to avoid adblocker filters
  const FEEDBACK_CSS = `
    /* Feedback bar — appears below the badge bar inside shadow DOM */
    #dst-feedback-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: linear-gradient(180deg, #f9fdf6 0%, #eef4e8 100%);
      border: 1.5px solid #B7CCA3;
      border-radius: 10px;
      margin: 8px 0 4px;
      box-shadow: 0 2px 8px rgba(183,204,163,0.2);
      position: relative;
      opacity: 1;
      transform: scale(1) translateY(0);
      transform-origin: center center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    #dst-feedback-bar .dst-fdbk-icon {
      width: 32px;
      height: 32px;
      min-width: 32px;
      background: #B7CCA3;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }

    #dst-feedback-bar .dst-fdbk-text {
      flex: 1;
      min-width: 0;
    }
    #dst-feedback-bar .dst-fdbk-title {
      font-size: 12.5px;
      font-weight: 700;
      color: #333;
      margin: 0 0 4px;
      line-height: 1.2;
    }

    /* Inline stars */
    #dst-feedback-bar .dst-fdbk-stars {
      display: flex;
      gap: 3px;
      align-items: center;
    }
    #dst-feedback-bar .dst-fdbk-star {
      font-size: 22px;
      cursor: pointer;
      color: #ccc;
      transition: color 0.12s ease, transform 0.12s ease;
      user-select: none;
      line-height: 1;
    }
    #dst-feedback-bar .dst-fdbk-star:hover { transform: scale(1.15); }
    #dst-feedback-bar .dst-fdbk-star.active { color: #F9A825; }
    #dst-feedback-bar .dst-fdbk-star.hover-preview { color: #FFCC02; }

    #dst-feedback-bar .dst-fdbk-label {
      font-size: 11px;
      color: #888;
      margin-left: 8px;
      white-space: nowrap;
      transition: color 0.2s ease, font-weight 0.2s ease;
    }

    /* Dismiss button (v2.1.0: only shown if dismissCount < MAX_DISMISSALS) */
    #dst-feedback-bar .dst-fdbk-dismiss {
      border: 1.5px solid #ddd;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      color: #999;
      background: transparent;
      flex-shrink: 0;
    }
    #dst-feedback-bar .dst-fdbk-dismiss:hover {
      border-color: #aaa;
      color: #666;
      background: #f5f5f5;
    }

    /* ═══ Golden Glow Pulse — 4-layer, 3 diminishing cycles ═══ */
    @keyframes dst-golden-pulse {
      0% {
        transform: scale(1);
        box-shadow:
          0 2px 8px rgba(183,204,163,0.2),
          0 0 0 0px rgba(255,215,0,0),
          0 0 0px rgba(255,215,0,0),
          0 0 0px rgba(255,193,7,0);
      }
      12% {
        transform: scale(1.04);
        box-shadow:
          0 2px 8px rgba(183,204,163,0.2),
          0 0 0 3px rgba(255,215,0,0.7),
          0 0 18px rgba(255,215,0,0.45),
          0 0 35px rgba(255,193,7,0.22),
          inset 0 0 10px rgba(255,215,0,0.06);
      }
      24% {
        transform: scale(1);
        box-shadow:
          0 2px 8px rgba(183,204,163,0.2),
          0 0 0 2px rgba(255,215,0,0.4),
          0 0 12px rgba(255,215,0,0.25),
          0 0 24px rgba(255,193,7,0.1),
          inset 0 0 6px rgba(255,215,0,0.03);
      }
      38% {
        transform: scale(1.03);
        box-shadow:
          0 2px 8px rgba(183,204,163,0.2),
          0 0 0 2.5px rgba(255,215,0,0.55),
          0 0 14px rgba(255,215,0,0.32),
          0 0 28px rgba(255,193,7,0.14),
          inset 0 0 8px rgba(255,215,0,0.04);
      }
      52% {
        transform: scale(1);
        box-shadow:
          0 2px 8px rgba(183,204,163,0.2),
          0 0 0 1.5px rgba(255,215,0,0.3),
          0 0 8px rgba(255,215,0,0.18),
          0 0 18px rgba(255,193,7,0.07),
          inset 0 0 4px rgba(255,215,0,0.02);
      }
      68% {
        transform: scale(1.02);
        box-shadow:
          0 2px 8px rgba(183,204,163,0.2),
          0 0 0 2px rgba(255,215,0,0.38),
          0 0 10px rgba(255,215,0,0.22),
          0 0 22px rgba(255,193,7,0.08),
          inset 0 0 6px rgba(255,215,0,0.03);
      }
      82% {
        transform: scale(1);
        box-shadow:
          0 2px 8px rgba(183,204,163,0.2),
          0 0 0 1.5px rgba(255,215,0,0.22),
          0 0 6px rgba(255,215,0,0.1),
          0 0 14px rgba(255,193,7,0.04);
      }
      100% {
        transform: scale(1);
        box-shadow:
          0 2px 8px rgba(183,204,163,0.2),
          0 0 0 1px rgba(255,215,0,0.15),
          0 0 5px rgba(255,215,0,0.08),
          0 0 10px rgba(255,193,7,0.03);
      }
    }

    #dst-feedback-bar.dst-golden-pulsing {
      animation: dst-golden-pulse 2s cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }

    /* ═══ Fade-out + height collapse ═══ */
    @keyframes dst-golden-fade {
      0% {
        opacity: 1;
        transform: translateY(0);
        max-height: 80px;
        margin: 8px 0 4px;
        padding: 10px 14px;
        box-shadow:
          0 2px 8px rgba(183,204,163,0.2),
          0 0 0 1px rgba(255,215,0,0.15),
          0 0 5px rgba(255,215,0,0.08);
      }
      50% {
        opacity: 0;
        transform: translateY(-6px);
        max-height: 80px;
        margin: 8px 0 4px;
        padding: 10px 14px;
        box-shadow: none;
      }
      100% {
        opacity: 0;
        transform: translateY(-6px);
        max-height: 0;
        margin: 0;
        padding: 0 14px;
        border-width: 0;
        box-shadow: none;
      }
    }

    #dst-feedback-bar.dst-golden-fading {
      animation: dst-golden-fade 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards;
      pointer-events: none;
    }
  `;

  // ── Build the feedback bar DOM element ────────────────────────────
  // v2.1.0: Added dismissCount parameter - dismiss button only shown if < MAX_DISMISSALS
  function createFeedbackBar(dismissCount) {
    const bar = document.createElement('div');
    bar.id = 'dst-feedback-bar';

    // AMO Security Fix: DOM-Aufbau per createElement statt innerHTML
    const icon = document.createElement('div');
    icon.className = 'dst-fdbk-icon';
    const triUp = document.createElement('span');
    triUp.style.cssText = 'color:#2e7d32; font-size:13px;';
    triUp.textContent = '\u25B2';
    const triDown = document.createElement('span');
    triDown.style.cssText = 'color:#c62828; font-size:9px;';
    triDown.textContent = '\u25BC';
    icon.appendChild(triUp);
    icon.appendChild(triDown);

    const textWrap = document.createElement('div');
    textWrap.className = 'dst-fdbk-text';
    const title = document.createElement('div');
    title.className = 'dst-fdbk-title';
    title.textContent = 'Bewerte um zu verbessern';
    const starsWrap = document.createElement('div');
    starsWrap.className = 'dst-fdbk-stars';
    for (let i = 1; i <= 5; i++) {
      const star = document.createElement('span');
      star.className = 'dst-fdbk-star';
      star.setAttribute('data-value', String(i));
      star.textContent = '\u2605';
      starsWrap.appendChild(star);
    }
    const fdbkLabel = document.createElement('span');
    fdbkLabel.className = 'dst-fdbk-label';
    fdbkLabel.textContent = 'Zum Bewerten klicken';
    starsWrap.appendChild(fdbkLabel);
    textWrap.appendChild(title);
    textWrap.appendChild(starsWrap);

    bar.appendChild(icon);
    bar.appendChild(textWrap);

    // Only add dismiss button if user hasn't reached the limit (v2.1.0)
    if (dismissCount < MAX_DISMISSALS) {
      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'dst-fdbk-dismiss';
      dismissBtn.title = 'Ein anderes mal';
      dismissBtn.textContent = '\u2715';
      bar.appendChild(dismissBtn);
    }

    return bar;
  }

  // ── Inject CSS into shadow DOM ──────────────────────────────────
  // v2.0.8: Renamed ID to avoid adblocker filters
  function injectCSS(shadowRoot) {
    if (shadowRoot.querySelector('#dst-feedback-css')) return;
    const style = document.createElement('style');
    style.id = 'dst-feedback-css';
    style.textContent = FEEDBACK_CSS;
    shadowRoot.appendChild(style);
  }

  // ── Wire up star interactions + dismiss ─────────────────────────
  // v2.1.0: Dismiss button may or may not exist (depends on dismissCount)
  function wireFeedbackBar(bar) {
    const stars = bar.querySelectorAll('.dst-fdbk-star');
    const label = bar.querySelector('.dst-fdbk-label');
    const dismissBtn = bar.querySelector('.dst-fdbk-dismiss'); // May be null
    let rated = false;

    const labels = ['', 'Schlecht', 'Geht so', 'Gut', 'Sehr gut', 'Perfekt'];

    // Hover preview
    stars.forEach(star => {
      star.addEventListener('mouseenter', () => {
        if (rated) return;
        const val = +star.dataset.value;
        stars.forEach(s => {
          s.classList.toggle('hover-preview',
            +s.dataset.value <= val && !s.classList.contains('active'));
        });
        label.textContent = labels[val];
      });

      star.addEventListener('mouseleave', () => {
        if (rated) return;
        stars.forEach(s => s.classList.remove('hover-preview'));
        label.textContent = 'Zum Bewerten klicken';
      });

      // Click → rate → golden pulse → fade → gone FOREVER
      star.addEventListener('click', async () => {
        if (rated) return;
        rated = true;

        const val = +star.dataset.value;

        // 1. Light up stars
        stars.forEach(s => {
          s.classList.remove('hover-preview');
          s.classList.toggle('active', +s.dataset.value <= val);
          s.style.cursor = 'default';
        });
        label.textContent = labels[val];
        label.style.color = '#B8860B';
        label.style.fontWeight = '700';

        // 2. Open review page (if ≥4 stars) — browser-aware URL.
        //    CHROME FIX: window.open() MUST run synchronously inside the click
        //    handler. Previously it was wrapped in setTimeout(..., 1500), which
        //    broke the user-gesture/transient-activation chain and let Chrome's
        //    popup blocker silently swallow the tab — so users who clicked 4-5
        //    stars never actually reached the store. Open it first, before any
        //    awaits or timeouts.
        if (val >= 4) {
          try { window.open(getReviewURL(), '_blank'); } catch (e) { /* noop */ }
        }

        // 3. Persist: ratingGiven = true → NEVER show again
        await storageSet({ [KEYS.RATING_GIVEN]: true });

        // 4. Golden pulse → fade → remove
        setTimeout(() => bar.classList.add('dst-golden-pulsing'), 80);
        setTimeout(() => {
          bar.classList.remove('dst-golden-pulsing');
          bar.classList.add('dst-golden-fading');
        }, 2200);
        setTimeout(() => {
          bar.style.display = 'none';
          bar.remove();
        }, 2600);
      });
    });

    // Dismiss → increment dismissCount → re-prompt after 3 days
    // v2.1.0: Only wired if button exists (dismissCount < MAX_DISMISSALS)
    if (dismissBtn) {
      dismissBtn.addEventListener('click', async () => {
        if (rated) return;
        rated = true;

        // Increment dismiss counter
        const currentCount = (await storageGet([KEYS.DISMISS_COUNT]))[KEYS.DISMISS_COUNT] || 0;
        await storageSet({
          [KEYS.LAST_DISMISSED]: Date.now(),
          [KEYS.DISMISS_COUNT]: currentCount + 1,
        });

        bar.classList.add('dst-golden-fading');
        setTimeout(() => {
          bar.style.display = 'none';
          bar.remove();
        }, 400);
      });
    }
  }

  // ── Main entry point ────────────────────────────────────────────
  async function main() {
    // Safety: only run on derstandard.at/.de
    const host = location.hostname;
    if (!host.includes('derstandard.at') && !host.includes('derstandard.de')) return;

    // 0. One-time v1.9.15 reset (runs at most once, before anything else).
    //    If it returns false the storage was unreadable → abort and touch
    //    nothing, so existing data can never be clobbered by a read glitch.
    const resetOk = await runV1915Reset();
    if (!resetOk) return;

    // 0b. One-time v1.9.16 reset — removes the accidental second 3-day delay
    //     introduced by v1.9.15 so existing users are prompted right away.
    const reset16Ok = await runV1916Reset();
    if (!reset16Ok) return;

    // 1. Read storage
    //    If the read FAILS (sync disabled, runtime error, etc.) we abort
    //    completely and write NOTHING — this guarantees installDate /
    //    ratingGiven / dismissCount / lastDismissed can never be clobbered
    //    by a transient read error that looks like a "fresh install".
    let data;
    try {
      data = await storageGet([
        KEYS.INSTALL_DATE,
        KEYS.RATING_GIVEN,
        KEYS.DISMISS_COUNT,
        KEYS.LAST_DISMISSED,
      ]);
    } catch (e) {
      return; // Storage unreadable → do nothing, never overwrite existing data
    }

    // 2. First ever load? Set installDate — but NEVER overwrite an existing one.
    if (!data[KEYS.INSTALL_DATE]) {
      // Defensive double-check: re-read once more right before writing.
      // Guards against a race (two tabs loading at once) and confirms the
      // key is genuinely absent rather than missing due to a fluke.
      let recheck;
      try {
        recheck = await storageGet([KEYS.INSTALL_DATE]);
      } catch (e) {
        return; // Can't confirm → abort without writing
      }
      if (recheck[KEYS.INSTALL_DATE]) {
        // It actually existed → adopt the real value, do NOT overwrite.
        data[KEYS.INSTALL_DATE] = recheck[KEYS.INSTALL_DATE];
      } else {
        await storageSet({ [KEYS.INSTALL_DATE]: Date.now() });
        return; // Don't show on first load
      }
    }

    // 3. Already rated? → NEVER show again
    if (data[KEYS.RATING_GIVEN]) return;

    // 4. Time check: only show after 3 days since install
    const now = Date.now();
    const installAge = now - data[KEYS.INSTALL_DATE];

    // Not yet 3 days since install
    if (installAge < DELAY_FIRST_PROMPT) return;

    // 5. Dismiss count check (v2.1.0)
    const dismissCount = data[KEYS.DISMISS_COUNT] || 0;

    // If user has dismissed < MAX_DISMISSALS times, honor the 3-day snooze
    if (dismissCount < MAX_DISMISSALS && data[KEYS.LAST_DISMISSED]) {
      const dismissAge = now - data[KEYS.LAST_DISMISSED];
      if (dismissAge < DELAY_AFTER_DISMISS) return; // Still in snooze period
    }
    // If dismissCount >= MAX_DISMISSALS, bar will show permanently (no snooze check)

    // 6. Wait for badge bar (proves extension & forum are active)
    const badgeBar = await waitForBadgeBar();
    if (!badgeBar) return; // No forum on this page, or extension inactive

    // 7. Get the shadow root
    const forum = document.querySelector('dst-forum');
    if (!forum || !forum.shadowRoot) return;
    const shadowRoot = forum.shadowRoot;

    // 8. Don't inject twice
    if (shadowRoot.querySelector('#dst-feedback-bar')) return;

    // 9. Inject CSS + feedback bar (v2.1.0: pass dismissCount to control button)
    injectCSS(shadowRoot);
    const feedbackBar = createFeedbackBar(dismissCount);
    wireFeedbackBar(feedbackBar);

    // 10. Insert after the badge bar
    // v2.4.10: explicit order, otherwise the forum's default order rule
    // (content.js) would push the bar to the very end of the forum.
    feedbackBar.style.order = '-1';
    badgeBar.insertAdjacentElement('afterend', feedbackBar);

    // 11. v2.5.0: never ask for a review and a coffee on the same day.
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    // content.js listens and keeps the coffee badge calm for the rest of the page.
    document.dispatchEvent(new Event('dst-review-shown'));
    await storageSet({ [KEYS.SHOWN_DAY]: today });
  }

  // ── Run when DOM is ready ───────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    // Small delay to let content.js inject the badge bar first
    setTimeout(main, 1000);
  }

})();
