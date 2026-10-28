// Boots content.js end-to-end against a simulated <dst-forum> and checks what
// the reader actually gets: CSS order, badge bar, persistence, observers,
// background loading and the voter popup.
import { describe, it, expect } from 'vitest';
import { createEnv, readFixture, DAY, DEFAULT_NOW } from '../helpers/env.js';
import { track } from '../helpers/setup.js';
import { buildForum, appendPostings, addLoadMoreButton, renderedOrder, orderOf } from '../helpers/forum.js';

const NOW = DEFAULT_NOW;

async function boot({ postings = [], sync = {}, local = {}, autoLoad = false, forum = {}, extraScripts = [], before } = {}) {
  const env = track(await createEnv({ sync: { dstSorterAutoLoad: autoLoad, ...sync }, local }));
  const f = buildForum(env.document, { postings, ...forum });
  if (before) before(env, f);
  for (const s of extraScripts) env.load(s);
  const c = env.load('content.js');
  await env.flush();
  const badges = () => Array.from(f.shadow.querySelectorAll('#dst-badge-bar .dst-badge-btn[data-group]'));
  const badge = (group) => f.shadow.querySelector(`#dst-badge-bar .dst-badge-btn[data-group="${group}"]`);
  return { env, c, ...f, badges, badge, order: () => renderedOrder(f.main) };
}

const BASIC = [
  { id: 'low', pos: 1, neg: 9 },
  { id: 'top', pos: 50, neg: 2 },
  { id: 'mid', pos: 10, neg: 3 },
  { id: 'zero' }
];

describe('initial sort', () => {
  it('sorts root postings by Balance: Top by default via CSS order only', async () => {
    const { order, main } = await boot({ postings: BASIC });
    expect(order()).toEqual(['top', 'mid', 'zero', 'low']);
    expect(main.style.display).toBe('flex');
    expect(main.style.flexDirection).toBe('column');
  });

  it('does not move or remove any DOM node', async () => {
    const env = track(await createEnv({ sync: { dstSorterAutoLoad: false } }));
    const { main } = buildForum(env.document, { postings: BASIC });
    const before = Array.from(main.children);
    env.load('content.js');
    await env.flush();
    const after = Array.from(main.children).filter((el) => el.id !== 'dst-badge-bar');
    expect(after).toEqual(before);
  });

  it('uses the stored sort mode', async () => {
    const { order } = await boot({ postings: BASIC, sync: { dstSorterMode: 'negative-only' } });
    expect(order()).toEqual(['low', 'mid', 'top', 'zero']);
  });

  it('migrates a legacy stored mode on boot', async () => {
    const { env, order } = await boot({ postings: BASIC, sync: { sortByPositive: true } });
    expect(order()).toEqual(['top', 'mid', 'low', 'zero']);
    expect(env.chrome.storage.sync.data.dstSorterMode).toBe('positive-only');
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

  it('hides the duplicate of a pinned posting and sorts with its fresher ratings', async () => {
    const { order, main } = await boot({
      postings: [
        { id: 'P', pinned: true, pos: 1 },
        { id: 'x', pos: 5 },
        { id: 'P', pos: 1, neg: 0, replies: 1 }
      ]
    });
    const copies = main.querySelectorAll('dst-posting[data-level="0"]');
    expect(copies[2].style.display).toBe('none');
    expect(main.querySelector('section.thread').style.display).toBe('none');
    expect(order()).toEqual(['P', 'x']);
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

  it('collapses expanded reply threads exactly once after sorting', async () => {
    const { main } = await boot({ postings: [{ id: 'a', expanded: true, replies: 1 }] });
    const p = main.querySelector('dst-posting');
    expect(p.classList.contains('posting-has-thread-expanded')).toBe(false);
    expect(p.dataset.toggleClicks).toBe('1');
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

describe('badge bar', () => {
  it('renders 3 sort badges + coffee as the first, keyboard-accessible element', async () => {
    const { shadow, main, badges } = await boot({ postings: BASIC });
    const bar = shadow.querySelector('#dst-badge-bar');
    expect(main.firstElementChild).toBe(bar);
    expect(bar.style.order).toBe('-1');
    expect(badges().map((b) => [b.dataset.group, b.dataset.mode, b.classList.contains('active')])).toEqual([
      ['balance', 'balance-top', true],
      ['likes', 'positive-only', false],
      ['timeline', 'chronological-new', false]
    ]);
    for (const b of bar.querySelectorAll('.dst-badge-btn')) {
      expect(b.getAttribute('role')).toBe('button');
      expect(b.getAttribute('tabindex')).toBe('0');
      expect(b.getAttribute('aria-label')).toBeTruthy();
    }
    expect(shadow.querySelectorAll('#dst-icon-style')).toHaveLength(1);
  });

  it('cycles sub-modes on repeated clicks, persists and re-sorts', async () => {
    const { env, badge, order } = await boot({ postings: BASIC });
    badge('likes').click();
    await env.flush();
    expect(env.chrome.storage.sync.data.dstSorterMode).toBe('positive-only');
    expect(order()).toEqual(['top', 'mid', 'low', 'zero']);

    badge('likes').click();
    await env.flush();
    expect(env.chrome.storage.sync.data.dstSorterMode).toBe('negative-only');
    expect(order()).toEqual(['low', 'mid', 'top', 'zero']);
    expect(badge('likes').classList.contains('dst-low')).toBe(true);

    badge('likes').click(); // wraps around
    await env.flush();
    expect(env.chrome.storage.sync.data.dstSorterMode).toBe('positive-only');
  });

  it('switching groups restores that group\'s last sub-mode', async () => {
    const { env, badge } = await boot({ postings: BASIC });
    badge('balance').click(); // → balance-flop
    await env.flush();
    badge('timeline').click(); // → chronological-new
    await env.flush();
    expect(badge('balance').dataset.mode).toBe('balance-flop');
    badge('balance').click(); // back to the remembered balance-flop
    await env.flush();
    expect(env.chrome.storage.sync.data.dstSorterMode).toBe('balance-flop');
  });

  it('exactly one badge is active at any time', async () => {
    const { env, badge, badges } = await boot({ postings: BASIC });
    for (const g of ['likes', 'timeline', 'timeline', 'balance', 'likes']) {
      badge(g).click();
      await env.flush();
      expect(badges().filter((b) => b.classList.contains('active'))).toHaveLength(1);
    }
  });

  it('works with Enter and Space', async () => {
    const { env, badge } = await boot({ postings: BASIC });
    badge('timeline').dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await env.flush();
    expect(env.chrome.storage.sync.data.dstSorterMode).toBe('chronological-new');
    badge('timeline').dispatchEvent(new env.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await env.flush();
    expect(env.chrome.storage.sync.data.dstSorterMode).toBe('chronological-old');
  });

  it('Timeline badges sort by time', async () => {
    const { env, badge, order } = await boot({
      postings: [
        { id: 'old', time: '2026-10-27T08:00:00Z', pos: 99 },
        { id: 'new', time: '2026-10-28T11:00:00Z' },
        { id: 'mid', timeText: 'vor 5 Stunden' } // <time> without datetime
      ]
    });
    badge('timeline').click();
    await env.flush();
    expect(order()).toEqual(['new', 'mid', 'old']);
    badge('timeline').click();
    await env.flush();
    expect(order()).toEqual(['old', 'mid', 'new']);
  });
});

describe('coffee badge pulse (same schedule as the popup)', () => {
  it.each([[0, 14, false], [0, 15, true], [1, 37, false], [1, 38, true]])(
    'n=%i, day %i → pulsing=%s', async (n, days, pulsing) => {
      const { env, shadow } = await boot({
        postings: BASIC,
        local: { dstInstallTimestamp: NOW - days * DAY },
        sync: { dstDonateAckN: n }
      });
      await env.flush();
      expect(shadow.querySelector('.dst-coffee-btn').classList.contains('dst-pulsing')).toBe(pulsing);
    });

  it('click acknowledges and opens the donation page', async () => {
    const { env, shadow } = await boot({ postings: BASIC, local: { dstInstallTimestamp: NOW - 20 * DAY } });
    await env.flush();
    const btn = shadow.querySelector('.dst-coffee-btn');
    btn.click();
    await env.flush();
    expect(btn.classList.contains('dst-pulsing')).toBe(false);
    expect(env.chrome.storage.sync.data.dstDonateAckN).toBe(1);
    expect(env.window.open).toHaveBeenCalledWith('https://buymeacoffee.com/diversion', '_blank');
  });
});

describe('runtime messages from the popup', () => {
  it('setMode re-sorts immediately', async () => {
    const { env, order } = await boot({ postings: BASIC });
    env.chrome.sendRuntimeMessage({ action: 'setMode', mode: 'balance-flop' });
    expect(order()).toEqual(['low', 'zero', 'mid', 'top']);
  });

  it('toggle off removes the badge bar', async () => {
    const { env, shadow } = await boot({ postings: BASIC });
    env.chrome.sendRuntimeMessage({ action: 'toggle', enabled: false });
    expect(shadow.querySelector('#dst-badge-bar')).toBeNull();
  });
});

describe('observers', () => {
  it('sorts newly loaded postings into place (debounced)', async () => {
    const { env, main, order } = await boot({ postings: BASIC });
    appendPostings(env.document, main, [{ id: 'new-best', pos: 999 }, { id: 'new-worst', neg: 999 }]);
    await env.tick(299);
    expect(order().slice(0, 1)).toEqual(['top']);
    await env.tick(1);
    expect(order()).toEqual(['new-best', 'top', 'mid', 'zero', 'low', 'new-worst']);
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
    await env.tick(3000);
    expect(order()[0]).toBe('zero');
  });

  it('does not end up in a sort loop', async () => {
    const { env, shadow } = await boot({ postings: BASIC });
    let rebuilt = 0;
    new env.window.MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (n.id === 'dst-badge-bar') rebuilt++;
      }
    }).observe(shadow.querySelector('main'), { childList: true });
    await env.tick(20000);
    expect(rebuilt).toBe(0);
  });
});

describe('late forum rendering', () => {
  it('waits for <dst-forum> to appear', async () => {
    const env = track(await createEnv({ sync: { dstSorterAutoLoad: false } }));
    env.load('content.js');
    await env.tick(2000);
    const { main } = buildForum(env.document, { postings: BASIC });
    await env.tick(600);
    expect(renderedOrder(main)).toEqual(['top', 'mid', 'zero', 'low']);
  });

  it('waits for main.forum--main and the first posting inside the shadow root', async () => {
    const env = track(await createEnv({ sync: { dstSorterAutoLoad: false } }));
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

  it('sorts anyway after ~15 s if ratings never show up', async () => {
    const { env, order, shadow } = await boot({
      postings: [{ id: 'a', ratings: false }, { id: 'b', ratings: false }, { id: 'c', pos: 3 }]
    });
    expect(shadow.querySelector('#dst-badge-bar')).toBeNull();
    await env.tick(15000);
    expect(shadow.querySelector('#dst-badge-bar')).not.toBeNull();
  });

  it('stops polling on pages without a forum', async () => {
    const env = track(await createEnv({ url: 'https://www.derstandard.at/' }));
    env.load('content.js');
    await env.flush();
    await env.tick(60000);
    expect(env.clock.countTimers()).toBe(0);
  });
});

describe('background loading of all postings', () => {
  it('clicks "Weitere Postings laden" until everything is loaded, then sorts all', async () => {
    let btn;
    const { env, order } = await boot({
      autoLoad: true,
      postings: [{ id: 'p1', pos: 5 }, { id: 'p2', pos: 1 }],
      before: (env, f) => {
        btn = addLoadMoreButton(env.document, f.shadow, f.main, [
          [{ id: 'p3', pos: 50 }, { id: 'p4', expanded: true }],
          [{ id: 'p5', pos: 3 }]
        ]);
      }
    });
    await env.tick(15000);
    expect(btn.clicks).toBe(2);
    expect(order()).toEqual(['p3', 'p1', 'p5', 'p2', 'p4']);
  });

  it('shows a progress bar while loading and restores the badges afterwards', async () => {
    const { env, shadow } = await boot({
      autoLoad: true,
      postings: [{ id: 'p1' }],
      forum: { count: 3 },
      before: (env, f) => addLoadMoreButton(env.document, f.shadow, f.main, [[{ id: 'p2' }], [{ id: 'p3' }]], { delay: 2000 })
    });
    await env.tick(300);
    const progress = shadow.querySelector('#dst-progress-container');
    expect(progress).not.toBeNull();
    expect(progress.textContent).toMatch(/Lade alle Postings\.\.\. \d+ \/ 3/);
    await env.tick(20000);
    expect(shadow.querySelector('#dst-progress-container')).toBeNull();
    for (const b of shadow.querySelectorAll('#dst-badge-bar .dst-badge-btn')) expect(b.style.display).toBe('');
  });

  it('confirms completion through the native load-state bridge', async () => {
    const { env, shadow } = await boot({
      autoLoad: true,
      postings: [{ id: 'p1' }, { id: 'p2' }],
      extraScripts: ['forum-hook.js'],
      before: (env, { forum }) => Object.assign(forum, {
        forumModel: new Map([['p1', {}], ['p2', {}]]),
        threadsByForumQuery: { data: { getForumRootPostingsV2: { pageInfo: { nextCursor: '' } } } },
        _totalPostingCount: 2,
        hasMorePostings: () => false,
        isLoading: false,
        activeFilter: 0,
        sortField: 'ByTime',
        sortDirection: 'descending'
      })
    });
    await env.tick(250);
    expect(shadow.querySelector('#dst-progress-container').textContent).toBe('✓ Alle 2 Postings geladen!');
    await env.tick(1500);
    expect(shadow.querySelector('#dst-progress-container')).toBeNull();
    expect(env.warnings()).toEqual([]);
  });

  it('gives up after 3 stalled attempts instead of clicking forever', async () => {
    let clicks = 0;
    const { env } = await boot({
      autoLoad: true,
      postings: [{ id: 'p1' }],
      before: (env, { shadow }) => {
        const btn = env.document.createElement('button');
        btn.className = 'thread--more';
        btn.addEventListener('click', () => clicks++);
        shadow.appendChild(btn);
      }
    });
    await env.tick(120000);
    expect(clicks).toBe(3);
    expect(env.warnings().some((w) => String(w.args[0]).includes('Vollständigkeit nicht bestätigt'))).toBe(true);
  });

  it('never touches reply toggles while loading', async () => {
    const { env, main } = await boot({
      autoLoad: true,
      postings: [{ id: 'p1', hasThread: true }],
      before: (env, f) => addLoadMoreButton(env.document, f.shadow, f.main, [[{ id: 'p2', hasThread: true }]])
    });
    await env.tick(15000);
    for (const p of main.querySelectorAll('dst-posting')) expect(p.dataset.toggleClicks).toBeUndefined();
  });

  it('switches to the "Alle Postings" tab once if a filter tab is active', async () => {
    let tabClicks = 0;
    await boot({
      autoLoad: true,
      postings: [{ id: 'p1' }],
      before: (env, { shadow }) => {
        const tab = env.document.createElement('button');
        tab.setAttribute('role', 'tab');
        tab.textContent = 'Alle Postings';
        tab.addEventListener('click', () => { tabClicks++; tab.classList.add('active'); });
        shadow.appendChild(tab);
      }
    }).then(({ env }) => env.tick(30000));
    expect(tabClicks).toBe(1);
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
        env.window.fetch = fetchImpl ? (url) => { calls.push(url); return fetchImpl(url, calls.length); } : async (url) => {
          calls.push(url);
          return { ok: true, status: 200, text: async () => queue.shift() || PAGE_EMPTY };
        };
      }
    });
    if (idMap) {
      ctx.env.window.dispatchEvent(new ctx.env.window.CustomEvent('dst-voter-idmap', { detail: JSON.stringify(idMap) }));
    }
    const rating = (id) => ctx.main.querySelector(`dst-posting--ratinglog[postingid="${id}"]`);
    const overlay = () => ctx.shadow.querySelector('#dst-voter-overlay');
    const names = (kind) => Array.from(ctx.shadow.querySelectorAll(`.dst-voter-list[data-kind="${kind}"] a`)).map((a) => a.textContent);
    return { ...ctx, calls, rating, overlay, names };
  }

  it('clicking the rating numbers lists all positive and negative voters', async () => {
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
    expect(shadow.querySelector('.dst-voter-progress-text').textContent).toBe('5 Bewertungen geladen');
    const link = shadow.querySelector('.dst-voter-list a');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    // Voter names are rendered as text, never as markup.
    expect(shadow.querySelector('.dst-voter-list b')).toBeNull();
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

  const failSecondPage = async (url, n) => n === 1
    ? { ok: true, text: async () => readFixture('ratinglog-initial.html') }
    : { ok: false, status: 429 };

  it('keeps partial results if a later page fails', async () => {
    const { env, rating, names, calls } = await withPopup({ fetchImpl: failSecondPage });
    rating('ENC1').click();
    await env.tick(5000);
    expect(names('pos')).toEqual(['Anna Beispiel', 'Berta']);
    expect(names('neg')).toEqual(['Kritiker <b>99</b>']);
    expect(calls).toHaveLength(2);
  });

  it('tells the reader that further data could not be loaded', async () => {
    const { env, rating, shadow } = await withPopup({ fetchImpl: failSecondPage });
    rating('ENC1').click();
    await env.tick(1000);
    expect(shadow.querySelector('.dst-voter-progress-text').textContent)
      .toBe('3 geladen \u2013 weitere Daten konnten nicht geladen werden.');
    expect(shadow.querySelector('#dst-voter-body').style.display).toBe('flex');
    expect(shadow.querySelector('.dst-voter-progress--done')).not.toBeNull();
  });

  it('stops when the cursor does not advance (no infinite loop)', async () => {
    const page = '<li data-rate="positive"><a href="/userprofil/postings/7"><span>Loop</span></a></li>';
    const { env, rating, calls } = await withPopup({
      fetchImpl: async () => ({ ok: true, text: async () => page })
    });
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
    const { env, main, shadow } = await boot({
      postings: [{ id: 'ENC2', pos: 1 }],
      extraScripts: ['forum-hook.js'],
      before: (env) => {
        env.window.fetch = async (url) => {
          calls.push(String(url));
          const body = String(url).includes('forum-serve-graphql') ? graphql : PAGE_EMPTY;
          return { ok: true, text: async () => body, clone: () => ({ text: async () => body }) };
        };
      }
    });
    await env.window.fetch('https://capi.ds.at/forum-serve-graphql');
    await env.flush();
    main.querySelector('dst-posting--ratinglog').click();
    await env.tick(500);
    expect(calls).toContain('https://apps.derstandard.at/forum/ratinglog?id=42&idType=1');
    expect(shadow.querySelector('.dst-voter-error')).toBeNull();
  });
});

describe('together with rating.js', () => {
  it('the review bar is placed right below the badge bar', async () => {
    const { env, shadow } = await boot({
      postings: BASIC,
      sync: { dstRanker_installDate: NOW - 10 * DAY, dstRanker_v1915Reset: true, dstRanker_v1916Reset: true }
    });
    env.load('rating.js');
    await env.tick(1500);
    const bar = shadow.querySelector('#dst-badge-bar');
    expect(bar.nextElementSibling.id).toBe('dst-feedback-bar');
  });
});
