import { describe, it, expect } from 'vitest';
import { loadContent } from '../helpers/setup.js';
import { createPosting, buildForum } from '../helpers/forum.js';

function html(doc, markup) {
  const t = doc.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

describe('isPinnedPosting', () => {
  it.each([
    '<dst-posting pinned></dst-posting>',
    '<dst-posting data-pinned></dst-posting>',
    '<dst-posting ispinned="true"></dst-posting>',
    '<dst-posting is-pinned="true"></dst-posting>',
    '<dst-posting class="posting pinned"></dst-posting>',
    '<dst-posting class="posting--pinned"></dst-posting>',
    '<dst-posting><div class="is-pinned"></div></dst-posting>',
    '<dst-posting><span class="angeheftet"></span></dst-posting>',
    '<dst-posting><div>Angeheftet</div></dst-posting>',
    '<dst-posting><dst-posting-head>Max · Angeheftet</dst-posting-head></dst-posting>',
    '<dst-posting><header><strong>📌 Angeheftet</strong></header></dst-posting>',
    '<dst-posting><header><b>📌</b></header></dst-posting>'
  ])('detects %s', async (markup) => {
    const { c, env } = await loadContent();
    expect(c.isPinnedPosting(html(env.document, markup))).toBe(true);
  });

  it('detects the label inside the posting shadow DOM', async () => {
    const { c, env } = await loadContent();
    const p = createPosting(env.document, {});
    p.attachShadow({ mode: 'open' }).innerHTML = '<div><span>📌 Angeheftet</span></div>';
    expect(c.isPinnedPosting(p)).toBe(true);

    const q = createPosting(env.document, {});
    q.attachShadow({ mode: 'open' }).innerHTML = '<div class="sticky"></div>';
    expect(c.isPinnedPosting(q)).toBe(true);
  });

  it.each([
    // Regression (v2.4.10): the word inside the user's own text must not pin it.
    '<dst-posting><p><span>Angeheftet</span> wurde hier gar nichts</p></dst-posting>',
    '<dst-posting><p>📌 Angeheftet ist mein Lieblingswort</p></dst-posting>',
    '<dst-posting><div><blockquote><strong>angeheftet</strong> sagt er</blockquote></div></dst-posting>',
    '<dst-posting><ul><li><b>📌</b></li></ul></dst-posting>',
    '<dst-posting><span>Angeheftet an die Wand</span></dst-posting>',
    '<dst-posting class="unpinned-thing"></dst-posting>',
    '<dst-posting ispinned="false"></dst-posting>',
    '<dst-posting></dst-posting>'
  ])('does not pin %s', async (markup) => {
    const { c, env } = await loadContent();
    expect(c.isPinnedPosting(html(env.document, markup))).toBe(false);
  });

  it.each([
    '<dst-posting><p>Angeheftet</p></dst-posting>',
    '<dst-posting><div><p>Angeheftet</p></div></dst-posting>',
    '<dst-posting><blockquote>pinned</blockquote></dst-posting>'
  ])('a one-word user text "Angeheftet" does not pin: %s', async (markup) => {
    const { c, env } = await loadContent();
    expect(c.isPinnedPosting(html(env.document, markup))).toBe(false);
  });

  it('a bare label element directly in the posting still pins', async () => {
    const { c, env } = await loadContent();
    expect(c.isPinnedPosting(html(env.document, '<dst-posting><div>Angeheftet</div></dst-posting>'))).toBe(true);
  });
});

describe('getPostingId / getStablePostingId', () => {
  it('prefers direct id attributes', async () => {
    const { c, env } = await loadContent();
    const p = html(env.document, '<dst-posting data-posting-id="direct"><dst-posting--ratinglog postingid="nested"></dst-posting--ratinglog></dst-posting>');
    expect(c.getPostingId(p)).toBe('direct');
  });

  it('uses the nested ratinglog postingid', async () => {
    const { c, env } = await loadContent();
    expect(c.getPostingId(createPosting(env.document, { id: '3FO5eHTfBXdAobg1YdEqB6a3jUu' }))).toBe('3FO5eHTfBXdAobg1YdEqB6a3jUu');
  });

  it('falls back to ratinglog-<id> and flyout-trigger-<kind>-<id> element ids', async () => {
    const { c, env } = await loadContent();
    const doc = env.document;
    expect(c.getStablePostingId(html(doc, '<dst-posting><div id="ratinglog-ABC"></div></dst-posting>'))).toBe('ABC');
    expect(c.getStablePostingId(html(doc, '<dst-posting><button id="flyout-trigger-identity-XYZ"></button></dst-posting>'))).toBe('XYZ');
    expect(c.getStablePostingId(html(doc, '<dst-posting></dst-posting>'))).toBeNull();
  });

  it('pinned copy and in-list twin share the same id even with stale ratings', async () => {
    const { c, env } = await loadContent();
    const a = createPosting(env.document, { id: 'SAME', pos: 5, pinned: true });
    const b = createPosting(env.document, { id: 'SAME', pos: 9 });
    expect(c.getPostingId(a)).toBe(c.getPostingId(b));
  });

  it('last resort: aria-label + ratings', async () => {
    const { c, env } = await loadContent();
    const p = createPosting(env.document, { id: null, ariaLabel: 'Posting von Max', pos: 2, neg: 1 });
    expect(c.getPostingId(p)).toBe('Posting von Max|2:1');
    expect(c.getPostingId(createPosting(env.document, { id: null }))).toBeNull();
  });
});

describe('element classification', () => {
  it('isRootPosting', async () => {
    const { c, env } = await loadContent();
    const doc = env.document;
    expect(c.isRootPosting(createPosting(doc, {}))).toBe(true);
    expect(c.isRootPosting(createPosting(doc, { level: 1 }))).toBe(false);
    expect(c.isRootPosting(html(doc, '<div data-level="0"></div>'))).toBe(false);

    // No data-level: only a direct child of <main> counts as root.
    const main = doc.createElement('main');
    const orphan = createPosting(doc, { level: null });
    expect(c.isRootPosting(orphan)).toBe(false);
    main.appendChild(orphan);
    expect(c.isRootPosting(orphan)).toBe(true);
  });

  it('isReplyThreadSection', async () => {
    const { c, env } = await loadContent();
    const doc = env.document;
    expect(c.isReplyThreadSection(html(doc, '<section class="thread"></section>'))).toBe(true);
    expect(c.isReplyThreadSection(html(doc, '<section class="forum-thread collapsed"></section>'))).toBe(true);
    expect(c.isReplyThreadSection(html(doc, '<section class="other"></section>'))).toBe(false);
    expect(c.isReplyThreadSection(html(doc, '<div class="thread"></div>'))).toBe(false);
  });

  it.each([
    '<dst-posting-form></dst-posting-form>',
    '<div><textarea></textarea></div>',
    '<div><input type="text"></div>',
    '<div><div contenteditable="true"></div></div>',
    '<div><button>Posten</button></div>',
    '<div><button> Absenden </button></div>',
    '<div class="forum--compose"></div>',
    '<div>Titel … Kommentar … Posten</div>'
  ])('isInputFormElement detects %s', async (markup) => {
    const { c, env } = await loadContent();
    expect(c.isInputFormElement(html(env.document, markup))).toBe(true);
  });

  it('isInputFormElement looks into the shadow DOM', async () => {
    const { c, env } = await loadContent();
    const el = env.document.createElement('dst-composer');
    el.attachShadow({ mode: 'open' }).innerHTML = '<textarea></textarea>';
    expect(c.isInputFormElement(el)).toBe(true);
  });

  it.each(['<slot></slot>', '<div class="ad"></div>', '<div><button>Mehr</button></div>'])(
    'isInputFormElement ignores %s', async (markup) => {
      const { c, env } = await loadContent();
      expect(c.isInputFormElement(html(env.document, markup))).toBe(false);
    });
});

describe('collectPostingGroups', () => {
  it('groups each root posting with its reply thread and ad slot', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, {
      postings: [
        { id: 'A', replies: 2, ad: true },
        { id: 'B' },
        { id: 'C', replies: 1 }
      ]
    });
    const { groups, formElements } = c.collectPostingGroups(main);
    expect(groups.map((g) => g.postingId)).toEqual(['A', 'B', 'C']);
    expect(groups.map((g) => g.siblings.map((s) => s.tagName))).toEqual([
      ['SECTION', 'SLOT'], [], ['SECTION']
    ]);
    expect(groups.map((g) => g.domIndex)).toEqual([0, 1, 2]);
    expect(formElements.map((f) => f.tagName)).toEqual(['DST-POSTING-BOX']);
  });

  it('a root posting with an "Antworten" button is not mistaken for the form', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, { postings: [{ id: 'A', hasThread: true }] });
    const { groups, formElements } = c.collectPostingGroups(main);
    expect(groups).toHaveLength(1);
    expect(formElements).toHaveLength(1);
  });

  it('elements before the first posting are not attached to any group', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, { postingBox: false });
    main.appendChild(env.document.createElement('section')).className = 'thread';
    main.appendChild(env.document.createElement('slot'));
    main.appendChild(createPosting(env.document, { id: 'A' }));
    const { groups } = c.collectPostingGroups(main);
    expect(groups).toHaveLength(1);
    expect(groups[0].siblings).toEqual([]);
  });

  it('marks the second copy of a posting as duplicate and keeps the freshest ratings', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, {
      postings: [
        { id: 'PIN', pinned: true, pos: 3, neg: 0 }, // stale pinned copy at the top
        { id: 'X', pos: 1 },
        { id: 'PIN', pos: 8, neg: 1 }               // live in-list twin
      ]
    });
    const { groups } = c.collectPostingGroups(main);
    expect(groups.map((g) => [g.postingId, g.pinned, g.isDuplicate])).toEqual([
      ['PIN', true, false], ['X', false, false], ['PIN', false, true]
    ]);
    expect(c.readRatings(groups[0].posting)).toEqual({ pos: 8, neg: 1 });
  });

  it('propagates "pinned" to the canonical copy when only the duplicate is pinned', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, {
      postings: [{ id: 'P' }, { id: 'P', pinned: true }]
    });
    const { groups } = c.collectPostingGroups(main);
    expect(groups[0].pinned).toBe(true);
    expect(groups[1].isDuplicate).toBe(true);
  });
});

describe('reply thread collapsing', () => {
  // v4.19.2: replies stay closed by CSS only (:host(.dst-fold) +
  // data-dst-open); derStandard's own toggle is never clicked any more.
  function toggleEvent(target, { trusted = true } = {}) {
    return {
      isTrusted: trusted,
      target,
      stopped: false,
      prevented: false,
      stopPropagation() { this.stopped = true; },
      preventDefault() { this.prevented = true; }
    };
  }

  it('closes all reply threads by CSS without clicking derStandard\'s toggle', async () => {
    const { c, env } = await loadContent();
    const { forum, shadow, main } = buildForum(env.document, {
      postings: [{ id: 'A', expanded: true, replies: 1 }, { id: 'B', hasThread: true }]
    });
    c.markOpenThreads(shadow, main);
    expect(forum.classList.contains('dst-fold')).toBe(true);
    for (const p of main.querySelectorAll('dst-posting')) {
      expect(p.hasAttribute('data-dst-open')).toBe(false);
      expect(p.dataset.toggleClicks).toBeUndefined();
    }
  });

  it('a click on a thread derStandard has open (but we hide) opens it without native toggle', async () => {
    const { c, env } = await loadContent();
    const { shadow, main } = buildForum(env.document, { postings: [{ id: 'A', expanded: true, replies: 1 }] });
    c.markOpenThreads(shadow, main);
    const a = main.querySelector('dst-posting');
    const ev = toggleEvent(a.querySelector('button.answers'));
    c.onThreadToggle(shadow, ev);
    expect(a.hasAttribute('data-dst-open')).toBe(true);
    expect(ev.stopped && ev.prevented).toBe(true); // native toggle would close it
    // Second click: derStandard closes it natively, we forget it.
    const ev2 = toggleEvent(a.querySelector('button.answers'));
    c.onThreadToggle(shadow, ev2);
    expect(a.hasAttribute('data-dst-open')).toBe(false);
    expect(ev2.stopped).toBe(false);
  });

  it('a click on a natively closed thread lets derStandard open it and keeps it visible', async () => {
    const { c, env } = await loadContent();
    const { shadow, main } = buildForum(env.document, { postings: [{ id: 'A', hasThread: true }] });
    c.markOpenThreads(shadow, main);
    const a = main.querySelector('dst-posting');
    const ev = toggleEvent(a.querySelector('button.answers'));
    c.onThreadToggle(shadow, ev);
    expect(ev.stopped).toBe(false);
    expect(a.hasAttribute('data-dst-open')).toBe(true);
  });

  it('opening a pinned posting opens both of its copies', async () => {
    const { c, env } = await loadContent();
    const { shadow, main } = buildForum(env.document, {
      postings: [{ id: 'P', pinned: true, expanded: true }, { id: 'P', expanded: true }, { id: 'X', expanded: true }]
    });
    c.markOpenThreads(shadow, main);
    const [pin, twin, other] = main.querySelectorAll('dst-posting');
    c.onThreadToggle(shadow, toggleEvent(twin.querySelector('button.answers')));
    expect(pin.hasAttribute('data-dst-open')).toBe(true);
    expect(twin.hasAttribute('data-dst-open')).toBe(true);
    expect(other.hasAttribute('data-dst-open')).toBe(false);
  });

  it('"Antworten" (reply) opens the thread so the reply box is visible', async () => {
    const { c, env } = await loadContent();
    const { shadow, main } = buildForum(env.document, { postings: [{ id: 'A', hasThread: true }] });
    c.markOpenThreads(shadow, main);
    const a = main.querySelector('dst-posting');
    const ev = toggleEvent(a.querySelector('button.answer-button'));
    c.onThreadToggle(shadow, ev);
    expect(a.hasAttribute('data-dst-open')).toBe(true);
    expect(ev.stopped).toBe(false); // derStandard still opens its reply box
  });

  it('opened threads stay open across re-sorts', async () => {
    const { c, env } = await loadContent();
    const { shadow, main } = buildForum(env.document, { postings: [{ id: 'A', hasThread: true }] });
    c.markOpenThreads(shadow, main);
    const a = main.querySelector('dst-posting');
    c.onThreadToggle(shadow, toggleEvent(a.querySelector('button.answers')));
    c.markOpenThreads(shadow, main);
    expect(a.hasAttribute('data-dst-open')).toBe(true);
  });

  it('ignores synthetic (untrusted) clicks and clicks elsewhere', async () => {
    const { c, env } = await loadContent();
    const { shadow, main } = buildForum(env.document, { postings: [{ id: 'A', expanded: true, text: 'Hallo' }] });
    c.markOpenThreads(shadow, main);
    const a = main.querySelector('dst-posting');
    c.onThreadToggle(shadow, toggleEvent(a.querySelector('button.answers'), { trusted: false }));
    c.onThreadToggle(shadow, toggleEvent(a.querySelector('p')));
    expect(a.hasAttribute('data-dst-open')).toBe(false);
  });

  it('respects the gear setting "Antworten ausgeklappt" (nothing is hidden)', async () => {
    const { c, env } = await loadContent();
    env.window.localStorage.setItem('user-settings', JSON.stringify({ '42_prefers-threads': 'expanded' }));
    expect(c.userPrefersExpandedThreads()).toBe(true);
    const { forum, shadow, main } = buildForum(env.document, { postings: [{ id: 'A', expanded: true }] });
    c.markOpenThreads(shadow, main);
    expect(forum.classList.contains('dst-fold')).toBe(false);
    const ev = toggleEvent(main.querySelector('button.answers'));
    c.onThreadToggle(shadow, ev);
    expect(ev.stopped).toBe(false);
  });

  it.each([null, 'not json', '{"42_prefers-threads":"collapsed"}', '{"other":"expanded"}'])(
    'userPrefersExpandedThreads is false for %j', async (raw) => {
      const { c, env } = await loadContent();
      if (raw !== null) env.window.localStorage.setItem('user-settings', raw);
      expect(c.userPrefersExpandedThreads()).toBe(false);
    });

  it('expands only pinned postings when the gear wants expanded threads', async () => {
    const { c, env } = await loadContent();
    env.window.localStorage.setItem('user-settings', JSON.stringify({ '1_prefers-threads': 'expanded' }));
    const { main } = buildForum(env.document, {
      postings: [
        { id: 'P', pinned: true, hasThread: true },
        { id: 'P', hasThread: true },
        { id: 'N', hasThread: true }
      ]
    });
    c.expandPinnedThreads(main);
    const [pinned, twin, normal] = main.querySelectorAll('dst-posting');
    expect(pinned.classList.contains('posting-has-thread-expanded')).toBe(true);
    expect(twin.dataset.toggleClicks).toBeUndefined();
    expect(normal.dataset.toggleClicks).toBeUndefined();
  });

  it('does not expand anything with the default (collapsed) setting', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, { postings: [{ id: 'P', pinned: true, hasThread: true }] });
    c.expandPinnedThreads(main);
    expect(main.querySelector('dst-posting').dataset.toggleClicks).toBeUndefined();
  });
});

describe('hasRatingData', () => {
  it('needs postings', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, {});
    expect(c.hasRatingData(main)).toBe(false);
  });

  it('is true once at least 3 (or half of the) postings carry ratings', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, {
      postings: [{ ratings: false }, { ratings: false }, { ratings: false }, { ratings: false }, {}, {}]
    });
    expect(c.hasRatingData(main)).toBe(false);
    main.appendChild(createPosting(env.document, {}));
    expect(c.hasRatingData(main)).toBe(true);
  });

  it('Timeline modes never wait for ratings', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, { postings: [{ ratings: false }] });
    c.sortMode = 'chronological-old';
    expect(c.hasRatingData(main)).toBe(true);
  });
});

describe('findLoadMoreButton', () => {
  it('finds the forum pagination button', async () => {
    const { c, env } = await loadContent();
    const { shadow } = buildForum(env.document, {});
    const btn = env.document.createElement('button');
    btn.className = 'thread--more';
    shadow.appendChild(btn);
    expect(c.findLoadMoreButton(shadow)).toBe(btn);
  });

  it('matches by text "Weitere Postings"', async () => {
    const { c, env } = await loadContent();
    const { shadow } = buildForum(env.document, {});
    const btn = env.document.createElement('button');
    btn.textContent = 'Weitere Postings laden';
    shadow.appendChild(btn);
    expect(c.findLoadMoreButton(shadow)).toBe(btn);
  });

  it('never returns reply controls, tabs or buttons inside postings', async () => {
    const { c, env } = await loadContent();
    const { shadow, main } = buildForum(env.document, { postings: [{ id: 'A', replies: 1, hasThread: true }] });
    const doc = env.document;
    const inPosting = doc.createElement('button');
    inPosting.className = 'thread--more';
    main.querySelector('dst-posting').appendChild(inPosting);
    const inThread = doc.createElement('button');
    inThread.textContent = 'Weitere Postings';
    main.querySelector('section.thread').appendChild(inThread);
    const replies = doc.createElement('button');
    replies.textContent = 'Weitere Antworten (Postings) anzeigen';
    shadow.appendChild(replies);
    const tab = doc.createElement('button');
    tab.setAttribute('role', 'tab');
    tab.textContent = 'Weitere Postings';
    shadow.appendChild(tab);
    expect(c.findLoadMoreButton(shadow)).toBeNull();
  });
});

describe('deleted postings (v3.0.1, v4.19.4)', () => {
  it('a deleted posting has no id (so they are never "duplicates" of each other)', async () => {
    const { c, env } = await loadContent();
    const d = createPosting(env.document, { id: null, deleted: true, ariaLabel: 'Posting von gelöschtem Profil' });
    expect(c.getPostingId(d)).toBeNull();
  });

  it('deleted without replies is hidden, deleted with replies stays', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, {
      postings: [
        { id: null, deleted: true, ariaLabel: 'gelöscht' },
        { id: null, deleted: true, ariaLabel: 'gelöscht', replies: 2 },
        { id: null, deleted: true, ariaLabel: 'gelöscht' },
        { id: 'A' }
      ]
    });
    const { groups } = c.collectPostingGroups(main);
    expect(groups.map((g) => [g.isDeletedAlone, g.isDuplicate])).toEqual([
      [true, false], [false, false], [true, false], [false, false]
    ]);
  });

  it('a deleted posting with replies gets a Timeline time from its earliest reply', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, {
      postings: [{ id: null, deleted: true, ariaLabel: 'x', replies: 1 }, { id: 'B', date: '28.10.2026, 09:00' }]
    });
    main.querySelector('section.thread dst-posting').appendChild(Object.assign(env.document.createElement('time'), {}))
      .setAttribute('data-date', '28.10.2026, 10:30');
    const { groups } = c.collectPostingGroups(main);
    expect(c.postingTimeOf(groups[0])).toBe(new Date(2026, 9, 28, 10, 29).getTime());
    // remembered on the element
    expect(groups[0].posting.dataset.dstTime).toBe(String(new Date(2026, 9, 28, 10, 29).getTime()));
  });

  it('without reply times it borrows the nearest neighbour\'s time', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, {
      postings: [{ id: 'A', date: '28.10.2026, 08:00' }, { id: null, deleted: true, ariaLabel: 'x', hasThread: true }, { id: 'C' }]
    });
    const { groups } = c.collectPostingGroups(main);
    expect(c.postingTimeOf(groups[1])).toBe(new Date(2026, 9, 28, 8, 0).getTime());
  });
});

describe('parseDataDate', () => {
  it.each([
    ['28.10.2026, 13:04', [2026, 9, 28, 13, 4]],
    ['1.2.2026 7:05', [2026, 1, 1, 7, 5]]
  ])('%s', async (text, parts) => {
    const { c } = await loadContent();
    expect(c.parseDataDate(text)).toBe(new Date(...parts).getTime());
  });

  it.each([null, '', 'gestern', '2026-10-28T10:00'])('returns 0 for %j', async (text) => {
    const { c } = await loadContent();
    expect(c.parseDataDate(text)).toBe(0);
  });
});

describe('posting cards (v4.0.0 – v4.12.0)', () => {
  it('adds the "⋯" button and the action row once, without touching derStandard\'s nodes', async () => {
    const { c, env } = await loadContent();
    const p = createPosting(env.document, { id: 'A', hasThread: true, text: 'Hallo' });
    const before = Array.from(p.children);
    c.decorateTile(p);
    c.decorateTile(p);
    expect(p.querySelectorAll(':scope > .dst-fb.more')).toHaveLength(1);
    expect(p.querySelectorAll(':scope > .dst-more-row')).toHaveLength(1);
    expect(Array.from(p.children).slice(0, before.length)).toEqual(before);
    const labels = Array.from(p.querySelectorAll('.dst-more-acts .dst-act')).map((b) => b.textContent);
    expect(labels).toEqual(['Melden', 'Ausblenden', 'Kopieren', 'Teilen']);
  });

  it('"⋯" swaps the footer for the actions and back', async () => {
    const { c, env } = await loadContent();
    const p = createPosting(env.document, { id: 'A' });
    c.decorateTile(p);
    const more = p.querySelector('.dst-fb.more');
    const row = p.querySelector('.dst-more-row');
    expect(row.inert).toBe(true);
    more.click();
    expect(p.classList.contains('dst-more-open')).toBe(true);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(row.inert).toBe(false);
    more.click();
    expect(p.classList.contains('dst-more-open')).toBe(false);
  });

  it('actions use derStandard\'s own "…" menu', async () => {
    const { c, env } = await loadContent();
    const doc = env.document;
    const p = createPosting(doc, { id: 'A' });
    const ctx = doc.createElement('dst-posting--context');
    const trigger = doc.createElement('button');
    const clicked = [];
    trigger.addEventListener('click', () => {
      trigger.setAttribute('aria-expanded', 'true');
      for (const label of ['Posting teilen', 'Permalink kopieren', 'User:in ausblenden', 'Posting melden']) {
        const item = doc.createElement('button');
        item.setAttribute('role', 'menuitem');
        item.textContent = label;
        item.addEventListener('click', () => clicked.push(label));
        ctx.appendChild(item);
      }
    });
    ctx.appendChild(trigger);
    p.appendChild(ctx);
    c.decorateTile(p);
    p.querySelector('.dst-act[title="User:in ausblenden"]').click();
    await env.tick(100);
    expect(clicked).toEqual(['User:in ausblenden']);
  });

  it('deleted postings keep their look (no card additions)', async () => {
    const { c, env } = await loadContent();
    const p = createPosting(env.document, { id: null, deleted: true });
    c.decorateTile(p);
    expect(p.querySelector('.dst-fb')).toBeNull();
  });

  it.each([[1, '1 Antwort', null], [12, '12 Antworten', null], [999, '999 Antworten', null], [1000, '1000 Antworten', '+1k'], [23456, '23456 Antworten', '+23k']])(
    '%i replies → tooltip %s, badge %s', async (n, tip, badge) => {
      const { c, env } = await loadContent();
      const p = createPosting(env.document, { id: 'A', hasThread: true, replyCount: n });
      c.updateTile(p);
      const ans = p.querySelector('.answers');
      expect(ans.title).toBe(tip);
      expect(ans.getAttribute('data-dst-n')).toBe(badge);
    });

  it('reply box: depth is counted through nested threads', async () => {
    const { c, env } = await loadContent();
    const doc = env.document;
    const outer = doc.createElement('section');
    outer.className = 'thread';
    const inner = doc.createElement('section');
    inner.className = 'thread';
    const box = doc.createElement('dst-posting-box');
    inner.appendChild(box);
    outer.appendChild(inner);
    c.widenReplyBox(box);
    expect(box.style.getPropertyValue('--dst-depth')).toBe('2');
  });
});
