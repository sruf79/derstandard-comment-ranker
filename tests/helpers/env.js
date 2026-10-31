// Test environment for the extension scripts.
//
// Every test gets its own jsdom window, an in-memory `chrome.*` mock and fake
// timers installed on that window. The extension files are evaluated unchanged;
// for the IIFE-wrapped scripts the loader appends one line right before the
// closing `})();` that copies selected closure-internal functions onto
// `window.__DST_INTERNALS__[file]`, so they can be unit-tested without
// refactoring the shipped code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import FakeTimers from '@sinonjs/fake-timers';
import { vi } from 'vitest';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

export function readFixture(name) {
  return fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', name), 'utf8');
}

// Closure-internal names exposed per file. Plain names are functions/consts;
// entries in STATE get a getter + setter so tests can drive module state.
const EXPOSE = {
  'content.js': [
    'MODE_DEFS', 'BUTTON_GROUPS', 'ALL_MODES', 'voterIdMap',
    'getGroupForMode', 'buildDotsIndicator',
    'parseRelativeTime', 'getPostingTimestamp',
    'readRatings', 'getPositiveRatings', 'getNegativeRatings', 'getNetRatings',
    'transferRatingsIfNewer', 'computeSortKey', 'sortComparator', 'buildSortSignature',
    'migrateStorage', 'loadState',
    'isPinnedPosting', 'getPostingId', 'getStablePostingId', 'isInputFormElement',
    'isRootPosting', 'isReplyThreadSection', 'collectPostingGroups',
    'userPrefersExpandedThreads', 'collapseReplyThreads', 'expandPinnedThreads',
    'hasRatingData', 'parseRatingLog', 'resolveNumericPostingId', 'fetchRatingLogPage',
    'openVoterPopup', 'closeVoterPopup',
    'getTotalPostingCount', 'findLoadMoreButton', 'readForumLoadState',
    'showProgressBar', 'hideProgressBar', 'sortPostings', 'injectSortBadge',
    'loadAllPostings', 'isArticlePage'
  ],
  'rating.js': [
    'KEYS', 'detectIsFirefox', 'getReviewURL', 'storageGet', 'storageSet',
    'runV1915Reset', 'runV1916Reset', 'createFeedbackBar', 'main'
  ],
  'forum-hook.js': ['collectPairs', 'relay', 'isForumGraphql']
};

const STATE = {
  'content.js': ['sortMode', 'sortEnabled', 'autoLoadEnabled', 'lastSortSignature']
};

function instrument(file, src) {
  const names = EXPOSE[file];
  if (!names) return src;
  const closing = /\}\)\(\);\s*$/;
  if (!closing.test(src)) throw new Error(file + ': expected the file to end with an IIFE "})();"');
  const props = names.slice();
  for (const s of STATE[file] || []) {
    props.push(`get ${s}() { return ${s}; }`, `set ${s}(v) { ${s} = v; }`);
  }
  const hook =
    `\n;(window.__DST_INTERNALS__ = window.__DST_INTERNALS__ || {})[${JSON.stringify(file)}] = {\n  ` +
    props.join(',\n  ') + '\n};\n';
  return src.replace(closing, hook + '})();\n');
}

// ── chrome.* mock ────────────────────────────────────────────────────────
function createStorageArea(chrome, initial) {
  const data = { ...initial };
  const area = {
    data,
    // Set to an Error to make the next get() fail like chrome does
    // (callback with undefined + chrome.runtime.lastError set).
    failNextGet: null,
    get: vi.fn((keys, cb) => {
      const fail = area.failNextGet;
      area.failNextGet = null;
      let wanted;
      if (keys == null) wanted = Object.keys(data);
      else if (typeof keys === 'string') wanted = [keys];
      else if (Array.isArray(keys)) wanted = keys;
      else wanted = Object.keys(keys);
      const out = {};
      for (const k of wanted) if (k in data) out[k] = data[k];
      Promise.resolve().then(() => {
        if (fail) {
          chrome.runtime.lastError = { message: String(fail.message || fail) };
          try { cb(undefined); } finally { chrome.runtime.lastError = undefined; }
        } else {
          cb(out);
        }
      });
    }),
    set: vi.fn((obj, cb) => {
      Object.assign(data, obj);
      if (cb) Promise.resolve().then(cb);
    }),
    remove: vi.fn((keys, cb) => {
      for (const k of [].concat(keys)) delete data[k];
      if (cb) Promise.resolve().then(cb);
    })
  };
  return area;
}

export function createChrome({ sync = {}, local = {}, storage = true } = {}) {
  const listeners = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.push(fn) }
    },
    tabs: {
      query: vi.fn((q, cb) => cb([{ id: 7 }])),
      sendMessage: vi.fn(() => Promise.resolve()),
      create: vi.fn()
    }
  };
  if (storage) {
    chrome.storage = {
      sync: createStorageArea(chrome, sync),
      local: createStorageArea(chrome, local)
    };
  }
  // Deliver a runtime message to every content-script listener.
  chrome.sendRuntimeMessage = (msg) => listeners.forEach((fn) => fn(msg));
  return chrome;
}

// ── Environment ──────────────────────────────────────────────────────────
export const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

export async function createEnv({
  url = 'https://www.derstandard.at/story/3000000123456/testartikel',
  html = '<!doctype html><html><head></head><body></body></html>',
  sync,
  local,
  storage = true,
  now = DEFAULT_NOW,
  userAgent,
  browserGlobal = false
} = {}) {
  const logs = [];
  const virtualConsole = new VirtualConsole();
  for (const level of ['log', 'info', 'warn', 'error']) {
    virtualConsole.on(level, (...args) => logs.push({ level, args }));
  }
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push(e));

  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });
  const window = dom.window;
  // Let jsdom finish parsing first, so readyState is "complete" like on a real
  // page where the content scripts run at document_idle.
  if (window.document.readyState !== 'complete') {
    await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  }

  if (userAgent) {
    Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
  }
  if (browserGlobal) window.browser = { runtime: {} };

  const chrome = createChrome({ sync, local, storage });
  window.chrome = chrome;
  window.open = vi.fn();
  // jsdom implements neither; the extension must never navigate in tests.
  window.scrollBy = vi.fn();

  const clock = FakeTimers.withGlobal(window).install({
    now,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date',
      'requestAnimationFrame', 'cancelAnimationFrame']
  });

  const env = {
    dom,
    window,
    document: window.document,
    chrome,
    clock,
    logs,
    errors,
    // Evaluate one of the extension's files in this window.
    load(file) {
      window.eval(instrument(file, readSource(file)) + '\n//# sourceURL=' + file);
      return (window.__DST_INTERNALS__ || {})[file];
    },
    // Advance fake time and flush the microtasks in between.
    async tick(ms = 0) {
      await clock.tickAsync(ms);
    },
    // Flush pending promise callbacks / MutationObserver records only.
    async flush() {
      for (let i = 0; i < 5; i++) await clock.tickAsync(0);
    },
    warnings() {
      return logs.filter((l) => l.level === 'warn' || l.level === 'error');
    },
    close() {
      clock.uninstall();
      window.close();
    }
  };
  return env;
}
