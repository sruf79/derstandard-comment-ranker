// Boots content.js (v4.x) end-to-end against a simulated <dst-forum> and checks
// what the reader actually gets: CSS order, the sort bar, persistence,
// observers, background loading with the progress ring, the voter popup and
// the coffee reminder.
import { describe, it, expect } from 'vitest';
import { createEnv, readFixture, DAY, DEFAULT_NOW } from '../helpers/env.js';
import { track } from '../helpers/setup.js';
import { buildForum, appendPostings, addLoadMoreButton, renderedOrder, orderOf } from '../helpers/forum.js';

const NOW = DEFAULT_NOW;
const GROUPS = ['likes', 'balance', 'timeline'];

// The native forum model forum-hook.js reads (see forum-hook.test.js).
function nativeModel(forum, { ids = [], more = () => false, total, loading = () => false } = {}) {
  Object.assign(forum, {
    forumModel: new Map(ids.map((id) => [id, {}])),
    stickyPostingsModel: new Map(),
    threadsByForumQuery: { data: { getForumRootPostingsV2: { pageInfo: { nextCursor: '' } } } },
    _totalPostingCount: total ?? ids.length,
    hasMorePostings: more,
    activeFilter: 0,
    sortField: 'ByTime',
    sortDirection: 'descending',
    isPermalink: false,
    isFolloweeTabChange: false
  });
  Object.defineProperty(forum, 'isLoading', { get: loading, configurable: true });
  return forum;
}

// Default: a forum that is already complete (native model says so), like most
// articles — so background loading finishes at once.
async function boot({
  postings = [], sync = {}, local = {}, forum = {}, native = true, before, barOnScreen = false
} = {}) {
  const env = track(await createEnv({ sync, local }));
  const f = buildForum(env.document, { postings, ...forum });
  if (native) nativeModel(f.forum, { ids: postings.map((p) => p.id).filter(Boolean) });
  if (barOnScreen) {
    // jsdom has no layout; pretend the sort bar is visible on screen.
    const orig = env.window.HTMLElement.prototype.getBoundingClientRect;
    env.window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.id === 'dst-badge-bar') return { top: 100, bottom: 150, height: 50, left: 0, right: 600, width: 600 };
      return orig.call(this);
    };
  }
  if (before) before(env, f);
  if (native) env.load('forum-hook.js');
  const c = env.load('content.js');
  await env.flush();
  const segButtons = () => Array.from(f.shadow.querySelectorAll('#dst-seg > .dst-badge-btn:not(.dst-coffee-btn)'));
  const badge = (group) => segButtons()[GROUPS.indexOf(group)];
  const coffee = () => f.shadow.querySelector('#dst-seg .dst-coffee-btn');
  // A click shows the new state at once and re-sorts after the slide (460 ms).
  const clickBadge = async (group) => {
    badge(group).click();
    await env.tick(500);
  };
  return { env, c, ...f, segButtons, badge, coffee, clickBadge, order: () => renderedOrder(f.main) };
}

const BASIC = [
  { id: 'low', pos: 1, neg: 9 },
  { id: 'top', pos: 50, neg: 2 },
  { id: 'mid', pos: 10, neg: 3 },
  { id: 'zero' }
];

describe('initial sort', () => {
  it('sorts root postings by Balance (highest first) by default via CSS order only', async () => {
    const { order, main } = await boot({ postings: BASIC });
    expect(order()).toEqual(['top', 'mid', 'zero', 'low']);
    expect(main.style.display).toBe('flex');
    expect(main.style.flexDirection).toBe('column');
  });

  it('does not move or remove any DOM node of derStandard', async () => {
    const env = track(await createEnv());
    const { main } = buildForum(env.document, { postings: BASIC });
    const before = Array.from(main.children);
    env.load('content.js');
    await env.flush();
    const after = Array.from(main.children).filter((el) => el.id !== 'dst-badge-bar');
    expect(after).toEqual(before);
  });

  it('uses the stored sort mode', async () => {
    const { order } = await boot({ postings: BASIC, sync: { dstSorterMode: 'negative-only' } });
    // Pure (dislikes): fewest likes first; postings without dislikes last
    expect(order()).toEqual(['low', 'mid', 'top', 'zero']);
  });

  it('migrates a legacy stored mode on boot', async () => {
    const { env, order } = await boot({ postings: BASIC, sync: { dstSorterMode: 'worst' } });
    expect(env.chrome.storage.sync.data.dstSorterMode).toBe('negative-only');
    expect(order()[0]).toBe('low');
  });

  it('keeps pinned postings on top, then the comment form, then the rest', async () => {
    const { order, main } = await boot({
      postings: [{ id: 'a', pos: 100 }, { id: 'pin', pinned: true, pos: 0 }, { id: 'b', pos: 5 }]
    });
    expect(order()).toEqual(['pin', 'a', 'b']);
    const box = main.querySelector('dst-posting-box');
    const [a, pin] = main.querySelectorAll('dst-posting');
    expect(orderOf(pin)).toBeLessThan(orderOf(box));
    expect(orderOf(box)).toBeLessThan(orderOf(a));
  });

  it('a posting whose text is just "Angeheftet" is not treated as pinned (v4.20.0)', async () => {
    const { order } = await boot({
      postings: [{ id: 'best', pos: 100 }, { id: 'joke', pos: 0, text: 'Angeheftet' }]
    });
    expect(order()).toEqual(['best', 'joke']);
  });

  it('hides the duplicate of a pinned posting and sorts with its fresher ratings', async () => {
    const { order, main } = await boot({
      postings: [
        { id: 'P', pinned: true, pos: 1 },
        { id: 'x', pos: 5 },
        { id: 'P', pos: 1, neg: 0, replies: 1 }
      ]
    });
    const copies = main.querySelectorAll(':scope > dst-posting[data-level="0"]');
    expect(copies[2].style.display).toBe('none');
    expect(main.querySelector(':scope > section.thread').style.display).toBe('none');
    expect(order()).toEqual(['P', 'x']);
  });

  it('hides deleted postings without replies, keeps deleted ones with replies', async () => {
    const { main } = await boot({
      postings: [
        { id: null, deleted: true, ariaLabel: 'gelöscht' },
        { id: 'a', pos: 3 },
        { id: null, deleted: true, ariaLabel: 'gelöscht', replies: 2 }
      ]
    });
    const [alone, a, withReplies] = main.querySelectorAll(':scope > dst-posting');
    expect(alone.style.display).toBe('none');
    expect(a.style.display).toBe('');
    expect(withReplies.style.display).toBe('');
  });

  it('a hidden deleted posting comes back once it gets a reply', async () => {
    const { env, main } = await boot({ postings: [{ id: 'a', pos: 1 }, { id: null, deleted: true, ariaLabel: 'x' }] });
    const deleted = main.querySelectorAll(':scope > dst-posting')[1];
    expect(deleted.style.display).toBe('none');
    deleted.classList.add('posting-with-thread');
    const thread = env.document.createElement('section');
    thread.className = 'thread';
    deleted.after(thread);
    await env.tick(400);
    expect(deleted.style.display).toBe('');
  });

  it('reply threads and ads travel with their posting', async () => {
    const { main } = await boot({
      postings: [{ id: 'a', pos: 1, replies: 2, ad: true }, { id: 'b', pos: 9, replies: 1 }]
    });
    const [a, b] = main.querySelectorAll(':scope > dst-posting');
    const [threadA, threadB] = main.querySelectorAll(':scope > section.thread');
    const slot = main.querySelector(':scope > slot');
    expect(orderOf(threadB)).toBe(orderOf(b) + 1);
    expect(orderOf(threadA)).toBe(orderOf(a) + 1);
    expect(orderOf(slot)).toBe(orderOf(a) + 2);
    expect(orderOf(b)).toBeLessThan(orderOf(a));
    expect(slot.style.display).toBe('none');
  });

  it('closes reply threads by CSS and never clicks derStandard\'s toggles', async () => {
    const { forum, main } = await boot({ postings: [{ id: 'a', expanded: true, replies: 1 }, { id: 'b', hasThread: true }] });
    expect(forum.classList.contains('dst-fold')).toBe(true);
    for (const p of main.querySelectorAll('dst-posting')) expect(p.dataset.toggleClicks).toBeUndefined();
  });

  it('decorates every posting card', async () => {
    const { main } = await boot({ postings: BASIC });
    for (const p of main.querySelectorAll(':scope > dst-posting')) {
      expect(p.hasAttribute('data-dst-tile')).toBe(true);
    }
  });

  it('applies the flat design when chosen', async () => {
    const { forum } = await boot({ postings: BASIC, sync: { dstFlat: true } });
    expect(forum.classList.contains('dst-flat')).toBe(true);
  });

  it('does nothing at all when the extension is disabled', async () => {
    const { shadow, main } = await boot({ postings: BASIC, sync: { dstSorterEnabled: false } });
    expect(shadow.querySelector('#dst-badge-bar')).toBeNull();
    expect(Array.from(main.children).every((el) => el.style.order === '')).toBe(true);
  });

  it('runs without uncaught errors', async () => {
    const { env } = await boot({ postings: BASIC });
    await env.tick(5000);
    expect(env.errors).toEqual([]);
  });
});

describe('sort bar', () => {
  it('renders Pure · Balance · Timeline + coffee as one track, first in the forum', async () => {
    const { shadow, main, segButtons, coffee } = await boot({ postings: BASIC });
    const bar = shadow.querySelector('#dst-badge-bar');
    expect(main.firstElementChild).toBe(bar);
    expect(bar.style.order).toBe('-1');
    expect(segButtons().map((b) => [b.textContent, b.getAttribute('data-mode'), b.classList.contains('active')])).toEqual([
      ['Pure', 'positive-only', false],
      ['Balance', 'balance-top', true],
      ['Timeline', 'chronological-new', false]
    ]);
    expect(coffee()).not.toBeNull();
    expect(shadow.querySelectorAll('#dst-icon-style')).toHaveLength(1);
  });

  it('every segment is keyboard accessible with a tooltip and aria state', async () => {
    const { segButtons, coffee } = await boot({ postings: BASIC });
    for (const b of [...segButtons(), coffee()]) {
      expect(b.getAttribute('role')).toBe('button');
      expect(b.getAttribute('tabindex')).toBe('0');
      expect(b.getAttribute('aria-label')).toBeTruthy();
    }
    expect(segButtons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(segButtons()[1].title).toBe('Balance: höchste Bilanz aus Plus- und Minus-Stimmen zuerst');
  });

  it('a click shows the new state at once and re-sorts after the slide', async () => {
    const { env, badge, order, segButtons } = await boot({ postings: BASIC });
    badge('likes').click();
    expect(segButtons()[0].classList.contains('active')).toBe(true);
    expect(order()).toEqual(['top', 'mid', 'zero', 'low']); // not yet
    await env.tick(500);
    expect(env.chrome.storage.sync.data.dstSorterMode).toBe('positive-only');
    expect(order()).toEqual(['top', 'mid', 'low', 'zero']);
  });

  it('a click on the active segment flips the direction; other segments keep it', async () => {
    const ctx = await boot({ postings: BASIC });
    const mode = () => ctx.env.chrome.storage.sync.data.dstSorterMode;
    await ctx.clickBadge('balance');
    expect(mode()).toBe('balance-flop');
    expect(ctx.order()).toEqual(['low', 'zero', 'mid', 'top']);
    await ctx.clickBadge('likes'); // direction "red" is kept
    expect(mode()).toBe('negative-only');
    await ctx.clickBadge('timeline');
    expect(mode()).toBe('chronological-old');
    expect(ctx.segButtons().map((b) => b.getAttribute('data-mode'))).toEqual(['negative-only', 'balance-flop', 'chronological-old']);
  });

  it('the bar is updated in place (no re-creation, the slide survives)', async () => {
    const ctx = await boot({ postings: BASIC });
    const bar = ctx.shadow.querySelector('#dst-badge-bar');
    await ctx.clickBadge('timeline');
    expect(ctx.shadow.querySelector('#dst-badge-bar')).toBe(bar);
  });

  it('only the last of several quick clicks re-sorts', async () => {
    const ctx = await boot({ postings: BASIC, sync: { dstSorterMode: 'balance-top' } });
    ctx.badge('likes').click();
    await ctx.env.tick(100);
    ctx.badge('timeline').click();
    await ctx.env.tick(600);
    expect(ctx.env.chrome.storage.sync.set.mock.calls.filter((c) => 'dstSorterMode' in c[0]).map((c) => c[0].dstSorterMode))
      .toEqual(['chronological-new']);
  });

  it('exactly one segment is active at any time', async () => {
    const ctx = await boot({ postings: BASIC });
    for (const g of ['likes', 'timeline', 'timeline', 'balance', 'likes']) {
      await ctx.clickBadge(g);
      expect(ctx.segButtons().filter((b) => b.classList.contains('active'))).toHaveLength(1);
    }
  });

  it('works with Enter and Space', async () => {
    const ctx = await boot({ postings: BASIC });
    ctx.badge('timeline').dispatchEvent(new ctx.env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await ctx.env.tick(500);
    expect(ctx.env.chrome.storage.sync.data.dstSorterMode).toBe('chronological-new');
    ctx.badge('timeline').dispatchEvent(new ctx.env.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await ctx.env.tick(500);
    expect(ctx.env.chrome.storage.sync.data.dstSorterMode).toBe('chronological-old');
  });

  it('Timeline sorts by the exact posting time', async () => {
    const ctx = await boot({
      postings: [
        { id: 'old', date: '27.10.2026, 08:00', pos: 99 },
        { id: 'new', date: '28.10.2026, 11:00' },
        { id: 'mid', timeText: 'vor 5 Stunden' }, // <time> without attributes (v4.20.0)
        { id: null, deleted: true, ariaLabel: 'x', replies: 1 }
      ]
    });
    ctx.main.querySelector(':scope > section.thread dst-posting')
      .appendChild(ctx.env.document.createElement('time')).setAttribute('data-date', '28.10.2026, 12:00');
    await ctx.clickBadge('timeline');
    // deleted: earliest reply 12:00 − 1 min → newest
    expect(ctx.order()).toEqual([null, 'new', 'mid', 'old']);
    await ctx.clickBadge('timeline');
    expect(ctx.order()).toEqual(['old', 'mid', 'new', null]);
  });
});

describe('popup → page', () => {
  it('switching the extension off reloads the page', async () => {
    const { env, c } = await boot({ postings: BASIC });
    env.chrome.sendRuntimeMessage({ action: 'toggle', enabled: false });
    expect(c.sortEnabled).toBe(false);
    // jsdom cannot navigate; it reports the attempted reload.
    expect(env.errors.some((e) => /navigation/i.test(String(e.message || e)))).toBe(true);
  });

  it('the design switch applies live', async () => {
    const { env, forum } = await boot({ postings: BASIC });
    env.chrome.storage.sync.set({ dstFlat: true });
    await env.flush();
    expect(forum.classList.contains('dst-flat')).toBe(true);
  });
});

describe('observers', () => {
  it('sorts newly loaded postings into place (debounced)', async () => {
    const { env, main, order } = await boot({ postings: BASIC });
    await env.tick(300);
    appendPostings(env.document, main, [{ id: 'new-best', pos: 999 }, { id: 'new-worst', neg: 999 }]);
    await env.tick(299);
    expect(order()[0]).toBe('top');
    await env.tick(1);
    expect(order()).toEqual(['new-best', 'top', 'mid', 'zero', 'low', 'new-worst']);
  });

  it('a new reply thread (reply box) sits below its posting at once, not at the end (v4.20.0)', async () => {
    const { env, main } = await boot({ postings: BASIC });
    await env.tick(300);
    const posting = main.querySelector('dst-posting--ratinglog[postingid="zero"]').closest('dst-posting');
    const thread = env.document.createElement('section');
    thread.className = 'thread';
    thread.appendChild(Object.assign(env.document.createElement('dst-posting-box'), { className: 'posting-new' }));
    posting.after(thread);
    await env.flush(); // MutationObserver only, no debounce yet
    expect(thread.style.order).toBe(posting.style.order);
    await env.tick(300); // the debounced re-sort keeps it right after the posting
    expect(orderOf(thread)).toBe(orderOf(posting) + 1);
  });

  it('new postings get their card right away', async () => {
    const { env, main } = await boot({ postings: BASIC });
    const [p] = appendPostings(env.document, main, [{ id: 'n' }]);
    await env.tick(20);
    expect(p.hasAttribute('data-dst-tile')).toBe(true);
  });

  it('never re-sorts when the user votes (rating attribute changes)', async () => {
    const { env, main, order } = await boot({ postings: BASIC });
    await env.tick(3500); // past the delayed re-check
    const before = order();
    main.querySelector('dst-posting--ratinglog[postingid="low"]').setAttribute('positiveratings', '1000');
    await env.tick(10000);
    expect(order()).toEqual(before);
  });

  it('re-sorts once if ratings arrive late (within 3 s)', async () => {
    const { env, main, order } = await boot({ postings: BASIC });
    main.querySelector('dst-posting--ratinglog[postingid="zero"]').setAttribute('positiveratings', '500');
    await env.tick(3300);
    expect(order()[0]).toBe('zero');
  });

  it('does not end up in a sort loop', async () => {
    const { env, main } = await boot({ postings: BASIC });
    let orderWrites = 0;
    new env.window.MutationObserver((records) => {
      orderWrites += records.filter((r) => r.attributeName === 'style').length;
    }).observe(main, { attributes: true, subtree: false, attributeFilter: ['style'] });
    await env.tick(4000); // background load + delayed re-check
    const settled = orderWrites;
    await env.tick(30000);
    expect(orderWrites).toBe(settled);
  });
});

describe('late forum rendering', () => {
  it('waits for <dst-forum> to appear', async () => {
    const env = track(await createEnv());
    env.load('content.js');
    await env.tick(2000);
    const { main } = buildForum(env.document, { postings: BASIC });
    await env.tick(600);
    expect(renderedOrder(main)).toEqual(['top', 'mid', 'zero', 'low']);
  });

  it('waits for main.forum--main and the first posting inside the shadow root', async () => {
    const env = track(await createEnv());
    const { shadow, main } = buildForum(env.document, { postings: [], postingBox: false });
    main.remove();
    env.load('content.js');
    await env.flush();
    shadow.appendChild(main);
    await env.flush();
    appendPostings(env.document, main, BASIC);
    await env.flush();
    expect(renderedOrder(main)).toEqual(['top', 'mid', 'zero', 'low']);
  });

  it('a fresh article with unvoted postings (no rating element, live DOM) sorts at once (v4.20.0)', async () => {
    const { shadow, order } = await boot({
      postings: [
        { id: 'a', pos: 2, date: '31.10.2026, 18:00' },
        { id: 'b', ratings: false, date: '31.10.2026, 18:05' },
        { id: 'c', ratings: false, date: '31.10.2026, 18:06' },
        { id: 'd', ratings: false, date: '31.10.2026, 18:07' }
      ]
    });
    expect(shadow.querySelector('#dst-badge-bar')).not.toBeNull();
    expect(order()[0]).toBe('a');
  });

  it('sorts anyway after ~15 s if ratings never show up', async () => {
    const { env, shadow } = await boot({
      postings: [{ id: 'a', ratings: false }, { id: 'b', ratings: false }, { id: 'c', pos: 3 }]
    });
    expect(shadow.querySelector('#dst-badge-bar')).toBeNull();
    await env.tick(15000);
    expect(shadow.querySelector('#dst-badge-bar')).not.toBeNull();
  });

  it('stops watching on pages without a forum', async () => {
    const env = track(await createEnv({ url: 'https://www.derstandard.at/' }));
    env.load('content.js');
    await env.flush();
    await env.tick(60000);
    expect(env.clock.countTimers()).toBe(0);
  });
});

describe('background loading of all postings', () => {
  // Native pagination without the load-state bridge (DOM progress only).
  function loading(batches, opts = {}) {
    return {
      native: false,
      before: (env, f) => { loading.btn = addLoadMoreButton(env.document, f.shadow, f.main, batches, opts); }
    };
  }

  it('clicks "Weitere Postings laden" until everything is loaded, then sorts all', async () => {
    const ctx = await boot({
      postings: [{ id: 'p1', pos: 5 }, { id: 'p2', pos: 1 }],
      ...loading([[{ id: 'p3', pos: 50 }, { id: 'p4', expanded: true }], [{ id: 'p5', pos: 3 }]])
    });
    await ctx.env.tick(15000);
    expect(loading.btn.clicks).toBe(2);
    expect(ctx.order()).toEqual(['p3', 'p1', 'p5', 'p2', 'p4']);
  });

  it('shows the progress as a ring in the coffee slot and removes it afterwards', async () => {
    const ctx = await boot({
      postings: [{ id: 'p1' }],
      forum: { count: 3 },
      ...loading([[{ id: 'p2' }], [{ id: 'p3' }]], { delay: 2000 })
    });
    await ctx.env.tick(300);
    const btn = ctx.coffee();
    expect(btn.classList.contains('dst-loading')).toBe(true);
    expect(btn.querySelector('.dst-load-pct').textContent).toBe('33%');
    expect(btn.title).toBe('Lade alle Postings… 1 / 3');
    await ctx.env.tick(20000);
    expect(btn.classList.contains('dst-loading')).toBe(false);
    expect(btn.style.getPropertyValue('--dst-p')).toBe('');
  });

  it('never shows the ring for a forum that is complete from the start', async () => {
    const ctx = await boot({ postings: BASIC });
    await ctx.env.tick(100);
    expect(ctx.coffee().classList.contains('dst-loading')).toBe(false);
    await ctx.env.tick(500);
    expect(ctx.coffee().classList.contains('dst-loading')).toBe(false);
    expect(ctx.env.warnings()).toEqual([]);
  });

  it('confirms completion with the check in the ring when postings were added', async () => {
    let more = true;
    const ctx = await boot({
      postings: [{ id: 'p1' }],
      barOnScreen: true,
      before: (env, f) => {
        nativeModel(f.forum, { ids: ['p1'], more: () => more });
        const btn = addLoadMoreButton(env.document, f.shadow, f.main, [[{ id: 'p2' }]]);
        btn.addEventListener('click', () => env.window.setTimeout(() => {
          more = false;
          f.forum.forumModel.set('p2', {});
        }, 100));
      }
    });
    await ctx.env.tick(1500);
    const btn = ctx.coffee();
    expect(btn.classList.contains('dst-load-done')).toBe(true);
    expect(btn.title).toBe('Alle 2 Postings geladen');
    await ctx.env.tick(2500);
    expect(btn.classList.contains('dst-load-done')).toBe(false);
  });

  it('gives up after 3 stalled attempts instead of clicking forever', async () => {
    let clicks = 0;
    const ctx = await boot({
      postings: [{ id: 'p1' }],
      native: false,
      before: (env, { shadow }) => {
        const btn = env.document.createElement('button');
        btn.className = 'thread--more';
        btn.addEventListener('click', () => clicks++);
        shadow.appendChild(btn);
      }
    });
    await ctx.env.tick(120000);
    expect(clicks).toBe(3);
    expect(ctx.env.warnings().some((w) => String(w.args[0]).includes('Vollständigkeit nicht bestätigt'))).toBe(true);
  });

  it('never touches reply toggles while loading', async () => {
    const ctx = await boot({
      postings: [{ id: 'p1', hasThread: true }],
      ...loading([[{ id: 'p2', hasThread: true }]])
    });
    await ctx.env.tick(15000);
    for (const p of ctx.main.querySelectorAll('dst-posting')) expect(p.dataset.toggleClicks).toBeUndefined();
  });

  it('a sort click waits for loading only while it has not finished once', async () => {
    const ctx = await boot({ postings: BASIC });
    await ctx.env.tick(300);
    expect(ctx.c.allLoadDone).toBe(true);
    ctx.badge('likes').click();
    await ctx.env.tick(470); // no 10 s wait for a load button that never comes
    expect(ctx.env.chrome.storage.sync.data.dstSorterMode).toBe('positive-only');
    expect(ctx.order()[0]).toBe('top');
  });
});

describe('voter popup', () => {
  const PAGE_EMPTY = '<div></div>';

  async function withPopup({ pages, idMap = { ENC1: '1151194732' }, fetchImpl } = {}) {
    const calls = [];
    const queue = (pages || [readFixture('ratinglog-initial.html'), readFixture('ratinglog-page.html'), PAGE_EMPTY]).slice();
    const ctx = await boot({
      postings: [{ id: 'ENC1', pos: 5, neg: 2 }, { id: 'ENC2', pos: 1 }],
      before: (env) => {
        env.window.fetch = fetchImpl ? (url) => { calls.push(String(url)); return fetchImpl(String(url), calls.length); } : async (url) => {
          calls.push(String(url));
          return { ok: true, status: 200, text: async () => queue.shift() || PAGE_EMPTY };
        };
      }
    });
    if (idMap) {
      ctx.env.window.dispatchEvent(new ctx.env.window.CustomEvent('dst-voter-idmap', { detail: JSON.stringify(idMap) }));
    }
    const rating = (id) => ctx.main.querySelector(`dst-posting--ratinglog[postingid="${id}"]`);
    const overlay = () => ctx.shadow.querySelector('#dst-voter-overlay');
    // v4.7.0: dislikes left, likes right
    const names = (kind) => {
      const lists = ctx.shadow.querySelectorAll('#dst-voter-body .dst-voter-list');
      return Array.from(lists[kind === 'neg' ? 0 : 1].querySelectorAll('a')).map((a) => a.textContent);
    };
    return { ...ctx, calls, rating, overlay, names };
  }

  it('clicking the rating lists all likes and dislikes', async () => {
    const { env, rating, overlay, names, calls, shadow } = await withPopup();
    rating('ENC1').click();
    await env.tick(1000);
    expect(overlay()).not.toBeNull();
    expect(calls).toEqual([
      'https://apps.derstandard.at/forum/ratinglog?id=1151194732&idType=1',
      'https://apps.derstandard.at/forum/RatingLog?id=1151194732&idType=Posting&LatestRaterCommunityIdentityId=555',
      'https://apps.derstandard.at/forum/RatingLog?id=1151194732&idType=Posting&LatestRaterCommunityIdentityId=202'
    ]);
    expect(names('pos')).toEqual(['Anna Beispiel', 'Berta', 'Dora']);
    expect(names('neg')).toEqual(['Kritiker <b>99</b>', 'Carl']);
    // the totals sit in the head; the footer only shows while loading
    expect(Array.from(shadow.querySelectorAll('#dst-voter-head .dst-vch-n')).map((n) => n.textContent)).toEqual(['−2', '+5']);
    expect(shadow.querySelector('#dst-voter-foot').style.display).toBe('none');
    const link = shadow.querySelector('.dst-voter-list a');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(shadow.querySelector('.dst-voter-list b')).toBeNull(); // names are text
  });

  it('the click is intercepted before the page (paywall) handler', async () => {
    const { env, rating } = await withPopup();
    let pageHandler = 0;
    rating('ENC1').addEventListener('click', () => pageHandler++);
    rating('ENC1').click();
    await env.flush();
    expect(pageHandler).toBe(0);
  });

  it('closes on Escape and on backdrop click, keeps open on card click', async () => {
    const { env, rating, overlay, shadow } = await withPopup();
    rating('ENC1').click();
    await env.tick(1000);
    env.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlay()).toBeNull();
    rating('ENC1').click();
    await env.tick(1000);
    shadow.querySelector('#dst-voter-card').click();
    expect(overlay()).not.toBeNull();
    overlay().click();
    expect(overlay()).toBeNull();
  });

  it('stops loading pages once the popup is closed', async () => {
    const { env, rating, overlay, calls } = await withPopup();
    rating('ENC1').click();
    await env.flush();
    expect(calls).toHaveLength(1);
    overlay().click();
    await env.tick(5000);
    expect(calls).toHaveLength(1);
  });

  it('waits briefly for the numeric id, then shows an error', async () => {
    const { env, rating, shadow, calls } = await withPopup({ idMap: null });
    rating('ENC1').click();
    await env.tick(4000);
    expect(shadow.querySelector('.dst-voter-error')).toBeNull();
    await env.tick(1500);
    expect(shadow.querySelector('.dst-voter-error').textContent).toMatch(/Posting-ID nicht gefunden/);
    expect(calls).toEqual([]);
  });

  it('picks up an id that arrives while waiting', async () => {
    const { env, rating, names } = await withPopup({ idMap: null });
    rating('ENC1').click();
    await env.tick(1000);
    env.window.dispatchEvent(new env.window.CustomEvent('dst-voter-idmap', { detail: JSON.stringify({ ENC1: '1' }) }));
    await env.tick(2000);
    expect(names('pos')).toContain('Anna Beispiel');
  });

  it('shows an error if the first page fails', async () => {
    const { env, rating, shadow } = await withPopup({ fetchImpl: async () => ({ ok: false, status: 500 }) });
    rating('ENC1').click();
    await env.tick(500);
    expect(shadow.querySelector('.dst-voter-error').textContent).toBe('Fehler beim Laden der Bewertungsdaten: HTTP 500');
  });

  it('keeps partial results and says so if a later page fails', async () => {
    const { env, rating, shadow, names } = await withPopup({
      fetchImpl: async (url, n) => n === 1
        ? { ok: true, text: async () => readFixture('ratinglog-initial.html') }
        : { ok: false, status: 429 }
    });
    rating('ENC1').click();
    await env.tick(1000);
    expect(names('pos')).toEqual(['Anna Beispiel', 'Berta']);
    expect(shadow.querySelector('.dst-progress-text').textContent)
      .toBe('3 geladen – weitere Daten konnten nicht geladen werden.');
    expect(shadow.querySelector('#dst-voter-foot').style.display).not.toBe('none');
  });

  it('stops when the cursor does not advance (no infinite loop)', async () => {
    const page = '<li data-rate="positive"><a href="/userprofil/postings/7"><span>Loop</span></a></li>';
    const { env, rating, calls } = await withPopup({ fetchImpl: async () => ({ ok: true, text: async () => page }) });
    rating('ENC1').click();
    await env.tick(5000);
    expect(calls).toHaveLength(2);
  });

  it('ignores malformed id-map events', async () => {
    const { env, rating, names } = await withPopup({ idMap: null });
    env.window.dispatchEvent(new env.window.CustomEvent('dst-voter-idmap', { detail: '{not json' }));
    env.window.dispatchEvent(new env.window.CustomEvent('dst-voter-idmap', { detail: JSON.stringify({ ENC1: '1' }) }));
    rating('ENC1').click();
    await env.tick(1000);
    expect(names('pos').length).toBeGreaterThan(0);
    expect(env.errors).toEqual([]);
  });

  it('end-to-end with forum-hook.js capturing ids from GraphQL', async () => {
    const graphql = JSON.stringify({ data: { node: { id: 'ENC2', legacy: { postingId: 42 } } } });
    const calls = [];
    const ctx = await boot({
      postings: [{ id: 'ENC2', pos: 1 }],
      before: (env) => {
        env.window.fetch = async (url) => {
          calls.push(String(url));
          const body = String(url).includes('forum-serve-graphql') ? graphql : PAGE_EMPTY;
          return { ok: true, text: async () => body, clone: () => ({ text: async () => body }) };
        };
      }
    });
    await ctx.env.window.fetch('https://capi.ds.at/forum-serve-graphql');
    await ctx.env.flush();
    ctx.main.querySelector('dst-posting--ratinglog').click();
    await ctx.env.tick(500);
    expect(calls).toContain('https://apps.derstandard.at/forum/ratinglog?id=42&idType=1');
    expect(ctx.shadow.querySelector('.dst-voter-error')).toBeNull();
  });
});

const bootOuter = (...a) => boot(...a);

describe('coffee reminder (v4.20.0)', () => {
  const localDay = (ts) => {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const TODAY = localDay(NOW);
  const YESTERDAY = localDay(NOW - DAY);
  // 9 usage days so far, last one yesterday → today is usage day 10 = first pulse due.
  const DUE = { dstUsageDays: 9, dstLastUsageDay: YESTERDAY };
  const isPulsing = (ctx) => ctx.coffee().classList.contains('dst-pulsing');
  // v4.21.0: the review request comes first; these tests are about a user
  // who has already rated (unless a test says otherwise).
  const boot = (opts = {}) => bootOuter({ ...opts, sync: { dstRanker_ratingGiven: true, ...(opts.sync || {}) } });

  describe('(A) usage days', () => {
    it('counts each day the extension sorted a forum once', async () => {
      const first = await boot({ postings: BASIC, local: { dstUsageDays: 4, dstLastUsageDay: YESTERDAY } });
      expect(first.env.chrome.storage.local.data).toMatchObject({ dstUsageDays: 5, dstLastUsageDay: TODAY });
      const second = await boot({ postings: BASIC, local: { dstUsageDays: 5, dstLastUsageDay: TODAY } });
      expect(second.env.chrome.storage.local.data.dstUsageDays).toBe(5);
    });

    it('starts at 1 for existing users and keeps the install time for the review logic', async () => {
      const { env } = await boot({ postings: BASIC });
      expect(env.chrome.storage.local.data).toMatchObject({ dstUsageDays: 1, dstLastUsageDay: TODAY, dstInstallTimestamp: NOW });
    });

    it('does not count pages where the extension is disabled', async () => {
      const { env } = await boot({ postings: BASIC, sync: { dstSorterEnabled: false } });
      expect(env.chrome.storage.local.data.dstUsageDays).toBeUndefined();
    });

    it.each([
      [0, 8, false], [0, 9, true],
      [1, 23, false], [1, 24, true]
    ])('n=%i, %i earlier usage days → pulsing after a helpful moment = %s', async (n, before, expected) => {
      const ctx = await boot({
        postings: BASIC,
        local: { dstUsageDays: before, dstLastUsageDay: YESTERDAY },
        sync: { dstDonateAckN: n }
      });
      await ctx.clickBadge('likes');
      expect(isPulsing(ctx)).toBe(expected);
    });

    it('calendar age alone does not trigger it', async () => {
      const ctx = await boot({ postings: BASIC, local: { dstInstallTimestamp: NOW - 400 * DAY, dstUsageDays: 2, dstLastUsageDay: YESTERDAY } });
      await ctx.clickBadge('likes');
      expect(isPulsing(ctx)).toBe(false);
    });
  });

  describe('(C) only right after the extension helped', () => {
    it('does not pulse on page load', async () => {
      const ctx = await boot({ postings: BASIC, local: DUE });
      await ctx.env.tick(5000);
      expect(isPulsing(ctx)).toBe(false);
    });

    it('pulses after the reader re-sorted, and keeps pulsing across re-sorts', async () => {
      const ctx = await boot({ postings: BASIC, local: DUE });
      await ctx.clickBadge('timeline');
      expect(isPulsing(ctx)).toBe(true);
      appendPostings(ctx.env.document, ctx.main, [{ id: 'new' }]); // observer re-sort
      await ctx.env.tick(400);
      expect(isPulsing(ctx)).toBe(true);
    });

    it('pulses once the loading ring with its check is gone', async () => {
      let more = true;
      const ctx = await boot({
        postings: [{ id: 'p1' }],
        local: DUE,
        barOnScreen: true,
        before: (env, f) => {
          nativeModel(f.forum, { ids: ['p1'], more: () => more });
          const btn = addLoadMoreButton(env.document, f.shadow, f.main, [[{ id: 'p2' }]]);
          btn.addEventListener('click', () => env.window.setTimeout(() => { more = false; f.forum.forumModel.set('p2', {}); }, 100));
        }
      });
      await ctx.env.tick(1500);
      expect(ctx.coffee().classList.contains('dst-load-done')).toBe(true);
      expect(isPulsing(ctx)).toBe(false); // the ring has the slot
      await ctx.env.tick(2500);
      expect(ctx.coffee().classList.contains('dst-loading')).toBe(false);
      expect(isPulsing(ctx)).toBe(true);
    });

    it('pulses after the complete voter list was shown', async () => {
      const ctx = await boot({
        postings: [{ id: 'ENC1', pos: 1 }],
        local: DUE,
        before: (env) => {
          env.window.fetch = async () => ({ ok: true, text: async () => readFixture('ratinglog-page.html').replace(/data-communityidentityid="\d+"/g, '') });
        }
      });
      ctx.env.window.dispatchEvent(new ctx.env.window.CustomEvent('dst-voter-idmap', { detail: JSON.stringify({ ENC1: '1' }) }));
      ctx.main.querySelector('dst-posting--ratinglog').click();
      await ctx.env.tick(2000);
      expect(ctx.shadow.querySelector('#dst-voter-foot').style.display).toBe('none');
      expect(isPulsing(ctx)).toBe(true);
    });

    it('a failed voter list is not a helpful moment', async () => {
      const ctx = await boot({
        postings: [{ id: 'ENC1', pos: 1 }],
        local: DUE,
        before: (env) => { env.window.fetch = async () => ({ ok: false, status: 500 }); }
      });
      ctx.env.window.dispatchEvent(new ctx.env.window.CustomEvent('dst-voter-idmap', { detail: JSON.stringify({ ENC1: '1' }) }));
      ctx.main.querySelector('dst-posting--ratinglog').click();
      await ctx.env.tick(2000);
      expect(isPulsing(ctx)).toBe(false);
    });
  });

  describe('(E) never on the same day as the review request', () => {
    it('stays calm if the review bar was shown earlier today', async () => {
      const ctx = await boot({ postings: BASIC, local: DUE, sync: { dstRanker_reviewShownDay: TODAY } });
      await ctx.clickBadge('likes');
      expect(isPulsing(ctx)).toBe(false);
    });

    it('a review bar shown yesterday does not block today', async () => {
      const ctx = await boot({ postings: BASIC, local: DUE, sync: { dstRanker_reviewShownDay: YESTERDAY } });
      await ctx.clickBadge('likes');
      expect(isPulsing(ctx)).toBe(true);
    });

    it('a review request on this page switches the pulse off for the rest of it', async () => {
      const ctx = await boot({ postings: BASIC, local: DUE });
      await ctx.clickBadge('likes');
      expect(isPulsing(ctx)).toBe(true);
      ctx.env.document.dispatchEvent(new ctx.env.window.Event('dst-review-shown'));
      expect(isPulsing(ctx)).toBe(false);
      await ctx.clickBadge('timeline');
      expect(isPulsing(ctx)).toBe(false);
    });
  });

  describe('(R) the review request comes first (v4.21.0)', () => {
    it.each([
      [{ dstRanker_ratingGiven: false }, false],
      [{ dstRanker_ratingGiven: false, dstRanker_dismissCount: 2 }, false],
      [{ dstRanker_ratingGiven: false, dstRanker_dismissCount: 3 }, true],
      [{ dstRanker_ratingGiven: true }, true]
    ])('review state %j → pulsing = %s', async (sync, expected) => {
      const ctx = await boot({ postings: BASIC, local: { dstUsageDays: 40, dstLastUsageDay: YESTERDAY }, sync });
      await ctx.clickBadge('likes');
      expect(isPulsing(ctx)).toBe(expected);
    });
  });

  describe('(W) a due pulse shows on at most 3 usage days (v4.21.0)', () => {
    it('the first due day starts the window', async () => {
      const ctx = await boot({ postings: BASIC, local: DUE });
      await ctx.clickBadge('likes');
      expect(isPulsing(ctx)).toBe(true);
      expect(ctx.env.chrome.storage.local.data).toMatchObject({ dstDonatePulseN: 0, dstDonatePulseFrom: 10 });
    });

    it('pulses on the 3rd usage day of the window', async () => {
      const ctx = await boot({ postings: BASIC, local: { dstUsageDays: 11, dstLastUsageDay: YESTERDAY, dstDonatePulseN: 0, dstDonatePulseFrom: 10 } });
      await ctx.clickBadge('likes');
      expect(isPulsing(ctx)).toBe(true);
      expect(ctx.env.chrome.storage.sync.data.dstDonateAckN).toBeUndefined();
    });

    it('after that it counts as seen (n + 1) and stays calm until the next pulse day', async () => {
      const ctx = await boot({ postings: BASIC, local: { dstUsageDays: 12, dstLastUsageDay: YESTERDAY, dstDonatePulseN: 0, dstDonatePulseFrom: 10 } });
      await ctx.clickBadge('likes');
      expect(isPulsing(ctx)).toBe(false);
      expect(ctx.env.chrome.storage.sync.data.dstDonateAckN).toBe(1);
    });

    it('the window of an earlier n does not count for the next pulse', async () => {
      const ctx = await boot({ postings: BASIC, local: { dstUsageDays: 24, dstLastUsageDay: YESTERDAY, dstDonatePulseN: 0, dstDonatePulseFrom: 10 }, sync: { dstDonateAckN: 1 } });
      await ctx.clickBadge('likes');
      expect(isPulsing(ctx)).toBe(true);
      expect(ctx.env.chrome.storage.local.data).toMatchObject({ dstDonatePulseN: 1, dstDonatePulseFrom: 25 });
    });
  });

  it('click acknowledges (n+1), opens the donation page and ends the pulse', async () => {
    const ctx = await boot({ postings: BASIC, local: DUE });
    await ctx.clickBadge('likes');
    const btn = ctx.coffee();
    expect(btn.classList.contains('dst-pulsing')).toBe(true);
    btn.click();
    await ctx.env.tick(400);
    expect(btn.classList.contains('dst-pulsing')).toBe(false);
    expect(ctx.env.chrome.storage.sync.data.dstDonateAckN).toBe(1);
    expect(ctx.env.window.open).toHaveBeenCalledWith('https://buymeacoffee.com/diversion', '_blank');
    await ctx.clickBadge('timeline');
    expect(isPulsing(ctx)).toBe(false);
  });

  it('fails safe (no pulse) when storage cannot be read', async () => {
    const ctx = await boot({
      postings: BASIC,
      local: DUE,
      before: (env) => { env.chrome.storage.local.failNextGet = new Error('boom'); }
    });
    await ctx.clickBadge('likes');
    expect(isPulsing(ctx)).toBe(false);
  });
});

describe('together with rating.js', () => {
  const YESTERDAY_ = (() => { const d = new Date(NOW - DAY); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();

  it('the review bar comes in a helpful moment, right below the sort bar (v4.21.0)', async () => {
    const ctx = await boot({ postings: BASIC, local: { dstUsageDays: 4, dstLastUsageDay: YESTERDAY_ } });
    ctx.env.load('rating.js');
    await ctx.env.tick(1500);
    expect(ctx.shadow.querySelector('#dst-feedback-bar')).toBeNull(); // no moment yet
    await ctx.clickBadge('likes');
    await ctx.env.flush();
    const bar = ctx.shadow.querySelector('#dst-badge-bar');
    expect(bar.nextElementSibling.id).toBe('dst-feedback-bar');
    expect(ctx.coffee().classList.contains('dst-pulsing')).toBe(false);
  });
});
