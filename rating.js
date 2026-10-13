// ═══════════════════════════════════════════════════════════════════════
//  rating.js — derStandard Comment Ranker
//  Review prompt for the Chrome Web Store / AMO, shown below the sort bar
//
//  v3.1.0 DISMISSALS:
//  - Bar appears after 3 days
//  - ✕ is always there; every dismissal snoozes the bar for 3 days
//    (v2.1.0 removed the ✕ after the 2nd dismissal — no longer)
//  - Rating (1-5★) → bar disappears forever
//
//  v2.0.8 UNIFIED REVIEW LOGIC + ADBLOCKER-RESISTANT:
//  - Uses SHARED storage key 'dstRanker_ratingGiven' (chrome.storage.sync)
//    with popup.js → clicking review in EITHER location stops prompts in BOTH
//  - CSS classes renamed from "rating"/"rate" to "feedback"/"fdbk" to avoid
//    common adblocker filters (e.g., EasyList blocks elements with "rating")
//
//  ISOLATION:
//  - Only reads content.js's sort bar (#dst-badge-bar) to know where to show
//    the prompt; the sorting itself never depends on this file
//
//  CROSS-BROWSER:
//  - Uses chrome.storage.sync (works in Chrome + Firefox MV3)
//  - No browser.* API needed — chrome.* is the universal MV3 standard
//  - Async/await with Promise wrappers for chrome.storage
//  - Browser-detection for correct review URL (Chrome Web Store vs AMO)
//
//  TIMING & DISMISS LOGIC:
//  - First prompt: 3 days after first page load (installDate)
//  - Every dismiss: re-prompt after 3 days
//  - Star click (ratingGiven=true): NEVER show again
// ═══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Storage keys (own namespace, no conflicts with content.js) ──
  const KEYS = {
    INSTALL_DATE:    'dstRanker_installDate',
    RATING_GIVEN:    'dstRanker_ratingGiven',
    LAST_DISMISSED:  'dstRanker_lastDismissed',
  };

  const DELAY_FIRST_PROMPT  = 3 * 24 * 60 * 60 * 1000;  // 3 days in ms
  const DELAY_AFTER_DISMISS = 3 * 24 * 60 * 60 * 1000;  // 3 days in ms

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
    /* v4.10.4: a pill in the look of the sort bar (and of the review button
       in the popup): "Gefällt dir? Bewerte uns", five stars, ✕ */
    #dst-feedback-bar {
      --dst-ink: var(--theme--on-secondary--hsl, 0 0% 13%);
      --dst-track: color-mix(in srgb, var(--theme--base, #e6e6e6) 65%, #fff);
      --dst-track-border: color-mix(in srgb, var(--theme--base, #e6e6e6) 75%, #000);
      display: flex;
      align-items: center;
      height: 50px;
      padding: 0 6px 0 20px;
      box-sizing: border-box;
      /* same distance to the sort bar above and to the postings below */
      margin: -13px 0 18px;
      border-radius: 999px;
      background: linear-gradient(to bottom,
        color-mix(in srgb, var(--dst-track) 35%, #fff),
        var(--dst-track) 55%,
        color-mix(in srgb, var(--dst-track) 94%, #000));
      box-shadow: 0 0 0 1px var(--dst-track-border),
        inset 0 1.5px 0 rgba(255, 255, 255, .95),
        inset 0 -2px 3px rgba(0, 0, 0, .08),
        0 3px 8px rgba(0, 0, 0, .18);
      color: hsl(var(--dst-ink));
      font-family: inherit;
      container-type: inline-size;
      overflow: hidden;
    }
    #dst-feedback-bar .dst-fdbk-main {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
    }
    #dst-feedback-bar .dst-fdbk-title {
      font-size: 15px;
      font-weight: 600;
      color: #b8860b;
      white-space: nowrap;
    }
    #dst-feedback-bar .dst-fdbk-stars { display: flex; gap: 2px; }
    #dst-feedback-bar .dst-fdbk-star {
      font: inherit;
      font-size: 18px;               /* like the stars in the popup */
      line-height: 1;
      padding: 0 1px;
      border: 0;
      background: none;
      cursor: pointer;
      color: hsl(var(--dst-ink) / .25);
      transition: color .12s ease, transform .12s ease;
      user-select: none;
    }
    #dst-feedback-bar .dst-fdbk-star:hover { transform: scale(1.15); }
    #dst-feedback-bar .dst-fdbk-star.active,
    #dst-feedback-bar .dst-fdbk-star.hover-preview { color: #f5c518; }
    #dst-feedback-bar .dst-fdbk-dismiss {
      flex: none;
      width: 38px;
      height: 38px;
      border: 0;
      border-radius: 50%;
      background: none;
      cursor: pointer;
      font-size: 15px;
      color: hsl(var(--dst-ink) / .55);
    }
    #dst-feedback-bar .dst-fdbk-dismiss:hover {
      background: hsl(var(--dst-ink) / .06);
      color: hsl(var(--dst-ink));
    }
    #dst-feedback-bar .dst-fdbk-dismiss:focus-visible,
    #dst-feedback-bar .dst-fdbk-star:focus-visible {
      outline: 2px solid hsl(var(--dst-ink));
      outline-offset: 2px;
    }
    @container (max-width: 420px) {
      #dst-feedback-bar .dst-fdbk-main { gap: 8px; }
      #dst-feedback-bar .dst-fdbk-title { font-size: 13px; }
    }

    /* after rating: the golden ring of the coffee button, then fade out */
    #dst-feedback-bar.dst-golden-pulsing {
      background: #fff8e1;
      box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, .95),
        0 0 0 2px rgba(230, 170, 0, .95), 0 2px 6px rgba(0, 0, 0, .12);
      transition: background .3s ease, box-shadow .3s ease;
    }
    @keyframes dst-fdbk-fade {
      0%   { opacity: 1; height: 50px; margin: -13px 0 18px; }
      50%  { opacity: 0; height: 50px; margin: -13px 0 18px; }
      100% { opacity: 0; height: 0; margin: 0; }
    }
    #dst-feedback-bar.dst-golden-fading {
      animation: dst-fdbk-fade .4s ease forwards;
      pointer-events: none;
    }
    @media (prefers-reduced-motion: reduce) {
      #dst-feedback-bar .dst-fdbk-star, #dst-feedback-bar.dst-golden-pulsing { transition: none; }
    }
  `;

  // ── Build the feedback bar DOM element ────────────────────────────
  // v3.1.0: the dismiss button is always there — a prompt that cannot be
  // closed is an anti-pattern and tends to earn bad reviews instead of good ones.
  function createFeedbackBar() {
    const bar = document.createElement('div');
    bar.id = 'dst-feedback-bar';

    // AMO Security Fix: DOM-Aufbau per createElement statt innerHTML
    const main = document.createElement('div');
    main.className = 'dst-fdbk-main';
    const title = document.createElement('span');
    title.className = 'dst-fdbk-title';
    title.textContent = 'Gefällt dir? Bewerte uns';
    const starsWrap = document.createElement('span');
    starsWrap.className = 'dst-fdbk-stars';
    const labels = ['Schlecht', 'Geht so', 'Gut', 'Sehr gut', 'Perfekt'];
    for (let i = 1; i <= 5; i++) {
      // v4.10.1: real buttons, so the stars work with the keyboard too
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'dst-fdbk-star';
      star.setAttribute('data-value', String(i));
      star.setAttribute('aria-label', i + (i === 1 ? ' Stern' : ' Sterne') + ' – ' + labels[i - 1]);
      star.title = labels[i - 1];
      star.textContent = '\u2605';
      starsWrap.appendChild(star);
    }
    main.appendChild(title);
    main.appendChild(starsWrap);
    bar.appendChild(main);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'dst-fdbk-dismiss';
    dismissBtn.title = 'Ein anderes Mal';
    dismissBtn.setAttribute('aria-label', 'Ein anderes Mal');
    dismissBtn.textContent = '\u2715';
    bar.appendChild(dismissBtn);

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
  function wireFeedbackBar(bar) {
    const stars = bar.querySelectorAll('.dst-fdbk-star');
    const dismissBtn = bar.querySelector('.dst-fdbk-dismiss');
    let rated = false;

    // Hover preview
    stars.forEach(star => {
      star.addEventListener('mouseenter', () => {
        if (rated) return;
        const val = +star.dataset.value;
        stars.forEach(s => {
          s.classList.toggle('hover-preview',
            +s.dataset.value <= val && !s.classList.contains('active'));
        });
      });

      star.addEventListener('mouseleave', () => {
        if (rated) return;
        stars.forEach(s => s.classList.remove('hover-preview'));
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
        setTimeout(() => bar.classList.add('dst-golden-fading'), 2200);
        setTimeout(() => {
          bar.style.display = 'none';
          bar.remove();
        }, 2600);
      });
    });

    // Dismiss → re-prompt after 3 days
    if (dismissBtn) {
      dismissBtn.addEventListener('click', async () => {
        if (rated) return;
        rated = true;

        await storageSet({ [KEYS.LAST_DISMISSED]: Date.now() });

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

    // 1. Read storage
    //    If the read FAILS (sync disabled, runtime error, etc.) we abort
    //    completely and write NOTHING — this guarantees installDate /
    //    ratingGiven / lastDismissed can never be clobbered
    //    by a transient read error that looks like a "fresh install".
    let data;
    try {
      data = await storageGet([
        KEYS.INSTALL_DATE,
        KEYS.RATING_GIVEN,
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

    // 5. Snooze check
    // v3.1.0: every dismissal snoozes for 3 days (no permanent bar any more)
    if (data[KEYS.LAST_DISMISSED]) {
      const dismissAge = now - data[KEYS.LAST_DISMISSED];
      if (dismissAge < DELAY_AFTER_DISMISS) return; // Still in snooze period
    }

    // 6. Wait for badge bar (proves extension & forum are active)
    const badgeBar = await waitForBadgeBar();
    if (!badgeBar) return; // No forum on this page, or extension inactive

    // 7. Get the shadow root
    const forum = document.querySelector('dst-forum');
    if (!forum || !forum.shadowRoot) return;
    const shadowRoot = forum.shadowRoot;

    // 8. Don't inject twice
    if (shadowRoot.querySelector('#dst-feedback-bar')) return;

    // 9. Inject CSS + feedback bar
    injectCSS(shadowRoot);
    const feedbackBar = createFeedbackBar();
    wireFeedbackBar(feedbackBar);

    // 10. Insert after the badge bar
    // v2.4.10: explicit order, otherwise the forum's default order rule
    // (content.js) would push the bar to the very end of the forum.
    feedbackBar.style.order = '-1';
    badgeBar.insertAdjacentElement('afterend', feedbackBar);
  }

  // ── Run (document_idle) — a small delay lets content.js inject the bar ──
  setTimeout(main, 1000);

})();
