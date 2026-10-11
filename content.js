(function () {
  'use strict';

  // v2.4.4 disabled the browser's scroll anchoring for the whole page, to avoid
  // jumps while CSS order reorders the forum. That also removed the browser's
  // protection against everything ELSE that changes height above the reader
  // (article images, ads, the forum header) — while the page was loading, the
  // text being read moved by more than 2000px. Scroll anchoring is now only
  // suspended during our own re-sorts (see sortPostings), which correct the
  // position themselves.

  // v2.4.10: Konsolen-Ausgaben nur noch im Debug-Modus (vorher 28 Logs, teils in Schleifen).
  const DEBUG = false;
  function log() { if (DEBUG) console.log.apply(console, arguments); }

  const SORT_KEY = 'dstSorterEnabled';
  const MODE_KEY = 'dstSorterMode';
  const AUTOLOAD_KEY = 'dstSorterAutoLoad';

  // ── Sort mode definitions ───────────────────────────────────────
  // Icon CSS classes: ico-pri = primary (large), ico-sec = secondary (small)
  // AMO Security Fix: badgeIcons als DOM-Builder-Funktionen statt innerHTML-Strings
  // Jedes Icon-Element wird per createElement/textContent erzeugt (kein innerHTML)
  function _mkSpan(cls, color, text) {
    const s = document.createElement('span');
    s.className = cls;
    if (color) s.style.color = color;
    s.textContent = text;
    return s;
  }
  // ── v2.2.0: grouped toggle buttons ─────────────────────────────
  // Instead of 5 separate sort badges we now render only 3 sort buttons
  // (plus the coffee button). Each button owns several sub-modes and
  // cycles through them on every click:
  //   • Balance  : Balance: Top  ↔ Balance: Low
  //   • Likes    : Likes: Top    ↔ Likes: Low
  //   • Timeline : Timeline: New ↔ Timeline: Old (v2.2.2: 2-way toggle)
  //
  // MODE_DEFS: label + icon builder for every individual sort mode.
  // v2.4.0: The two Balance triangles keep a FIXED position (green ▲ left,
  // red ▼ right). Only their SIZE changes with the selected sub-mode — the
  // active direction's triangle grows (ico-pri = big), the other shrinks
  // (ico-sec = small). Nothing moves, so switching modes is a minimal visual
  // change.
  // v3.1.0: one short word per segment. "Balance" keeps its text in both
  // directions — the two triangles show the direction. The old "Likes: Low"
  // actually sorted by the most MINUS votes, hence "Dislikes". New/Old as on
  // Reddit. `title` is the full name for tooltips and screen readers.
  const MODE_DEFS = {
    'balance-top':      { label: 'Balance',  title: 'Balance: Top', buildIcon: function(p) { p.appendChild(_mkSpan('ico-pri','#2e7d32','\u25B2')); p.appendChild(_mkSpan('ico-sec','#c62828','\u25BC')); } },
    'balance-flop':     { label: 'Balance',  title: 'Balance: Low', buildIcon: function(p) { p.appendChild(_mkSpan('ico-sec','#2e7d32','\u25B2')); p.appendChild(_mkSpan('ico-pri','#c62828','\u25BC')); } },
    'positive-only':    { label: 'Likes',    title: 'Likes',        buildIcon: function(p) { p.appendChild(_mkSpan('ico-pri','#2e7d32','\u25B2')); } },
    'negative-only':    { label: 'Dislikes', title: 'Dislikes',     buildIcon: function(p) { p.appendChild(_mkSpan('ico-pri','#c62828','\u25BC')); } },
    // Time is neutral (no red/green): the arrow inherits the text colour.
    'chronological-new':{ label: 'New',      title: 'New',          buildIcon: function(p) { p.appendChild(_mkSpan('ico-time', null, '\u2193')); } },
    'chronological-old':{ label: 'Old',      title: 'Old',          buildIcon: function(p) { p.appendChild(_mkSpan('ico-time', null, '\u2191')); } }
  };

  // BUTTON_GROUPS: one badge per entry; each click advances to the next mode.
  const BUTTON_GROUPS = [
    { id: 'balance',  modes: ['balance-top', 'balance-flop'] },
    { id: 'likes',    modes: ['positive-only', 'negative-only'] },
    { id: 'timeline', modes: ['chronological-new', 'chronological-old'] }
  ];

  // v2.2.2 (back in v3.1.1): two small dots under every segment, in the style
  // of Material Design's page indicators — they show that the segment has two
  // sort modes, and the filled dot which one is selected (also on inactive
  // segments). Real CSS circles, crisp on high-density screens.
  function buildDotsIndicator(group, currentMode) {
    const span = document.createElement('span');
    span.className = 'dots-indicator';
    span.setAttribute('aria-hidden', 'true');
    const currentIndex = group.modes.indexOf(currentMode);
    for (let i = 0; i < group.modes.length; i++) {
      const dot = document.createElement('span');
      dot.className = 'dst-dot' + (i === currentIndex ? ' filled' : '');
      span.appendChild(dot);
    }
    return span;
  }

  const ALL_MODES = Object.keys(MODE_DEFS);

  // Remembers the last-selected sub-mode per button group so a button keeps
  // showing a sensible label/icon even while another button is the active one.
  const groupSelection = {
    balance:  'balance-top',
    likes:    'positive-only',
    timeline: 'chronological-new'
  };

  function getGroupForMode(mode) {
    for (let i = 0; i < BUTTON_GROUPS.length; i++) {
      if (BUTTON_GROUPS[i].modes.indexOf(mode) !== -1) return BUTTON_GROUPS[i];
    }
    return null;
  }

  // Keep groupSelection in sync with the currently active sortMode.
  // v3.1.2: mode clicked but not sorted yet (the re-sort waits for the
  // slide animation), and a counter so only the latest click re-sorts.
  let pendingMode = null;
  let pendingClick = 0;

  function syncGroupSelection() {
    const g = getGroupForMode(sortMode);
    if (g) groupSelection[g.id] = sortMode;
  }

  // CSS injected into shadow DOM: icon hierarchy, badge bar, animation, hide old buttons
  const ICON_STYLE_CSS = `
    /* Hide old tab navigation buttons (Alle Postings, Aelteste, Plus, Minus) */
    dst-forum--tabnavigation { display: none !important; }

    /* v2.4.10: Everything that has not (yet) received an explicit CSS order goes
       to the END of the forum. Previously new postings loaded in the background
       defaulted to order:0 and popped up at the TOP of the forum until the next
       sort, shifting everything the reader was looking at. Inline style.order
       from the sorter always overrides this rule. */
    main.forum--main > * { order: 999999; }

    /* NOTE: Reply thread sections (SECTION.thread) are now attached as siblings
       of their parent posting groups and move together during sorting.
       This preserves the expand/collapse ("Antworten") functionality.
       We do NOT hide section.thread elements — derstandard.at manages their
       visibility natively via the "collapsed" CSS class. */

    /* ═══ v3.1.0 SORT BAR: one segmented control in derStandard's own look ═══
       All colours come from derStandard's theme variables, which change with
       the Ressort (and dark mode); the fallbacks are the default light theme.
       Green and red appear ONLY in the triangles — they stand for ratings. */
    #dst-badge-bar, #dst-voter-overlay {
      --dst-ink: var(--theme--on-secondary--hsl, 0 0% 13%);
      --dst-card: var(--theme--card, #fff);
    }
    #dst-badge-bar {
      display: flex;
      flex-wrap: nowrap;
      gap: 6px;
      padding: 10px 0 6px 0;
      align-items: stretch;
      box-sizing: border-box;
      width: 100%;
      font-family: inherit;
    }
    /* The track holding the three sort segments */
    #dst-seg {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      gap: 3px;
      padding: 3px;
      border-radius: 8px;
      background: hsl(var(--dst-ink) / .08);
      box-sizing: border-box;
    }
    /* v3.1.2: the active segment's card is ONE element sliding under the
       segments (like the switch in the extension popup, 0.3s). Segments are
       equal-width, so its position is pure CSS: no layout measurement. Its
       width is set from JS (depends on the number of segments). On a click
       it slides first; the re-sort only starts afterwards. */
    #dst-seg-thumb {
      position: absolute;
      top: 3px;
      bottom: 3px;
      left: 3px;
      border-radius: 6px;
      background: var(--dst-card);
      box-shadow: 0 0 0 1px hsl(var(--dst-ink) / .15);
      transform: translateX(calc(var(--dst-i, 0) * (100% + 3px)));
      transition: transform .3s ease;
    }
    @media (prefers-reduced-motion: reduce) {
      #dst-seg-thumb { transition: none; }
    }
    .dst-badge-btn {
      flex: 1 1 0;
      min-width: 0;
      min-height: 38px;           /* + 2 x 3px track padding = 44px touch target */
      padding: 0 8px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;     /* label row on top, dots below */
      align-items: center;
      justify-content: center;
      gap: 5px;
      border-radius: 6px;         /* same rounding as derStandard's posting cards */
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      line-height: 1;
      color: hsl(var(--dst-ink) / .8);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition: background-color .15s ease, color .15s ease;
    }
    /* v3.1.2: every inactive segment is a faint tile of its own, so the
       three segments are visibly separate; the active one sits on the thumb. */
    #dst-seg .dst-badge-btn {
      position: relative;         /* above the sliding thumb */
      background: color-mix(in srgb, var(--dst-card) 45%, transparent);
    }
    #dst-seg .dst-badge-btn:hover {
      background: color-mix(in srgb, var(--dst-card) 70%, transparent);
      color: hsl(var(--dst-ink));
    }
    #dst-seg .dst-badge-btn.active,
    #dst-seg .dst-badge-btn.active:hover {
      background: transparent;    /* the thumb underneath is the card */
      color: hsl(var(--dst-ink));
      font-weight: 700;
    }
    .dst-badge-btn:focus-visible {
      outline: 2px solid hsl(var(--dst-ink));
      outline-offset: 2px;
    }
    .dst-btn-toprow {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      min-width: 0;
      max-width: 100%;
    }
    .dst-btn-ico {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 1px;
    }
    /* ico-pri = big (active direction), ico-sec = small (other direction) */
    .ico-pri { font-size: 15px; line-height: 1; }
    .ico-sec { font-size: 10px; line-height: 1; }
    .ico-time { font-size: 14px; line-height: 1; }
    .dst-btn-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* Two dots: segment has two modes; the filled one is selected */
    .dots-indicator {
      display: flex;
      justify-content: center;
      gap: 4px;
      line-height: 1;
    }
    .dst-dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      box-sizing: border-box;
      border: 1px solid currentColor;
      opacity: .55;
    }
    .dst-dot.filled {
      background: currentColor;
      opacity: .9;
    }

    /* Coffee/Donate button — never active; square, tinted like the track. */
    .dst-badge-btn.dst-coffee-btn {
      flex: 0 0 44px;
      width: 44px;
      min-height: 44px;
      padding: 0;
      border-radius: 8px;
      background: hsl(var(--dst-ink) / .08);
      color: #6d4c41;
      position: relative;
    }
    .dst-badge-btn.dst-coffee-btn:hover,
    .dst-badge-btn.dst-coffee-btn.dst-pulsing {
      background: #fff8e1;
      outline: 2px solid #FFD700;
      outline-offset: -2px;
      animation: dst-coffee-golden-pulse 1.5s ease-in-out infinite;
    }
    .dst-badge-btn.dst-coffee-btn:hover .dst-coffee-icon,
    .dst-badge-btn.dst-coffee-btn.dst-pulsing .dst-coffee-icon {
      transform: scale(1.1);
    }
    /* v2.4.5: Auto-Puls alle 15 Tage — respektiert reduzierte Bewegung */
    @media (prefers-reduced-motion: reduce) {
      .dst-badge-btn.dst-coffee-btn.dst-pulsing {
        animation: none;
        box-shadow: 0 0 10px 2px rgba(255, 215, 0, 0.35);
      }
    }

    /* Golden Pulse animation for Coffee badge */
    @keyframes dst-coffee-golden-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(255, 215, 0, 0.7); }
      50%  { box-shadow: 0 0 20px 10px rgba(255, 215, 0, 0.4); }
      100% { box-shadow: 0 0 0 0 rgba(255, 215, 0, 0); }
    }

    /* V14 Coffee Steam Container */
    .dst-steam-container {
      position: absolute;
      bottom: 60%;
      left: 40%;
      transform: translateX(-50%);
      width: 25px;
      height: 50px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 1.5s ease-out;
      overflow: visible;
    }
    .dst-badge-btn.dst-coffee-btn:hover .dst-steam-container,
    .dst-badge-btn.dst-coffee-btn.dst-pulsing .dst-steam-container {
      opacity: 1;
      transition: opacity 0.3s ease-in;
    }

    /* V14 Fine Steam Wisps */
    .dst-steam-wisp {
      position: absolute;
      bottom: 0;
      width: 4px;
      height: 8px;
      background: linear-gradient(to top,
        rgba(140, 140, 140, 0.5) 0%,
        rgba(160, 160, 160, 0.35) 40%,
        rgba(180, 180, 180, 0.2) 100%
      );
      border-radius: 50% 50% 30% 30% / 40% 40% 60% 60%;
      filter: blur(2.5px);
      box-shadow: 0 0 2px rgba(120, 120, 120, 0.2);
      animation: dst-steam-fine-rise 6s ease-out infinite;
    }
    .dst-steam-wisp:nth-child(1) { left: 48%; animation-delay: 0s; width: 3px; height: 7px; }
    .dst-steam-wisp:nth-child(2) { left: 50%; animation-delay: 0.2s; width: 4px; height: 8px; }
    .dst-steam-wisp:nth-child(3) { left: 49%; animation-delay: 0.4s; width: 3.5px; height: 7.5px; }
    .dst-steam-wisp:nth-child(4) { left: 51%; animation-delay: 0.6s; width: 3px; height: 7px; }
    .dst-steam-wisp:nth-child(5) { left: 50%; animation-delay: 0.8s; width: 3.5px; height: 8px; }

    @keyframes dst-steam-fine-rise {
      0%   { transform: translateY(0) translateX(0) rotate(0deg) scaleY(1); opacity: 0; }
      5%   { transform: translateY(-15px) translateX(0) rotate(2deg) scaleY(1.1); opacity: 0.7; }
      20%  { transform: translateY(-22px) translateX(1px) rotate(4deg) scaleY(1.3); opacity: 0.6; }
      40%  { transform: translateY(-30px) translateX(0) rotate(-3deg) scaleY(1.5); opacity: 0.5; }
      50%  { transform: translateY(-35px) translateX(-1px) rotate(-5deg) scaleY(1.6); opacity: 0.4; }
      60%  { transform: translateY(-40px) translateX(-1px) rotate(-4deg) scaleY(1.7); opacity: 0.25; }
      70%  { transform: translateY(-45px) translateX(0) rotate(-2deg) scaleY(1.8); opacity: 0.12; }
      80%  { transform: translateY(-49px) translateX(0) rotate(2deg) scaleY(1.85); opacity: 0.05; }
      90%  { transform: translateY(-51px) translateX(0) rotate(1deg) scaleY(1.88); opacity: 0.015; }
      100% { transform: translateY(-53px) translateX(0) rotate(0deg) scaleY(1.9); opacity: 0; }
    }

    /* Mobile: the segmented control stays in ONE row; just tighter padding. */
    @media (max-width: 768px) {
      .dst-badge-btn { padding: 0 4px; }
    }

    /* ═══ VOTER POPUP (v1.9.18) ═══════════════════════════════════════════
       Clicking a posting's rating numbers opens this badge-styled popup that
       lists who rated positively / negatively (data from the public ratinglog
       endpoint). Rendered inside the forum shadow DOM so styles stay isolated. */

    /* Make the rating numbers look clickable */
    dst-posting--ratinglog button.u-interactive {
      cursor: pointer !important;
    }
    /* v1.9.20 — Fix 2: on hover, frame the whole rating area in gold — exactly
       like the coffee icon (2px solid #FFD700 + warm #fff8e1 background) instead
       of underlining the numbers. The default border is transparent so the
       layout never jumps when the gold frame appears. */
    dst-posting--ratinglog.dst-votable button {
      border: 2px solid transparent !important;
      border-radius: 11px !important;
      transition: border-color 0.2s ease, background 0.2s ease !important;
    }
    dst-posting--ratinglog.dst-votable button:hover {
      border: 2px solid #FFD700 !important;
      background: #fff8e1 !important;
    }
    dst-posting--ratinglog.dst-votable button:hover span.pos,
    dst-posting--ratinglog.dst-votable button:hover span.neg {
      text-decoration: none !important;
    }

    /* Full-screen backdrop */
    #dst-voter-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
      padding: 16px;
      box-sizing: border-box;
      animation: dst-voter-fade 0.15s ease-out;
    }
    @keyframes dst-voter-fade { from { opacity: 0; } to { opacity: 1; } }

    /* The badge-styled card */
    #dst-voter-card {
      position: relative;
      background: var(--dst-card);
      border-radius: 8px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
      width: 100%;
      max-width: 540px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: inherit;
      color: hsl(var(--dst-ink));
      animation: dst-voter-pop 0.18s cubic-bezier(0.2, 0.8, 0.3, 1.1);
    }
    @keyframes dst-voter-pop { from { transform: scale(0.94); opacity: 0; } to { transform: scale(1); opacity: 1; } }

    /* v2.0.0: no more central heading — each column owns its own header (see
       .dst-voter-col-head). v3.1.0: a visible "✕" in the top right corner, in
       addition to backdrop click and Escape. */
    #dst-voter-close {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 2;
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: hsl(var(--dst-ink) / .6);
      font: inherit;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
    }
    #dst-voter-close:hover { background: hsl(var(--dst-ink) / .08); color: hsl(var(--dst-ink)); }
    #dst-voter-close:focus-visible { outline: 2px solid hsl(var(--dst-ink)); outline-offset: 1px; }

    /* Body: two columns */
    #dst-voter-body {
      display: flex;
      gap: 0;
      overflow: hidden;
      flex: 1 1 auto;
      min-height: 120px;
    }
    .dst-voter-col {
      flex: 1 1 50%;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .dst-voter-col + .dst-voter-col { border-left: 1px solid hsl(var(--dst-ink) / .12); }
    .dst-voter-col-head {
      padding: 13px 14px 11px 14px;
      font-size: 13px;
      position: sticky;
      top: 0;
      background: var(--dst-card);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    /* v2.0.1 Fix 2: triangle keeps the SAME size ratio to the text as in the
       badge bar (.ico-pri 17px / .dst-badge-btn 11.5px = 1.478). With 13px text
       that means 13 * 1.478 = 19.2px. */
    .dst-voter-col-head .dst-vch-tri { font-size: 19.2px; line-height: 1; }
    /* v2.0.1 Fix 1: count and label share the SAME size & weight — no longer
       does the number look bigger/bolder than the text next to it. */
    .dst-voter-col-head .dst-vch-count { font-weight: 600; font-size: 13px; }
    .dst-voter-col-head .dst-vch-label { font-weight: 600; font-size: 13px; }
    .dst-voter-col-head.pos { color: #2e7d32; border-bottom: 2px solid #2e7d32; }
    .dst-voter-col-head.neg { color: #c62828; border-bottom: 2px solid #c62828; padding-right: 44px; }
    .dst-voter-list {
      list-style: none;
      margin: 0;
      padding: 4px 0 8px 0;
      overflow-y: auto;
      flex: 1 1 auto;
    }
    .dst-voter-list li { margin: 0; padding: 0; }
    .dst-voter-list a {
      display: block;
      padding: 7px 14px;
      font-size: 13px;
      color: inherit;
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-radius: 8px;
      margin: 1px 6px;
    }
    .dst-voter-list a:hover { background: hsl(var(--dst-ink) / .06); }

    /* Footer / pagination */
    #dst-voter-foot {
      flex: 0 0 auto;
      padding: 10px 14px;
      border-top: 1px solid hsl(var(--dst-ink) / .12);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      min-height: 22px;
    }

    /* Loading spinner */
    .dst-voter-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 30px;
      width: 100%;
      color: hsl(var(--dst-ink) / .65);
      font-size: 13px;
    }
    .dst-voter-spinner {
      width: 28px;
      height: 28px;
      border: 3px solid hsl(var(--dst-ink) / .12);
      border-top-color: hsl(var(--dst-ink) / .7);
      border-radius: 50%;
      animation: dst-voter-spin 0.8s linear infinite;
    }
    @keyframes dst-voter-spin { to { transform: rotate(360deg); } }

    /* v2.0.4: footer progress bar — replicates derStandard's posting-load bar
       (the green "Lade alle Postings …" bar) for a consistent look. */
    .dst-voter-progress {
      width: 100%;
      height: 28px;
      background: hsl(var(--dst-ink) / .08);
      border-radius: 6px;
      position: relative;
      overflow: hidden;
    }
    .dst-voter-progress-fill {
      position: absolute;
      left: 0;
      top: 0;
      height: 100%;
      width: 0%;
      background: hsl(var(--dst-ink) / .18);
      border-radius: 6px;
      transition: width 0.4s ease;
    }
    .dst-voter-progress-fill--loading {
      animation: dst-voter-progress-pulse 1.5s ease-in-out infinite;
    }
    .dst-voter-progress-text {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: hsl(var(--dst-ink));
      font-weight: 700;
      font-size: 12px;
      z-index: 1;
    }
    @keyframes dst-voter-progress-pulse { 0% { opacity: 1; } 50% { opacity: 0.7; } 100% { opacity: 1; } }
    .dst-voter-error {
      padding: 24px 20px;
      text-align: center;
      color: #c62828;
      font-size: 13px;
      width: 100%;
    }

    @media (max-width: 768px) {
      #dst-voter-card { max-width: 100%; max-height: 86vh; }
      .dst-voter-list a { padding: 9px 14px; font-size: 14px; }
    }
  `;

  let sortEnabled = true;
  let sortMode = 'balance-top'; // default
  let autoLoadEnabled = true;
  let observer = null;
  let sortTimeout = null;
  let isSorting = false;
  let lastSortSignature = '';
  let isLoadingAllPostings = false; // v1.7.3: Guard for loadAllPostings
  // v1.6.10: Removed ratingChangeDebounce — we no longer observe rating attribute changes
  // This prevents the extension from interfering with derStandard.at's vote processing

  // v1.9.19 — Fix 1: Reply threads must stay COLLAPSED by default.
  // We collapse each expanded thread exactly ONCE (via the native toggle), and
  // track which postings we've already auto-collapsed so we never fight a user
  // who manually re-expands a thread. WeakSet keyed on the posting element is
  // robust because the CSS-order sort never recreates posting nodes.
  const autoCollapsedPostings = new WeakSet();

  // v1.9.20 — track pinned postings we've auto-EXPANDED. When the user turns on
  // the gear's "Antworten ausgeklappt", derStandard expands normal postings but
  // leaves angeheftete (pinned) postings collapsed. We expand those pinned
  // postings once so both posting types honor the setting equally — and the
  // WeakSet makes sure we never fight a user who re-collapses one afterwards.
  const autoExpandedPostings = new WeakSet();

  // ════════════════════════════════════════════════════════════════════════
  // VOTER POPUP (v1.9.18)
  // Make the rating numbers clickable and show who rated positive/negative.
  // The numeric posting id (needed by the ratinglog endpoint) is supplied by
  // forum-hook.js (MAIN world) which captures it from the GraphQL responses.
  // ════════════════════════════════════════════════════════════════════════

  // Maps encoded posting id (DOM "postingid" attr) -> numeric legacy posting id
  const voterIdMap = Object.create(null);
  let voterListenerAttached = false;
  let voterEscBound = false;
  // v2.4.10: Jede geoeffnete Popup-Sitzung bekommt eine Nummer. Schliessen oder
  // Neu-Oeffnen erhoeht sie, wodurch laufende Ladeschleifen sofort abbrechen.
  let voterSession = 0;

  // Receive id pairs from the MAIN-world hook
  window.addEventListener('dst-voter-idmap', function (ev) {
    try {
      const pairs = JSON.parse(ev.detail);
      for (const k in pairs) voterIdMap[k] = pairs[k];
    } catch (e) { /* ignore malformed payloads */ }
  });

  const RATINGLOG_BASE = 'https://apps.derstandard.at/forum';

  // Resolve the numeric posting id for an encoded id, retrying briefly in case
  // the GraphQL response for that posting hasn't been captured yet.
  function resolveNumericPostingId(encodedId, session) {
    return new Promise(function (resolve) {
      if (voterIdMap[encodedId]) return resolve(voterIdMap[encodedId]);
      let tries = 0;
      const iv = setInterval(function () {
        tries++;
        if (session !== voterSession) { clearInterval(iv); resolve(null); } // Popup geschlossen
        else if (voterIdMap[encodedId]) { clearInterval(iv); resolve(voterIdMap[encodedId]); }
        else if (tries >= 20) { clearInterval(iv); resolve(null); } // ~5s
      }, 250);
    });
  }

  // Fetch one ratinglog "page". When `cursor` is null we hit the initial
  // endpoint (returns the wrapper + first entries + next cursor); otherwise we
  // hit the pagination endpoint (returns bare <li> entries).
  async function fetchRatingLogPage(numericId, cursor) {
    let url;
    if (cursor == null) {
      url = RATINGLOG_BASE + '/ratinglog?id=' + encodeURIComponent(numericId) + '&idType=1';
    } else {
      url = RATINGLOG_BASE + '/RatingLog?id=' + encodeURIComponent(numericId) +
            '&idType=Posting&LatestRaterCommunityIdentityId=' + encodeURIComponent(cursor);
    }
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'omit'
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  }

  // Parse a ratinglog HTML fragment into structured data.
  // Returns { totals:{pos,neg}|null, entries:[{name,rate,profile,cid}], nextCursor }
  function parseRatingLog(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    let totals = null;
    const wrapper = doc.querySelector('.js-ratings-log, .ratings-log');
    if (wrapper && wrapper.hasAttribute('data-totalpositive')) {
      totals = {
        pos: parseInt(wrapper.getAttribute('data-totalpositive'), 10) || 0,
        neg: parseInt(wrapper.getAttribute('data-totalnegative'), 10) || 0
      };
    }

    const entries = [];
    let lastCid = null;
    const items = doc.querySelectorAll('li[data-rate]');
    items.forEach(function (li) {
      const rate = li.getAttribute('data-rate'); // "positive" | "negative"
      const link = li.querySelector('a.ratings-log-communityname, a[href*="/userprofil/"]');
      const nameEl = link ? (link.querySelector('span') || link) : null;
      const name = nameEl ? (nameEl.textContent || '').trim() : '';
      const profile = link ? link.getAttribute('href') : null;
      let cid = null;
      const followBtn = li.querySelector('[data-communityidentityid]');
      if (followBtn) cid = followBtn.getAttribute('data-communityidentityid');
      else if (profile) { const m = profile.match(/\/(\d+)(?:\D*)$/); if (m) cid = m[1]; }
      if (name && (rate === 'positive' || rate === 'negative')) {
        entries.push({ name: name, rate: rate, profile: profile, cid: cid });
      }
      if (cid) lastCid = cid;
    });

    // Pagination cursor: prefer the hidden input from the initial response,
    // otherwise fall back to the last entry's community-identity id.
    let nextCursor = null;
    const hidden = doc.querySelector('input[name="LatestRaterCommunityIdentityId"]');
    if (hidden && hidden.value && /^\d+$/.test(hidden.value)) nextCursor = hidden.value;
    else if (lastCid) nextCursor = lastCid;

    return { totals: totals, entries: entries, nextCursor: nextCursor };
  }

  // ── Popup rendering ───────────────────────────────────────────────────
  function closeVoterPopup(shadowRoot) {
    voterSession++; // laufende Ladevorgaenge abbrechen
    const ov = shadowRoot.querySelector('#dst-voter-overlay');
    if (ov) ov.remove();
  }

  function buildVoterPopupSkeleton(shadowRoot, posCount, negCount) {
    closeVoterPopup(shadowRoot);

    const overlay = document.createElement('div');
    overlay.id = 'dst-voter-overlay';

    const card = document.createElement('div');
    card.id = 'dst-voter-card';

    // v2.0.0: the central "Bewertungen ▲ ▼" heading is gone; each column carries
    // its own header with a coloured triangle, the count, and a descriptive label.
    // v3.1.0: a visible "✕" again (besides backdrop click and Escape) — on a
    // phone the card covers nearly the whole screen, little backdrop is left.

    // Body with two columns
    const body = document.createElement('div');
    body.id = 'dst-voter-body';

    function makeColumn(kind, count, labelText) {
      const col = document.createElement('div');
      col.className = 'dst-voter-col';
      const colHead = document.createElement('div');
      colHead.className = 'dst-voter-col-head ' + kind;
      const tri = document.createElement('span');
      tri.className = 'dst-vch-tri';
      tri.textContent = kind === 'pos' ? '\u25B2' : '\u25BC';
      const cnt = document.createElement('span');
      cnt.className = 'dst-vch-count';
      cnt.textContent = count;
      const t = document.createElement('span');
      t.className = 'dst-vch-label';
      t.textContent = labelText;
      colHead.appendChild(tri);
      colHead.appendChild(cnt);
      colHead.appendChild(t);
      const ul = document.createElement('ul');
      ul.className = 'dst-voter-list';
      ul.setAttribute('data-kind', kind);
      col.appendChild(colHead);
      col.appendChild(ul);
      return { col: col, ul: ul };
    }
    const posCol = makeColumn('pos', posCount, 'Positive Bewertungen');
    const negCol = makeColumn('neg', negCount, 'Negative Bewertungen');
    body.appendChild(posCol.col);
    body.appendChild(negCol.col);

    // Footer
    const foot = document.createElement('div');
    foot.id = 'dst-voter-foot';

    const closeBtn = document.createElement('button');
    closeBtn.id = 'dst-voter-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Schließen');
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', function () { closeVoterPopup(shadowRoot); });

    card.appendChild(body);
    card.appendChild(foot);
    card.appendChild(closeBtn);
    overlay.appendChild(card);

    // Close on backdrop click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeVoterPopup(shadowRoot);
    });

    // Close on Escape (bound once)
    if (!voterEscBound) {
      voterEscBound = true;
      // v2.4.10: shadowRoot erst beim Tastendruck ermitteln (vorher wurde das
      // erste shadowRoot dauerhaft festgehalten).
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        const f = document.querySelector('dst-forum');
        if (f && f.shadowRoot && f.shadowRoot.querySelector('#dst-voter-overlay')) {
          closeVoterPopup(f.shadowRoot);
        }
      });
    }

    shadowRoot.appendChild(overlay);
    return { overlay: overlay, posUl: posCol.ul, negUl: negCol.ul, foot: foot };
  }

  function appendVoterEntries(ul, entries) {
    entries.forEach(function (en) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.textContent = en.name;
      a.title = en.name;
      if (en.profile) {
        a.href = en.profile;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      } else {
        a.href = '#';
        a.addEventListener('click', function (e) { e.preventDefault(); });
      }
      a.addEventListener('click', function (e) { e.stopPropagation(); });
      li.appendChild(a);
      ul.appendChild(li);
    });
  }

  async function openVoterPopup(shadowRoot, encodedId, posCount, negCount) {
    const refs = buildVoterPopupSkeleton(shadowRoot, posCount, negCount);
    // Erst NACH dem Skeleton lesen: buildVoterPopupSkeleton ruft intern
    // closeVoterPopup auf und erhoeht dabei den Zaehler.
    const session = voterSession;
    const isStale = function () { return session !== voterSession || !refs.overlay.isConnected; };

    // Initial loading state inside the body
    const loading = document.createElement('div');
    loading.className = 'dst-voter-loading';
    const spin = document.createElement('div');
    spin.className = 'dst-voter-spinner';
    const ltxt = document.createElement('div');
    ltxt.textContent = 'Bewertungen werden geladen \u2026';
    loading.appendChild(spin);
    loading.appendChild(ltxt);
    const body = refs.overlay.querySelector('#dst-voter-body');
    body.style.display = 'none';
    body.parentElement.insertBefore(loading, body);

    function showError(message) {
      const card = refs.overlay.querySelector('#dst-voter-card');
      if (loading.parentElement) loading.remove();
      body.style.display = 'none';
      let err = card.querySelector('.dst-voter-error');
      if (!err) {
        err = document.createElement('div');
        err.className = 'dst-voter-error';
        card.insertBefore(err, refs.foot);
      }
      err.textContent = message;
    }

    // Resolve numeric id
    const numericId = await resolveNumericPostingId(encodedId, session);
    if (isStale()) return;
    if (!numericId) {
      showError('Bewertungsdaten konnten nicht geladen werden (Posting-ID nicht gefunden). Bitte Seite neu laden und erneut versuchen.');
      return;
    }

    // State for pagination
    let cursor = null;
    let done = false;
    let totalPos = parseInt(posCount, 10) || 0;
    let totalNeg = parseInt(negCount, 10) || 0;
    let loadedPos = 0;
    let loadedNeg = 0;
    let bodyShown = false;

    // v2.0.3: the ratinglog endpoint returns ALL raters interleaved by recency
    // (positive + negative mixed). Because positive raters usually far outnumber
    // negative ones, the first page is almost all positives and the negative
    // column would stay empty until the user clicked "Mehr laden" several times.
    // We now auto-load EVERY page so both columns fill completely on their own —
    // no "Mehr laden" button anymore.
    const MAX_PAGES = 400;       // safety cap against infinite loops
    const PAGE_DELAY_MS = 120;   // be polite to the server between requests

    // v2.0.4: the footer shows the same green progress bar derStandard's forum
    // uses while loading postings (grey track + green gradient fill + pulse +
    // centred text overlay), instead of the small circular spinner.
    function ensureProgressBar() {
      let bar = refs.foot.querySelector('#dst-voter-progress');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'dst-voter-progress';
        bar.className = 'dst-voter-progress';
        const fill = document.createElement('div');
        fill.className = 'dst-voter-progress-fill';
        const txt = document.createElement('span');
        txt.className = 'dst-voter-progress-text';
        bar.appendChild(fill);
        bar.appendChild(txt);
        refs.foot.appendChild(bar);
      }
      return {
        bar: bar,
        fill: bar.querySelector('.dst-voter-progress-fill'),
        txt: bar.querySelector('.dst-voter-progress-text')
      };
    }

    function updateStatus() {
      const pb = ensureProgressBar();
      const total = totalPos + totalNeg;
      const loaded = loadedPos + loadedNeg;
      if (done) {
        pb.fill.style.width = '100%';
        pb.fill.classList.remove('dst-voter-progress-fill--loading');
        pb.bar.classList.add('dst-voter-progress--done');
        pb.txt.textContent = loaded + ' Bewertungen geladen';
      } else {
        const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        pb.fill.style.width = pct + '%';
        pb.fill.classList.add('dst-voter-progress-fill--loading');
        pb.txt.textContent = 'L\u00E4dt \u2026 ' + loaded + ' von ' + total + ' geladen';
      }
    }

    function revealBodyOnce() {
      if (bodyShown) return;
      if (loading.parentElement) loading.remove();
      body.style.display = 'flex';
      bodyShown = true;
    }

    // Auto-load every page until there is nothing left to fetch.
    async function loadAllPages() {
      let guard = 0;
      updateStatus(); // show the progress bar immediately (0 %)
      while (!done && guard < MAX_PAGES) {
        if (isStale()) return;
        guard++;
        let html;
        try {
          html = await fetchRatingLogPage(numericId, cursor);
        } catch (err) {
          if (isStale()) return;
          if (loadedPos + loadedNeg === 0) {
            showError('Fehler beim Laden der Bewertungsdaten: ' + err.message);
            return;
          }
          // We already have some data — stop gracefully and report partial state.
          done = true;
          const pb = ensureProgressBar();
          pb.fill.style.width = '100%';
          pb.fill.classList.remove('dst-voter-progress-fill--loading');
          pb.bar.classList.add('dst-voter-progress--done');
          pb.txt.textContent = (loadedPos + loadedNeg) + ' geladen \u2013 weitere Daten konnten nicht geladen werden.';
          break;
        }

        if (isStale()) return;
        const parsed = parseRatingLog(html);
        if (parsed.totals) { totalPos = parsed.totals.pos; totalNeg = parsed.totals.neg; }

        // Reveal the columns as soon as the first page arrives.
        revealBodyOnce();

        const posEntries = parsed.entries.filter(function (e) { return e.rate === 'positive'; });
        const negEntries = parsed.entries.filter(function (e) { return e.rate === 'negative'; });
        appendVoterEntries(refs.posUl, posEntries);
        appendVoterEntries(refs.negUl, negEntries);
        loadedPos += posEntries.length;
        loadedNeg += negEntries.length;

        // Stop when there are no new entries or the cursor stops advancing.
        if (parsed.entries.length === 0 || !parsed.nextCursor || parsed.nextCursor === cursor) {
          done = true;
        } else {
          cursor = parsed.nextCursor;
        }

        updateStatus();

        if (!done) {
          await new Promise(function (r) { setTimeout(r, PAGE_DELAY_MS); });
        }
      }

      // Reached the safety cap without a natural end.
      if (!done) done = true;

      revealBodyOnce();
      // v2.0.5: no "Keine … Bewertungen" placeholder — an empty column simply
      // stays empty.
      updateStatus();
    }

    await loadAllPages();
  }

  // Delegated, capturing click handler — beats derStandard's own paywall
  // handler so clicking the rating numbers opens our popup instead.
  function handleRatingClick(e) {
    if (!sortEnabled) return;
    const path = e.composedPath ? e.composedPath() : [];
    let ratingEl = null;
    for (let i = 0; i < path.length; i++) {
      const node = path[i];
      if (node && node.tagName === 'DST-POSTING--RATINGLOG') { ratingEl = node; break; }
    }
    if (!ratingEl) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const forum = document.querySelector('dst-forum');
    const shadowRoot = forum && forum.shadowRoot;
    if (!shadowRoot) return;

    const encodedId = ratingEl.getAttribute('postingid');
    const pos = ratingEl.getAttribute('positiveratings') || '0';
    const neg = ratingEl.getAttribute('negativeratings') || '0';
    if (!encodedId) return;

    openVoterPopup(shadowRoot, encodedId, pos, neg);
  }

  function attachVoterListener(shadowRoot) {
    if (voterListenerAttached) return;
    voterListenerAttached = true;
    // Capture on document: fires before any of the page's own click handlers,
    // including the "STANDARD Smart" paywall trigger inside the rating element.
    document.addEventListener('click', handleRatingClick, true);
    // Mark rating elements as votable for the hover style hint.
    try {
      shadowRoot.querySelectorAll('dst-posting--ratinglog').forEach(function (el) {
        el.classList.add('dst-votable');
      });
    } catch (e) { /* ignore */ }
  }

  // ── Utility: read ratings from a posting ───────────────────────
  // v2.4.10: Frischere Bewertungen einer Duplikat-Kopie werden nur noch INTERN
  // gemerkt (WeakMap) statt in die Attribute der nativen Web-Component zu
  // schreiben. Das Ueberschreiben der Attribute konnte Lit beim naechsten
  // Update durcheinanderbringen und die angezeigten Zahlen verfaelschen.
  const ratingOverrides = new WeakMap();

  function readRatings(posting) {
    const ratingEl = posting.querySelector('dst-posting--ratinglog');
    const pos = ratingEl ? (parseInt(ratingEl.getAttribute('positiveratings'), 10) || 0) : 0;
    const neg = ratingEl ? (parseInt(ratingEl.getAttribute('negativeratings'), 10) || 0) : 0;
    const ov = ratingOverrides.get(posting);
    if (ov && ov.pos + ov.neg > pos + neg) return ov;
    return { pos: pos, neg: neg };
  }

  function getPositiveRatings(posting) {
    return readRatings(posting).pos;
  }

  function getNegativeRatings(posting) {
    return readRatings(posting).neg;
  }

  function getNetRatings(posting) {
    return getPositiveRatings(posting) - getNegativeRatings(posting);
  }

  // ── Parse relative time strings like "vor 5 Stunden" ──────────
  function parseRelativeTime(text) {
    if (!text) return 0;
    const now = Date.now();
    // Match patterns like "vor 5 Stunden", "vor 2 Tagen", "vor 30 Minuten", "vor 1 Monat"
    const match = text.match(/vor\s+(\d+)\s+(Sekunde|Minute|Stunde|Tag|Woche|Monat|Jahr)n?/i);
    if (!match) return 0;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith('sekunde')) ms = value * 1000;
    else if (unit.startsWith('minute')) ms = value * 60 * 1000;
    else if (unit.startsWith('stunde')) ms = value * 60 * 60 * 1000;
    else if (unit.startsWith('tag')) ms = value * 24 * 60 * 60 * 1000;
    else if (unit.startsWith('woche')) ms = value * 7 * 24 * 60 * 60 * 1000;
    else if (unit.startsWith('monat')) ms = value * 30 * 24 * 60 * 60 * 1000;
    else if (unit.startsWith('jahr')) ms = value * 365 * 24 * 60 * 60 * 1000;
    return ms > 0 ? (now - ms) : 0;
  }

  // ── Extract timestamp from a posting for chronological sort ────
  function getPostingTimestamp(posting) {
    // Strategy 1: <time datetime="..."> with a valid ISO date
    let timeEl = posting.querySelector('time[datetime]');
    if (timeEl) {
      const dtAttr = timeEl.getAttribute('datetime');
      if (dtAttr && dtAttr !== 'null' && dtAttr !== 'undefined') {
        const parsed = new Date(dtAttr).getTime();
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
      // Strategy 1b: Parse relative time from <time> textContent
      const relTime = parseRelativeTime(timeEl.textContent);
      if (relTime > 0) return relTime;
    }

    // Strategy 2: Check shadow DOM of the posting
    if (posting.shadowRoot) {
      timeEl = posting.shadowRoot.querySelector('time[datetime]');
      if (timeEl) {
        const dtAttr = timeEl.getAttribute('datetime');
        if (dtAttr && dtAttr !== 'null' && dtAttr !== 'undefined') {
          const parsed = new Date(dtAttr).getTime();
          if (!isNaN(parsed) && parsed > 0) return parsed;
        }
        const relTime = parseRelativeTime(timeEl.textContent);
        if (relTime > 0) return relTime;
      }
    }

    // Strategy 3: Check sub-elements like dst-posting-head
    const headEl = posting.querySelector('dst-posting-head');
    if (headEl) {
      timeEl = headEl.querySelector('time');
      if (!timeEl && headEl.shadowRoot) {
        timeEl = headEl.shadowRoot.querySelector('time');
      }
      if (timeEl) {
        const dtAttr = timeEl.getAttribute('datetime');
        if (dtAttr && dtAttr !== 'null' && dtAttr !== 'undefined') {
          const parsed = new Date(dtAttr).getTime();
          if (!isNaN(parsed) && parsed > 0) return parsed;
        }
        const relTime = parseRelativeTime(timeEl.textContent);
        if (relTime > 0) return relTime;
      }
    }

    // Strategy 4: Find any <span> with relative time text
    const spans = posting.querySelectorAll('span');
    for (const span of spans) {
      if (span.children.length === 0) {
        const relTime = parseRelativeTime(span.textContent);
        if (relTime > 0) return relTime;
      }
    }

    // Strategy 5: data-created or data-timestamp attribute
    const ts = posting.getAttribute('data-created') ||
               posting.getAttribute('data-timestamp') ||
               posting.getAttribute('datetime') ||
               posting.getAttribute('data-date');
    if (ts) {
      const parsed = new Date(ts).getTime();
      if (!isNaN(parsed)) return parsed;
    }

    // Fallback: use DOM position (index) to preserve original order
    return 0;
  }

  // ── Build a signature of current ratings to detect changes ─────
  function buildSortSignature(groups) {
    return groups
      .map((g) => {
        const p = getPositiveRatings(g.posting);
        const n = getNegativeRatings(g.posting);
        return `${p}:${n}`;
      })
      .join(',');
  }

  // ── Detect if a posting is pinned ("angeheftet") ─────────────────
  function isPinnedPosting(posting) {
    if (posting.hasAttribute('pinned')) return true;
    if (posting.hasAttribute('data-pinned')) return true;
    if (posting.getAttribute('ispinned') === 'true') return true;
    if (posting.getAttribute('is-pinned') === 'true') return true;

    const classList = posting.className || '';
    if (/\bpinned\b/i.test(classList) || /\bis-pinned\b/i.test(classList) ||
        /\bposting--pinned\b/i.test(classList)) return true;

    const shadowRoot = posting.shadowRoot;
    if (shadowRoot) {
      const allText = shadowRoot.textContent || ''; // read-only, textContent statt innerHTML
      if (/angeheftet|📌/i.test(allText)) {
        const allElements = shadowRoot.querySelectorAll('*');
        for (const el of allElements) {
          for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
              const text = node.textContent?.trim().toLowerCase() || '';
              if (text === 'angeheftet' || text === 'pinned' || text === '📌' ||
                  text === '📌 angeheftet') {
                log('[DST Sorter] Pinned detected via shadow DOM text: "' + text + '"');
                return true;
              }
            }
          }
        }
      }

      const pinElements = shadowRoot.querySelectorAll(
        '.pinned, .is-pinned, .posting--pinned, .angeheftet, ' +
        '[class~="pinned"], [class~="is-pinned"], [class~="angeheftet"], [class~="sticky"]'
      );
      if (pinElements.length > 0) {
        log('[DST Sorter] Pinned detected via shadow DOM class');
        return true;
      }
    }

    const lightPinElements = posting.querySelectorAll(
      '.pinned, .is-pinned, .posting--pinned, .angeheftet, ' +
      '[class~="pinned"], [class~="is-pinned"], [class~="angeheftet"]'
    );
    if (lightPinElements.length > 0) return true;

    for (const child of posting.children) {
      const text = child.textContent?.trim().toLowerCase() || '';
      if (text === 'angeheftet' || text === 'pinned') return true;
    }

    const headerEl = posting.querySelector('dst-posting-head');
    if (headerEl) {
      const headerText = headerEl.textContent || '';
      if (/\bAngeheftet\b/i.test(headerText)) {
        log('[DST Sorter] Pinned detected via header text "Angeheftet"');
        return true;
      }
    }

    // v2.4.10: Nur noch Elemente, deren Text EXAKT dem Pinned-Label entspricht
    // und die nicht im eigentlichen Posting-Text liegen. Vorher reichte ein
    // <span>, der mit "Angeheftet" oder 📌 BEGANN, bzw. "📌 Angeheftet" in den
    // ersten 300 Zeichen des gesamten Postings – auch im Text des Nutzers.
    // Dadurch landeten normale Postings faelschlich ganz oben.
    const strongEls = posting.querySelectorAll('strong, b, span');
    for (const el of strongEls) {
      if (el.closest('p, blockquote, li')) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (text === 'angeheftet' || text === '📌' || text === '📌 angeheftet') {
        log('[DST Sorter] Pinned detected via <' + el.tagName + '> label');
        return true;
      }
    }

    return false;
  }

  // ── Get posting ID for deduplication ───────────────────────────
  function getPostingId(posting) {
    // 1) Direct attributes on the <dst-posting> element (rarely present in 2026 DOM)
    const directId = posting.getAttribute('data-posting-id') ||
           posting.getAttribute('data-postingid') ||
           posting.getAttribute('data-id') ||
           posting.getAttribute('id') ||
           posting.getAttribute('postingid') ||
           posting.getAttribute('posting-id') ||
           null;
    if (directId) return directId;

    // 2) STABLE encoded posting ID nested inside the posting (v2.1.1).
    //    derStandard does NOT put an id on the <dst-posting> element itself, but
    //    every posting embeds its encoded id (e.g. "3FO5eHTfBXdAobg1YdEqB6a3jUu")
    //    on child elements such as <dst-posting--ratinglog postingid="…"> and the
    //    flyout trigger buttons (id="flyout-trigger-identity-…"). This id is
    //    IDENTICAL for the pinned ("angeheftet") copy and its in-list twin, so it
    //    is the reliable key for de-duplicating pinned postings — even when the
    //    two copies momentarily show different (stale) rating counts.
    const stableId = getStablePostingId(posting);
    if (stableId) return stableId;

    // Deleted postings carry no id at all, and the fallback below gives every
    // one of them the same key ("Posting von gelöschtem Profil|0:0"). They were
    // all hidden as "duplicates" of the first one — together with their replies.
    if (posting.classList.contains('posting-deleted')) return null;

    // 3) Last-resort fallback: author + rating counts. Unreliable (ratings can be
    //    stale between the two copies), kept only for postings that somehow lack
    //    the nested encoded id.
    const ariaLabel = posting.getAttribute('aria-label') || '';
    if (ariaLabel) {
      const ratingEl = posting.querySelector('dst-posting--ratinglog');
      const pos = ratingEl ? (ratingEl.getAttribute('positiveratings') || '0') : '0';
      const neg = ratingEl ? (ratingEl.getAttribute('negativeratings') || '0') : '0';
      return ariaLabel + '|' + pos + ':' + neg;
    }

    return null;
  }

  // ── Extract the stable encoded posting ID from nested child elements ──────
  // Returns a string like "3FO5eHTfBXdAobg1YdEqB6a3jUu" or null. We deliberately
  // read it from the posting's OWN header elements (ratinglog / flyout buttons),
  // which are part of the dst-posting itself — reply postings live in separate
  // sibling <section.thread> nodes, so querySelector here won't pick them up.
  function getStablePostingId(posting) {
    // a) <dst-posting--ratinglog postingid="…"> — most direct source
    const ratingEl = posting.querySelector('dst-posting--ratinglog[postingid]');
    if (ratingEl) {
      const pid = ratingEl.getAttribute('postingid');
      if (pid) return pid;
    }
    // b) ratinglog element with id="ratinglog-<encodedId>"
    const ratingById = posting.querySelector('[id^="ratinglog-"]');
    if (ratingById) {
      const v = ratingById.getAttribute('id').replace(/^ratinglog-/, '');
      if (v) return v;
    }
    // c) flyout trigger buttons: id="flyout-trigger-identity-<encodedId>" etc.
    const flyout = posting.querySelector('[id^="flyout-trigger-"]');
    if (flyout) {
      const v = flyout.getAttribute('id').replace(/^flyout-trigger-[a-z]+-/i, '');
      if (v) return v;
    }
    return null;
  }

  // ── Detect if an element is the posting input form / reply box ────
  function isInputFormElement(el) {
    const tag = el.tagName?.toUpperCase() || '';

    // Check tag name for form-like custom elements
    if (/FORM|EDITOR|COMPOSE|POSTFORM|POSTING-FORM|REPLY-FORM|COMMENT-FORM/.test(tag)) return true;

    // Check if element contains <textarea>, <input type="text">, or contenteditable
    if (el.querySelector && (
      el.querySelector('textarea') ||
      el.querySelector('input[type="text"]') ||
      el.querySelector('[contenteditable="true"]')
    )) return true;

    // Check for button with "Posten"/"Absenden"/"Senden" text inside the element
    if (el.querySelector) {
      const buttons = el.querySelectorAll('button');
      for (const btn of buttons) {
        const txt = btn.textContent?.trim().toLowerCase() || '';
        if (txt === 'posten' || txt === 'absenden' || txt === 'senden' || txt === 'antworten') return true;
      }
    }

    // Check for specific CSS classes
    const cls = el.className || '';
    if (/\bposting-form\b|\bcomment-form\b|\breply-form\b|\bforum--form\b|\bforum--compose\b|\bforum--editor\b/i.test(cls)) return true;

    // Check shadow DOM for form elements
    if (el.shadowRoot) {
      if (el.shadowRoot.querySelector('textarea') ||
          el.shadowRoot.querySelector('input[type="text"]') ||
          el.shadowRoot.querySelector('[contenteditable="true"]')) return true;
      const shadowButtons = el.shadowRoot.querySelectorAll('button');
      for (const btn of shadowButtons) {
        const txt = btn.textContent?.trim().toLowerCase() || '';
        if (txt === 'posten' || txt === 'absenden' || txt === 'senden') return true;
      }
    }

    // Check if element has text "Titel" + "Kommentar" pattern (the derstandard.at input form)
    const text = el.textContent || '';
    if (/Titel/i.test(text) && /Kommentar/i.test(text) && /Posten/i.test(text)) return true;

    return false;
  }

  // ── Determine if a direct child of main is a root posting ────────────
  // On derstandard.at, the DOM inside main.forum--main looks like:
  //   DST-POSTING-BOX       → comment form
  //   SECTION.thread        → reply thread container (data-level=1 postings inside)
  //   DST-POSTING[level=0]  → root posting (SORTABLE)
  //   SLOT                  → ad container between postings
  //
  // The key visual indicator (as described by users):
  //   - Reply postings sit inside SECTION.thread elements with a grey left border
  //   - Root postings are DST-POSTING[data-level="0"] direct children of main
  //   - The "grey triangle" is the SECTION's border-left visual indicator
  function isRootPosting(el) {
    const tag = el.tagName?.toUpperCase();
    if (tag !== 'DST-POSTING') return false;

    // Primary check: data-level attribute
    const level = el.getAttribute('data-level');
    if (level === '0') return true;

    // If no data-level but it's a direct child of main (not inside a section.thread),
    // treat as root posting
    if (level === null || level === undefined) {
      const parent = el.parentElement;
      if (parent && parent.tagName?.toUpperCase() === 'MAIN') {
        log('[DST Sorter] DST-POSTING without data-level, direct child of main — treating as root');
        return true;
      }
    }

    return false;
  }

  // ── Determine if a direct child of main is a reply thread section ──
  function isReplyThreadSection(el) {
    const tag = el.tagName?.toUpperCase();
    if (tag !== 'SECTION') return false;

    // Check for thread-related CSS classes
    const cls = (el.className || '').toLowerCase();
    return cls.includes('thread');
  }

  // ── Transfer rating data from one posting to another ──────────────
  // Used to sync ratings from a duplicate (stale pinned copy) to the
  // canonical posting, ensuring sorting uses the most current numbers.
  function transferRatingsIfNewer(fromPosting, toPosting) {
    const from = readRatings(fromPosting);
    const to = readRatings(toPosting);
    // If 'from' has more total ratings, it's likely the newer/fresher copy
    if (from.pos + from.neg > to.pos + to.neg) {
      ratingOverrides.set(toPosting, { pos: from.pos, neg: from.neg });
      log('[DST Sorter] Using fresher ratings: +' + from.pos + '/-' + from.neg +
          ' (was +' + to.pos + '/-' + to.neg + ')');
      return true;
    }
    return false;
  }

  // ── Collect posting "groups" for sorting ───────────────────────────
  // ARCHITECTURE (based on live DOM analysis of derstandard.at 2026):
  //
  //   main.forum--main children (original order):
  //     [0]  DST-POSTING-BOX          → comment form (keep separate)
  //     [1]  DST-POSTING[lv=0]        → root posting #1 (SORTABLE)
  //     [2]  SECTION.thread           → reply thread for posting #1 (SIBLING)
  //     [3]  SLOT                     → ad container (SIBLING)
  //     [4]  DST-POSTING[lv=0]        → root posting #2 (SORTABLE)
  //     [5]  SLOT                     → ad container (SIBLING)
  //     ...
  //
  // Each posting "group" = the DST-POSTING element + its trailing siblings
  // (SECTION.thread + SLOT). SECTION.thread elements MUST move with their
  // parent posting to preserve the expand/collapse ("Antworten") functionality.
  // Only DST-POSTING[data-level="0"] direct children of main are sortable.
  function collectPostingGroups(main) {
    const groups = [];
    const formElements = [];
    let current = null;
    const seenPostingIds = new Map();
    let skippedSections = 0;
    let skippedSlots = 0;

    for (const child of Array.from(main.children)) {
      const tag = child.tagName?.toUpperCase();

      // ── Case 1: SECTION.thread → Reply thread container ──
      // These sections contain level-1 reply postings (the replies).
      // They MUST move together with their parent root posting during sorting,
      // otherwise the expand/collapse ("Antworten") functionality breaks.
      // We attach them as siblings of the preceding posting group.
      if (isReplyThreadSection(child)) {
        if (current) {
          current.siblings.push(child);
        }
        skippedSections++;
        continue;
      }

      // ── Case 2: DST-POSTING[data-level="0"] → Root posting → NEW sortable group ──
      // IMPORTANT: Check this BEFORE isInputFormElement, because root postings
      // contain "Antworten" buttons that would falsely match the form heuristic.
      if (isRootPosting(child)) {
        const pinned = isPinnedPosting(child);
        const postingId = getPostingId(child);

        let isDuplicate = false;
        if (postingId) {
          if (seenPostingIds.has(postingId)) {
            isDuplicate = true;
            const firstGroup = seenPostingIds.get(postingId);
            
            // Transfer fresher ratings from duplicate to the canonical posting
            if (firstGroup) {
              transferRatingsIfNewer(child, firstGroup.posting);
            }
            
            if (firstGroup && firstGroup.pinned) {
              log('[DST Sorter] Duplicate of pinned posting detected (ID: ' + postingId + ')');
            } else if (pinned) {
              if (firstGroup) firstGroup.pinned = true;
              log('[DST Sorter] Duplicate posting, second is pinned (ID: ' + postingId + ')');
            } else {
              log('[DST Sorter] Duplicate posting detected (ID: ' + postingId + ')');
            }
          }
        }

        current = {
          posting: child,
          siblings: [],
          pinned: pinned,
          isDuplicate: isDuplicate,
          // "Posting durch Poster:in gelöscht." without replies: nothing to read,
          // so it is hidden. With replies it stays, as the replies hang off it.
          isDeletedAlone: child.classList.contains('posting-deleted') &&
            !child.classList.contains('posting-with-thread'),
          postingId: postingId,
          domIndex: groups.length
        };
        groups.push(current);

        if (postingId && !isDuplicate) {
          seenPostingIds.set(postingId, current);
        }

        if (pinned) {
          log('[DST Sorter] Pinned posting (ID: ' + (postingId || '?') + ')');
        }

        continue;
      }

      // ── Case 3: DST-POSTING-BOX or input form → comment form → keep separate ──
      if (tag === 'DST-POSTING-BOX' || isInputFormElement(child)) {
        formElements.push(child);
        continue;
      }

      // ── Case 4: SLOT (ad container) or any other element → attach to current group ──
      if (tag === 'SLOT') skippedSlots++;
      if (current) {
        current.siblings.push(child);
      }
    }

    log('[DST Sorter] Collected ' + groups.length + ' root posting groups' +
      ' (skipped ' + skippedSections + ' reply thread sections, ' + skippedSlots + ' ad slots attached)');

    return { groups, formElements };
  }

  // ── v1.9.19 Fix 1 + Fix 2: keep reply threads collapsed by default ──
  // The forum's gear menu ("Zahnrad") has an "Antworten ausgeklappt" toggle.
  // When the user explicitly turns it ON, derStandard stores
  //   "<userId>_prefers-threads": "expanded"
  // in localStorage["user-settings"]. We HONOR that choice: if the user wants
  // threads expanded we never collapse them — that makes the native gear
  // setting work again instead of being silently overridden by the extension.
  function userPrefersExpandedThreads() {
    try {
      const raw = localStorage.getItem('user-settings');
      if (!raw) return false;
      const settings = JSON.parse(raw);
      for (const key in settings) {
        if (key.indexOf('_prefers-threads') !== -1 && settings[key] === 'expanded') {
          return true;
        }
      }
    } catch (e) { /* ignore malformed settings */ }
    return false;
  }

  // Collapse every reply thread that derStandard rendered as expanded, so that
  // replies are hidden until the user clicks the native "Antworten" toggle.
  // We click the real native control (button.answers) so derStandard's own
  // expand/collapse state stays in sync and the original forum functionality
  // (re-expanding on click) keeps working perfectly.
  function collapseReplyThreads(main) {
    if (!main) return;
    if (userPrefersExpandedThreads()) return; // respect the gear's "Antworten ausgeklappt"

    const expanded = main.querySelectorAll('dst-posting.posting-has-thread-expanded');
    let collapsedCount = 0;

    // v1.9.20 — Fix 1: treat pinned ("angeheftete") postings exactly like normal
    // ones. derStandard renders a pinned posting TWICE (two DOM nodes that share
    // the same postingId). The collapse/expand state is keyed by postingId, so if
    // we click the native toggle on BOTH copies the two toggles cancel out and the
    // thread snaps back to expanded — which is why the setting previously only
    // worked for normal (non-duplicated) postings. We therefore toggle each
    // logical posting at most ONCE per postingId.
    const processedIds = new Set();

    expanded.forEach((posting) => {
      // Only auto-collapse a given posting ONCE — never re-collapse a thread the
      // user has deliberately re-opened after our initial collapse.
      if (autoCollapsedPostings.has(posting)) return;

      // Second DOM copy of a pinned posting we already collapsed: do NOT click
      // again (that would re-expand it). Just remember the node and move on.
      const pid = getPostingId(posting);
      if (pid) {
        if (processedIds.has(pid)) {
          autoCollapsedPostings.add(posting);
          return;
        }
        processedIds.add(pid);
      }

      const toggle = posting.querySelector('button.answers');
      if (!toggle) return;

      // The native toggle marks the posting "is-active-posting" (focus highlight).
      // Remove that purely-visual side-effect if we added it, so the page doesn't
      // look like dozens of postings are selected after a bulk collapse.
      const hadActive = posting.classList.contains('is-active-posting');
      toggle.click();
      if (!hadActive) posting.classList.remove('is-active-posting');

      autoCollapsedPostings.add(posting);
      collapsedCount++;
    });

    if (collapsedCount > 0) {
      log('[DST Sorter] Collapsed ' + collapsedCount +
        ' reply thread(s) — pinned & normal treated equally (v1.9.20)');
    }
  }

  // v1.9.20 — Fix 1 (expand side): when the user enabled "Antworten ausgeklappt"
  // in the gear, derStandard expands NORMAL postings but leaves angeheftete
  // (pinned) postings collapsed. We expand those pinned postings ourselves so the
  // setting works for BOTH posting types. Normal postings are left untouched —
  // derStandard already expands them, and forcing them would override threads the
  // user collapsed by hand.
  function expandPinnedThreads(main) {
    if (!main) return;
    if (!userPrefersExpandedThreads()) return; // only when the gear wants expanded

    const candidates = main.querySelectorAll('dst-posting.posting-with-thread');
    let expandedCount = 0;
    const processedIds = new Set();

    candidates.forEach((posting) => {
      // already expanded (by derStandard or by us) → nothing to do
      if (posting.classList.contains('posting-has-thread-expanded')) return;
      // only auto-expand once, so the user can re-collapse a pinned thread
      if (autoExpandedPostings.has(posting)) return;
      // only pinned postings — normal ones are already expanded by derStandard
      if (!isPinnedPosting(posting)) return;

      // derStandard renders pinned postings twice (shared postingId); toggle the
      // logical posting only once so the two clicks don't cancel each other out.
      const pid = getPostingId(posting);
      if (pid) {
        if (processedIds.has(pid)) { autoExpandedPostings.add(posting); return; }
        processedIds.add(pid);
      }

      const toggle = posting.querySelector('button.answers');
      if (!toggle) return;

      // The native toggle also marks the posting "is-active-posting" (focus
      // highlight). Remove that purely-visual side-effect if we added it.
      const hadActive = posting.classList.contains('is-active-posting');
      toggle.click(); // expands asynchronously (derStandard fetches the replies)
      if (!hadActive) posting.classList.remove('is-active-posting');

      autoExpandedPostings.add(posting);
      expandedCount++;
    });

    if (expandedCount > 0) {
      log('[DST Sorter] Expanded ' + expandedCount +
        ' pinned reply thread(s) to honor "Antworten ausgeklappt" (v1.9.20)');
    }
  }

  // ── Sort keys: computed ONCE per group before sorting (v2.4.10) ──
  // Previously every single comparison re-ran several DOM queries (and in the
  // Timeline modes a scan over all <span>s of a posting). With 1000 postings
  // that is ~20,000 comparisons -> noticeable main-thread jank while reading.
  function computeSortKey(group) {
    const r = readRatings(group.posting);
    const needsTime = sortMode.indexOf('chronological') === 0;
    return {
      pos: r.pos,
      neg: r.neg,
      net: r.pos - r.neg,
      time: needsTime ? getPostingTimestamp(group.posting) : 0
    };
  }

  function keyOf(group) {
    if (!group.key) group.key = computeSortKey(group);
    return group.key;
  }

  // ── Sort comparator based on current mode ──────────────────────
  // v2.4.10 – sort definitions:
  //   Balance: Top  -> (positive - negative), highest first
  //   Balance: Low  -> (negative - positive), highest first  (= exact mirror)
  //   Likes:   Top  -> positive ratings only, highest first (negatives ignored)
  //   Likes:   Low  -> negative ratings only, highest first (positives ignored)
  // Ties always fall back to the original forum order (domIndex), so equal
  // scores never get shuffled by an unrelated secondary criterion.
  function sortComparator(a, b) {
    const ka = keyOf(a);
    const kb = keyOf(b);
    let diff = 0;
    switch (sortMode) {
      case 'balance-top':   diff = kb.net - ka.net; break;
      case 'balance-flop':  diff = ka.net - kb.net; break;
      case 'positive-only': diff = kb.pos - ka.pos; break;
      case 'negative-only': diff = kb.neg - ka.neg; break;
      case 'chronological-new': diff = kb.time - ka.time; break;
      case 'chronological':      // legacy alias -> behaves like "Old Timeline"
      case 'chronological-old': diff = ka.time - kb.time; break;
      default: diff = 0;
    }
    if (diff !== 0) return diff;
    return (a.domIndex || 0) - (b.domIndex || 0);
  }

  // ── Check if rating data is available ──────────────────────────
  function hasRatingData(main) {
    const postings = main.querySelectorAll('dst-posting[data-level="0"]');
    if (postings.length === 0) return false;
    // For timeline / no-timeline modes we don't need ratings at all
    if (sortMode.indexOf('chronological') === 0 || sortMode === 'no-timeline') return true;
    let withRatings = 0;
    postings.forEach((p) => {
      if (p.querySelector('dst-posting--ratinglog')) withRatings++;
    });
    return withRatings >= Math.min(3, postings.length) ||
           withRatings >= postings.length * 0.5;
  }

  // ── Sort and reorder ─────────────────────────────────────────
  // ── v1.7.0 CSS-ORDER SORT: No DOM removal/insertion! ──────────
  // Instead of removing elements from the DOM and re-inserting them
  // (which destroys derStandard.at's internal Web Component state,
  // breaking votes, counters, and visual feedback), we use CSS
  // flexbox ordering. The DOM stays completely untouched.
  // ── v2.4.10: keep the reader's visible position stable ─────────────────
  // The browser's scroll anchoring misbehaves with CSS order, so it is
  // suspended during a re-sort (see sortPostings) and we anchor manually:
  // remember where the element the reader is currently looking at sits, apply
  // the change, and scroll by the difference — all in the same task, i.e.
  // before the browser paints, so no jump is visible.
  function captureScrollAnchor(shadowRoot) {
    const main = shadowRoot.querySelector('main.forum--main');
    if (!main) return null;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const rect = main.getBoundingClientRect();
    // Forum still below the viewport (reader is in the article): changes there
    // cannot move anything the reader sees.
    if (rect.top >= vh) return null;
    // Reader is below the forum: keep the forum's bottom edge in place.
    if (rect.bottom <= 0) return { el: main, edge: 'bottom', y: rect.bottom };
    // Badge bar on screen (reader is at the top of the forum, e.g. just clicked
    // a badge): keep the BAR in place. Anchoring the first posting below it
    // made the page follow that posting to its new rank — a jump of several
    // thousand pixels on a badge click. The bar is re-created on every sort,
    // so it is looked up again when restoring.
    const bar = shadowRoot.querySelector('#dst-badge-bar');
    if (bar) {
      const br = bar.getBoundingClientRect();
      if (br.height > 0 && br.bottom > 0 && br.top < vh) {
        return { get: function () { return shadowRoot.querySelector('#dst-badge-bar'); }, edge: 'top', y: br.top };
      }
    }
    // Reader is inside the forum: anchor the topmost visible element.
    let best = null, bestTop = Infinity;
    for (const child of main.children) {
      if (child.id === 'dst-badge-bar') continue; // gets re-created on every sort
      const r = child.getBoundingClientRect();
      if (r.height === 0 || r.bottom <= 0 || r.top >= vh) continue;
      if (r.top < bestTop) { bestTop = r.top; best = child; }
    }
    return best ? { el: best, edge: 'top', y: bestTop } : null;
  }

  function restoreScrollAnchor(anchor) {
    if (!anchor) return;
    const el = anchor.get ? anchor.get() : anchor.el;
    if (!el || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    if (anchor.edge === 'top' && r.height === 0) return; // anchor got hidden
    const now = anchor.edge === 'bottom' ? r.bottom : r.top;
    const delta = now - anchor.y;
    if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
  }

  // The browser's own scroll anchoring would fight the manual correction while
  // CSS order reorders the forum, so it is switched off until the frame after
  // the sort; nested sorts in the same frame are counted.
  let anchoringSuspended = 0;

  function sortPostings(shadowRoot) {
    if (isSorting) return;
    const root = document.documentElement;
    anchoringSuspended++;
    root.style.overflowAnchor = 'none';
    const anchor = captureScrollAnchor(shadowRoot);
    sortPostingsNow(shadowRoot);
    restoreScrollAnchor(anchor);
    // Native collapse/expand clicks re-render via Lit in microtasks; correct
    // once more right before the next frame is painted.
    requestAnimationFrame(function () {
      restoreScrollAnchor(anchor);
      if (--anchoringSuspended === 0) root.style.overflowAnchor = '';
    });
  }

  function sortPostingsNow(shadowRoot) {
    if (isSorting) return;
    isSorting = true;

    if (observer) observer.disconnect();

    try {
      const main = shadowRoot.querySelector('main.forum--main');
      if (!main) return;

      const { groups: allGroups, formElements } = collectPostingGroups(main);
      if (allGroups.length === 0) return;

      // Step 1: Hide duplicate postings. v2.4.10: NOT removed any more — the
      // nodes belong to derStandard's Lit templates, and removing them can break
      // later native re-renders. display:none has the same visual effect.
      // Deleted postings without replies are hidden the same way.
      const isHidden = (g) => g.isDuplicate || g.isDeletedAlone;
      const hiddenGroups = allGroups.filter(isHidden);
      for (const dup of hiddenGroups) {
        dup.posting.style.display = 'none';
        dup.siblings.forEach((sib) => { sib.style.display = 'none'; });
      }

      // Step 2: Separate pinned from regular
      const remainingGroups = allGroups.filter((g) => !isHidden(g));
      // A posting hidden by an earlier sort that no longer qualifies (e.g. a
      // deleted posting that got a reply) becomes visible again.
      for (const g of remainingGroups) {
        if (g.posting.style.display === 'none') g.posting.style.display = '';
        g.siblings.forEach((sib) => {
          if (sib.tagName === 'SECTION' && sib.style.display === 'none') sib.style.display = '';
        });
      }
      const pinnedGroups = remainingGroups.filter((g) => g.pinned);
      const regularGroups = remainingGroups.filter((g) => !g.pinned);

      const allSortable = remainingGroups;
      log('[DST Sorter] CSS-ORDER sorting ' + allSortable.length + ' ROOT postings (' + pinnedGroups.length + ' pinned + ' + regularGroups.length + ' regular, mode: ' + sortMode + ')');

      if (allSortable.length === 0) {
        injectSortBadge(shadowRoot);
        return;
      }

      const sig = buildSortSignature(allSortable);

      // Sort groups
      pinnedGroups.sort(sortComparator);
      regularGroups.sort(sortComparator);

      // Combined order: pinned first, then form elements, then regular
      // We assign CSS order values to EVERY child of main — no exceptions!
      // Elements without an explicit order default to 0 in flexbox, which
      // causes them to cluster at the top and create visual gaps.

      // Enable flexbox on main (only once, idempotent)
      if (!main.style.display || main.style.display !== 'flex') {
        main.style.display = 'flex';
        main.style.flexDirection = 'column';
      }

      // CRITICAL: Hide SLOT elements (ad containers) inside the flex container.
      // Shadow DOM <slot> elements render light DOM content (ads) through the
      // slot mechanism. When flexbox reorders elements via CSS order, the slotted
      // content doesn't follow the flex layout properly, creating huge visual gaps
      // (4000+ px) between postings. Hiding slots eliminates these gaps.
      // The ads are derstandard.at's own ad containers injected between postings.
      for (const child of main.children) {
        if (child.tagName === 'SLOT') {
          child.style.display = 'none';
        }
      }

      // Build a set of all elements we know about (groups + form elements)
      const handledElements = new Set();
      for (const group of [...pinnedGroups, ...regularGroups]) {
        handledElements.add(group.posting);
        group.siblings.forEach((s) => handledElements.add(s));
      }
      formElements.forEach((f) => handledElements.add(f));

      // Collect unhandled children (headers, tab nav, ad slots not attached
      // to any group, injected elements, etc.) preserving their DOM order.
      // We split them into "before first posting" and "after last posting"
      // so headers stay at the top and trailing elements go to the bottom.
      const preElements = [];   // elements before the first known element
      const postElements = [];  // elements after (or between) known elements
      let seenFirstHandled = false;
      for (const child of main.children) {
        if (handledElements.has(child)) {
          seenFirstHandled = true;
          continue;
        }
        // Skip the badge bar — it gets its order separately after injection
        if (child.id === 'dst-badge-bar') {
          preElements.push(child);
          continue;
        }
        if (!seenFirstHandled) {
          preElements.push(child);
        } else {
          postElements.push(child);
        }
      }

      let orderIndex = 0;

      // 1. Pre-elements (headers, tab navigation, etc.) — keep at top
      for (const el of preElements) {
        el.style.order = String(orderIndex++);
      }

      // 2. Pinned postings (appear first among postings)
      for (const group of pinnedGroups) {
        group.posting.style.order = String(orderIndex++);
        for (const sib of group.siblings) {
          sib.style.order = String(orderIndex++);
        }
      }

      // 3. Form elements (comment box) come after pinned
      for (const formEl of formElements) {
        formEl.style.order = String(orderIndex++);
      }

      // 4. Regular postings in sorted order
      for (const group of regularGroups) {
        group.posting.style.order = String(orderIndex++);
        for (const sib of group.siblings) {
          sib.style.order = String(orderIndex++);
        }
      }

      // 5. Post-elements (trailing ads, injected elements) — push to end
      for (const el of postElements) {
        el.style.order = String(orderIndex++);
      }

      lastSortSignature = sig;
      injectSortBadge(shadowRoot);

      // Log top 5
      const groups = [...pinnedGroups, ...regularGroups];
      log('[DST Sorter] Top 5 after CSS-order sort:');
      for (let i = 0; i < Math.min(5, groups.length); i++) {
        const pos = getPositiveRatings(groups[i].posting);
        const neg = getNegativeRatings(groups[i].posting);
        const net = pos - neg;
        const pid = getPostingId(groups[i].posting) || '?';
        const label = groups[i].pinned ? ' [PINNED]' : '';
        log('  ' + (i + 1) + '. Net=' + net + ' (Pos=' + pos + ', Neg=' + neg + ') [ID: ' + pid + ']' + label);
      }

      log('[DST Sorter] CSS-ORDER sorting complete! No DOM elements were removed or moved.');

      // v1.9.19 — Fix 1: After (re)sorting, keep reply threads collapsed by
      // default. The observer is disconnected here, so the native toggle clicks
      // below cannot trigger a re-sort loop. Each posting is collapsed at most
      // once and the user's "Antworten ausgeklappt" gear choice is respected.
      collapseReplyThreads(main);
      // ...and, when the gear wants threads expanded, make pinned postings match
      // the normal ones (derStandard leaves pinned collapsed). Both helpers guard
      // on the gear setting internally, so exactly one of them does work.
      expandPinnedThreads(main);
    } finally {
      isSorting = false;
      observeForum(shadowRoot);
    }
  }

  // ── Badge bar: 3 grouped toggle badges + coffee ───────────────
  async function changeSortMode(newMode, shadowRoot) {
    completeNotice = null; // the reader wants the badges now, not the notice
    sortMode = newMode;
    syncGroupSelection();

    if (chrome?.storage?.sync) {
      chrome.storage.sync.set({ [MODE_KEY]: sortMode });
    } else {
      localStorage.setItem(MODE_KEY, sortMode);
    }

    lastSortSignature = '';

    // v1.7.4: Load all postings before re-sorting (if not yet loaded)
    if (autoLoadEnabled) {
      await loadAllPostings(shadowRoot);
      lastSortSignature = '';
    }

    sortPostings(shadowRoot);
  }

  // v2.4.10: div-Badges per Tastatur bedienbar (Tab + Enter/Leertaste).
  function makeKeyboardButton(el, label) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', label);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  }

  // v2.4.10: Ergebnis der Kaffee-Puls-Pruefung wird pro Seitenaufruf nur einmal
  // aus dem Storage gelesen (vorher bei JEDER Sortierung zwei Storage-Abfragen).
  let coffeePulseCache = null; // null = noch nicht geprueft, sonst true/false

  // Icon + label + mode dots of one segment (v3.1.2: also used to update a
  // segment in place on click, before the re-sort re-creates the bar).
  function fillSegment(btn, group, mode) {
    const m = MODE_DEFS[mode];
    btn.textContent = '';
    btn.setAttribute('data-mode', mode);
    btn.title = m.title;
    btn.setAttribute('aria-label', m.title);
    // AMO Security Fix: createElement statt innerHTML
    // v2.2.9: [icon][label] centred TOGETHER as one unit (icon belongs to text).
    const topRow = document.createElement('span');
    topRow.className = 'dst-btn-toprow';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'dst-btn-ico';
    m.buildIcon(iconWrap);
    const labelSpan = document.createElement('span');
    labelSpan.className = 'dst-btn-label';
    labelSpan.textContent = m.label;
    topRow.appendChild(iconWrap);
    topRow.appendChild(labelSpan);
    btn.appendChild(topRow);
    btn.appendChild(buildDotsIndicator(group, mode));
  }

  function injectSortBadge(shadowRoot) {
    const header = shadowRoot.querySelector('.forum--header');
    if (!header) return;

    // Inject CSS into shadow DOM (once)
    if (!shadowRoot.querySelector('#dst-icon-style')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'dst-icon-style';
      styleEl.textContent = ICON_STYLE_CSS;
      shadowRoot.appendChild(styleEl);
    }

    // v1.9.18: Enable the clickable voter popup on the rating numbers.
    attachVoterListener(shadowRoot);
    try {
      shadowRoot.querySelectorAll('dst-posting--ratinglog:not(.dst-votable)').forEach(function (el) {
        el.classList.add('dst-votable');
      });
    } catch (e) { /* ignore */ }

    // Remove existing badge bar
    const existingBar = shadowRoot.querySelector('#dst-badge-bar');
    if (existingBar) existingBar.remove();

    // Also remove legacy container from v1.4
    const legacyContainer = shadowRoot.querySelector('#dst-sorter-container');
    if (legacyContainer) legacyContainer.remove();

    // ── Badge bar: lives INSIDE main.forum--main ──────────────────
    // v2.2.7: instead of inserting the bar as a sibling of the header (which
    // spans the full <section.forum> width and overflowed the frame), we insert
    // it as the FIRST CHILD of <main.forum--main>. The composer frame + all
    // posting entries live in that same container, so the bar automatically
    // inherits its exact width → both edges line up perfectly, no margin math.
    const bar = document.createElement('div');
    bar.id = 'dst-badge-bar';
    bar.style.width = '100%';   // fill main.forum--main
    bar.style.order = '-1';     // v2.4.10: always on top (see default order rule)

    // v2.2.0: render ONE badge per button group. Each badge shows the
    // label/icon of its currently-selected sub-mode and cycles through its
    // sub-modes on click. Exactly one group is "active" at any time (the one
    // that owns the current sortMode).
    // v3.1.0: the three groups form ONE segmented control (#dst-seg).
    // v3.1.2: while a click's re-sort is still pending, the bar shows the
    // clicked mode (pendingMode), not the one the forum is sorted by yet.
    syncGroupSelection();
    const shownMode = pendingMode || sortMode;
    const seg = document.createElement('div');
    seg.id = 'dst-seg';
    const n = BUTTON_GROUPS.length;
    const activeIdx = BUTTON_GROUPS.findIndex((g) => g.modes.indexOf(shownMode) !== -1);
    const thumb = document.createElement('div');
    thumb.id = 'dst-seg-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    thumb.style.width = 'calc((100% - ' + (6 + 3 * (n - 1)) + 'px) / ' + n + ')';
    thumb.style.setProperty('--dst-i', String(activeIdx));
    if (activeIdx === -1) thumb.style.display = 'none';
    seg.appendChild(thumb);

    BUTTON_GROUPS.forEach((group, groupIdx) => {
      const isActive = groupIdx === activeIdx;
      const btn = document.createElement('div');
      btn.className = 'dst-badge-btn' + (isActive ? ' active' : '');
      btn.setAttribute('data-group', group.id);
      makeKeyboardButton(btn, '');
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      fillSegment(btn, group, groupSelection[group.id]);

      btn.addEventListener('click', (e) => {
        e.stopPropagation();

        const current = pendingMode || sortMode;
        let targetMode;
        if (group.modes.indexOf(current) !== -1) {
          // This group is already active → advance to its next sub-mode.
          const idx = group.modes.indexOf(current);
          targetMode = group.modes[(idx + 1) % group.modes.length];
        } else {
          // Switching to a different group → activate its remembered sub-mode.
          targetMode = groupSelection[group.id];
        }
        const slides = group.modes.indexOf(current) === -1;
        groupSelection[group.id] = targetMode;

        // v3.1.2: show the new state at once — the active card slides over
        // (0.3s) or the segment flips its direction — and only re-sort
        // afterwards. Sorting a large forum blocks the page for a moment;
        // done first, it would swallow the animation.
        seg.querySelectorAll('.dst-badge-btn').forEach((b, i) => {
          b.classList.toggle('active', i === groupIdx);
          b.setAttribute('aria-pressed', i === groupIdx ? 'true' : 'false');
        });
        fillSegment(btn, group, targetMode);
        thumb.style.display = '';
        thumb.style.setProperty('--dst-i', String(groupIdx));

        // A newer click supersedes a re-sort that has not started yet.
        const token = ++pendingClick;
        pendingMode = targetMode;
        const run = () => {
          if (token !== pendingClick) return;
          pendingMode = null;
          changeSortMode(targetMode, shadowRoot);   // re-renders the bar too
        };
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (slides && !reduce) {
          setTimeout(run, 320);
        } else {
          // Let the flipped segment be painted before the re-sort starts.
          requestAnimationFrame(() => setTimeout(run, 0));
        }
      });

      seg.appendChild(btn);
    });
    bar.appendChild(seg);

    // ── Coffee / Donate button (4th badge, not a sort mode) ─────
    const coffeeBtn = document.createElement('div');
    coffeeBtn.className = 'dst-badge-btn dst-coffee-btn';
    makeKeyboardButton(coffeeBtn, 'Unterstützen');
    coffeeBtn.style.position = 'relative';
    // AMO Security Fix: createElement statt innerHTML
    const coffeeIcon = document.createElement('span');
    coffeeIcon.className = 'dst-coffee-icon';
    coffeeIcon.style.cssText = 'font-size:16px;line-height:1;vertical-align:middle;transition:transform 0.3s';
    coffeeIcon.textContent = '☕';
    coffeeBtn.appendChild(coffeeIcon);
    // V14 Dampf-Container mit 5 feinen Wisps
    const steamContainer = document.createElement('div');
    steamContainer.className = 'dst-steam-container';
    for (let i = 0; i < 5; i++) {
      const wisp = document.createElement('div');
      wisp.className = 'dst-steam-wisp';
      steamContainer.appendChild(wisp);
    }
    coffeeIcon.style.position = 'relative';
    coffeeIcon.appendChild(steamContainer);
    // V14 JS Animation Control: restart on hover-in, stop after hover-out
    (function() {
      var _hovering = false, _stopTO = null;
      var _wisps = steamContainer.querySelectorAll('.dst-steam-wisp');
      coffeeBtn.addEventListener('mouseenter', function() {
        _hovering = true;
        if (_stopTO) { clearTimeout(_stopTO); _stopTO = null; }
        _wisps.forEach(function(w) {
          w.style.animation = 'none';
          w.offsetHeight;
          w.style.animation = '';
          w.style.animationIterationCount = 'infinite';
        });
      });
      coffeeBtn.addEventListener('mouseleave', function() {
        _hovering = false;
        _stopTO = setTimeout(function() {
          if (!_hovering) {
            _wisps.forEach(function(w) {
              w.style.animationIterationCount = '1';
            });
          }
        }, 7500);
      });
    })();
    // ── v2.4.6: recurring donation pulse (exponential growth, b=1.5, same as popup) ──
    // Keys shared with popup.js: install time in storage.local, acknowledged counter n in sync.
    // Pulse formula: Tag(n) = 30 · (1.5^n - 1) → 1st: day 15, 2nd: day 37.5, 3rd: day 71.25, …
    // A click increments n, so the pulse only returns at the next calculated day.
    const DST_DONATE_ACK_N_KEY = 'dstDonateAckN';
    const DST_INSTALL_TS_KEY = 'dstInstallTimestamp';
    const DST_DONATE_BASE = 1.5;
    const DST_DONATE_DAY_MS = 24 * 60 * 60 * 1000;

    function dstNextPulseDay(n) {
      // Day for the (n+1)-th pulse = 30 · (1.5^(n+1) - 1)
      return 30 * (Math.pow(DST_DONATE_BASE, n + 1) - 1);
    }

    coffeeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Acknowledge by incrementing n, so pulse returns only at the next calculated day.
      coffeeBtn.classList.remove('dst-pulsing');
      coffeePulseCache = false;
      try {
        if (chrome?.storage?.sync) {
          chrome.storage.sync.get([DST_DONATE_ACK_N_KEY], (res) => {
            res = res || {};
            const n = (typeof res[DST_DONATE_ACK_N_KEY] === 'number') ? res[DST_DONATE_ACK_N_KEY] : 0;
            try { chrome.storage.sync.set({ [DST_DONATE_ACK_N_KEY]: n + 1 }); } catch (err) { /* noop */ }
          });
        }
      } catch (err) { /* noop */ }
      window.open('https://buymeacoffee.com/diversion', '_blank');
    });

    // Decide whether to auto-pulse this time (fail-safe: no pulse on any error).
    if (coffeePulseCache !== null) {
      if (coffeePulseCache) coffeeBtn.classList.add('dst-pulsing');
    } else try {
      if (chrome?.storage?.local && chrome?.storage?.sync) {
        coffeePulseCache = false; // bis zur Antwort: kein Puls, keine Doppelabfrage
        chrome.storage.local.get([DST_INSTALL_TS_KEY], (localData) => {
          if (chrome.runtime && chrome.runtime.lastError) return;
          localData = localData || {};
          let installedAt = localData[DST_INSTALL_TS_KEY];
          if (typeof installedAt !== 'number') {
            installedAt = Date.now();
            try { chrome.storage.local.set({ [DST_INSTALL_TS_KEY]: installedAt }); } catch (err) { /* noop */ }
          }
          const usageDays = Math.floor((Date.now() - installedAt) / DST_DONATE_DAY_MS);
          chrome.storage.sync.get([DST_DONATE_ACK_N_KEY], (syncData) => {
            if (chrome.runtime && chrome.runtime.lastError) return;
            syncData = syncData || {};
            const n = (typeof syncData[DST_DONATE_ACK_N_KEY] === 'number') ? syncData[DST_DONATE_ACK_N_KEY] : 0;
            const nextPulseDay = dstNextPulseDay(n);
            if (usageDays >= nextPulseDay) {
              coffeePulseCache = true;
              // Die Leiste kann inzwischen neu gebaut worden sein.
              const live = shadowRoot.querySelector('.dst-coffee-btn');
              if (live) live.classList.add('dst-pulsing');
            }
          });
        });
      }
    } catch (err) { /* noop */ }

    bar.appendChild(coffeeBtn);

    // v2.2.7: Insert the bar as the FIRST CHILD of main.forum--main so it
    // inherits that container's exact width (aligns with the composer frame &
    // posting entries). Fall back to the old sibling-of-header placement only
    // if main.forum--main can't be found.
    const mainEl = shadowRoot.querySelector('main.forum--main');
    if (mainEl) {
      mainEl.insertBefore(bar, mainEl.firstChild);
    } else if (header.nextSibling) {
      header.parentNode.insertBefore(bar, header.nextSibling);
    } else if (header.parentNode) {
      header.parentNode.appendChild(bar);
    } else {
      header.appendChild(bar);
    }

    if (completeNotice) renderCompleteNotice(shadowRoot);
    else if (isLoadingAllPostings && lastProgress) showProgressBar(shadowRoot, ...lastProgress);
  }

  function removeSortBadge(shadowRoot) {
    const bar = shadowRoot.querySelector('#dst-badge-bar');
    if (bar) bar.remove();
    // Clean up legacy elements from v1.4
    const c = shadowRoot.querySelector('#dst-sorter-container');
    if (c) c.remove();
  }

  // ── Debounced sort ────────────────────────────────────────────
  function scheduledSort(shadowRoot) {
    if (sortTimeout) clearTimeout(sortTimeout);
    sortTimeout = setTimeout(() => {
      if (sortEnabled) sortPostings(shadowRoot);
    }, 300);
  }

  // ── Observe mutations inside forum shadow root ────────────────
  // v1.6.10 CRITICAL FIX: Do NOT observe rating attribute changes at all.
  //
  // PROBLEM (v1.6.9 and earlier):
  //   When a user clicks +/- (upvote/downvote), derStandard.at updates the
  //   positiveratings/negativeratings attributes on dst-posting--ratinglog.
  //   Even with a 2-second debounce delay, the subsequent sortPostings() call
  //   removes ALL postings from the DOM and re-inserts them in sorted order.
  //   This DOM manipulation destroys derStandard.at's internal vote state,
  //   causing the vote counter to revert and the vote to not be saved.
  //
  // SOLUTION (v1.6.10):
  //   - Only observe childList changes (new postings being loaded)
  //   - NEVER react to rating attribute changes
  //   - Sorting based on updated ratings only happens on:
  //     a) Manual badge bar click (user explicitly requests re-sort)
  //     b) New postings loaded (childList mutation)
  //     c) Page load / tab switch
  //   This ensures the extension NEVER interferes with the vote process.
  function observeForum(shadowRoot) {
    if (observer) observer.disconnect();

    const main = shadowRoot.querySelector('main.forum--main');
    if (!main) return;

    observer = new MutationObserver((mutations) => {
      if (isSorting) return;

      let hasNewPosting = false;

      for (const mutation of mutations) {
        // v1.6.11 CRITICAL: Only react to childList changes directly on main.
        // Ignore subtree changes (e.g. vote counter text updates inside postings).
        // When derStandard.at updates a vote counter, it changes textContent inside
        // a nested element — that's a childList mutation on a CHILD node, not on main.
        // We only care about new DST-POSTING elements being added to main directly.
        if (mutation.type === 'childList' && mutation.target === main) {
          // Check if any added node is a posting (new comment loaded)
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1 && (
              node.tagName === 'DST-POSTING' ||
              node.tagName === 'SECTION' ||
              node.tagName === 'SLOT'
            )) {
              hasNewPosting = true;
              break;
            }
          }
          if (hasNewPosting) break;
        }
      }

      if (hasNewPosting) {
        scheduledSort(shadowRoot);
      }
    });

    // v1.6.11: Only childList on main's direct children — NO subtree, NO attributes!
    // subtree:false ensures we only see changes to main's direct children,
    // not internal DOM changes within postings (like vote counter updates).
    observer.observe(main, {
      childList: true,
      subtree: false,
    });
  }

  // ── URL check: is this an article page? ─────────────────────────
  function isArticlePage() {
    const path = window.location.pathname;
    return /\/story\//.test(path);
  }

  // ── Native forum initialization without navigation ──────────
  function autoLoadForum() {
    // The site mounts dst-forum independently. Its posting-count link is a
    // navigation control (data-scrollto), not a load API. preventDefault alone
    // would not stop that link's JavaScript scroll handler. Never click it.
    return isArticlePage() && autoLoadEnabled && !!document.querySelector('dst-forum');
  }

  // ── Load main postings without automatically expanding reply threads ──
  // Search forum shadow DOM and slotted light DOM. Reply controls are excluded.
  // Stop on repeated absence or stalled loading, not after a fixed batch count.

  function findLoadMoreButton(shadowRoot) {
    // Only forum pagination; leave the user's reply expansion state untouched.
    const roots = [shadowRoot, document.querySelector('section.forum'),
      document.querySelector('dst-forum')].filter(Boolean);
    for (const root of roots) {
      for (const btn of root.querySelectorAll('button')) {
        // Offscreen/display:none controls still have native click handlers.
        // Do not use viewport geometry as a prerequisite for pagination.
        const text = (btn.textContent || '').trim().toLowerCase();
        if (btn.closest('dst-posting, section.thread') || text.includes('antwort')) continue;
        if (btn.getAttribute('role') === 'tab') continue;
        if (btn.matches('button.thread--more') ||
            (text.includes('weitere') && text.includes('posting'))) {
          return btn;
        }
      }
    }
    return null;
  }

  function getTotalPostingCount(shadowRoot) {
    // v2.4.1: read the TOTAL posting count from the dedicated count element
    // derStandard renders (verified live on the forum DOM):
    //   • .forum--postingcount   (inside dst-forum shadow) → "143 Postings und Antworten"
    //   • .js-forum-postingcount (main doc)                → "143 Postings"
    //   • .article-postingcount  (button under the headline) → "143 Postings"
    // We query these SPECIFIC classes in priority order instead of the old
    // greedy `[class*="postingcount"]`, which could accidentally match an
    // unrelated per-thread counter (e.g. a reply count of "1") and thus show
    // "X / 1" during loading. Numbers may carry a German thousands separator
    // ("1.234"), so we strip dots/whitespace before parsing.
    const selectors = ['.forum--postingcount', '.js-forum-postingcount', '.article-postingcount'];
    for (let i = 0; i < selectors.length; i++) {
      const sel = selectors[i];
      const el = (shadowRoot && shadowRoot.querySelector(sel)) || document.querySelector(sel);
      if (el) {
        const m = (el.textContent || '').match(/(\d[\d.\s]*)/);
        if (m) {
          const n = parseInt(m[1].replace(/[.\s]/g, ''), 10);
          if (n > 0) return n;
        }
      }
    }
    return 0;
  }

  // ── v1.7.4: Progress bar replaces badge bar during loading ──────
  // Last progress shown, so a re-sort during loading (which re-creates the
  // bar) can show it again instead of flashing the badges for a moment.
  let lastProgress = null;

  function showProgressBar(shadowRoot, loaded, total, message) {
    const bar = shadowRoot.querySelector('#dst-badge-bar');
    if (!bar) return;
    lastProgress = [loaded, total, message];

    // Hide all badge buttons. visibility (not display) keeps their space, and
    // the progress bar is laid over them: the bar keeps its height, so the
    // forum below no longer shifts up and back down by ~14px.
    for (const child of bar.children) {
      if (child.id !== 'dst-progress-container') {
        child.style.visibility = 'hidden';
      }
    }

    let container = bar.querySelector('#dst-progress-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'dst-progress-container';
      container.style.cssText = 'position:absolute;left:0;right:0;top:10px;bottom:6px;display:flex;flex-direction:column;justify-content:center;gap:3px;min-width:0;';
      bar.style.position = 'relative';
      bar.appendChild(container);
    }

    // v2.4.1: guard the denominator. A trustworthy total is always ≥ the
    // number already loaded; if detection returned something smaller (or 0),
    // fall back to the loaded count so we never render a bogus "X / 1".
    const validTotal = (total && total >= loaded) ? total : 0;
    const percentage = validTotal > 0 ? Math.round((loaded / validTotal) * 100) : 0;

    // Build progress bar HTML using DOM methods (AMO safe)
    container.textContent = ''; // clear

    // Outer bar
    const outer = document.createElement('div');
    // v3.1.0: neutral, in derStandard's text colour (green is kept for ratings)
    outer.style.cssText = 'width:100%;height:28px;background:hsl(var(--dst-ink) / .08);border-radius:6px;position:relative;overflow:hidden;';

    // Inner fill
    const fill = document.createElement('div');
    fill.style.cssText = 'position:absolute;left:0;top:0;height:100%;width:' + percentage + '%;background:hsl(var(--dst-ink) / .18);border-radius:6px;transition:width 0.4s ease;';

    // Pulse animation on fill
    const pulseStyle = document.createElement('style');
    pulseStyle.id = 'dst-pulse-style';
    if (!shadowRoot.querySelector('#dst-pulse-style')) {
      pulseStyle.textContent = '@keyframes dst-progress-pulse{0%{opacity:1}50%{opacity:0.7}100%{opacity:1}} #dst-progress-fill{animation:dst-progress-pulse 1.5s ease-in-out infinite}';
      shadowRoot.appendChild(pulseStyle);
    }
    fill.id = 'dst-progress-fill';

    // Text overlay
    const textEl = document.createElement('span');
    textEl.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:hsl(var(--dst-ink));font-weight:700;font-size:12px;z-index:1;';
    // v2.4.1: show "X / Y" only when we have a trustworthy total; otherwise
    // just show the loaded count (never the bogus "/ 1").
    textEl.textContent = message
      || (validTotal > 0
            ? ('Lade alle Postings... ' + loaded + ' / ' + validTotal)
            : ('Lade alle Postings... ' + loaded));

    outer.appendChild(fill);
    outer.appendChild(textEl);
    container.appendChild(outer);
  }

  function hideProgressBar(shadowRoot) {
    lastProgress = null;
    const bar = shadowRoot.querySelector('#dst-badge-bar');
    if (!bar) return;

    const container = bar.querySelector('#dst-progress-container');
    if (container) container.remove();

    // Show all badge buttons again
    for (const child of bar.children) {
      child.style.visibility = '';
    }

    // Remove pulse style
    const pulseStyle = shadowRoot.querySelector('#dst-pulse-style');
    if (pulseStyle) pulseStyle.remove();
  }

  // "✓ Alle N Postings geladen!" is shown for 1.5s, but only when background
  // loading actually added postings while the reader had the badge bar on
  // screen. The sort that follows re-creates the bar, so the notice is kept
  // here and re-applied by injectSortBadge (previously it was wiped before it
  // was ever painted).
  let completeNotice = null;

  function badgeBarOnScreen(shadowRoot) {
    const bar = shadowRoot.querySelector('#dst-badge-bar');
    if (!bar) return false;
    const r = bar.getBoundingClientRect();
    return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function renderCompleteNotice(shadowRoot) {
    const bar = shadowRoot.querySelector('#dst-badge-bar');
    if (!bar || !completeNotice) return;
    showProgressBar(shadowRoot, 0, 0); // hides the badges, provides the container
    const container = bar.querySelector('#dst-progress-container');
    if (!container) return;
    container.textContent = '';
    const outer = document.createElement('div');
    outer.style.cssText = 'width:100%;height:28px;background:hsl(var(--dst-ink) / .18);border-radius:6px;display:flex;align-items:center;justify-content:center;';
    const textEl = document.createElement('span');
    textEl.style.cssText = 'color:hsl(var(--dst-ink));font-weight:700;font-size:12px;';
    textEl.textContent = '✓ Alle ' + completeNotice.total + ' Postings geladen!';
    outer.appendChild(textEl);
    container.appendChild(outer);
  }

  function showProgressComplete(shadowRoot, totalPostings) {
    const notice = { total: totalPostings };
    completeNotice = notice;
    renderCompleteNotice(shadowRoot);

    // After 1.5s, hide the notice and show the badges again
    setTimeout(function() {
      if (completeNotice !== notice) return;
      completeNotice = null;
      hideProgressBar(shadowRoot);
    }, 1500);
  }

  function readForumLoadState(shadowRoot) {
    const forum = shadowRoot.host || document.querySelector('dst-forum');
    if (!forum) return null;
    // MAIN-world bridge exposes only counts and pagination flags, no posting text.
    forum.removeAttribute('data-dst-load-state');
    forum.dispatchEvent(new Event('dst-request-load-state', { bubbles: true }));
    try {
      const state = JSON.parse(forum.getAttribute('data-dst-load-state'));
      if (state && Number.isFinite(state.loaded) && typeof state.more === 'boolean') return state;
    } catch (e) { /* Native model unavailable: use DOM progress, never invent completion. */ }
    return null;
  }

  function waitForForumCondition(shadowRoot, predicate, timeout = 10000) {
    return new Promise(resolve => {
      let done = false, timer, poll;
      const mutations = new MutationObserver(check);
      function finish(result) {
        if (done) return;
        done = true;
        mutations.disconnect();
        clearTimeout(timer);
        clearInterval(poll);
        resolve(result);
      }
      function check() {
        try {
          if (!autoLoadEnabled || !sortEnabled) return finish(false);
          if (predicate()) finish(true);
        } catch (error) {
          console.warn('[DST Sorter] Ladeprüfung fehlgeschlagen:', error);
          finish(false);
        }
      }
      mutations.observe(shadowRoot, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['disabled', 'aria-busy', 'aria-disabled', 'class'] });
      const forum = shadowRoot.host || document.querySelector('dst-forum');
      if (forum) mutations.observe(forum, { childList: true, subtree: true });
      // Poll as a fallback for shadow-root attachment / native state-only changes.
      poll = setInterval(check, 250);
      timer = setTimeout(() => finish(false), timeout);
      check();
    });
  }

  // v2.4.10: wait until the browser is idle (article rendering, scrolling and
  // input have priority). Falls back to a timeout where requestIdleCallback is
  // missing.
  function waitForIdle(timeout) {
    return new Promise(function (resolve) {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(function () { resolve(); }, { timeout: timeout });
      } else {
        setTimeout(resolve, Math.min(timeout, 200));
      }
    });
  }

  async function loadAllPostings(shadowRoot) {
    if (isLoadingAllPostings || !autoLoadEnabled || !sortEnabled) return false;
    isLoadingAllPostings = true;
    const countRendered = () => {
      const roots = [shadowRoot, document.querySelector('dst-forum'),
        document.querySelector('section.forum')].filter(Boolean);
      return new Set(roots.flatMap(root => Array.from(root.querySelectorAll('dst-posting')))).size;
    };
    const initialCount = countRendered();
    let completed = false;
    let stalled = 0;
    let changed = false;
    let filterAttempted = false;
    const busy = btn => btn.disabled || btn.getAttribute('aria-disabled') === 'true' ||
      btn.getAttribute('aria-busy') === 'true';
    const allPostingsTab = () => Array.from(shadowRoot.querySelectorAll('button[role="tab"]'))
      .find(btn => btn.textContent.trim().toLowerCase() === 'alle postings' &&
        !btn.classList.contains('active') && btn.getAttribute('aria-selected') !== 'true' &&
        !filterAttempted);

    try {
      injectSortBadge(shadowRoot);
      if (observer) observer.disconnect();
      while (autoLoadEnabled && sortEnabled) {
        const before = readForumLoadState(shadowRoot);
        const beforeCount = countRendered();
        showProgressBar(shadowRoot, before?.loaded ?? beforeCount,
          before?.total ?? getTotalPostingCount(shadowRoot));

        // An inactive "Alle Postings" tab can restrict pagination. Never keep
        // clicking the active tab, and never touch reply-expansion controls.
        const tab = allPostingsTab();
        if (tab && !busy(tab)) {
          filterAttempted = true;
          tab.click();
          changed = true;
          await waitForForumCondition(shadowRoot, () => {
            const state = readForumLoadState(shadowRoot);
            return state ? !state.loading && state.all : !!findLoadMoreButton(shadowRoot);
          });
          continue;
        }
        if (before && !before.loading && before.all && !before.more) {
          completed = true;
          break;
        }

        const btn = findLoadMoreButton(shadowRoot);
        if (!btn || busy(btn) || before?.loading) {
          const ready = await waitForForumCondition(shadowRoot, () => {
            const state = readForumLoadState(shadowRoot);
            const candidate = findLoadMoreButton(shadowRoot);
            return (state && !state.loading && state.all && !state.more) ||
              (candidate && !busy(candidate) && !state?.loading);
          });
          if (!ready) break;
          continue;
        }

        // v2.4.10: New postings are appended at the END of the forum (default
        // order rule), so readers in the article or inside the forum are not
        // affected. Only a reader BELOW the forum would be pushed down by the
        // growing forum; compensate that case if they have not scrolled since.
        const growAnchor = captureScrollAnchor(shadowRoot);
        const scrollBefore = window.scrollY;
        btn.click(); // Native pagination fetches replies too, without expanding them.
        const progressed = await waitForForumCondition(shadowRoot, () => {
          const state = readForumLoadState(shadowRoot);
          if (state?.loading) return false;
          return countRendered() > beforeCount ||
            (state && before && (state.loaded > before.loaded || state.cursor !== before.cursor)) ||
            (state && state.all && !state.more);
        });
        if (growAnchor && growAnchor.edge === 'bottom' &&
            Math.abs(window.scrollY - scrollBefore) < 2) {
          restoreScrollAnchor(growAnchor);
        }
        // Give the browser room for scrolling/rendering between batches.
        await waitForIdle(1000);
        changed = changed || progressed;
        stalled = progressed ? 0 : stalled + 1;
        if (stalled >= 3) break;
      }
      const finalState = readForumLoadState(shadowRoot);
      // v2.4.10: finalState can be null -> previously a TypeError here.
      if (completed) {
        if (countRendered() > initialCount && badgeBarOnScreen(shadowRoot)) {
          showProgressComplete(shadowRoot, finalState?.loaded ?? countRendered());
        } else {
          hideProgressBar(shadowRoot);
        }
      } else {
        hideProgressBar(shadowRoot);
        console.warn('[DST Sorter] Vollständigkeit nicht bestätigt; keine Scroll-Ausweichlösung.',
          finalState?.loaded ?? countRendered());
      }
    } catch (error) {
      hideProgressBar(shadowRoot);
      console.warn('[DST Sorter] Fehler beim Hintergrundladen:', error);
    } finally {
      isLoadingAllPostings = false;
      // No saved position, no restoration: the user remains free to scroll.
      observeForum(shadowRoot);
    }
    return changed || countRendered() > initialCount;
  }

  // ── Wait for the dst-forum element and its shadow root ────────
  function waitForForum() {
    const forum = document.querySelector('dst-forum');
    if (forum && forum.shadowRoot) {
      log('[DST Sorter] Forum already loaded, initializing sort...');
      initSort(forum.shadowRoot);
      return;
    }

    const autoLoaded = autoLoadForum();
    log(
      '[DST Sorter] Forum: ' + (autoLoaded ? 'vorhanden' : 'warte auf native Initialisierung')
    );

    let poll = null;
    const docObserver = new MutationObserver(() => {
      const f = document.querySelector('dst-forum');
      if (f && f.shadowRoot) {
        log('[DST Sorter] Forum element detected via MutationObserver');
        docObserver.disconnect();
        if (poll) clearInterval(poll);
        initSort(f.shadowRoot);
      }
    });
    docObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    let attempts = 0;
    poll = setInterval(() => {
      attempts++;
      const f = document.querySelector('dst-forum');
      if (f && f.shadowRoot) {
        log('[DST Sorter] Forum element detected via polling (attempt ' + attempts + ')');
        clearInterval(poll);
        docObserver.disconnect();
        initSort(f.shadowRoot);
      }
      if (attempts > 100) {
        log('[DST Sorter] Timeout: Forum element not found after 50 seconds');
        clearInterval(poll);
        // v2.4.10: previously the document-wide observer kept running forever
        // on pages without a forum (home page, live tickers, ...).
        docObserver.disconnect();
      }
    }, 500);
  }

  // ── Initialise sorting ────────────────────────────────────────
  let sortInitialized = false;
  function initSort(shadowRoot) {
    if (sortInitialized) return;
    const ready = () => {
      const m = shadowRoot.querySelector('main.forum--main');
      return !!m && !!m.querySelector('dst-posting[data-level="0"]');
    };
    const start = () => {
      if (sortInitialized) return;
      sortInitialized = true;
      waitForRatingsAndSort(shadowRoot);
    };
    if (ready()) { start(); return; }
    // v2.4.10: observe the whole shadow root. Previously, if main.forum--main
    // was not rendered yet (Lit renders asynchronously), no observer was
    // attached at all and the extension silently did nothing on that page.
    const innerObs = new MutationObserver(() => {
      if (ready()) { innerObs.disconnect(); start(); }
    });
    innerObs.observe(shadowRoot, { childList: true, subtree: true });
  }

  // ── Wait for rating data before first sort ────────────────────
  function waitForRatingsAndSort(shadowRoot) {
    const main = shadowRoot.querySelector('main.forum--main');
    if (!main) return;

    if (hasRatingData(main)) {
      // v1.7.4: Properly handle async runSort
      runSort(shadowRoot).catch(function(e) {
        log('[DST Sorter] runSort error: ' + e.message);
      });
      return;
    }

    let ratingWaitAttempts = 0;
    const maxWaitAttempts = 30;

    const ratingPoll = setInterval(function() {
      ratingWaitAttempts++;
      if (hasRatingData(main)) {
        clearInterval(ratingPoll);
        runSort(shadowRoot).catch(function(e) {
          log('[DST Sorter] runSort error: ' + e.message);
        });
      } else if (ratingWaitAttempts >= maxWaitAttempts) {
        clearInterval(ratingPoll);
        runSort(shadowRoot).catch(function(e) {
          log('[DST Sorter] runSort error: ' + e.message);
        });
      }
    }, 500);
  }

  async function runSort(shadowRoot) {
    // v1.7.4: First do an initial sort with whatever postings are available,
    // then load all remaining postings and re-sort.
    // This gives the user immediate visual feedback while loading continues.

    if (sortEnabled) {
      // Initial sort with available postings
      sortPostings(shadowRoot);
    }

    // Start discovery even when the lazy-loaded button does not exist yet.
    if (sortEnabled && autoLoadEnabled) {
      // v2.4.10: start only once the page is idle, so the article itself
      // renders and scrolls without competition.
      await waitForIdle(2000);
      const loaded = await loadAllPostings(shadowRoot);
      if (loaded) {
        lastSortSignature = '';
        sortPostings(shadowRoot);
      }
    }

    observeForum(shadowRoot);

    // v1.7.0: Only ONE delayed re-sort (for late-loading ratings)
    setTimeout(function() {
      if (sortEnabled) {
        const main = shadowRoot.querySelector('main.forum--main');
        if (main) {
          const { groups: allGrps } = collectPostingGroups(main);
          const sortableGrps = allGrps.filter(function(g) { return !g.isDuplicate && !g.isDeletedAlone; });
          const newSig = buildSortSignature(sortableGrps);
          if (newSig !== lastSortSignature) {
            sortPostings(shadowRoot);
          }
        }
      }
    }, 3000);

    // Listen for manual "Weitere Postings laden" clicks
    const moreBtn = findLoadMoreButton(shadowRoot);
    if (moreBtn) {
      moreBtn.addEventListener('click', function() {
        setTimeout(function() { scheduledSort(shadowRoot); }, 2000);
      });
    }

    const tabs = shadowRoot.querySelectorAll(
      'dst-forum--tabnavigation button.tab'
    );
    tabs.forEach(function(tab) {
      tab.addEventListener('click', function() {
        lastSortSignature = '';
        setTimeout(function() { scheduledSort(shadowRoot); }, 1500);
      });
    });
  }

  // ── Storage migration: old format -> new format ────────────────
  function migrateStorage(data) {
    const currentMode = data[MODE_KEY];
    // Already in current format
    if (currentMode && ALL_MODES.indexOf(currentMode) !== -1) {
      return currentMode;
    }
    // v2.2.2: "no-timeline" removed (was identical to chronological-new)
    if (currentMode === 'no-timeline') return 'chronological-new';
    // v2.2.0: the single "chronological" mode was split into timeline sub-modes.
    // The old behaviour was "oldest first" → map to chronological-old.
    if (currentMode === 'chronological') return 'chronological-old';
    // Migrate old format
    if (currentMode === 'net') return 'balance-top';
    if (currentMode === 'positive') return 'positive-only';
    // Check legacy boolean key (very old versions)
    if (data.sortByPositive === true) return 'positive-only';
    if (data.sortByPositive === false) return 'balance-top';
    // Default
    return 'balance-top';
  }

  // ── Storage: persist enabled state & sort mode ─────────────────
  function loadState(callback) {
    if (chrome?.storage?.sync) {
      chrome.storage.sync.get([SORT_KEY, MODE_KEY, AUTOLOAD_KEY, 'sortByPositive'], (data) => {
        sortEnabled = data[SORT_KEY] !== false;
        sortMode = migrateStorage(data);
        syncGroupSelection();
        autoLoadEnabled = data[AUTOLOAD_KEY] !== false;

        // Persist migrated mode if it changed
        const oldMode = data[MODE_KEY];
        if (oldMode !== sortMode) {
          chrome.storage.sync.set({ [MODE_KEY]: sortMode });
          log('[DST Sorter] Migrated sort mode from "' + oldMode + '" to "' + sortMode + '"');
        }

        callback();
      });
    } else {
      sortEnabled = localStorage.getItem(SORT_KEY) !== 'false';
      const rawMode = localStorage.getItem(MODE_KEY);
      sortMode = migrateStorage({ [MODE_KEY]: rawMode });
      syncGroupSelection();
      autoLoadEnabled = localStorage.getItem(AUTOLOAD_KEY) !== 'false';
      if (rawMode !== sortMode) {
        localStorage.setItem(MODE_KEY, sortMode);
      }
      callback();
    }
  }

  // Listen for messages from popup
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'toggle') {
        sortEnabled = msg.enabled;
        const forum = document.querySelector('dst-forum');
        if (forum && forum.shadowRoot) {
          // v2.4.10: reload in both directions. Switching ON previously only
          // sorted once, without background loading, observer or voter popup.
          if (!sortEnabled) removeSortBadge(forum.shadowRoot);
          location.reload();
        }
      }
      if (msg.action === 'setMode') {
        sortMode = msg.mode;
        syncGroupSelection();
        const forum = document.querySelector('dst-forum');
        if (forum && forum.shadowRoot) {
          if (sortEnabled) {
            lastSortSignature = '';
            sortPostings(forum.shadowRoot);
          }
        }
      }
      if (msg.action === 'setAutoLoad') {
        autoLoadEnabled = msg.enabled;
      }
    });
  }

  // ── Entry point ───────────────────────────────────────────────
  loadState(() => {
    if (sortEnabled) waitForForum();
  });

})();
