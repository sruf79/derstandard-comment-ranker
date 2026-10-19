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
  const FLAT_KEY = 'dstFlat';   // v4.18.0: flat design instead of the glass look
  let flatDesign = false;
  function applyFlat() {
    const f = document.querySelector('dst-forum');
    if (f) f.classList.toggle('dst-flat', flatDesign);
  }
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'sync' && FLAT_KEY in changes) {
        flatDesign = changes[FLAT_KEY].newValue === true;
        applyFlat();
      }
    });
  } catch (e) { /* noop */ }

  // ── v2.2.0: grouped toggle buttons ─────────────────────────────
  // Instead of 5 separate sort badges we now render only 3 sort buttons
  // (plus the coffee button). Each button owns several sub-modes and
  // cycles through them on every click:
  //   • Balance  : Balance: Top  ↔ Balance: Low
  //   • Likes    : Likes         ↔ Dislikes
  //   • Timeline : Timeline: New ↔ Timeline: Old (v2.2.2: 2-way toggle)
  //
  // MODE_DEFS: label + tooltip for every individual sort mode.
  // v3.1.0: one short word per segment and direction. `title` explains each
  // mode for tooltips and screen readers.
  // v3.5.0: back to the three sort groups users know — Likes/Dislikes,
  // Balance (in the middle, the default) and New/Old.
  // v3.12.0: text only, no ▲ ▼ ⇥ ⇤ icons.
  // v3.13.0: one fixed word per segment — Pure (only one kind of vote),
  // Balance (both kinds netted), Timeline. The direction is shown by the
  // pill's colour (green = first, red = second) and the two dots.
  const MODE_DEFS = {
    'positive-only':    { label: 'Pure',     title: 'Pure: Likes mit möglichst wenigen Gegenstimmen zuerst' },
    'negative-only':    { label: 'Pure',     title: 'Pure: Dislikes mit möglichst wenigen Gegenstimmen zuerst' },
    'balance-top':      { label: 'Balance',  title: 'Balance: höchste Bilanz aus Plus- und Minus-Stimmen zuerst' },
    'balance-flop':     { label: 'Balance',  title: 'Balance: niedrigste Bilanz aus Plus- und Minus-Stimmen zuerst' },
    'chronological-new':{ label: 'Timeline', title: 'Timeline: neueste Postings zuerst' },
    'chronological-old':{ label: 'Timeline', title: 'Timeline: älteste Postings zuerst' }
  };

  // BUTTON_GROUPS: one badge per entry; each click advances to the next mode.
  const BUTTON_GROUPS = [
    { id: 'likes',    modes: ['positive-only', 'negative-only'] },
    { id: 'balance',  modes: ['balance-top', 'balance-flop'] },
    { id: 'timeline', modes: ['chronological-new', 'chronological-old'] }
  ];

  // v3.15.0: under every label a small bar in the look of derStandard's own
  // rating bars (red left, green right): it replaces the two dots and shows
  // the direction of the segment's current mode — also on inactive segments.
  //   Pure     : all green (most likes) / all red (most dislikes)
  //   Balance  : split, mostly green (highest) / mostly red (lowest)
  //   Timeline : fading green (newest first) / fading red (oldest first)
  // Every bar has the same size; its width follows the segment width.
  const MODE_BARS = {
    'positive-only':     [['pos', 1]],
    'negative-only':     [['neg', 1]],
    'balance-top':       [['neg', 1], ['pos', 3]],
    'balance-flop':      [['neg', 3], ['pos', 1]],
    'chronological-new': [['fade-new', 1]],
    'chronological-old': [['fade-old', 1]]
  };
  function buildModeBar(mode) {
    const bar = document.createElement('span');
    bar.className = 'dst-mode-bar';
    bar.setAttribute('aria-hidden', 'true');
    MODE_BARS[mode].forEach(function(part) {
      const seg = document.createElement('span');
      seg.className = 'dst-mb-' + part[0];
      seg.style.flexGrow = String(part[1]);
      bar.appendChild(seg);
    });
    return bar;
  }

  const ALL_MODES = Object.keys(MODE_DEFS);

  // Remembers the last-selected sub-mode per button group so a button keeps
  // showing a sensible label even while another button is the active one.
  const groupSelection = {
    likes:    'positive-only',
    balance:  'balance-top',
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

  // v3.19.0: the direction (green = first, red = second mode of a group) is
  // shared by all segments: switching to another segment keeps it, only a
  // click on the active segment flips it. Every segment shows that direction.
  function setDirectionAll(mode) {
    const g = getGroupForMode(mode);
    if (!g) return;
    const dir = g.modes.indexOf(mode);
    BUTTON_GROUPS.forEach(function(grp) { groupSelection[grp.id] = grp.modes[dir] || grp.modes[0]; });
  }

  function syncGroupSelection() {
    setDirectionAll(sortMode);
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
    /* v4.19.2: the browser picks its scroll anchor in DOM order, which is
       not the order on screen here. Opening a thread then moved that anchor
       and the page jumped down to the last reply. */
    main.forum--main { overflow-anchor: none; }

    /* NOTE: Reply thread sections (SECTION.thread) are now attached as siblings
       of their parent posting groups and move together during sorting.
       This preserves the expand/collapse ("Antworten") functionality.
       derstandard.at manages their visibility natively via the "collapsed"
       CSS class; v4.19.2 only hides closed top level threads (dst-fold). */

    /* ═══ v3.1.0 SORT BAR: one segmented control in derStandard's own look ═══
       Track and text colours come from derStandard's theme variables, which
       change with the Ressort; the fallbacks are the default light theme.
       Green and red stand for ratings only: the rating bars and the ring of
       the active segment (the direction). */
    #dst-badge-bar, #dst-voter-overlay {
      --dst-ink: var(--theme--on-secondary--hsl, 0 0% 13%);
      --dst-card: var(--theme--card, #fff);
      /* v3.7.1: the article's background (derStandard's --theme--base, per
         Ressort) made lighter, so the bar stands out from the page
         (v3.8.1: 35% white, was 25%) */
      --dst-track: color-mix(in srgb, var(--theme--base, #e6e6e6) 78%, #fff);   /* v4.17.0: was 65%, so the white knob stands out */
      /* v3.8.1: frame of the track — a darker shade of the same colour */
      --dst-track-border: color-mix(in srgb, var(--theme--base, #e6e6e6) 80%, #000);   /* v4.16.0: = card frame (was 75%) */
    }
    /* v3.8.0: two rows — the sort track (always shown and usable) and, while
       postings are loading, the loading bar below it. */
    #dst-badge-bar {
      display: flex;
      flex-direction: column;
      gap: 10px;
      /* v3.5.1: 31px below, whatever comes next. Before, it was 6px + the
         comment box's own 25px top margin (31px), but only 6px when a pinned
         posting came first. The comment box's top margin is dropped below. */
      padding: 10px 0 31px 0;   /* 31px below the lowest row */
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
      border-radius: 24px;        /* v3.1.5: one pill-shaped track */
      /* v3.8.4: the track is drawn by ::before (sort segments) and ::after
         (coffee button) — two pills with a gap in the article colour */
      isolation: isolate;
      box-sizing: border-box;
    }
    /* v3.1.2: the active segment's card is ONE element sliding under the
       segments (like the switch in the extension popup, 0.3s). Segments are
       equal-width, so its position is pure CSS: no layout measurement. Its
       width is set from JS (depends on the number of segments). On a click
       it slides first; the re-sort only starts afterwards. */
    /* v3.9.0: the active pill reaches the track's outer frame (incl. its 1px
       line). It is 8px wider than a segment (3px padding + 1px frame on each
       side); one step is still segment + 3px gap = 100% - 5px. */
    #dst-seg-thumb {
      position: absolute;
      top: -1px;
      bottom: -1px;
      left: -1px;
      border-radius: 999px;
      transform: translateX(calc(var(--dst-i, 0) * (100% - 5px)));
      /* v4.16.0: a soft spring (fast start, the faintest settle), like
         Apple's segmented control; done before the re-sort (460ms) */
      transition: transform .4s cubic-bezier(.3, 1.08, .5, 1);
    }
    /* v3.8.4: two pills with the same rounding (v3.8.5: 10px apart): the three
       sort segments and the coffee button. v3.8.1: darker frame + soft drop
       shadow, so the bar does not get lost on the page. */
    #dst-seg::before,
    #dst-seg::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      z-index: -1;
      /* v3.9.0: slightly domed: light at the top, a touch darker at the
         bottom, a highlight line along the top edge */
      background: linear-gradient(to bottom,
        color-mix(in srgb, var(--dst-track) 35%, #fff),
        var(--dst-track) 55%,
        color-mix(in srgb, var(--dst-track) 94%, #000));
      border-radius: 24px;
      box-shadow: 0 0 0 1px var(--dst-track-border),
        inset 0 1.5px 0 rgba(255, 255, 255, .95),
        inset 0 -2px 3px rgba(0, 0, 0, .08),
        0 3px 8px rgba(0, 0, 0, .18);
      pointer-events: none;
    }
    #dst-seg::before { left: 0; right: calc(3px + 38px + 3px + 10px); }
    /* v4.8.0: room on the right → the track reaches past the postings by
       exactly the coffee button + gap, so the sort pill itself is as wide
       as the postings (see fitSortBar) */
    #dst-seg.dst-wide { margin-right: calc(-1 * (3px + 38px + 3px + 10px)); }
    /* v3.10.0: a 20px bridge in the same domed look links the two pills; it
       runs under both of them (pills z-index -1, bridge -2) */
    #dst-seg-bridge {
      position: absolute;
      z-index: -2;
      top: 50%;
      height: 20px;
      right: calc(3px + 38px + 3px - 10px);
      width: 30px;
      transform: translateY(-50%);
      background: linear-gradient(to bottom,
        color-mix(in srgb, var(--dst-track) 35%, #fff),
        var(--dst-track) 55%,
        color-mix(in srgb, var(--dst-track) 94%, #000));
      box-shadow: 0 0 0 1px var(--dst-track-border),
        inset 0 1.5px 0 rgba(255, 255, 255, .95),
        inset 0 -2px 3px rgba(0, 0, 0, .08),
        0 3px 8px rgba(0, 0, 0, .18);
      pointer-events: none;
    }
    #dst-seg::after { right: 0; width: calc(3px + 38px + 3px); }
    /* v3.20.0: the active segment is a raised knob reaching over the edge of
       the pill. v4.8.0: the track stays neutral; only the knob shows the
       direction (data-tone, always set), see v4.17.0 below. */
    #dst-seg-thumb::before {
      content: '';
      position: absolute;
      inset: -1px;
      border-radius: 999px;
    }
    /* v4.17.0: a white knob; the direction shows as a fine coloured edge
       and a glow from below (was a 3px ring on a tinted knob) */
    #dst-seg-thumb[data-tone]::before { background: linear-gradient(to bottom, #fff, #f6f7f8); }
    #dst-seg-thumb[data-tone="pos"]::before { box-shadow: 0 0 0 1.5px rgba(46, 125, 50, .75), inset 0 0 0 1px rgba(255, 255, 255, .9), inset 0 -7px 12px -2px rgba(46, 125, 50, .45), 0 2px 6px rgba(0, 0, 0, .16), 0 1px 1.5px rgba(0, 0, 0, .12); }
    #dst-seg-thumb[data-tone="neg"]::before { box-shadow: 0 0 0 1.5px rgba(198, 40, 40, .75), inset 0 0 0 1px rgba(255, 255, 255, .9), inset 0 -7px 12px -2px rgba(198, 40, 40, .45), 0 2px 6px rgba(0, 0, 0, .16), 0 1px 1.5px rgba(0, 0, 0, .12); }
    /* click flash: a short glow ring in the direction's colour */
    @keyframes dst-glass-flash-pos {
      0%   { box-shadow: 0 0 0 1.5px rgba(46, 125, 50, .75), inset 0 0 0 1px rgba(255, 255, 255, .9), inset 0 -7px 12px -2px rgba(46, 125, 50, .45), 0 2px 6px rgba(0, 0, 0, .16), 0 1px 1.5px rgba(0, 0, 0, .12), 0 0 0 9px rgba(46, 125, 50, .35); }
      100% { box-shadow: 0 0 0 1.5px rgba(46, 125, 50, .75), inset 0 0 0 1px rgba(255, 255, 255, .9), inset 0 -7px 12px -2px rgba(46, 125, 50, .45), 0 2px 6px rgba(0, 0, 0, .16), 0 1px 1.5px rgba(0, 0, 0, .12), 0 0 0 1.5px rgba(46, 125, 50, 0); }
    }
    @keyframes dst-glass-flash-neg {
      0%   { box-shadow: 0 0 0 1.5px rgba(198, 40, 40, .75), inset 0 0 0 1px rgba(255, 255, 255, .9), inset 0 -7px 12px -2px rgba(198, 40, 40, .45), 0 2px 6px rgba(0, 0, 0, .16), 0 1px 1.5px rgba(0, 0, 0, .12), 0 0 0 9px rgba(198, 40, 40, .35); }
      100% { box-shadow: 0 0 0 1.5px rgba(198, 40, 40, .75), inset 0 0 0 1px rgba(255, 255, 255, .9), inset 0 -7px 12px -2px rgba(198, 40, 40, .45), 0 2px 6px rgba(0, 0, 0, .16), 0 1px 1.5px rgba(0, 0, 0, .12), 0 0 0 1.5px rgba(198, 40, 40, 0); }
    }
    #dst-seg-thumb.dst-flash[data-tone="pos"]::before { animation: dst-glass-flash-pos .45s ease-out; }
    #dst-seg-thumb.dst-flash[data-tone="neg"]::before { animation: dst-glass-flash-neg .45s ease-out; }
    @media (prefers-reduced-motion: reduce) {
      #dst-seg-thumb { transition: none; }
      #dst-seg-thumb.dst-flash[data-tone]::before { animation: none; }
    }
    .dst-badge-btn {
      flex: 1 1 0;
      min-width: 0;
      min-height: 38px;           /* + 2 x 3px track padding = 44px touch target */
      padding: 0 8px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;     /* label row on top, mode bar below */
      align-items: center;
      justify-content: center;
      gap: 5px;
      border-radius: 20px;
      font: inherit;
      font-size: 15px;            /* v3.14.1: like the usernames (was 13px) */
      font-weight: 600;
      line-height: 1;
      color: hsl(var(--dst-ink) / .8);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition: background-color .15s ease, color .15s ease;
    }
    /* Segments sit directly on the track (v3.1.4: no separate tiles any
       more — the sliding card marks the active one); it slides underneath. */
    #dst-seg .dst-badge-btn {
      position: relative;         /* above the sliding thumb */
      background: transparent;
    }
    /* v3.8.5: no hover colour change on the sort segments */
    /* v3.21.1: the glass knob works like a lens: label and bar of the active
       segment are shown 1.15x larger */
    #dst-seg .dst-badge-btn > * { transition: transform .3s ease, opacity .3s ease; }
    #dst-seg .dst-badge-btn.active > * { transform: scale(1.15); }
    /* v3.21.1: inactive segments recede (label and bar slightly faded), as
       the inactive badges did in v2.3.2–2.4.10 (opacity .65) */
    #dst-seg .dst-badge-btn[data-mode]:not(.active) > * { opacity: .65; }
    /* v4.16.0: press feedback like Apple's segmented control: pressing the
       active segment shrinks the knob a little, pressing another one dims
       its label; both spring back on release */
    #dst-seg-thumb::before { transition: transform .15s ease; }
    #dst-seg:has(> .dst-badge-btn.active:active) #dst-seg-thumb::before { transform: scale(.95); }
    #dst-seg .dst-badge-btn[data-mode]:not(.active):active > * { opacity: .35; transition-duration: .1s; }
    @media (prefers-reduced-motion: reduce) {
      #dst-seg .dst-badge-btn > *, #dst-seg-thumb::before { transition: none; }
    }
    #dst-seg .dst-badge-btn.active {
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
      min-width: 0;
      max-width: 100%;
    }
    .dst-btn-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* v3.15.0: mode bar in derStandard's rating-bar look (same colours,
       6px high, 2px gap, round outer ends); same size in every segment,
       its width follows the segment (i.e. the display) width */
    .dst-mode-bar {
      display: flex;
      gap: 2px;
      width: clamp(36px, 45%, 110px);
      height: 6px;
    }
    .dst-mode-bar > span { flex: 1 1 0; min-width: 4px; height: 100%; }
    .dst-mb-neg { background: rgb(213, 42, 42); border-radius: 3px 0 0 3px; }
    .dst-mb-pos { background: rgb(75, 120, 43); border-radius: 0 3px 3px 0; }
    .dst-mode-bar > span:only-child { border-radius: 3px; }
    .dst-mb-fade-new { background: linear-gradient(to right, rgb(75, 120, 43), rgba(75, 120, 43, .12)); }
    .dst-mb-fade-old { background: linear-gradient(to right, rgba(213, 42, 42, .12), rgb(213, 42, 42)); }
    /* v3.27.0: all rating bars slightly recessed ("stamped" into the raised
       bar, like iOS 6 slider tracks): a fine inner shadow at the top and a
       1px light edge below — no gloss, so the bar itself stays calm */
    .dst-mode-bar > span,
    .dst-vch-bar {
      box-shadow: inset 0 1px 1.5px rgba(0, 0, 0, .38), 0 1px 0 rgba(255, 255, 255, .85);
    }

    /* Coffee/Donate button — never active, round. v4.13.1: at rest it looks
       like the inactive sort segments (no ring, icon at .65); the golden
       ring only shows on hover and during the reminder (dst-pulsing).
       v3.7.0: inside the track as its last slot. v3.9.2: it fills its whole
       pill (44px, over the track padding), so the ring and the click flash
       sit on the pill's edge. Hovering lights the cup up, starts the steam
       and gives one short golden flash; the reminder (dst-pulsing) keeps the
       light background and the steam. */
    #dst-seg .dst-badge-btn.dst-coffee-btn {
      flex: 0 0 44px;
      width: 44px;
      margin: -3px -3px -3px 10px;     /* v3.8.5: 10px gap to the sort pill */
      min-height: 44px;
      padding: 0;
      border-radius: 50%;
      background: transparent;
      position: relative;
    }
    #dst-seg .dst-badge-btn.dst-coffee-btn > * { opacity: .65; transition: opacity .15s ease, transform .3s ease; }
    #dst-seg .dst-badge-btn.dst-coffee-btn:hover,
    #dst-seg .dst-badge-btn.dst-coffee-btn.dst-pulsing {
      background: #fff8e1;
      box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, .95), 0 0 0 2px rgba(230, 170, 0, .95), 0 2px 6px rgba(0, 0, 0, .12);
    }
    #dst-seg .dst-badge-btn.dst-coffee-btn:hover { animation: dst-coffee-flash .45s ease-out; }
    #dst-seg .dst-badge-btn.dst-coffee-btn:hover > *,
    #dst-seg .dst-badge-btn.dst-coffee-btn.dst-pulsing > *,
    #dst-seg .dst-badge-btn.dst-coffee-btn.dst-flash > * { opacity: 1; }
    .dst-badge-btn.dst-coffee-btn:hover .dst-coffee-icon,
    .dst-badge-btn.dst-coffee-btn.dst-pulsing .dst-coffee-icon {
      transform: scale(1.1);
    }
    @media (prefers-reduced-motion: reduce) {
      #dst-seg .dst-badge-btn.dst-coffee-btn:hover { animation: none; }
    }

    /* v3.7.0: golden click flash of the coffee button (like the sort flash) */
    @keyframes dst-coffee-flash {
      0%   { background-color: #FFE27A; box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, .95), 0 0 0 2px rgba(230, 170, 0, .95), 0 2px 6px rgba(0, 0, 0, .12), 0 0 0 10px rgba(255, 200, 0, .45); }
      100% { background-color: #fff8e1; box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, .95), 0 0 0 2px rgba(230, 170, 0, .95), 0 2px 6px rgba(0, 0, 0, .12), 0 0 0 0 rgba(255, 200, 0, 0); }
    }
    #dst-seg .dst-badge-btn.dst-coffee-btn.dst-flash { animation: dst-coffee-flash .45s ease-out; }

    /* v4.15.0: while all postings load, the coffee slot shows a progress
       ring with the percentage instead of the cup (no extra row, nothing
       moves). When done (v4.15.2, like Apple Pay / Google Drive): the ring
       closes, then fades while the button lights up golden like the coffee
       button on hover, and a green check draws itself; after a moment the
       cup comes back. */
    .dst-load-ring, .dst-load-pct, .dst-load-check { display: none; }
    #dst-seg .dst-coffee-btn.dst-loading > .dst-coffee-icon { opacity: 0 !important; }
    #dst-seg .dst-coffee-btn.dst-loading > .dst-load-ring {
      display: block; position: absolute; inset: 5px; border-radius: 50%; pointer-events: none;
      background: conic-gradient(hsl(var(--dst-ink) / .5) calc(var(--dst-p, 0) * 1%), hsl(var(--dst-ink) / .1) 0);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px));
    }
    #dst-seg .dst-coffee-btn.dst-loading > .dst-load-pct {
      display: flex; position: absolute; inset: 0; align-items: center; justify-content: center; pointer-events: none;
      font-size: 10.5px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums;
      color: hsl(var(--dst-ink) / .7);
    }
    #dst-seg .dst-coffee-btn.dst-load-done { animation: dst-load-gold .5s ease-out .2s both; }
    @keyframes dst-load-gold {
      0%   { background-color: rgba(255, 248, 225, 0); box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, 0), 0 0 0 2px rgba(230, 170, 0, 0), 0 2px 6px rgba(0, 0, 0, 0), 0 0 0 0 rgba(255, 200, 0, .5); }
      40%  { background-color: #FFE27A; box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, .95), 0 0 0 2px rgba(230, 170, 0, .95), 0 2px 6px rgba(0, 0, 0, .12), 0 0 0 10px rgba(255, 200, 0, .4); }
      100% { background-color: #fff8e1; box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, .95), 0 0 0 2px rgba(230, 170, 0, .95), 0 2px 6px rgba(0, 0, 0, .12), 0 0 0 12px rgba(255, 200, 0, 0); }
    }
    #dst-seg .dst-coffee-btn.dst-load-done > .dst-load-pct { display: none; }
    #dst-seg .dst-coffee-btn.dst-load-done > .dst-load-ring { animation: dst-ring-out .2s ease .2s both; }
    @keyframes dst-ring-out { to { opacity: 0; } }
    #dst-seg .dst-coffee-btn.dst-load-done > .dst-load-check {
      display: block; position: absolute; inset: 0; margin: auto; width: 26px; height: 26px;
      opacity: 1; overflow: visible; pointer-events: none;
    }
    .dst-load-check path {
      fill: none; stroke: #2e7d32; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round;
      stroke-dasharray: 1; stroke-dashoffset: 1;
    }
    #dst-seg .dst-coffee-btn.dst-load-done > .dst-load-check path { animation: dst-check-draw .3s cubic-bezier(.4, 0, .2, 1) .3s both; }
    @keyframes dst-check-draw { to { stroke-dashoffset: 0; } }
    @media (prefers-reduced-motion: reduce) {
      #dst-seg .dst-coffee-btn.dst-load-done {
        animation: none; background: #fff8e1;
        box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, .95), 0 0 0 2px rgba(230, 170, 0, .95), 0 2px 6px rgba(0, 0, 0, .12);
      }
      #dst-seg .dst-coffee-btn.dst-load-done > .dst-load-ring { display: none; }
      #dst-seg .dst-coffee-btn.dst-load-done > .dst-load-check path { animation: none; stroke-dashoffset: 0; }
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

    /* v3.5.1: the gap above the comment box comes from the bar (see above);
       below pinned postings their thread section already leaves 20px. */
    main.forum--main > dst-posting-box { margin-top: 0 !important; }
    /* v3.28.0: postings as cards — rounder corners, a fine frame in a darker
       shade of the article colour, a light top edge and a soft shadow */
    main.forum--main dst-posting.posting {
      border-radius: 14px !important;
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme--base, #e6e6e6) 80%, #000),
        inset 0 1.5px 0 rgba(255, 255, 255, .7),
        0 3px 10px rgba(0, 0, 0, .12) !important;
    }
    /* ═══ v4.3.0: POSTING CARDS ═════════════════════════════════════════
       derStandard's own arrangement (name, time and rating on top; − Antworten
       + below the text) in our style. v4.11.0: the footer is one symmetric
       row  💬 n  ·  − Antworten +  ·  ⋯  — "⋯" swaps it for Melden,
       Ausblenden, Kopieren, Teilen (v4.12.0).
       All icons are grey; colour only shows state: the rating top right and
       a vote you gave (derStandard fills − / + red / green itself).
       Everything is laid out on derStandard's own grids: only the column
       templates change, their named lines (marker, posting, …) stay. */
    main.forum--main { --dst-side: 14px; --dst-ic: 34px; --dst-gap: 6px; }
    @media (max-width: 600px) { main.forum--main { --dst-side: 6px; } }
    /* v4.14.0: below 640px derStandard's forum touches the window edges;
       10px on both sides keep the cards and the sort bar whole (round
       corners, frame and shadow) instead of cut off at the edge */
    @media (max-width: 639px) { main.forum--main { padding-left: 10px !important; padding-right: 10px !important; box-sizing: border-box; } }
    main.forum--main dst-posting[data-dst-tile] {
      grid-template-columns: [permalink-start marker-start] 0px [marker-end] var(--dst-side)
        [posting-start] minmax(0, 1fr) [posting-end] var(--dst-side) [permalink-end] !important;
      --posting-background: var(--theme--card);
      background-color: var(--theme--card) !important;
      container-type: inline-size;
    }
    /* replies: a card of their own instead of a ruled line */
    main.forum--main .thread dst-posting[data-dst-tile] {
      border: 1px solid hsl(var(--theme--on-secondary--hsl) / .15) !important;
      margin-top: 8px;            /* v4.13.5: was 12px — closer to the original density */
    }
    /* v4.1.0: threads like Reddit — each reply is indented and joined to the
       posting it answers by a line that comes down from above and bends into
       the reply at the height of the user name. derStandard's grey side bars
       and triangles are replaced. Every level is its own <section class=
       "thread"> right after its parent posting, so this is pure CSS: a reply
       draws its own bend (::before) and, if more replies follow on its level,
       the straight line further down (::after); a nested thread in between
       carries the line on (section ::before). */
    /* v4.13.6: lighter line (20%, was 32%), about the tone of the card
       frames; the bend has a small radius, so it runs into the card
       horizontally (like Reddit) instead of hooking into it */
    main.forum--main { --dst-ind: 32px; --dst-line: color-mix(in srgb, hsl(var(--theme--on-secondary--hsl)) 20%, var(--theme--base, #e6e6e6)); --dst-name-y: 28px; --dst-bend: 8px; }
    @media (max-width: 600px) { main.forum--main { --dst-ind: 18px; --dst-bend: 5px; } }
    main.forum--main .thread {
      background: none !important; border: 0 !important; border-radius: 0 !important;
      padding-left: var(--dst-ind); position: relative;
    }
    /* v4.19.4: the same 20px above every posting. derStandard put the gap
       below postings without replies and below open threads only, so
       postings with closed replies stuck to the next one. */
    main.forum--main > dst-posting,
    main.forum--main > dst-posting-box { margin: 20px 0 0 !important; } /* v4.19.5: the comment box too */
    main.forum--main > .thread { margin-bottom: 0 !important; }
    /* v4.19.2: replies closed until the reader opens them, on every level
       (markOpenThreads); the bubble shows closed like derStandard's own */
    :host(.dst-fold) main.forum--main dst-posting:not([data-dst-open]) + .thread { display: none !important; }
    :host(.dst-fold) main.forum--main dst-posting:not([data-dst-open]) .answers { --answers-filled: 1 !important; --answers-outline: 0 !important; }
    /* derStandard hides the number while a thread is open (v4.19.3) */
    :host(.dst-fold) main.forum--main dst-posting:not([data-dst-open]) .answers:not([data-dst-n]) span { display: block !important; }
    /* v4.19.4: deleted replies without replies of their own are hidden, like
       deleted postings at the top */
    main.forum--main .thread > dst-posting.posting-deleted:not(.posting-with-thread) { display: none !important; }
    main.forum--main .thread > dst-posting { position: relative; }
    /* v4.13.6: deleted postings too keep 8px to the card above, so the
       lines (which start 2px below it) never reach into that card */
    main.forum--main .thread > dst-posting:not([data-dst-tile]) { margin-top: 8px; }
    main.forum--main .thread > dst-posting::before,
    main.forum--main .thread > dst-posting::after,
    main.forum--main .thread > .thread::before {
      content: none; position: absolute !important;
      left: calc(var(--dst-ind) / -2 - 1px) !important;
      grid-area: auto !important; place-self: auto !important;
      margin: 0 !important; opacity: 1 !important;
      background: none !important; border-radius: 0 !important;
      pointer-events: none;
    }
    /* v4.11.0: deleted postings have no 1px frame — same line position */
    main.forum--main .thread > dst-posting:not([data-dst-tile])::before,
    main.forum--main .thread > dst-posting:not([data-dst-tile])::after {
      left: calc(var(--dst-ind) / -2) !important;
    }
    /* the bend into the reply: it starts 2px below the card above and stops
       3px before this card's frame, so no frame is ever crossed */
    main.forum--main .thread > dst-posting::before {
      content: '' !important;
      /* v4.13.5: it ends at the card's frame (no piece inside the card any
         more, it read like a dash before the user name) */
      top: -6px; height: calc(4px + var(--dst-name-y)) !important; width: calc(var(--dst-ind) / 2 - 3px) !important;
      border-left: 2px solid var(--dst-line); border-bottom: 2px solid var(--dst-line);
      border-bottom-left-radius: var(--dst-bend) !important;
    }
    /* when more replies follow, one straight trunk runs on past this reply
       (the bend branches off it, like on Reddit); the line colour is opaque,
       so the overlapping pieces join seamlessly */
    main.forum--main .thread > dst-posting:has(~ dst-posting:not(.posting-deleted:not(.posting-with-thread)))::after {
      content: '' !important;
      top: -6px; bottom: -8px; width: 0 !important; height: auto !important;
      border-left: 2px solid var(--dst-line);
    }
    /* … and past a nested thread between two replies */
    main.forum--main .thread > .thread:has(~ dst-posting:not(.posting-deleted:not(.posting-with-thread)))::before {
      content: ''; top: 0; bottom: -8px; width: 0; /* on to the next reply's line */
      left: calc(var(--dst-ind) / -2) !important; /* a section has no 1px frame */
      border-left: 2px solid var(--dst-line);
    }
    /* long user names are shortened with "…" (full name in the tooltip) */
    dst-posting[data-dst-tile] dst-posting--user { min-width: 0; max-width: 100%; overflow: hidden; }
    dst-posting[data-dst-tile] dst-posting--user > button { max-width: 100%; }
    dst-posting[data-dst-tile] dst-posting--user > button > span > span:first-child {
      display: inline-block; max-width: 100%; vertical-align: bottom;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* the rating top right is derStandard's own; its bar gets our recessed
       look like the bars in the sort bar */
    dst-posting[data-dst-tile] dst-posting--ratinglog button > div > div {
      border: 0 !important;
      box-shadow: inset 0 1px 1.5px rgba(0, 0, 0, .38), 0 1px 0 rgba(255, 255, 255, .85);
    }
    /* … level with the user name and larger: derStandard draws it 4px high
       and at most 50px wide; zoom keeps its own proportions (→ 6px / 80px) */
    dst-posting[data-dst-tile] dst-posting-head dst-posting--user { grid-column: 2 / 3 !important; }
    dst-posting[data-dst-tile] dst-posting-head dst-posting--ratinglog {
      grid-row: 1 !important; grid-column: 3 / 5 !important;
      align-self: center; justify-self: end; position: relative; top: 2px;
    }
    dst-posting[data-dst-tile] dst-posting--ratinglog button { font-size: 13px !important; padding: 3px 8px !important; }
    dst-posting[data-dst-tile] dst-posting--ratinglog button > div { zoom: 1.6; margin: 0 4px !important; }
    /* the "…" menu stays (its share submenu opens from it) but sits invisibly
       under our share icon */
    dst-posting[data-dst-tile] dst-posting-head dst-posting--context {
      position: absolute; width: var(--dst-ic); height: var(--dst-ic);
      /* v4.11.0: moved under "Teilen" from JS (its share menu opens there) */
      left: var(--dst-ctx-x, auto); top: var(--dst-ctx-y, auto);
      right: var(--dst-ctx-r, var(--dst-side)); bottom: var(--dst-ctx-b, 10px);
    }
    dst-posting[data-dst-tile] dst-posting-head dst-posting--context > button { opacity: 0; pointer-events: none; }
    /* pinned: derStandard's own pin with the text "Angeheftet" (v4.11.0) */
    /* footer: 💬n · − Antworten + · ⌄
       v4.5.4: every icon is the same glyph size (--dst-i) in a button of the
       same size (--dst-ic). v4.11.0: the reply icon sits bottom left (its
       number grows to the right, the icon never moves, as in derStandard's
       original), "⋯" bottom right, both the same distance from the edge. */
    dst-posting[data-dst-tile] {
      --dst-i: 22px;
      --dst-p: calc((var(--dst-ic) - var(--dst-i)) / 2);
    }
    dst-posting[data-dst-tile] dst-posting-footer {
      grid-template-columns: 1fr auto auto auto 1fr !important;
      column-gap: var(--dst-gap);
      padding: 0 !important;
      margin-top: 12px;
    }
    dst-posting[data-dst-tile] dst-posting-footer > * { grid-row: 1 !important; }
    dst-posting[data-dst-tile] dst-posting-footer .rate-down { grid-column: 2 !important; }
    dst-posting[data-dst-tile] dst-posting-footer dst-reply-postingbox { grid-column: 3 !important; }
    dst-posting[data-dst-tile] dst-posting-footer .rate-up { grid-column: 4 !important; }
    /* derStandard's report flag lives on (Melden in the row below clicks it),
       but takes no room in the footer */
    dst-posting[data-dst-tile] dst-posting-footer dst-dialog--report { grid-column: 1 !important; justify-self: start; }
    dst-posting[data-dst-tile] dst-posting-footer dst-dialog--report > button { display: none !important; }
    /* thread toggle ("💬 169"): bottom left; from 1.000 on "+1k" (updateTile) */
    dst-posting[data-dst-tile] dst-posting-footer .answers {
      grid-column: 1 !important; justify-self: start !important;
      margin: 0 !important; display: flex !important; align-items: center; justify-content: flex-start !important; gap: 4px !important;
      padding: 0 var(--dst-p) !important; height: var(--dst-ic); min-width: var(--dst-ic);
      color: hsl(var(--theme--on-secondary--hsl) / .7);
      font-variant-numeric: tabular-nums; overflow: visible;
    }
    /* every footer icon the same size, without padding of its own */
    dst-posting[data-dst-tile] dst-posting-footer svg {
      width: var(--dst-i) !important; height: var(--dst-i) !important;
      padding: 0 !important; margin: 0 !important; flex: none;
    }
    dst-posting[data-dst-tile] dst-posting-footer .answers[data-dst-n] span { display: none; }
    dst-posting[data-dst-tile] dst-posting-footer .answers[data-dst-n]::after { content: attr(data-dst-n); }
    /* v4.12.0: "⋯" bottom right, on the posting grid in the footer row.
       It swaps the row: 💬 / − Antworten + give way to Melden, Ausblenden,
       Kopieren, Teilen in the same place (nothing moves, nothing is covered);
       "⋯" turns into "‹" (back). Both glyphs in the same 22px box as the
       bubble, so they sit as far from the edge as the bubble on the left. */
    .dst-fb {
      grid-row: footer-start / footer-end; align-self: center;
      grid-column: posting-start / posting-end; justify-self: end;
      position: relative; z-index: 2; margin-top: 12px;
      width: var(--dst-ic); height: var(--dst-ic); padding: 0; border: 0; border-radius: 50%;
      background: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      color: hsl(var(--theme--on-secondary--hsl) / .7);
      transition: color .25s;
    }
    .dst-fb:hover { background: hsl(var(--theme--on-secondary--hsl) / .06); }
    .dst-fb svg { width: var(--dst-i); height: var(--dst-i); overflow: visible; }
    .dst-fb .dst-dots { fill: currentColor; }
    .dst-fb .dst-back { fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .dst-fb g { transform-origin: 12px 12px; transition: opacity .25s, transform .3s cubic-bezier(.3, .7, .3, 1); }
    .dst-fb .dst-back { opacity: 0; transform: translateX(5px) scale(.6); }
    dst-posting.dst-more-open > .dst-fb .dst-dots { opacity: 0; transform: scale(.5); }
    /* v4.12.1: "‹" is a side button — smaller and lighter than the four
       actions; full colour on hover / keyboard focus */
    dst-posting.dst-more-open > .dst-fb .dst-back { opacity: 1; transform: scale(.7); }
    dst-posting.dst-more-open > .dst-fb { color: hsl(var(--theme--on-secondary--hsl) / .45); }
    dst-posting.dst-more-open > .dst-fb:hover,
    dst-posting.dst-more-open > .dst-fb:focus-visible { color: hsl(var(--theme--on-secondary--hsl) / .8); }
    /* the action row lies in the footer row itself (0px high, so the card
       never changes its height) */
    .dst-more-row {
      grid-row: footer-start / footer-end; grid-column: posting-start / posting-end;
      align-self: center; height: 0; margin-top: 12px; position: relative; z-index: 1;
      display: flex; align-items: center; pointer-events: none;
    }
    .dst-more-row > div { flex: 1; }
    dst-posting.dst-more-open > .dst-more-row { pointer-events: auto; }
    .dst-more-acts {
      display: flex; justify-content: center; gap: 22px;
      opacity: 0; transform: translateY(10px);
      transition: opacity .25s, transform .3s cubic-bezier(.3, .7, .3, 1);
    }
    dst-posting.dst-more-open .dst-more-acts { opacity: 1; transform: none; transition-delay: .08s; }
    dst-posting[data-dst-tile] dst-posting-footer > * { transition: opacity .2s, transform .3s cubic-bezier(.3, .7, .3, 1); }
    dst-posting.dst-more-open dst-posting-footer > * { opacity: 0 !important; transform: translateY(-10px); pointer-events: none; }
    .dst-act {
      flex: 0 0 72px; display: flex; flex-direction: column; align-items: center; gap: 3px;
      padding: 2px 4px; border: 0; border-radius: 12px; background: none; cursor: pointer;
      font: inherit; font-size: 11.5px; line-height: 1.2;
      color: hsl(var(--theme--on-secondary--hsl) / .75);
    }
    .dst-act:hover { background: hsl(var(--theme--on-secondary--hsl) / .06); }
    .dst-act svg { width: 22px; height: 22px; }
    .dst-act.dst-done { color: #2e7d32; }
    .dst-act:focus-visible { outline: 2px solid hsl(var(--theme--on-secondary--hsl)); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) {
      .dst-fb, .dst-fb g, .dst-more-acts, dst-posting[data-dst-tile] dst-posting-footer > * { transition: none; }
    }
    dst-posting[data-dst-tile] dst-posting-footer dst-reply-postingbox button { white-space: nowrap; }
    /* narrow cards (phones, deeply indented replies): smaller icons and gaps */
    @container (max-width: 420px) {
      dst-posting-footer, .dst-fb, dst-posting-head { --dst-ic: 26px; --dst-gap: 2px; --dst-i: 19px;
        --dst-p: calc((var(--dst-ic) - var(--dst-i)) / 2); }
      dst-posting-footer .rate-down, dst-posting-footer .rate-up { width: 28px !important; }
      dst-posting-footer dst-reply-postingbox button { padding: 0 6px !important; }
      .dst-more-acts { gap: 4px; }
      .dst-act { flex-basis: 68px; }
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
    /* v4.4.1: hover like derStandard's user-name button (a light grey
       background); no underlined numbers */
    dst-posting--ratinglog.dst-votable button {
      border: 0 !important;
      border-radius: 11px !important;
      transition: background 0.15s ease !important;
    }
    dst-posting--ratinglog.dst-votable button:hover {
      background: hsl(var(--theme--on-base--hsl) / 5%) !important;
    }
    dst-posting--ratinglog.dst-votable button:active {
      background: hsl(var(--theme--on-base--hsl) / 8%) !important;
    }
    dst-posting--ratinglog.dst-votable button:focus-visible,
    .dst-fb:focus-visible {
      outline: 2px solid hsl(var(--theme--on-secondary--hsl)) !important;
      outline-offset: 2px;
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
      /* v3.25.0: same domed look as the sort bar */
      background: linear-gradient(to bottom,
        color-mix(in srgb, var(--dst-track) 35%, #fff),
        var(--dst-track) 40%,
        color-mix(in srgb, var(--dst-track) 96%, #000));
      border-radius: 14px;              /* v4.5.1: like the posting cards */
      /* v3.25.1: more depth — bevelled edge and a deep, layered shadow */
      box-shadow: 0 0 0 1px var(--dst-track-border),
        inset 0 1.5px 0 rgba(255, 255, 255, .95),
        inset 0 -3px 4px rgba(0, 0, 0, .08),
        0 28px 60px rgba(0, 0, 0, .38), 0 10px 20px rgba(0, 0, 0, .22), 0 2px 4px rgba(0, 0, 0, .2);
      width: 540px;                    /* v3.25.3: fixed width, names never stretch it */
      max-width: 100%;
      max-height: 80vh;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: inherit;
      color: hsl(var(--dst-ink));
      animation: dst-voter-pop 0.18s cubic-bezier(0.2, 0.8, 0.3, 1.1);
    }
    @keyframes dst-voter-pop { from { transform: scale(0.94); opacity: 0; } to { transform: scale(1); opacity: 1; } }

    /* Body: two columns */
    #dst-voter-body {
      display: flex;
      gap: 0;
      overflow: hidden;
      flex: 1 1 auto;
      min-height: 120px;
    }
    .dst-voter-col {
      flex: 1 1 0;                     /* v3.25.3: two equal halves, whatever the names */
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .dst-voter-col + .dst-voter-col { border-left: 1px solid hsl(var(--dst-ink) / .1); }
    /* v4.5.0: the white top of the window, with a straight edge to the list
       below; two equal halves (v4.7.0: one shared bar, see below) */
    #dst-voter-head {
      flex: 0 0 auto;
      display: flex;
      height: 56px;
      align-items: stretch;
      position: relative;
      z-index: 1;
      background: linear-gradient(to bottom, #fff, #f4f5f7);
      box-shadow: 0 1px 0 var(--dst-track-border), 0 4px 8px -4px rgba(0, 0, 0, .25);
    }
    /* v4.7.0: one bar like in the posting cards, scaled up: red left, green
       right, the gap between them on the column divider. Both numbers stand
       at fixed places (the ends of the full bar); the bars grow from the
       divider towards them — up to 10 votes one tenth per vote, then the
       bigger side full and the other in proportion (--f, set in JS). */
    .dst-voter-col-head {
      flex: 1 1 50%;
      min-width: 0;
      position: relative;
      --dst-vmax: min(160px, 100% - 70px);
    }
    .dst-voter-col-head.pos { box-shadow: -1px 0 0 rgba(0, 0, 0, .1); }
    .dst-vch-bar {
      position: absolute; top: 50%; height: 8px; margin-top: -4px;
      width: max(6px, calc(var(--f, 0) * var(--dst-vmax)));
    }
    .dst-voter-col-head.neg .dst-vch-bar { right: 2px; background: rgb(213, 42, 42); border-radius: 4px 0 0 4px; }
    .dst-voter-col-head.pos .dst-vch-bar { left: 1px; background: rgb(75, 120, 43); border-radius: 0 4px 4px 0; }
    .dst-voter-col-head.zero .dst-vch-bar { display: none; }
    .dst-vch-n {
      position: absolute; top: 50%; transform: translateY(-50%);
      font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1;
    }
    .dst-voter-col-head.neg .dst-vch-n { right: calc(var(--dst-vmax) + 12px); color: rgb(213, 42, 42); }
    .dst-voter-col-head.pos .dst-vch-n { left: calc(var(--dst-vmax) + 12px); color: rgb(75, 120, 43); }
    .dst-voter-col-head.zero .dst-vch-n { color: hsl(var(--dst-ink) / .4); }
    /* an empty column is greyed out */
    .dst-voter-list.dst-empty { background: hsl(var(--dst-ink) / .07); }
    .dst-voter-list {
      list-style: none;
      margin: 0;
      padding: 0 0 8px 0;
      overflow-y: auto;
      flex: 1 1 auto;
      /* v3.25.1: the list sits a little lower than the head (soft inner shadow) */
      box-shadow: inset 0 8px 8px -8px rgba(0, 0, 0, .18);
    }
    .dst-voter-list li { margin: 0; padding: 0; min-width: 0; }
    /* v3.25.1: a grid — fine lines and every other row shaded */
    .dst-voter-list li + li { border-top: 1px solid hsl(var(--dst-ink) / .08); }
    .dst-voter-list li:nth-child(even) { background: hsl(var(--dst-ink) / .045); }
    .dst-voter-list a {
      display: block;
      padding: 7px 14px;
      font-size: 14px;
      color: inherit;
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dst-voter-list a:hover { background: hsl(var(--dst-ink) / .06); }
    .dst-voter-list a:focus-visible { outline: 2px solid hsl(var(--dst-ink)); outline-offset: -2px; }
    /* v3.25.2: schwarzer Aufzählungspunkt, Tab-Abstand, dann der Name */
    .dst-voter-list a::before {
      content: '•';
      display: inline-block;
      width: 2em;
      color: hsl(var(--dst-ink));
      font-weight: 700;
    }

    /* Footer / pagination */
    #dst-voter-foot {
      flex: 0 0 auto;
      padding: 10px 14px 12px;
      border-top: 1px solid hsl(var(--dst-ink) / .1);
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

    /* v2.0.4: progress bar of the voter window (v4.15.0: loading the
       postings shows a ring in the coffee slot instead) */
    .dst-progress {
      width: 100%;
      height: 28px;
      background: hsl(var(--dst-ink) / .08);
      border-radius: 14px;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, .1);
      position: relative;
      overflow: hidden;
    }
    .dst-progress-fill {
      position: absolute;
      left: 0;
      top: 0;
      height: 100%;
      width: 0%;
      background: hsl(var(--dst-ink) / .18);
      border-radius: 14px;
      transition: width 0.4s ease;
    }
    .dst-progress-fill--loading {
      animation: dst-progress-pulse 1.5s ease-in-out infinite;
    }
    .dst-progress-text {
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
    @keyframes dst-progress-pulse { 0% { opacity: 1; } 50% { opacity: 0.7; } 100% { opacity: 1; } }
    .dst-voter-error {
      padding: 24px 20px;
      text-align: center;
      color: #c62828;
      font-size: 13px;
      width: 100%;
    }

    @media (max-width: 768px) {
      #dst-voter-card { max-height: 86vh; }
      .dst-voter-list a { padding: 9px 14px; }
    }
    @media (prefers-reduced-motion: reduce) {
      #dst-voter-overlay, #dst-voter-card, .dst-progress-fill--loading,
      .dst-steam-wisp { animation: none; }
    }

    /* ═══ v4.18.0: FLAT DESIGN (option in the popup) ═══════════════════
       The same layout without the glass look: flat fills and fine frames,
       no domes, highlights or drop shadows; the active knob is white with
       a 2px edge in the direction's colour. Set on the dst-forum host. */
    :host(.dst-flat) #dst-seg::before,
    :host(.dst-flat) #dst-seg::after,
    :host(.dst-flat) #dst-seg-bridge,
    :host(.dst-flat) #dst-feedback-bar {
      background: var(--dst-track) !important;
      box-shadow: 0 0 0 1px var(--dst-track-border) !important;
    }
    :host(.dst-flat) #dst-seg-thumb[data-tone]::before { background: #fff; }
    :host(.dst-flat) #dst-seg-thumb[data-tone="pos"]::before { box-shadow: 0 0 0 2px rgba(46, 125, 50, .85); }
    :host(.dst-flat) #dst-seg-thumb[data-tone="neg"]::before { box-shadow: 0 0 0 2px rgba(198, 40, 40, .85); }
    :host(.dst-flat) #dst-seg-thumb.dst-flash[data-tone="pos"]::before { animation-name: dst-flat-flash-pos; }
    :host(.dst-flat) #dst-seg-thumb.dst-flash[data-tone="neg"]::before { animation-name: dst-flat-flash-neg; }
    @keyframes dst-flat-flash-pos {
      0%   { box-shadow: 0 0 0 2px rgba(46, 125, 50, .85), 0 0 0 9px rgba(46, 125, 50, .3); }
      100% { box-shadow: 0 0 0 2px rgba(46, 125, 50, .85), 0 0 0 2px rgba(46, 125, 50, 0); }
    }
    @keyframes dst-flat-flash-neg {
      0%   { box-shadow: 0 0 0 2px rgba(198, 40, 40, .85), 0 0 0 9px rgba(198, 40, 40, .3); }
      100% { box-shadow: 0 0 0 2px rgba(198, 40, 40, .85), 0 0 0 2px rgba(198, 40, 40, 0); }
    }
    :host(.dst-flat) .dst-mode-bar > span,
    :host(.dst-flat) .dst-vch-bar,
    :host(.dst-flat) dst-posting[data-dst-tile] dst-posting--ratinglog button > div > div { box-shadow: none; }
    :host(.dst-flat) main.forum--main dst-posting.posting {
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme--base, #e6e6e6) 80%, #000) !important;
    }
    :host(.dst-flat) #dst-voter-card {
      background: var(--dst-track);
      box-shadow: 0 0 0 1px var(--dst-track-border);
    }
    :host(.dst-flat) #dst-voter-head { background: #fff; box-shadow: 0 1px 0 var(--dst-track-border); }
    :host(.dst-flat) .dst-voter-list { box-shadow: none; }
  `;

  let sortEnabled = true;
  let sortMode = 'balance-top'; // default
  let observer = null;
  let sortTimeout = null;
  let isSorting = false;
  let lastSortSignature = '';
  let isLoadingAllPostings = false; // v1.7.3: Guard for loadAllPostings
  let allLoadDone = false;          // v4.10.1: loadAllPostings ran to its end once
  // v1.6.10: Removed ratingChangeDebounce — we no longer observe rating attribute changes
  // This prevents the extension from interfering with derStandard.at's vote processing

  // v4.19.2: postings whose replies the reader opened (by posting id, so
  // both copies of a pinned posting count). All other reply threads stay
  // hidden by CSS; see markOpenThreads.
  const openThreadIds = new Set();

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

    // v4.7.0: one head for both columns: red bar + count left, green right.

    // Body with two columns
    const body = document.createElement('div');
    body.id = 'dst-voter-body';

    // v3.26.0: the heads sit together in one pill track above the columns
    const head = document.createElement('div');
    head.id = 'dst-voter-head';

    function makeColumn(kind, count, labelText) {
      const col = document.createElement('div');
      col.className = 'dst-voter-col';
      const colHead = document.createElement('div');
      colHead.className = 'dst-voter-col-head ' + kind;
      // v3.25.3: only the rating pill, the text lives in title/aria-label
      const label = count + ' ' + labelText + (Number(count) === 1 ? '' : 's');
      colHead.title = label;
      colHead.setAttribute('aria-label', label);
      const c = Number(count) || 0;
      const P = Number(posCount) || 0, N = Number(negCount) || 0, T = P + N;
      // derStandard's rule: one tenth per vote up to 10, then in proportion
      const f = T ? Math.min(T, 10) / 10 * c / Math.max(P, N) : 0;
      colHead.style.setProperty('--f', String(f));
      if (!c) colHead.classList.add('zero');
      const bar = document.createElement('span');
      bar.className = 'dst-vch-bar';
      bar.setAttribute('aria-hidden', 'true');
      const n = document.createElement('span');
      n.className = 'dst-vch-n';
      n.textContent = c ? (kind === 'pos' ? '+' : '\u2212') + c : '0';
      colHead.append(bar, n);
      const ul = document.createElement('ul');
      ul.className = 'dst-voter-list';
      if (!c) ul.classList.add('dst-empty');
      head.appendChild(colHead);
      col.appendChild(ul);
      return { col: col, ul: ul };
    }
    // v4.7.0: red left, green right — like the rating bar in the cards
    const negCol = makeColumn('neg', negCount, 'Dislike');
    const posCol = makeColumn('pos', posCount, 'Like');
    body.appendChild(negCol.col);
    body.appendChild(posCol.col);

    // Footer
    const foot = document.createElement('div');
    foot.id = 'dst-voter-foot';

    // v3.26.0: no "✕" any more — Escape or a click outside closes the window
    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(foot);
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

    // v2.0.4: the footer shows a progress bar (track, fill, pulse, centred
    // text) while loading, instead of a small circular spinner.
    function ensureProgressBar() {
      let bar = refs.foot.querySelector('.dst-progress');
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'dst-progress';
        const fill = document.createElement('div');
        fill.className = 'dst-progress-fill';
        const txt = document.createElement('span');
        txt.className = 'dst-progress-text';
        bar.appendChild(fill);
        bar.appendChild(txt);
        refs.foot.appendChild(bar);
      }
      return {
        bar: bar,
        fill: bar.querySelector('.dst-progress-fill'),
        txt: bar.querySelector('.dst-progress-text')
      };
    }

    function updateStatus() {
      const pb = ensureProgressBar();
      const total = totalPos + totalNeg;
      const loaded = loadedPos + loadedNeg;
      if (done) {
        pb.fill.style.width = '100%';
        pb.fill.classList.remove('dst-progress-fill--loading');
        pb.txt.textContent = loaded + ' Bewertungen geladen';
        // v4.5.0: the footer only shows while loading; the total is on top
        refs.foot.style.display = 'none';
      } else {
        const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        pb.fill.style.width = pct + '%';
        pb.fill.classList.add('dst-progress-fill--loading');
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
          // We already have some data — stop and say that the list is
          // incomplete (v4.10.1: the footer stays visible for this note).
          const pb = ensureProgressBar();
          pb.fill.style.width = '100%';
          pb.fill.classList.remove('dst-progress-fill--loading');
          pb.txt.textContent = (loadedPos + loadedNeg) + ' geladen \u2013 weitere Daten konnten nicht geladen werden.';
          revealBodyOnce();
          return;
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

  function attachVoterListener() {
    if (voterListenerAttached) return;
    voterListenerAttached = true;
    // Capture on document: fires before any of the page's own click handlers,
    // including the "STANDARD Smart" paywall trigger inside the rating element.
    document.addEventListener('click', handleRatingClick, true);
  }

  // ── v4.0.0 / v4.3.0: posting cards ───────────────────────────
  // Adds three footer icons (hide, copy, share) to every posting. They only
  // TRIGGER derStandard's own "…" menu — sharing, copying and hiding keep
  // working exactly as before. Rating, − / + and the report flag are
  // derStandard's own elements, only rearranged by CSS. The new elements are
  // plain children of <dst-posting>, placed on its grid by CSS;
  // derStandard's nodes are never moved, so Lit's rendering is not disturbed.
  const TILE_ICONS = {
    share: 'M18,16.08C17.24,16.08 16.56,16.38 16.04,16.85L8.91,12.7C8.96,12.47 9,12.24 9,12C9,11.76 8.96,11.53 8.91,11.3L15.96,7.19C16.5,7.69 17.21,8 18,8A3,3 0 0,0 21,5A3,3 0 0,0 18,2A3,3 0 0,0 15,5C15,5.24 15.04,5.47 15.09,5.7L8.04,9.81C7.5,9.31 6.79,9 6,9A3,3 0 0,0 3,12A3,3 0 0,0 6,15C6.79,15 7.5,14.69 8.04,14.19L15.16,18.34C15.11,18.55 15.08,18.77 15.08,19C15.08,20.61 16.39,21.91 18,21.91C19.61,21.91 20.92,20.61 20.92,19A2.92,2.92 0 0,0 18,16.08Z',
    copy: 'M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z',
    hide: 'M11.83,9L15,12.16C15,12.11 15,12.05 15,12A3,3 0 0,0 12,9C11.94,9 11.89,9 11.83,9M7.53,9.8L9.08,11.35C9.03,11.56 9,11.77 9,12A3,3 0 0,0 12,15C12.22,15 12.44,14.97 12.65,14.92L14.2,16.47C13.53,16.8 12.79,17 12,17A5,5 0 0,1 7,12C7,11.21 7.2,10.47 7.53,9.8M2,4.27L4.28,6.55L4.73,7C3.08,8.3 1.78,10 1,12C2.73,16.39 7,19.5 12,19.5C13.55,19.5 15.03,19.2 16.38,18.66L16.81,19.08L19.73,22L21,20.73L3.27,3M12,7A5,5 0 0,1 17,12C17,12.64 16.87,13.26 16.64,13.82L19.57,16.75C21.07,15.5 22.27,13.86 23,12C21.27,7.61 17,4.5 12,4.5C10.6,4.5 9.26,4.75 8,5.2L10.17,7.35C10.74,7.13 11.35,7 12,7Z',
    check: 'M9,20.42L2.79,14.21L5.62,11.38L9,14.77L18.88,4.88L21.71,7.71L9,20.42Z'
  };

  // v4.13.8: icons are built with createElementNS (AMO flags innerHTML)
  function svgEl(tag, attrs, children) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    (children || []).forEach(function (c) { el.appendChild(c); });
    return el;
  }

  function tileSvg(path) {
    return svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      [svgEl('path', { fill: 'currentColor', d: path })]);
  }

  function tileButton(cls, label, nodes, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append.apply(b, nodes);
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      onClick(b);
    });
    return b;
  }

  // Opens derStandard's "…" menu of a posting and clicks the item with the
  // given label (the menu is rendered lazily, so wait for it briefly).
  function runPostingMenu(posting, label) {
    const ctx = posting.querySelector('dst-posting--context');
    const trigger = ctx && ctx.querySelector(':scope > button');
    if (!trigger) return Promise.resolve(false);
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    return new Promise(function (resolve) {
      let tries = 0;
      (function look() {
        const item = Array.prototype.find.call(ctx.querySelectorAll('[role=menuitem]'), function (b) {
          return b.textContent.indexOf(label) !== -1;
        });
        if (item) { item.click(); resolve(true); }
        else if (++tries < 20) setTimeout(look, 25);
        else resolve(false);
      })();
    });
  }

  // v4.12.0: "⋯" (more) and "‹" (back) in one symbol, the CSS shows one of them
  function moreSvg() {
    return svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
      svgEl('g', { class: 'dst-dots' }, [4.5, 12, 19.5].map(function (cx) {
        return svgEl('circle', { cx: cx, cy: 12, r: 2.4 });
      })),
      svgEl('g', { class: 'dst-back' }, [svgEl('path', { d: 'M15.5 3 6.5 12l9 9' })])
    ]);
  }
  const FLAG_PATH = 'M14.4,6L14,4H5V21H7V14H12.6L13,16H20V6H14.4Z';

  // v4.11.0: one action of the unfolding row (symbol + short label)
  function tileAction(label, title, path, onClick) {
    const text = document.createElement('span');
    text.textContent = label;
    return tileButton('dst-act', title, [tileSvg(path), text], onClick);
  }

  function buildTile(posting) {
    // v4.12.0: "⋯" bottom right swaps the footer row for the four actions
    // of derStandard's "…" menu (they are rarely needed); "‹" swaps back
    function setOpen(open) {
      posting.classList.toggle('dst-more-open', open);
      more.setAttribute('aria-expanded', String(open));
      more.title = open ? 'Zurück' : 'Weitere Aktionen';
      more.setAttribute('aria-label', more.title);
      row.inert = !open;
    }
    const more = tileButton('dst-fb more', 'Weitere Aktionen', [moreSvg()], function () {
      setOpen(!posting.classList.contains('dst-more-open'));
    });
    more.setAttribute('aria-expanded', 'false');

    const share = tileAction('Teilen', 'Posting teilen', TILE_ICONS.share, function (btn) {
      // derStandard's share menu opens at its (invisible) "…" button: put
      // that button where our share button is
      // (CSS variables: derStandard re-renders the button's own style)
      const ctx = posting.querySelector('dst-posting--context');
      if (ctx) {
        // the menu hangs below that button, right-aligned with it; moved by
        // the difference, whatever box it is positioned in
        const r = btn.getBoundingClientRect();
        const c = ctx.getBoundingClientRect();
        const cs = getComputedStyle(ctx);
        posting.style.setProperty('--dst-ctx-x', (parseFloat(cs.left) + r.right - c.right) + 'px');
        posting.style.setProperty('--dst-ctx-y', (parseFloat(cs.top) + r.bottom - c.bottom) + 'px');
        posting.style.setProperty('--dst-ctx-r', 'auto');
        posting.style.setProperty('--dst-ctx-b', 'auto');
      }
      runPostingMenu(posting, 'Posting teilen');
      setOpen(false);
    });
    const copy = tileAction('Kopieren', 'Permalink kopieren', TILE_ICONS.copy, function (btn) {
      runPostingMenu(posting, 'Permalink kopieren').then(function (ok) {
        const trigger = posting.querySelector('dst-posting--context > button');
        if (trigger && trigger.getAttribute('aria-expanded') === 'true') trigger.click();
        if (!ok) { setOpen(false); return; }
        const icon = btn.querySelector('path');
        icon.setAttribute('d', TILE_ICONS.check);
        btn.classList.add('dst-done');
        setTimeout(function () {
          setOpen(false);
          icon.setAttribute('d', TILE_ICONS.copy);
          btn.classList.remove('dst-done');
        }, 1200);
      });
    });
    const hide = tileAction('Ausblenden', 'User:in ausblenden', TILE_ICONS.hide, function () {
      runPostingMenu(posting, 'ausblenden');
      setOpen(false);
    });
    // Melden: "Posting melden" from derStandard's "…" menu, otherwise its
    // own report button (kept, but hidden in the footer)
    const nativeFlag = posting.querySelector('dst-dialog--report svg path');
    const report = tileAction('Melden', 'Diesen Inhalt melden',
      (nativeFlag && nativeFlag.getAttribute('d')) || FLAG_PATH, function () {
        setOpen(false);
        runPostingMenu(posting, 'Posting melden').then(function (ok) {
          if (ok) return;
          const b = posting.querySelector('dst-dialog--report button');
          if (b) b.click();
        });
      });

    const row = document.createElement('div');
    row.className = 'dst-more-row';
    row.inert = true;
    const clip = document.createElement('div');
    const acts = document.createElement('div');
    acts.className = 'dst-more-acts';
    acts.append(report, hide, copy, share); // v4.11.2: left to right
    clip.appendChild(acts);
    row.appendChild(clip);

    posting.append(more, row);
    posting.setAttribute('data-dst-tile', '');
  }

  // Keeps our small additions in line with derStandard's data.
  function updateTile(posting) {
    // replies: up to 999 derStandard's own number (stays live), from 1.000
    // on "+1k", "+2k", …
    const ans = posting.querySelector('dst-posting-footer .answers');
    if (ans) {
      const n = parseInt((ans.textContent || '').replace(/\D/g, ''), 10) || 0;
      const label = n > 999 ? '+' + Math.floor(n / 1000) + 'k' : (n ? String(n) : '');
      if (n > 999) {
        if (ans.getAttribute('data-dst-n') !== label) ans.setAttribute('data-dst-n', label);
      } else if (ans.hasAttribute('data-dst-n')) {
        ans.removeAttribute('data-dst-n');
      }
      // v4.10.5: tooltip just the number, without "(x direkt, y indirekt)"
      const tip = n === 1 ? '1 Antwort' : n + ' Antworten';
      if (n && ans.title !== tip) ans.title = tip;
    }
    // the full user name as tooltip (long names are shortened with "…")
    const user = posting.querySelector('dst-posting--user > button');
    const name = user && user.querySelector('span > span');
    if (name && !user.title) user.title = name.textContent.trim();
  }

  function decorateTiles(shadowRoot) {
    const main = shadowRoot.querySelector('main.forum--main');
    if (!main) return;
    main.querySelectorAll('dst-posting.posting').forEach(decorateTile);
    observeTiles(main);
  }

  function decorateTile(p) {
    if (!p.querySelector(':scope > .dst-fb')) {
      // deleted postings keep their look
      if (p.classList.contains('posting-deleted') || !p.querySelector('dst-posting-footer')) return;
      buildTile(p);
    }
    updateTile(p);
  }

  // Watches new postings (they get their icons right away, also while the
  // rest is still loading in the background). Only OUR
  // additions are updated here — nothing is sorted and
  // derStandard's DOM is not touched (see the note at observeForum).
  let tileObserver = null;
  let tileObservedMain = null;
  function observeTiles(main) {
    if (tileObserver && tileObservedMain === main) return;
    if (tileObserver) tileObserver.disconnect();
    tileObservedMain = main;
    const pending = new Set();
    let scheduled = false;
    tileObserver = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        const t = m.target;
        if (!t.closest || t.closest('.dst-fb, .dst-more-row')) return;
        if (m.type === 'childList') {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType !== 1) return;
            if (n.tagName === 'DST-POSTING') pending.add(n);
            else if (n.querySelectorAll) n.querySelectorAll('dst-posting').forEach(function (q) { pending.add(q); });
          });
          const host = t.closest('dst-posting');
          if (host) pending.add(host);
        }
      });
      if (!pending.size || scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        pending.forEach(function (p) {
          if (p.isConnected && p.classList.contains('posting')) decorateTile(p);
        });
        pending.clear();
      });
    });
    tileObserver.observe(main, { subtree: true, childList: true });
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
  // v3.3.1: derStandard puts the exact time on <time data-date="09.10.2026,
  // 13:04"> (local time). Previously only the relative text ("vor 2 Tagen")
  // was read, so all postings of the same day/hour tied and New/Old sorted
  // only roughly.
  function parseDataDate(value) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4}),?\s+(\d{1,2}):(\d{2})/.exec(value || '');
    if (!m) return 0;
    const t = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime();
    return isNaN(t) ? 0 : t;
  }

  function getPostingTimestamp(posting) {
    // Strategy 0: exact time in <time data-date="…"> (current derStandard DOM)
    const dated = posting.querySelector('time[data-date]');
    if (dated) {
      const t = parseDataDate(dated.getAttribute('data-date'));
      if (t > 0) return t;
    }
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
          domIndex: groups.length,
          prevGroup: groups.length ? groups[groups.length - 1] : null
        };
        if (current.prevGroup) current.prevGroup.nextGroup = current;
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

  // v4.19.2: reply threads stay closed until the reader opens one. Only CSS
  // hides them (:host(.dst-fold), data-dst-open); we never click
  // derStandard's toggle any more. Those clicks re-rendered hundreds of
  // threads at once, opened replies everywhere and made the page jump.
  function markOpenThreads(shadowRoot, main) {
    const fold = !userPrefersExpandedThreads(); // the gear's "Antworten ausgeklappt"
    if (shadowRoot.host) shadowRoot.host.classList.toggle('dst-fold', fold);
    if (!fold) return;
    main.querySelectorAll('dst-posting').forEach((posting) => {
      const pid = getPostingId(posting);
      posting.toggleAttribute('data-dst-open', !!pid && openThreadIds.has(pid));
    });
  }

  // A real click on a toggle, on any level. A thread hidden only by us opens
  // without derStandard (it is open natively), everything else stays native.
  function onThreadToggle(shadowRoot, e) {
    if (!e.isTrusted || !shadowRoot.host || !shadowRoot.host.classList.contains('dst-fold')) return;
    const btn = e.target && e.target.closest && e.target.closest('button.answers');
    const posting = btn && btn.closest('dst-posting');
    const main = posting && posting.closest('main.forum--main');
    if (!main) return;
    const pid = getPostingId(posting);
    if (!pid) return;
    const expanded = posting.classList.contains('posting-has-thread-expanded');
    if (openThreadIds.has(pid)) {
      if (expanded) openThreadIds.delete(pid); // derStandard closes it
    } else {
      openThreadIds.add(pid);
      if (expanded) { e.stopPropagation(); e.preventDefault(); }
    }
    markOpenThreads(shadowRoot, main);
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
      time: needsTime ? postingTimeOf(group) : 0
    };
  }

  // v3.15.1: a deleted posting has no time of its own. If it has replies it
  // stays visible, so for Timeline it needs an estimate instead of 0 (which
  // put it at the very top of "oldest first" and the bottom of "newest
  // first"): the time of its earliest reply minus a minute (replies are not
  // always in the DOM — collapsed threads), else the time of its nearest
  // neighbour in derStandard's own (chronological) order. The estimate is
  // remembered on the element.
  function postingTimeOf(group) {
    const el = group.posting;
    const t = getPostingTimestamp(el);
    if (t > 0 || !el.classList.contains('posting-deleted')) return t;
    if (el.dataset.dstTime) return +el.dataset.dstTime;
    let earliest = 0;
    group.siblings.forEach(function(sib) {
      if (!sib.querySelectorAll) return;
      sib.querySelectorAll('time[data-date]').forEach(function(tEl) {
        const rt = parseDataDate(tEl.getAttribute('data-date'));
        if (rt > 0 && (earliest === 0 || rt < earliest)) earliest = rt;
      });
    });
    if (earliest > 0) {
      el.dataset.dstTime = String(earliest - 60000);
      return earliest - 60000;
    }
    for (let g = group.prevGroup, h = group.nextGroup; g || h; g = g && g.prevGroup, h = h && h.nextGroup) {
      const n = (g && getPostingTimestamp(g.posting)) || (h && getPostingTimestamp(h.posting));
      if (n > 0) return n;
    }
    return 0;
  }

  function keyOf(group) {
    if (!group.key) group.key = computeSortKey(group);
    return group.key;
  }

  // ── Sort comparator based on current mode ──────────────────────
  // v2.4.10 – sort definitions:
  //   Balance: Top  -> (positive - negative), highest first
  //   Balance: Low  -> (negative - positive), highest first  (= exact mirror)
  //   Pure (likes)  -> fewest dislikes first, then most likes (v4.5.0, see below)
  //   Pure (dislikes) -> the exact mirror
  // Ties always fall back to the original forum order (domIndex), so equal
  // scores never get shuffled by an unrelated secondary criterion.
  function sortComparator(a, b) {
    const ka = keyOf(a);
    const kb = keyOf(b);
    let diff = 0;
    switch (sortMode) {
      // v3.15.2: same balance (e.g. 5:5 and 2:2) -> more votes in total first
      case 'balance-top':   diff = (kb.net - ka.net) || ((kb.pos + kb.neg) - (ka.pos + ka.neg)); break;
      case 'balance-flop':  diff = (ka.net - kb.net) || ((kb.pos + kb.neg) - (ka.pos + ka.neg)); break;
      // v3.17.0: "Pure", likes direction: first the purely positive postings
      // (no dislike), then those with exactly 1 dislike, then 2, … — within
      // each step the most likes first. Postings without any like come last.
      // The dislikes direction mirrors this. Nothing is hidden.
      // v4.5.0: back to these plain steps for every posting (no longer only
      // where the chosen side outweighs the other).
      case 'positive-only':
        diff = ((ka.pos === 0) - (kb.pos === 0)) || (ka.neg - kb.neg) || (kb.pos - ka.pos);
        break;
      case 'negative-only':
        diff = ((ka.neg === 0) - (kb.neg === 0)) || (ka.pos - kb.pos) || (kb.neg - ka.neg);
        break;
      case 'chronological-new': diff = kb.time - ka.time; break;
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
    // For the timeline modes we don't need ratings at all
    if (sortMode.indexOf('chronological') === 0) return true;
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
      markOpenThreads(shadowRoot, main);

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
        // The badge bar always stays in front of the postings
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

      // When the gear wants threads expanded, make pinned postings match the
      // normal ones (derStandard leaves pinned collapsed).
      expandPinnedThreads(main);
    } finally {
      isSorting = false;
      // while loading in the background, loadAllPostings reconnects at its end
      if (!isLoadingAllPostings) observeForum(shadowRoot);
    }
  }

  // ── Badge bar: 3 grouped toggle badges + coffee ───────────────
  async function changeSortMode(newMode, shadowRoot) {
    completeNotice = null; // the 100% ring needs no re-render after a re-sort
    sortMode = newMode;
    syncGroupSelection();

    chrome.storage.sync.set({ [MODE_KEY]: sortMode });

    lastSortSignature = '';

    // v1.7.4: Load all postings before re-sorting (if not yet loaded).
    // v4.10.1: only while that never ran to its end, or when the forum offers
    // more again — otherwise every click could wait for the load timeout.
    if (!allLoadDone || findLoadMoreButton(shadowRoot)) {
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

  // Label + mode bar of one segment (v3.1.2: also used to update a
  // segment in place on click, before the re-sort re-creates the bar).
  function fillSegment(btn, group, mode) {
    const m = MODE_DEFS[mode];
    btn.textContent = '';
    btn.setAttribute('data-mode', mode);
    btn.title = m.title;
    btn.setAttribute('aria-label', m.title);
    // AMO Security Fix: createElement statt innerHTML
    const topRow = document.createElement('span');
    topRow.className = 'dst-btn-toprow';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'dst-btn-label';
    labelSpan.textContent = m.label;
    topRow.appendChild(labelSpan);
    btn.appendChild(topRow);
    btn.appendChild(buildModeBar(mode));
  }

  // v3.6.0: the active pill is green, or red for the "low" modes (as the
  // active badge of the old design), and flashes on every click.
  // v3.13.0: also Old (Timeline) — green = first, red = second direction
  const LOW_MODES = ['balance-flop', 'negative-only', 'chronological-old'];
  function toneOf(mode) { return LOW_MODES.indexOf(mode) !== -1 ? 'neg' : 'pos'; }
  function flashThumb(thumb, mode) {
    thumb.setAttribute('data-tone', toneOf(mode));
    thumb.classList.remove('dst-flash');
    requestAnimationFrame(() => thumb.classList.add('dst-flash'));   // restart
    if (!thumb.dataset.flashHooked) {
      thumb.dataset.flashHooked = '1';
      thumb.addEventListener('animationend', () => thumb.classList.remove('dst-flash'));
    }
  }

  // The mode the bar shows (a pending click wins over the current sort) —
  // and groupSelection updated to match it.
  function syncShownSelection() {
    syncGroupSelection();
    if (pendingMode) setDirectionAll(pendingMode);
    return pendingMode || sortMode;
  }

  // v3.1.4: bring an existing bar up to date without re-creating it, so a
  // running slide animation (and the progress display) survive a re-sort.
  function updateSortBar(bar) {
    const shownMode = syncShownSelection();
    const activeIdx = BUTTON_GROUPS.findIndex((g) => g.modes.indexOf(shownMode) !== -1);
    const seg = bar.querySelector('#dst-seg');
    const thumb = seg.querySelector('#dst-seg-thumb');
    const btns = seg.querySelectorAll('.dst-badge-btn');
    BUTTON_GROUPS.forEach((group, i) => {
      const b = btns[i];
      if (!b) return;
      b.classList.toggle('active', i === activeIdx);
      b.setAttribute('aria-pressed', i === activeIdx ? 'true' : 'false');
      const mode = groupSelection[group.id];
      if (b.getAttribute('data-mode') !== mode) fillSegment(b, group, mode);
    });
    if (thumb) {
      thumb.style.display = activeIdx === -1 ? 'none' : '';
      if (activeIdx !== -1) thumb.style.setProperty('--dst-i', String(activeIdx));
      thumb.setAttribute('data-tone', toneOf(shownMode));
    }
  }

  // Width the round coffee button takes inside the track, incl. its gap and
  // (v3.8.5) the 10px gap between the two pills plus the pill padding.
  const COFFEE_SLOT = 38 + 3 + 13;

  function injectSortBadge(shadowRoot) {
    if (shadowRoot.host) shadowRoot.host.classList.toggle('dst-flat', flatDesign);
    const header = shadowRoot.querySelector('.forum--header');
    if (!header) return;

    // Inject CSS into shadow DOM (once)
    if (!shadowRoot.querySelector('#dst-icon-style')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'dst-icon-style';
      styleEl.textContent = ICON_STYLE_CSS;
      shadowRoot.appendChild(styleEl);
    }

    // v4.0.0: tiles for all postings loaded so far (runs on every sort)
    decorateTiles(shadowRoot);

    // v1.9.18: Enable the clickable voter popup on the rating numbers.
    attachVoterListener();
    // Mark rating elements as votable for the hover style hint.
    try {
      shadowRoot.querySelectorAll('dst-posting--ratinglog:not(.dst-votable)').forEach(function (el) {
        el.classList.add('dst-votable');
      });
    } catch (e) { /* ignore */ }

    // v3.1.4: a bar that is still in place is only UPDATED. Re-creating it on
    // every sort (several times while postings load in the background)
    // cancelled the slide animation — the active card just jumped.
    const existingBar = shadowRoot.querySelector('#dst-badge-bar');
    const mainForBar = shadowRoot.querySelector('main.forum--main');
    if (existingBar && mainForBar && existingBar.parentNode === mainForBar &&
        existingBar.querySelector('#dst-seg')) {
      updateSortBar(existingBar);
      fitSortBar(existingBar);
      return;
    }
    if (existingBar) existingBar.remove();
    if (!mainForBar) return;

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
    // label of its currently-selected sub-mode and cycles through its
    // sub-modes on click. Exactly one group is "active" at any time (the one
    // that owns the current sortMode).
    // v3.1.0: the three groups form ONE segmented control (#dst-seg).
    // v3.1.2: while a click's re-sort is still pending, the bar shows the
    // clicked mode (pendingMode), not the one the forum is sorted by yet.
    const shownMode = syncShownSelection();
    const seg = document.createElement('div');
    seg.id = 'dst-seg';
    // v4.16.0: Safari on iOS only applies :active (press feedback) when a
    // touch listener exists
    seg.addEventListener('touchstart', function () {}, { passive: true });
    const n = BUTTON_GROUPS.length;
    const activeIdx = BUTTON_GROUPS.findIndex((g) => g.modes.indexOf(shownMode) !== -1);
    const thumb = document.createElement('div');
    thumb.id = 'dst-seg-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    // v3.7.0: the coffee button sits at the end of the track (COFFEE_SLOT)
    thumb.style.width = 'calc((100% - ' + (6 + 3 * (n - 1) + COFFEE_SLOT) + 'px) / ' + n + ' + 8px)';
    thumb.style.setProperty('--dst-i', String(activeIdx));
    thumb.setAttribute('data-tone', toneOf(shownMode));
    if (activeIdx === -1) thumb.style.display = 'none';
    seg.appendChild(thumb);
    // v3.10.0: a bridge between the sort pill and the coffee pill
    const bridge = document.createElement('div');
    bridge.id = 'dst-seg-bridge';
    bridge.setAttribute('aria-hidden', 'true');
    seg.appendChild(bridge);

    BUTTON_GROUPS.forEach((group, groupIdx) => {
      const isActive = groupIdx === activeIdx;
      const btn = document.createElement('div');
      btn.className = 'dst-badge-btn' + (isActive ? ' active' : '');
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
          // v3.19.0: switching to a different group keeps the direction
          // (green stays green, red stays red).
          targetMode = groupSelection[group.id];
        }
        const slides = group.modes.indexOf(current) === -1;
        setDirectionAll(targetMode);

        // v3.1.2: show the new state at once — the active card slides over
        // (0.3s) or the segment flips its direction — and only re-sort
        // afterwards. Sorting a large forum blocks the page for a moment;
        // done first, it would swallow the animation.
        seg.querySelectorAll('.dst-badge-btn').forEach((b, i) => {
          b.classList.toggle('active', i === groupIdx);
          b.setAttribute('aria-pressed', i === groupIdx ? 'true' : 'false');
        });
        seg.querySelectorAll('.dst-badge-btn[data-mode]').forEach((b, i) => {
          if (BUTTON_GROUPS[i]) fillSegment(b, BUTTON_GROUPS[i], groupSelection[BUTTON_GROUPS[i].id]);
        });
        thumb.style.display = '';
        thumb.style.setProperty('--dst-i', String(groupIdx));

        // A newer click supersedes a re-sort that has not started yet.
        const token = ++pendingClick;
        pendingMode = targetMode;
        const sortNow = () => {
          if (token !== pendingClick) return;
          pendingMode = null;
          changeSortMode(targetMode, shadowRoot);   // re-renders the bar too
        };
        // v3.4.1: flash right away (while sliding); re-sort once slide and
        // flash are over — a large forum's re-sort blocks the page and would
        // otherwise swallow them.
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduce) {
          requestAnimationFrame(() => setTimeout(sortNow, 0));
        } else {
          flashThumb(thumb, targetMode);
          setTimeout(sortNow, 460);
        }
      });

      seg.appendChild(btn);
    });
    bar.appendChild(seg);

    // ── Coffee / Donate button (4th badge, not a sort mode) ─────
    const coffeeBtn = document.createElement('div');
    coffeeBtn.className = 'dst-badge-btn dst-coffee-btn';
    makeKeyboardButton(coffeeBtn, 'Unterstützen');
    // AMO Security Fix: createElement statt innerHTML
    const coffeeIcon = document.createElement('span');
    coffeeIcon.className = 'dst-coffee-icon';
    coffeeIcon.style.cssText = 'display:inline-flex;line-height:1;vertical-align:middle;position:relative';
    // v3.10.0: the same cup on every system (Noto Emoji, see icons/NOTICE.txt)
    // instead of the ☕ character, which looks different on every OS
    const coffeeImg = document.createElement('img');
    coffeeImg.src = chrome.runtime.getURL('icons/coffee.svg');
    coffeeImg.alt = '';
    coffeeImg.width = 20;
    coffeeImg.height = 20;
    coffeeImg.draggable = false;
    coffeeIcon.appendChild(coffeeImg);
    coffeeBtn.appendChild(coffeeIcon);
    // v4.15.0: progress ring + percentage, shown only while postings load
    const loadRing = document.createElement('span');
    loadRing.className = 'dst-load-ring';
    const loadPct = document.createElement('span');
    loadPct.className = 'dst-load-pct';
    const loadCheck = svgEl('svg', { class: 'dst-load-check', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      [svgEl('path', { d: 'M5.5 12.5l4.2 4.2L18.5 7.5', pathLength: 1 })]);
    coffeeBtn.append(loadRing, loadPct, loadCheck);
    // V14 Dampf-Container mit 5 feinen Wisps
    const steamContainer = document.createElement('div');
    steamContainer.className = 'dst-steam-container';
    for (let i = 0; i < 5; i++) {
      const wisp = document.createElement('div');
      wisp.className = 'dst-steam-wisp';
      steamContainer.appendChild(wisp);
    }
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
    // Pulse formula: day(n) = 30 · (1.5^(n+1) - 1) → 1st: day 15, 2nd: day 37.5, 3rd: day 71.25, …
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
      // v3.7.0: golden click flash like the sort segments' flash
      const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      coffeeBtn.classList.remove('dst-flash');
      if (!reduceMotion) requestAnimationFrame(() => coffeeBtn.classList.add('dst-flash'));
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
      // Open the page once the flash has been seen (still within the click's
      // user activation, so it is not blocked as a popup).
      setTimeout(() => window.open('https://buymeacoffee.com/diversion', '_blank'), reduceMotion ? 0 : 350);
    });
    coffeeBtn.addEventListener('animationend', (e) => {
      if (e.animationName === 'dst-coffee-flash') coffeeBtn.classList.remove('dst-flash');
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

    // v3.7.0: inside the track, as its last (round) slot
    seg.appendChild(coffeeBtn);

    // v2.2.7: Insert the bar as the FIRST CHILD of main.forum--main so it
    // inherits that container's exact width (aligns with the composer frame &
    // posting entries).
    mainForBar.insertBefore(bar, mainForBar.firstChild);

    fitSortBar(bar);
    if (!fitSortBar.bound) {
      fitSortBar.bound = true;
      window.addEventListener('resize', function () {
        const f = document.querySelector('dst-forum');
        const b = f && f.shadowRoot && f.shadowRoot.querySelector('#dst-badge-bar');
        if (b) fitSortBar(b);
      });
    }

    if (completeNotice) renderCompleteNotice(shadowRoot);
    else if (isLoadingAllPostings && lastProgress) showProgressBar(shadowRoot, ...lastProgress);
  }

  // v4.8.0: when there is room right of the postings, the sort pill gets the
  // exact width of the postings and the coffee button (with its bridge) sits
  // outside, in the free space on the right. Otherwise (phones, narrow
  // windows) the coffee button stays inside that width, as before.
  function fitSortBar(bar) {
    const seg = bar.querySelector('#dst-seg');
    if (!seg) return;
    const free = document.documentElement.clientWidth - bar.getBoundingClientRect().right;
    seg.classList.toggle('dst-wide', free >= 54 + 16);
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
  //     c) Page load
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

  // v4.15.0: the loading progress is a ring in the coffee slot
  function showProgressBar(shadowRoot, loaded, total, done) {
    const btn = shadowRoot.querySelector('#dst-seg .dst-coffee-btn');
    if (!btn) return;
    lastProgress = [loaded, total, done];
    // v2.4.1: a trustworthy total is always >= the number already loaded
    const validTotal = (total && total >= loaded) ? total : 0;
    const pct = done ? 100 : (validTotal > 0 ? Math.min(99, Math.floor(loaded / validTotal * 100)) : 0);
    btn.classList.add('dst-loading');
    btn.style.setProperty('--dst-p', String(pct));
    btn.querySelector('.dst-load-pct').textContent = pct + '%';
    btn.title = done ? 'Alle ' + loaded + ' Postings geladen'
      : 'Lade alle Postings… ' + loaded + (validTotal > 0 ? ' / ' + validTotal : '');
  }

  function hideProgressBar(shadowRoot) {
    lastProgress = null;
    const btn = shadowRoot.querySelector('#dst-seg .dst-coffee-btn');
    if (!btn) return;
    btn.classList.remove('dst-loading', 'dst-load-done');
    btn.style.removeProperty('--dst-p');
    btn.removeAttribute('title');
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
    // done: the ring closes, a golden flash and a green check drawing itself
    showProgressBar(shadowRoot, completeNotice.total, completeNotice.total, true);
    const btn = bar.querySelector('.dst-coffee-btn');
    if (btn) btn.classList.add('dst-load-done');
  }

  function showProgressComplete(shadowRoot, totalPostings) {
    const notice = { total: totalPostings };
    completeNotice = notice;
    renderCompleteNotice(shadowRoot);

    // the 100% stays for a moment, then the cup comes back. Timed by frames:
    // right after loading the final sort keeps the page busy and delayed a
    // plain setTimeout by several seconds.
    const t0 = performance.now();
    (function wait() {
      if (performance.now() - t0 < 1800) { requestAnimationFrame(wait); return; }
      if (completeNotice === notice) completeNotice = null;
      if (!isLoadingAllPostings) hideProgressBar(shadowRoot);
    })();
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
      let done = false, timer, poll, framePending = false;
      // v4.10.1: at most one check per frame — every check asks forum-hook.js
      // for the whole load state, and mutations come in bursts
      const mutations = new MutationObserver(function () {
        if (framePending) return;
        framePending = true;
        requestAnimationFrame(function () { framePending = false; check(); });
      });
      function finish(result) {
        if (done) return;
        done = true;
        mutations.disconnect();
        clearTimeout(timer);
        clearInterval(poll);
        resolve(result);
      }
      function check() {
        if (done) return;
        try {
          if (!sortEnabled) return finish(false);
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
    if (isLoadingAllPostings || !sortEnabled) return false;
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
      while (sortEnabled) {
        const before = readForumLoadState(shadowRoot);
        const beforeCount = countRendered();

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
        // v4.15.0: only once there is really something to load (a forum that
        // is complete from the start never shows the ring)
        showProgressBar(shadowRoot, before?.loaded ?? beforeCount,
          before?.total || getTotalPostingCount(shadowRoot));

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
      allLoadDone = true;
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
      shadowRoot.addEventListener('click', function (e) { onThreadToggle(shadowRoot, e); }, true);
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
    // v4.10.1: a forum without postings would otherwise be watched for good
    setTimeout(function () { innerObs.disconnect(); }, 60000);
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
    if (sortEnabled) {
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
    // v3.5.0: Best/Worst (3.2.0–3.4.1) went back to Likes/Dislikes
    if (currentMode === 'best' || currentMode === 'positive') return 'positive-only';
    if (currentMode === 'worst') return 'negative-only';
    // Check legacy boolean key (very old versions)
    if (data.sortByPositive === true) return 'positive-only';
    if (data.sortByPositive === false) return 'balance-top';
    // Default
    return 'balance-top';
  }

  // ── Storage: persist enabled state & sort mode ─────────────────
  function loadState(callback) {
    if (chrome?.storage?.sync) {
      chrome.storage.sync.get([SORT_KEY, MODE_KEY, FLAT_KEY, 'sortByPositive', 'dstTintEdge'], (data) => {
        data = data || {};
        flatDesign = data[FLAT_KEY] === true;
        applyFlat();
        // v4.10.1: setting of the removed "Farbmarkierung" option
        if ('dstTintEdge' in data) chrome.storage.sync.remove('dstTintEdge');
        sortEnabled = data[SORT_KEY] !== false;
        sortMode = migrateStorage(data);
        syncGroupSelection();

        // Persist migrated mode if it changed
        const oldMode = data[MODE_KEY];
        if (oldMode !== sortMode) {
          chrome.storage.sync.set({ [MODE_KEY]: sortMode });
          log('[DST Sorter] Migrated sort mode from "' + oldMode + '" to "' + sortMode + '"');
        }

        callback();
      });
    } else {
      callback();
    }
  }

  // Listen for messages from popup
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'toggle') {
        sortEnabled = msg.enabled;
        // v2.4.10: reload in both directions. Switching ON previously only
        // sorted once, without background loading, observer or voter popup.
        // v4.10.1: also when the forum has not finished mounting yet.
        if (document.querySelector('dst-forum')) location.reload();
      }
    });
  }

  // ── Entry point ───────────────────────────────────────────────
  loadState(() => {
    if (sortEnabled) waitForForum();
  });

})();
