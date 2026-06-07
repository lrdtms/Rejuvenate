/**
 * Vitest configuration.
 *
 * Phase 2 introduces the first integration-style tests (supertest against
 * `createApp()`); kept deliberately minimal — Node environment (this is a backend
 * API, no DOM needed), and tests live alongside the source files they cover
 * (`*.test.ts`) rather than in a parallel directory tree, per the repo's existing
 * "co-located" convention (e.g. nothing under a top-level `__tests__/`).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
