import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the WUNCoin HTTP contract tests.
 *
 * The legacy suite (`tests/blockchain.test.ts`) uses a bespoke ts-node runner
 * and is intentionally excluded here so `npx vitest run` only executes the
 * new golden-master contract tests under `tests/`.
 *
 * `pool: 'forks'` + `singleFork` keeps every test file in one process. This
 * matters because `src/server.ts` opens a listening socket at import time; the
 * harness closes it during teardown, and running a single fork avoids port
 * collisions between parallel workers.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      'tests/blockchain.test.ts',
      // Phase 8.2: the performance harness (benchmarks, HTTP load smoke and the
      // long-running memory soak) must NEVER run under `vitest run` / `npm test`
      // and therefore never in CI. `.bench.ts` files run only via `vitest bench`
      // (see the `benchmark` block below); `.load.ts`/`.soak.ts` are standalone
      // ts-node scripts invoked on demand (`npm run perf:http` / `perf:soak`).
      'tests/perf/**',
      'node_modules/**',
      'dist/**',
    ],
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    benchmark: {
      // `vitest bench` (npm run bench) only collects the PoW/hash-v2 +
      // difficulty benchmarks; nothing else is treated as a benchmark.
      include: ['tests/perf/**/*.bench.ts'],
    },
  },
});
