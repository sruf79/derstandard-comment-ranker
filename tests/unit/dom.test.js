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

  // KNOWN GAP (content.js, "for (const child of posting.children)"): a direct
  // child whose whole text is "angeheftet" pins the posting, even when it is
  // user content such as a quote or a one-word paragraph. `it.fails` flips to
  // red once this is fixed; then turn it into a normal test.
  it.fails('KNOWN GAP: a one-word user paragraph "Angeheftet" does not pin', async () => {
    const { c, env } = await loadContent();
    expect(c.isPinnedPosting(html(env.document, '<dst-posting><p>Angeheftet</p></dst-posting>'))).toBe(false);
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
  it('collapses each expanded thread once via the native toggle', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, {
      postings: [{ id: 'A', expanded: true }, { id: 'B', hasThread: true }]
    });
    const [a, b] = main.querySelectorAll('dst-posting');
    c.collapseReplyThreads(main);
    expect(a.classList.contains('posting-has-thread-expanded')).toBe(false);
    expect(a.dataset.toggleClicks).toBe('1');
    expect(b.dataset.toggleClicks).toBeUndefined();
    // Visual side effect of the native toggle is removed again.
    expect(a.classList.contains('is-active-posting')).toBe(false);

    // The user re-opens the thread → we never fight that.
    a.querySelector('button.answers').click();
    c.collapseReplyThreads(main);
    expect(a.classList.contains('posting-has-thread-expanded')).toBe(true);
  });

  it('toggles a pinned posting rendered twice only once (shared postingId)', async () => {
    const { c, env } = await loadContent();
    const { main } = buildForum(env.document, {
      postings: [{ id: 'P', pinned: true, expanded: true }, { id: 'P', expanded: true }]
    });
    c.collapseReplyThreads(main);
    const clicks = Array.from(main.querySelectorAll('dst-posting')).map((p) => p.dataset.toggleClicks);
    expect(clicks).toEqual(['1', undefined]);
  });

  it('respects the gear setting "Antworten ausgeklappt"', async () => {
    const { c, env } = await loadContent();
    env.window.localStorage.setItem('user-settings', JSON.stringify({ '42_prefers-threads': 'expanded' }));
    expect(c.userPrefersExpandedThreads()).toBe(true);
    const { main } = buildForum(env.document, { postings: [{ id: 'A', expanded: true }] });
    c.collapseReplyThreads(main);
    expect(main.querySelector('dst-posting').classList.contains('posting-has-thread-expanded')).toBe(true);
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
