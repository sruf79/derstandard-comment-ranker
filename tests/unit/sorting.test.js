import { describe, it, expect } from 'vitest';
import { loadContent } from '../helpers/setup.js';
import { createPosting } from '../helpers/forum.js';

async function setup() {
  const { env, c } = await loadContent();
  const doc = env.document;
  // A group as produced by collectPostingGroups().
  const group = (spec, domIndex) => ({ posting: createPosting(doc, spec), siblings: [], domIndex });
  const sortIds = (mode, specs) => {
    c.sortMode = mode;
    const groups = specs.map((s, i) => group(s, i));
    return groups.sort(c.sortComparator).map((g) => g.posting.querySelector('dst-posting--ratinglog').getAttribute('postingid'));
  };
  return { env, c, doc, group, sortIds };
}

const SAMPLE = [
  { id: 'a', pos: 10, neg: 2 },  // net 8
  { id: 'b', pos: 3, neg: 9 },   // net -6
  { id: 'c', pos: 20, neg: 15 }, // net 5
  { id: 'd', pos: 0, neg: 0 },   // net 0
  { id: 'e', pos: 1, neg: 30 }   // net -29
];

describe('sortComparator', () => {
  it('Balance: Top sorts by positive minus negative, highest first', async () => {
    const { sortIds } = await setup();
    expect(sortIds('balance-top', SAMPLE)).toEqual(['a', 'c', 'd', 'b', 'e']);
  });

  it('Balance: Low is the exact mirror of Balance: Top', async () => {
    const { sortIds } = await setup();
    expect(sortIds('balance-flop', SAMPLE)).toEqual(['e', 'b', 'd', 'c', 'a']);
  });

  it('Likes: Top sorts by positive ratings only', async () => {
    const { sortIds } = await setup();
    expect(sortIds('positive-only', SAMPLE)).toEqual(['c', 'a', 'b', 'e', 'd']);
  });

  it('Likes: Low sorts by negative ratings only', async () => {
    const { sortIds } = await setup();
    expect(sortIds('negative-only', SAMPLE)).toEqual(['e', 'c', 'b', 'a', 'd']);
  });

  it('Timeline: New / Old sort by posting timestamp', async () => {
    const { sortIds } = await setup();
    const specs = [
      { id: 'mid', time: '2026-10-28T10:00:00Z' },
      { id: 'old', time: '2026-10-27T10:00:00Z' },
      { id: 'new', time: '2026-10-28T11:30:00Z' }
    ];
    expect(sortIds('chronological-new', specs)).toEqual(['new', 'mid', 'old']);
    expect(sortIds('chronological-old', specs)).toEqual(['old', 'mid', 'new']);
  });

  it('treats the legacy "chronological" mode as Timeline: Old', async () => {
    const { sortIds } = await setup();
    const specs = [
      { id: 'b', time: '2026-10-28T10:00:00Z' },
      { id: 'a', time: '2026-10-27T10:00:00Z' }
    ];
    expect(sortIds('chronological', specs)).toEqual(['a', 'b']);
  });

  it('keeps the original forum order for ties in every mode', async () => {
    const { sortIds, c } = await setup();
    const ties = [
      { id: 't1', pos: 5, neg: 1, time: '2026-10-28T10:00:00Z' },
      { id: 't2', pos: 5, neg: 1, time: '2026-10-28T10:00:00Z' },
      { id: 't3', pos: 5, neg: 1, time: '2026-10-28T10:00:00Z' }
    ];
    for (const mode of c.ALL_MODES) {
      expect(sortIds(mode, ties), mode).toEqual(['t1', 't2', 't3']);
    }
  });

  it('restores forum order for ties even if the input array is shuffled', async () => {
    const { c, group } = await setup();
    c.sortMode = 'balance-top';
    const groups = [group({ id: 'third', pos: 1 }, 2), group({ id: 'first', pos: 1 }, 0), group({ id: 'second', pos: 1 }, 1)];
    const ids = groups.sort(c.sortComparator).map((g) => g.posting.querySelector('dst-posting--ratinglog').getAttribute('postingid'));
    expect(ids).toEqual(['first', 'second', 'third']);
  });

  it('breaks ties by domIndex, not by an unrelated secondary criterion', async () => {
    const { sortIds } = await setup();
    // Same positives, very different negatives: Likes: Top must ignore negatives.
    expect(sortIds('positive-only', [
      { id: 'x', pos: 4, neg: 50 },
      { id: 'y', pos: 4, neg: 0 }
    ])).toEqual(['x', 'y']);
  });

  it('leaves the order untouched for an unknown mode', async () => {
    const { sortIds } = await setup();
    expect(sortIds('does-not-exist', SAMPLE)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('computes the sort key only once per group', async () => {
    const { c, group } = await setup();
    c.sortMode = 'balance-top';
    const g1 = group({ pos: 1 }, 0);
    const g2 = group({ pos: 2 }, 1);
    c.sortComparator(g1, g2);
    const key = g1.key;
    expect(key).toEqual({ pos: 1, neg: 0, net: 1, time: 0 });
    // Changing the DOM afterwards does not change the cached key for this sort run.
    g1.posting.querySelector('dst-posting--ratinglog').setAttribute('positiveratings', '99');
    c.sortComparator(g1, g2);
    expect(g1.key).toBe(key);
  });

  it('only reads timestamps for Timeline modes', async () => {
    const { c, group } = await setup();
    const g = group({ pos: 1, time: '2026-10-28T10:00:00Z' }, 0);
    c.sortMode = 'balance-top';
    expect(c.computeSortKey(g).time).toBe(0);
    c.sortMode = 'chronological-new';
    expect(c.computeSortKey(g).time).toBe(Date.parse('2026-10-28T10:00:00Z'));
  });

  it('is a consistent comparator (antisymmetric) for all modes', async () => {
    const { c, group } = await setup();
    for (const mode of c.ALL_MODES) {
      c.sortMode = mode;
      const groups = SAMPLE.map((s, i) => group({ ...s, time: new Date(Date.UTC(2026, 0, i + 1)).toISOString() }, i));
      for (const a of groups) {
        for (const b of groups) {
          expect(Math.sign(c.sortComparator(a, b)) + 0, mode).toBe(-Math.sign(c.sortComparator(b, a)) + 0);
        }
      }
    }
  });
});

describe('readRatings / rating overrides', () => {
  it('reads positive/negative attributes of dst-posting--ratinglog', async () => {
    const { c, doc } = await setup();
    const p = createPosting(doc, { pos: 7, neg: 3 });
    expect(c.readRatings(p)).toEqual({ pos: 7, neg: 3 });
    expect(c.getNetRatings(p)).toBe(4);
  });

  it('returns zeros for missing or non-numeric attributes', async () => {
    const { c, doc } = await setup();
    expect(c.readRatings(createPosting(doc, { ratings: false }))).toEqual({ pos: 0, neg: 0 });
    const p = createPosting(doc, {});
    const r = p.querySelector('dst-posting--ratinglog');
    r.setAttribute('positiveratings', 'abc');
    r.removeAttribute('negativeratings');
    expect(c.readRatings(p)).toEqual({ pos: 0, neg: 0 });
  });

  it('transferRatingsIfNewer only applies fresher (higher total) ratings', async () => {
    const { c, doc } = await setup();
    const canonical = createPosting(doc, { pos: 5, neg: 1 });
    const staleCopy = createPosting(doc, { pos: 4, neg: 1 });
    const freshCopy = createPosting(doc, { pos: 6, neg: 2 });

    expect(c.transferRatingsIfNewer(staleCopy, canonical)).toBe(false);
    expect(c.readRatings(canonical)).toEqual({ pos: 5, neg: 1 });

    expect(c.transferRatingsIfNewer(freshCopy, canonical)).toBe(true);
    expect(c.readRatings(canonical)).toEqual({ pos: 6, neg: 2 });
  });

  it('never writes the override into the native component attributes', async () => {
    const { c, doc } = await setup();
    const canonical = createPosting(doc, { pos: 1, neg: 0 });
    c.transferRatingsIfNewer(createPosting(doc, { pos: 9, neg: 9 }), canonical);
    const r = canonical.querySelector('dst-posting--ratinglog');
    expect(r.getAttribute('positiveratings')).toBe('1');
    expect(r.getAttribute('negativeratings')).toBe('0');
  });

  it('drops the override once the live attributes catch up', async () => {
    const { c, doc } = await setup();
    const canonical = createPosting(doc, { pos: 1, neg: 0 });
    c.transferRatingsIfNewer(createPosting(doc, { pos: 3, neg: 0 }), canonical);
    // The user votes on the canonical copy → native attributes now newer.
    canonical.querySelector('dst-posting--ratinglog').setAttribute('positiveratings', '4');
    expect(c.readRatings(canonical)).toEqual({ pos: 4, neg: 0 });
  });

  it('buildSortSignature changes whenever any rating changes', async () => {
    const { c, group } = await setup();
    const groups = [group({ pos: 1, neg: 2 }, 0), group({ pos: 3, neg: 0 }, 1)];
    const sig = c.buildSortSignature(groups);
    expect(sig).toBe('1:2,3:0');
    groups[1].posting.querySelector('dst-posting--ratinglog').setAttribute('negativeratings', '1');
    expect(c.buildSortSignature(groups)).not.toBe(sig);
  });
});

describe('migrateStorage', () => {
  const MODE_KEY = 'dstSorterMode';
  const cases = [
    [{ [MODE_KEY]: 'balance-top' }, 'balance-top'],
    [{ [MODE_KEY]: 'balance-flop' }, 'balance-flop'],
    [{ [MODE_KEY]: 'positive-only' }, 'positive-only'],
    [{ [MODE_KEY]: 'negative-only' }, 'negative-only'],
    [{ [MODE_KEY]: 'chronological-new' }, 'chronological-new'],
    [{ [MODE_KEY]: 'chronological-old' }, 'chronological-old'],
    [{ [MODE_KEY]: 'no-timeline' }, 'chronological-new'],
    [{ [MODE_KEY]: 'chronological' }, 'chronological-old'],
    [{ [MODE_KEY]: 'net' }, 'balance-top'],
    [{ [MODE_KEY]: 'positive' }, 'positive-only'],
    [{ sortByPositive: true }, 'positive-only'],
    [{ sortByPositive: false }, 'balance-top'],
    [{}, 'balance-top'],
    [{ [MODE_KEY]: null }, 'balance-top'],
    [{ [MODE_KEY]: 'garbage' }, 'balance-top'],
    // An explicit current-format mode wins over the legacy boolean.
    [{ [MODE_KEY]: 'negative-only', sortByPositive: true }, 'negative-only']
  ];

  it.each(cases)('%j → %s', async (data, expected) => {
    const { c } = await setup();
    expect(c.migrateStorage(data)).toBe(expected);
  });

  it('every migration target is a valid, displayable mode', async () => {
    const { c } = await setup();
    for (const [data] of cases) {
      expect(c.ALL_MODES).toContain(c.migrateStorage(data));
    }
  });
});

describe('mode groups', () => {
  it('every mode belongs to exactly one badge group', async () => {
    const { c } = await setup();
    for (const mode of c.ALL_MODES) {
      const owners = c.BUTTON_GROUPS.filter((g) => g.modes.includes(mode));
      expect(owners, mode).toHaveLength(1);
      expect(c.getGroupForMode(mode)).toBe(owners[0]);
    }
    expect(c.getGroupForMode('chronological')).toBeNull();
  });

  it('dots indicator fills exactly the active sub-mode', async () => {
    const { c } = await setup();
    const group = c.BUTTON_GROUPS.find((g) => g.id === 'balance');
    const dots = c.buildDotsIndicator(group, 'balance-flop').querySelectorAll('.dst-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0].classList.contains('filled')).toBe(false);
    expect(dots[1].classList.contains('filled')).toBe(true);
    expect(c.buildDotsIndicator(group, 'positive-only').children).toHaveLength(0);
  });
});

describe('loadState', () => {
  it('reads settings from chrome.storage.sync and persists a migrated mode', async () => {
    const { env, c } = await loadContent({ sync: { dstSorterMode: 'net', dstSorterAutoLoad: false } });
    expect(c.sortMode).toBe('balance-top');
    expect(c.sortEnabled).toBe(true);
    expect(c.autoLoadEnabled).toBe(false);
    expect(env.chrome.storage.sync.data.dstSorterMode).toBe('balance-top');
  });

  it('does not rewrite storage when the mode is already current', async () => {
    const { env } = await loadContent({ sync: { dstSorterMode: 'negative-only' } });
    expect(env.chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('respects a disabled extension', async () => {
    const { c } = await loadContent({ sync: { dstSorterEnabled: false } });
    expect(c.sortEnabled).toBe(false);
  });

  it('falls back to localStorage without chrome.storage', async () => {
    const { env, c } = await loadContent({ storage: false });
    env.window.localStorage.setItem('dstSorterMode', 'positive');
    env.window.localStorage.setItem('dstSorterEnabled', 'false');
    c.loadState(() => {});
    expect(c.sortMode).toBe('positive-only');
    expect(c.sortEnabled).toBe(false);
    expect(env.window.localStorage.getItem('dstSorterMode')).toBe('positive-only');
  });
});
