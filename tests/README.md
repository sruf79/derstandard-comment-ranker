# Tests

```bash
npm install
npm test            # unit + integration (Vitest + jsdom), ~5 s
npm run test:e2e    # real extension in Chromium against a local fixture forum
npm run lint:firefox  # Mozilla's AMO linter (web-ext lint) on the extension files
npm run test:live   # opt-in smoke test against derstandard.at (see below)
```

## Layout

| Folder | What | How |
| --- | --- | --- |
| `unit/` | Pure logic of every script: sort comparator, storage migration, time and ratinglog parsing, pinned/duplicate detection, rating prompt state machine, popup pulses, `forum-hook.js` wrappers, manifest/store hygiene | jsdom per test, fake timers, in-memory `chrome.*` mock |
| `integration/` | `content.js` booted end to end against a simulated `<dst-forum>`: CSS order, badge bar, persistence, observers, background loading, voter popup, interplay with `rating.js` | same |
| `e2e/extension.spec.js` | The unpacked extension in Chromium; derStandard URLs are routed to `e2e/fixtures/forum-page.html` | Playwright |
| `e2e/scroll.spec.js` | The reader's position (in the article, inside the forum, below the forum) stays put while postings load and re-sort — desktop and mobile viewport, sampled every frame | Playwright |
| `e2e/perf.spec.js` | Re-sorting 2000 postings never blocks the page for more than 400 ms (Long Tasks API) | Playwright |
| `e2e/live.spec.js` | Early warning when derstandard.at changes its forum DOM | Playwright, opt-in |

The extension files are not modified for testing. `helpers/env.js` evaluates
them unchanged in a jsdom window and, for the IIFE scripts, appends one line
before the closing `})();` that exposes selected internal functions (list in
`EXPOSE`). Renaming such a function makes the loader's test fail loudly.

`helpers/forum.js` builds the forum DOM the extension relies on. The ratinglog
fixtures in `fixtures/` are reconstructed from the parser's selectors, not
captured from the live site — refresh them if the live test starts failing.

The fixture forum takes URL parameters for generated content (`?gen=N`,
`&batches=B&size=S`, `&delay=MS`, `&article=PX`, `&moreAfter=MS`, `&keepMore=1`);
see the comment at the top of `e2e/fixtures/forum-page.html`.

## Known gaps (`it.fails` / `test.fail()`)

Use `it.fails` (Vitest) or `test.fail()` (Playwright) with a `KNOWN BUG` /
`KNOWN GAP` name to document misbehaviour that is not fixed yet: it passes
while the problem exists and turns red once it is fixed — then turn it into a
normal test.

Currently open: `e2e/scroll.spec.js` › *footer also stays when the load-more
button disappears* — a reader below the forum moves up by the button height
(~21 px) when the native button vanishes after the last batch, because the
extension anchors the bottom of `main.forum--main` and the fixture button sits
outside it. Whether the live site places the button there is unverified.

## Live test

derstandard.at shows a consent wall to new visitors; the test never answers
it. Create a profile once and decide yourself:

```bash
HEADED=1 DST_LIVE=1 DST_PROFILE=$HOME/.dst-test-profile npm run test:live
# afterwards headless:
DST_LIVE=1 DST_PROFILE=$HOME/.dst-test-profile npm run test:live
```

`DST_ARTICLE=<story URL>` pins a specific article.

## Packaging

`tests/`, `node_modules/`, `package*.json`, `vitest.config.mjs` and `.github/`
are development files — exclude them when zipping the extension for the stores.
