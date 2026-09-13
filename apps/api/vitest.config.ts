import { defineConfig } from 'vitest/config';

/**
 * Unit suite — pure functions only, no Docker, no network. This is what
 * `pnpm test` runs, and it must stay fast enough to run on every save.
 * The integration suite lives in `vitest.integration.config.ts`.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/test/**'],
    globals: true,
  },
});
