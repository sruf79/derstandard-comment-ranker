import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test builds its own jsdom window (tests/helpers/env.js).
    environment: 'node',
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    restoreMocks: true
  }
});
