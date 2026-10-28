import { describe, it, expect } from 'vitest';
import { loadContent } from '../helpers/setup.js';
import { createPosting, buildForum } from '../helpers/forum.js';
import { readFixture, DEFAULT_NOW } from '../helpers/env.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('parseRelativeTime', () => {
  it.each([
    ['vor 30 Sekunden', 30 * 1000],
    ['vor 1 Sekunde', 1000],
    ['vor 1 Minute', MIN],
    ['vor 5 Minuten', 5 * MIN],
    ['vor 1 Stunde', HOUR],
    ['vor 3 Stunden', 3 * HOUR],
    ['vor 1 Tag', DAY],
    ['vor 2 Tagen', 2 * DAY],
    ['vor 2 Wochen', 14 * DAY],
    ['vor 1 Monat', 30 * DAY],
    ['vor 3 Monaten', 90 * DAY],
    ['vor 2 Jahren', 730 * DAY],
    ['Gepostet vor 4 Stunden', 4 * HOUR],
    ['VOR 2 TAGEN', 2 * DAY]
  ])('%s', async (text, ago) => {
    const { c } = await loadContent();
    expect(c.parseRelativeTime(text)).toBe(DEFAULT_NOW - ago);
  });

  it.each([null, undefined, '', '28. Oktober 2026, 10:00', 'vor kurzem', 'vor 0 Minuten'])(
    'returns 0 for unparseable input %j', async (text) => {
      const { c } = await loadContent();
      expect(c.parseRelativeTime(text)).toBe(0);
    });

  // Known gaps: these phrasings yield 0 (= "unknown time") today. If derStandard
  // renders them, Timeline sorting falls back to DOM order for those postings.
  // `it.fails` turns green→red once the parser learns them, so update the test then.
  it.fails('KNOWN GAP: understands spelled-out "vor einer Stunde"', async () => {
    const { c } = await loadContent();
    expect(c.parseRelativeTime('vor einer Stunde')).toBe(DEFAULT_NOW - HOUR);
  });
  it.fails('KNOWN GAP: understands abbreviated "vor 3 Std."', async () => {
    const { c } = await loadContent();
    expect(c.parseRelativeTime('vor 3 Std.')).toBe(DEFAULT_NOW - 3 * HOUR);
  });
});

describe('getPostingTimestamp', () => {
  it('prefers a valid ISO datetime attribute', async () => {
    const { c, env } = await loadContent();
    const p = createPosting(env.document, { time: '2026-10-01T08:00:00Z', timeText: 'vor 5 Minuten' });
    expect(c.getPostingTimestamp(p)).toBe(Date.parse('2026-10-01T08:00:00Z'));
  });

  it.each(['null', 'undefined', 'kaputt', ''])(
    'falls back to the relative text when datetime is %j', async (attr) => {
      const { c, env } = await loadContent();
      const p = createPosting(env.document, { time: attr, timeText: 'vor 2 Stunden' });
      expect(c.getPostingTimestamp(p)).toBe(DEFAULT_NOW - 2 * HOUR);
    });

  it('reads <time> inside the posting shadow DOM', async () => {
    const { c, env } = await loadContent();
    const p = createPosting(env.document, {});
    const t = env.document.createElement('time');
    t.setAttribute('datetime', '2026-09-09T09:09:09Z');
    p.attachShadow({ mode: 'open' }).appendChild(t);
    expect(c.getPostingTimestamp(p)).toBe(Date.parse('2026-09-09T09:09:09Z'));
  });

  it('reads <time> inside dst-posting-head (light and shadow DOM)', async () => {
    const { c, env } = await loadContent();
    const doc = env.document;
    const p1 = createPosting(doc, {});
    const head1 = doc.createElement('dst-posting-head');
    const t1 = doc.createElement('time');
    t1.textContent = 'vor 10 Minuten';
    head1.appendChild(t1);
    p1.appendChild(head1);
    expect(c.getPostingTimestamp(p1)).toBe(DEFAULT_NOW - 10 * MIN);

    const p2 = createPosting(doc, {});
    const head2 = doc.createElement('dst-posting-head');
    const t2 = doc.createElement('time');
    t2.setAttribute('datetime', '2026-10-28T11:00:00Z');
    head2.attachShadow({ mode: 'open' }).appendChild(t2);
    p2.appendChild(head2);
    expect(c.getPostingTimestamp(p2)).toBe(Date.parse('2026-10-28T11:00:00Z'));
  });

  it('scans leaf <span>s for relative time text', async () => {
    const { c, env } = await loadContent();
    const p = createPosting(env.document, {});
    const s = env.document.createElement('span');
    s.textContent = 'vor 3 Tagen';
    p.appendChild(s);
    expect(c.getPostingTimestamp(p)).toBe(DEFAULT_NOW - 3 * DAY);
  });

  it('uses data-created / data-timestamp attributes as last resort', async () => {
    const { c, env } = await loadContent();
    const p = createPosting(env.document, {});
    p.setAttribute('data-created', '2026-05-05T05:05:05Z');
    expect(c.getPostingTimestamp(p)).toBe(Date.parse('2026-05-05T05:05:05Z'));
  });

  // KNOWN GAP: a <time> without datetime attribute is skipped (strategy 1 needs
  // time[datetime], strategy 4 only scans <span>s), so the posting sorts as
  // "unknown time" in Timeline modes.
  it.fails('KNOWN GAP: reads relative text of a <time> without datetime attribute', async () => {
    const { c, env } = await loadContent();
    const p = createPosting(env.document, { timeText: 'vor 5 Stunden' });
    expect(c.getPostingTimestamp(p)).toBe(DEFAULT_NOW - 5 * HOUR);
  });

  it('returns 0 when no time information exists', async () => {
    const { c, env } = await loadContent();
    expect(c.getPostingTimestamp(createPosting(env.document, {}))).toBe(0);
  });
});

describe('parseRatingLog', () => {
  it('parses totals, entries and the cursor of the initial response', async () => {
    const { c } = await loadContent();
    const r = c.parseRatingLog(readFixture('ratinglog-initial.html'));
    expect(r.totals).toEqual({ pos: 5, neg: 2 });
    expect(r.nextCursor).toBe('555');
    expect(r.entries).toEqual([
      { name: 'Anna Beispiel', rate: 'positive', profile: '/userprofil/postings/101', cid: '101' },
      { name: 'Kritiker <b>99</b>', rate: 'negative', profile: '/userprofil/postings/102', cid: '102' },
      { name: 'Berta', rate: 'positive', profile: 'https://www.derstandard.at/userprofil/postings/103', cid: '103' }
    ]);
  });

  it('skips entries with an unknown rate or an empty name', async () => {
    const { c } = await loadContent();
    const names = c.parseRatingLog(readFixture('ratinglog-initial.html')).entries.map((e) => e.name);
    expect(names).not.toContain('Unbekannt');
    expect(names).not.toContain('');
  });

  it('uses the last community id as cursor for pagination pages', async () => {
    const { c } = await loadContent();
    const r = c.parseRatingLog(readFixture('ratinglog-page.html'));
    expect(r.totals).toBeNull();
    expect(r.entries.map((e) => [e.name, e.rate, e.cid])).toEqual([
      ['Carl', 'negative', '201'],
      ['Dora', 'positive', '202']
    ]);
    expect(r.nextCursor).toBe('202');
  });

  it('ignores a non-numeric hidden cursor', async () => {
    const { c } = await loadContent();
    const html = '<input name="LatestRaterCommunityIdentityId" value="abc">' +
      '<li data-rate="positive"><a href="/userprofil/postings/9"><span>X</span></a></li>';
    expect(c.parseRatingLog(html).nextCursor).toBe('9');
  });

  it.each(['', '<html></html>', '<li>', 'not html at all <<<'])(
    'survives empty or broken markup %j', async (html) => {
      const { c } = await loadContent();
      expect(c.parseRatingLog(html)).toEqual({ totals: null, entries: [], nextCursor: null });
    });

  it('treats voter names as text (no HTML injection)', async () => {
    const { c } = await loadContent();
    const html = '<li data-rate="positive"><a href="/userprofil/postings/1"><span>&lt;img src=x onerror=alert(1)&gt;</span></a></li>';
    expect(c.parseRatingLog(html).entries[0].name).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('fetchRatingLogPage', () => {
  it('builds the initial and the pagination URL and omits credentials', async () => {
    const { c, env } = await loadContent();
    const calls = [];
    env.window.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, text: async () => 'ok' };
    };
    await c.fetchRatingLogPage('1151194732', null);
    await c.fetchRatingLogPage('1151194732', '555');
    expect(calls[0].url).toBe('https://apps.derstandard.at/forum/ratinglog?id=1151194732&idType=1');
    expect(calls[1].url).toBe('https://apps.derstandard.at/forum/RatingLog?id=1151194732&idType=Posting&LatestRaterCommunityIdentityId=555');
    for (const call of calls) expect(call.opts.credentials).toBe('omit');
  });

  it('URL-encodes ids', async () => {
    const { c, env } = await loadContent();
    let seen;
    env.window.fetch = async (url) => { seen = url; return { ok: true, text: async () => '' }; };
    await c.fetchRatingLogPage('1&x=2', null);
    expect(seen).toContain('id=1%26x%3D2&');
  });

  it('throws on HTTP errors', async () => {
    const { c, env } = await loadContent();
    env.window.fetch = async () => ({ ok: false, status: 503 });
    await expect(c.fetchRatingLogPage('1', null)).rejects.toThrow('HTTP 503');
  });
});

describe('getTotalPostingCount', () => {
  it('reads the count from the forum header', async () => {
    const { c, env } = await loadContent();
    const { shadow } = buildForum(env.document, { count: 143 });
    expect(c.getTotalPostingCount(shadow)).toBe(143);
  });

  it('strips German thousands separators', async () => {
    const { c, env } = await loadContent();
    const { shadow } = buildForum(env.document, {});
    const el = env.document.createElement('span');
    el.className = 'forum--postingcount';
    el.textContent = '1.234 Postings und Antworten';
    shadow.appendChild(el);
    expect(c.getTotalPostingCount(shadow)).toBe(1234);
  });

  it('falls back to the light-DOM counters in priority order', async () => {
    const { c, env } = await loadContent();
    const { shadow } = buildForum(env.document, {});
    const doc = env.document;
    doc.body.insertAdjacentHTML('beforeend',
      '<button class="article-postingcount">99 Postings</button>' +
      '<span class="js-forum-postingcount">57 Postings</span>');
    expect(c.getTotalPostingCount(shadow)).toBe(57);
  });

  it('ignores unrelated per-thread counters and zero counts', async () => {
    const { c, env } = await loadContent();
    const { shadow } = buildForum(env.document, {});
    shadow.querySelector('main').insertAdjacentHTML('beforeend',
      '<span class="thread-postingcount">1</span><span class="forum--postingcount">0 Postings</span>');
    expect(c.getTotalPostingCount(shadow)).toBe(0);
  });
});
