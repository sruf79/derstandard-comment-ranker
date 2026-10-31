// Static checks on the package itself: catches broken references and the kinds
// of code patterns store reviews (AMO / Chrome Web Store) reject.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readSource } from '../helpers/env.js';

const manifest = JSON.parse(readSource('manifest.json'));
const SCRIPTS = ['content.js', 'rating.js', 'popup.js', 'forum-hook.js'];

describe('manifest.json', () => {
  it('is MV3 with a semver version', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('references only files that exist', () => {
    const files = [
      ...manifest.content_scripts.flatMap((cs) => cs.js),
      manifest.action.default_popup,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon)
    ];
    for (const f of files) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
  });

  it('runs forum-hook.js in the MAIN world at document_start (before the forum fetches)', () => {
    const hook = manifest.content_scripts.find((cs) => cs.js.includes('forum-hook.js'));
    expect(hook.world).toBe('MAIN');
    expect(hook.run_at).toBe('document_start');
  });

  it('loads content.js before rating.js in the isolated world', () => {
    const cs = manifest.content_scripts.find((c) => c.js.includes('content.js'));
    expect(cs.world).toBeUndefined();
    expect(cs.js.indexOf('content.js')).toBeLessThan(cs.js.indexOf('rating.js'));
  });

  it('only targets derStandard and asks for minimal permissions', () => {
    for (const cs of manifest.content_scripts) {
      for (const m of cs.matches) expect(m).toMatch(/^\*:\/\/\*\.derstandard\.(at|de)\/\*$/);
    }
    expect(manifest.permissions).toEqual(['storage']);
  });

  it('declares Firefox data collection as none', () => {
    expect(manifest.browser_specific_settings.gecko.data_collection_permissions.required).toEqual(['none']);
  });

  it('versions in file headers match the manifest', () => {
    expect(readSource('popup.js').split('\n')[0]).toContain('v' + manifest.version);
  });
});

describe('store-review hygiene', () => {
  it.each(SCRIPTS)('%s uses no HTML-string sinks or dynamic code', (file) => {
    const src = readSource(file);
    expect(src).not.toMatch(/\.(inner|outer)HTML\s*=/);
    expect(src).not.toMatch(/insertAdjacentHTML|document\.write\(/);
    expect(src).not.toMatch(/\beval\(|new Function\(/);
    expect(src).not.toMatch(/setTimeout\(\s*['"`]/);
  });

  it.each(SCRIPTS)('%s keeps debug logging off', (file) => {
    const src = readSource(file);
    const m = src.match(/const DEBUG = (\w+);/);
    if (m) expect(m[1]).toBe('false');
  });

  it.each(SCRIPTS)('%s parses as a classic script', (file) => {
    // eslint-disable-next-line no-new-func
    expect(() => new Function(readSource(file))).not.toThrow();
  });

  it('fetches only derStandard hosts', () => {
    for (const file of SCRIPTS) {
      const urls = readSource(file).match(/https?:\/\/[^\s'"`)]+/g) || [];
      for (const u of urls) {
        expect(u, file).toMatch(/^https:\/\/((apps|www)\.derstandard\.at|capi\.ds\.at|chromewebstore\.google\.com|addons\.mozilla\.org|buymeacoffee\.com)\//);
      }
    }
  });
});
