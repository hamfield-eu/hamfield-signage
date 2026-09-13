import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (name: string) => resolve(workspace, 'packages', name, 'src/index.ts');

/**
 * Integration suite: real Postgres, real Redis, the real Fastify pipeline.
 * Separate from `vitest.config.ts` so `pnpm test` stays Docker-free and fast —
 * a suite developers skip is a suite that rots.
 */
export default defineConfig({
  resolve: {
    /**
     * Resolve the workspace packages to their TypeScript sources rather than
     * their built `dist/`. Two reasons, and the first is not cosmetic:
     *
     * 1. `dist/` is CommonJS while Vite serves `apps/api` as ESM, so each half
     *    would load a *different copy* of zod. `err instanceof ZodError` in the
     *    server's error handler would then be false for every schema defined in
     *    `@signage/shared`, and validation failures would surface as 500 instead
     *    of 400 — under test only. Production compiles both sides to CommonJS
     *    against one zod, so the harness would have been inventing a bug.
     * 2. A stale `dist/` would quietly test yesterday's code.
     */
    alias: {
      '@signage/shared': src('shared'),
      '@signage/sync-protocol': src('sync-protocol'),
      '@signage/scheduler': src('scheduler'),
      '@signage/media': src('media'),
      '@signage/database': src('database'),
    },
  },
  test: {
    include: ['src/test/**/*.test.ts'],
    globals: true,
    globalSetup: ['src/test/global-setup.ts'],
    // One database, shared. Files run one at a time so the truncate between
    // tests cannot race a test in another worker.
    fileParallelism: false,
    // Pulling images on a cold machine is slow; the tests themselves are not.
    hookTimeout: 180_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
    },
  },
});
