// E2E tests load the unpacked extension into Chromium. derStandard URLs are
// answered from local fixtures via request routing, so no network is needed
// (except for live.spec.js, which is opt-in via DST_LIVE=1).
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.js$/,
  timeout: 60000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list'
});
