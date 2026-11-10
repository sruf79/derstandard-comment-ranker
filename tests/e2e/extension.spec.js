// Loads the real, unpacked extension into Chromium and drives it on a fixture
// forum served under a derStandard article URL. Real (trusted) clicks and real
// layout: this covers what jsdom cannot, e.g. CSS order and reply folding.
const { test, expect, visualOrder, shadow, segment, coffee, waitLoaded } = require('./extension');

// Ratings in fixtures/forum-page.html (net = pos - neg):
// E1 3/1, E2 40/5 (2 replies), E3 0/12, E4 12/0 | batch 1: E5 100/1, E6 1/30 | batch 2: E7 7/7
const ALL_BALANCE_TOP = ['E5', 'E2', 'E4', 'E1', 'E7', 'E3', 'E6'];
const ALL_NEWEST = ['E6', 'E3', 'E1', 'E2', 'E4', 'E5', 'E7'];

// Visible = rendered with a size (display:none and hidden ancestors excluded).
async function visibleReplies(page, parentId) {
  return page.evaluate((pid) => {
    const main = document.querySelector('dst-forum').shadowRoot.querySelector('main.forum--main');
    return Array.from(main.querySelectorAll(`dst-posting--ratinglog[postingid^="${pid}-r"]`))
      .filter((r) => r.getBoundingClientRect().height > 0).length;
  }, parentId);
}

test.describe('sorting', () => {
  test('sorts the whole forum by Balance after loading all postings', async ({ context, site }) => {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(site.ARTICLE_URL);

    await expect(shadow(page, '#dst-badge-bar')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__loadMoreClicks || 0), { timeout: 20000 }).toBe(2);
    await expect.poll(() => visualOrder(page), { timeout: 20000 }).toEqual(ALL_BALANCE_TOP);
    await waitLoaded(page);
    // Background loading never touches reply threads.
    expect(await page.evaluate(() => window.__replyToggles || 0)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('segment clicks change the order and the mode survives a reload', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await expect.poll(() => visualOrder(page), { timeout: 20000 }).toEqual(ALL_BALANCE_TOP);
    await waitLoaded(page);

    await segment(page, 'timeline').click();
    await expect.poll(() => visualOrder(page)).toEqual(ALL_NEWEST);
    await expect(shadow(page, '#dst-seg .dst-badge-btn.active')).toHaveAttribute('data-mode', 'chronological-new');

    await page.reload();
    await expect(shadow(page, '#dst-seg .dst-badge-btn.active')).toHaveAttribute('data-mode', 'chronological-new', { timeout: 20000 });
    await expect.poll(() => visualOrder(page), { timeout: 20000 }).toEqual(ALL_NEWEST);
  });

  test('Pure: fewest dislikes first; a click on the active segment flips to dislikes', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await waitLoaded(page);
    await segment(page, 'likes').click();
    // likes: by fewest dislikes → E4(0) E1(1) E5(1, more likes first) E2(5) E7(7) E6(30); no likes: E3
    await expect.poll(() => visualOrder(page)).toEqual(['E4', 'E5', 'E1', 'E2', 'E7', 'E6', 'E3']);
    await segment(page, 'likes').click();
    await expect(shadow(page, '#dst-seg .dst-badge-btn.active')).toHaveAttribute('data-mode', 'negative-only');
    // dislikes: by fewest likes → E3(0) E6(1) E1(3) E2(40)… ; no dislikes (E4) last
    await expect.poll(() => visualOrder(page)).toEqual(['E3', 'E6', 'E1', 'E7', 'E2', 'E5', 'E4']);
  });

  test('keyboard: segments are reachable and operable', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await expect(segment(page, 'likes')).toBeVisible({ timeout: 20000 });
    await segment(page, 'likes').focus();
    await page.keyboard.press('Enter');
    await expect(shadow(page, '#dst-seg .dst-badge-btn.active')).toHaveAttribute('data-mode', 'positive-only');
  });
});

test.describe('reply threads (v4.19.x, real clicks)', () => {
  test('replies stay closed until the reader opens them — also when derStandard renders them open', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL + '?expanded=1');
    await waitLoaded(page);
    expect(await visibleReplies(page, 'E2')).toBe(0);
  });

  test('💬 opens and closes exactly one thread, without native mass toggling', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL + '?gen=20');
    await waitLoaded(page);
    // G0, G7, G14 have 2 replies each
    const answers = shadow(page, 'dst-posting:has(dst-posting--ratinglog[postingid="G7"]) > dst-posting-footer .answers');
    await answers.click();
    await expect.poll(() => visibleReplies(page, 'G7')).toBe(2);
    expect(await visibleReplies(page, 'G0')).toBe(0);
    expect(await visibleReplies(page, 'G14')).toBe(0);
    await answers.click();
    await expect.poll(() => visibleReplies(page, 'G7')).toBe(0);
    // only the reader's own clicks reached derStandard's toggle
    expect(await page.evaluate(() => window.__replyToggles)).toBe(2);
  });

  test('a thread derStandard has open opens with one click (no double toggle)', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL + '?gen=20&expanded=1');
    await waitLoaded(page);
    await shadow(page, 'dst-posting:has(dst-posting--ratinglog[postingid="G7"]) > dst-posting-footer .answers').click();
    await expect.poll(() => visibleReplies(page, 'G7')).toBe(2);
    expect(await page.evaluate(() => window.__replyToggles || 0)).toBe(0); // handled by CSS only
  });

  test('an opened thread stays open after re-sorting', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await waitLoaded(page);
    await shadow(page, 'dst-posting:has(dst-posting--ratinglog[postingid="E2"]) > dst-posting-footer .answers').click();
    await expect.poll(() => visibleReplies(page, 'E2')).toBe(2);
    await segment(page, 'timeline').click();
    await expect.poll(() => visualOrder(page)).toEqual(ALL_NEWEST);
    expect(await visibleReplies(page, 'E2')).toBe(2);
  });

  test('"Antworten" shows derStandard\'s reply box right below the posting', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await waitLoaded(page);
    await shadow(page, 'dst-posting:has(dst-posting--ratinglog[postingid="E4"]) > dst-posting-footer .answer-button').click();
    const box = shadow(page, 'dst-posting:has(dst-posting--ratinglog[postingid="E4"]) + .thread > dst-posting-box');
    await expect(box).toBeVisible();
    const [p, b] = await Promise.all([
      shadow(page, 'dst-posting:has(dst-posting--ratinglog[postingid="E4"])').boundingBox(),
      box.boundingBox()
    ]);
    expect(b.y).toBeGreaterThanOrEqual(p.y + p.height - 1);
    expect(b.y - (p.y + p.height)).toBeLessThan(60);
  });

  // derStandard's global :focus-visible ring is 3px wide and 2px outside the
  // button; in the card footer it ran into − and + next to "Antworten".
  test('the focus ring of "Antworten" stays inside the button', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await waitLoaded(page);
    const btn = shadow(page, 'dst-posting:has(dst-posting--ratinglog[postingid="E4"]) > dst-posting-footer .answer-button');
    await page.keyboard.press('Shift'); // last input = keyboard, so .focus() is :focus-visible
    await btn.focus();
    const ring = await btn.evaluate((b) => {
      const cs = getComputedStyle(b);
      return { visible: b.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset };
    });
    expect(ring).toEqual({ visible: true, style: 'solid', width: '2px', offset: '-2px' });
  });

  test('opening a thread does not move the posting the reader clicked', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL + '?gen=40');
    await waitLoaded(page);
    const posting = shadow(page, 'dst-posting:has(dst-posting--ratinglog[postingid="G21"])');
    await posting.scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(200);
    const before = (await posting.boundingBox()).y;
    await posting.locator(':scope > dst-posting-footer .answers').click();
    await page.waitForTimeout(300);
    expect(Math.abs((await posting.boundingBox()).y - before)).toBeLessThanOrEqual(2);
  });

  // Live bug (4.20.1): at the end of the forum, the browser's own scroll
  // anchoring picked an element BELOW the forum (main has overflow-anchor:
  // none) and kept it in place while the thread opened, so the clicked
  // posting jumped out of view and its first reply sat in its place.
  for (const [label, extra] of [['closed natively', ''], ['open natively (gear)', '&expanded=1']]) {
    test(`opening a thread at the end of the forum keeps the clicked posting in place (${label})`, async ({ context, site }) => {
      const page = await context.newPage();
      await page.goto(site.ARTICLE_URL + '?gen=20&allReplies=1' + extra);
      await waitLoaded(page);
      const id = await page.evaluate(() => {
        const main = document.querySelector('dst-forum').shadowRoot.querySelector('main.forum--main');
        const roots = Array.from(main.querySelectorAll(':scope > dst-posting[data-level="0"]'))
          .filter((p) => p.querySelector(':scope > dst-posting-footer .answers'))
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        const last = roots[roots.length - 1];
        // the end of the forum (and what follows it) is on screen
        window.scrollBy(0, main.getBoundingClientRect().bottom - (innerHeight - 60));
        if (last.getBoundingClientRect().top < 0) throw new Error('posting not on screen');
        return last.querySelector('dst-posting--ratinglog').getAttribute('postingid');
      });
      await page.waitForTimeout(300);
      const posting = shadow(page, `dst-posting:has(> dst-posting--ratinglog[postingid="${id}"])`);
      const before = (await posting.boundingBox()).y;
      await posting.locator(':scope > dst-posting-footer .answers').click();
      await expect.poll(() => visibleReplies(page, id)).toBe(2);
      await page.waitForTimeout(500);
      expect(Math.abs((await posting.boundingBox()).y - before)).toBeLessThanOrEqual(2);
    });
  }
});

test.describe('posting cards and voter popup', () => {
  test('"⋯" swaps the footer for the actions', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await waitLoaded(page);
    const card = shadow(page, 'dst-posting:has(dst-posting--ratinglog[postingid="E1"])');
    await card.locator(':scope > .dst-fb.more').click();
    await expect(card).toHaveClass(/dst-more-open/);
    await expect(card.locator('.dst-act')).toHaveText(['Melden', 'Ausblenden', 'Kopieren', 'Teilen']);
    await card.locator(':scope > .dst-fb.more').click();
    await expect(card).not.toHaveClass(/dst-more-open/);
  });

  test('voter popup lists who voted, without triggering the page handler', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await waitLoaded(page);

    await shadow(page, 'dst-posting--ratinglog[postingid="E2"]').click();
    const overlay = shadow(page, '#dst-voter-overlay');
    await expect(overlay).toBeVisible();
    const lists = shadow(page, '#dst-voter-body .dst-voter-list');
    await expect(lists.nth(1).locator('a')).toHaveText(['Anna Beispiel', 'Berta', 'Dora']);
    await expect(lists.nth(0).locator('a')).toHaveText(['Kritiker <b>99</b>', 'Carl']);
    expect(site.requests).toContain('https://apps.derstandard.at/forum/ratinglog?id=9002&idType=1');
    expect(await page.evaluate(() => window.__paywallClicks || 0)).toBe(0);

    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });
});

test.describe('popup', () => {
  test('switching the extension off disables it on the page', async ({ context, site, extensionId }) => {
    test.skip(!extensionId, 'extension id not resolvable in this Chromium build');
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await expect(shadow(page, '#dst-badge-bar')).toBeVisible({ timeout: 20000 });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator('#btnExt')).toHaveText('Erweiterung ist an');
    await popup.locator('#btnExt').click();
    await expect(popup.locator('#btnExt')).toHaveText('Erweiterung ist aus');
    expect(await popup.evaluate(() => new Promise((r) => chrome.storage.sync.get('dstSorterEnabled', r)))).toEqual({ dstSorterEnabled: false });

    await page.reload();
    await page.waitForTimeout(3000);
    await expect(shadow(page, '#dst-badge-bar')).toHaveCount(0);
  });

  test('the design switch changes the page live', async ({ context, site, extensionId }) => {
    test.skip(!extensionId, 'extension id not resolvable in this Chromium build');
    const page = await context.newPage();
    await page.goto(site.ARTICLE_URL);
    await waitLoaded(page);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator('#btnDesign').click();
    await expect(popup.locator('#btnDesign')).toHaveText('Design: Flach');
    await expect(page.locator('dst-forum')).toHaveClass(/dst-flat/);
  });
});

test.describe('other pages', () => {
  test('does nothing on pages without a forum', async ({ context, site }) => {
    await context.route('https://www.derstandard.at/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Home</title><h1>Startseite</h1>' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('https://www.derstandard.at/');
    await page.waitForTimeout(2000);
    expect(await page.evaluate(() => document.querySelectorAll('[id^="dst-"]').length)).toBe(0);
    expect(errors).toEqual([]);
  });
});
