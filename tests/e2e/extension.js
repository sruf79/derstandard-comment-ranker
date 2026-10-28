// Playwright fixture: a persistent Chromium context with the unpacked extension.
const path = require('path');
const fs = require('fs');
const { test: base, chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

const ARTICLE_URL = 'https://www.derstandard.at/story/3000000999999/testartikel';

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      // Extensions need the full Chromium build (not the headless shell).
      channel: 'chromium',
      headless: !process.env.HEADED,
      locale: 'de-AT',
      args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`]
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) {
      // MV3 without background worker: read the id from the extensions page.
      const page = await context.newPage();
      await page.goto('chrome://extensions');
      const id = await page.evaluate(async () => {
        const items = await new Promise((r) => chrome.management.getAll(r));
        const ext = items.find((e) => e.name === 'derStandard Comment Ranker');
        return ext && ext.id;
      });
      await page.close();
      await use(id);
      return;
    }
    await use(new URL(worker.url()).host);
  },
  // Routes derStandard + API hosts to local fixtures and records requests.
  site: async ({ context }, use) => {
    const requests = [];
    const ratingPages = [fixture('ratinglog-initial.html'), fixture('ratinglog-page.html')];
    await context.route('https://www.derstandard.at/**', (route) => {
      requests.push(route.request().url());
      if (route.request().resourceType() === 'document') {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(__dirname, 'fixtures', 'forum-page.html'), 'utf8') });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await context.route('https://capi.ds.at/**', (route) => {
      requests.push(route.request().url());
      const nodes = [9001, 9002, 9003, 9004, 9005, 9006, 9007].map((n, i) => ({ id: 'E' + (i + 1), legacy: { postingId: n } }));
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ data: { nodes } }) });
    });
    await context.route('https://apps.derstandard.at/forum/**', (route) => {
      requests.push(route.request().url());
      const url = route.request().url();
      const body = /\/ratinglog\?/.test(url) ? ratingPages[0] : (/=555$/.test(url) ? ratingPages[1] : '<div></div>');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body });
    });
    await use({ requests, ARTICLE_URL });
  }
});

// Rendered top-to-bottom order of the visible root postings (real layout, so
// this verifies that CSS `order` actually takes effect in the browser).
async function visualOrder(page) {
  return page.evaluate(() => {
    const forum = document.querySelector('dst-forum');
    const main = forum && forum.shadowRoot && forum.shadowRoot.querySelector('main.forum--main');
    if (!main) return [];
    return Array.from(main.querySelectorAll(':scope > dst-posting[data-level="0"]'))
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => ({ id: el.querySelector('dst-posting--ratinglog').getAttribute('postingid'), top: el.getBoundingClientRect().top }))
      .sort((a, b) => a.top - b.top)
      .map((x) => x.id);
  });
}

function shadow(page, selector) {
  return page.locator('dst-forum').locator(selector);
}

module.exports = { test, expect: require('@playwright/test').expect, visualOrder, shadow, ARTICLE_URL };
