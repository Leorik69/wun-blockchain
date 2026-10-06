/**
 * Vitest shim for the legacy ts-node suite (`tests/blockchain.test.ts`).
 *
 * The legacy file predates Vitest: each `testX()` returns a bespoke
 * `TestResult` and the ts-node runner (`runAllTests`) simply prints pass/fail
 * and exits non-zero on any failure. Rather than rewrite 38 hand-rolled
 * assertions (risking coverage loss), this shim imports the SINGLE exported
 * registry `legacyTests` and re-runs every function under Vitest, asserting the
 * captured `TestResult.passed` flag. Because both entry points consume the same
 * registry, coverage is identical by construction — no drift is possible.
 *
 * Isolation notes:
 *  - Importing `blockchain.test.ts` sets `REQUIRE_TREASURY_SIGNATURE=false` at
 *    module load (golden-master semantics for the unsigned-TREASURY bypass
 *    tests). `process.env` is shared across files in the single-fork Vitest
 *    process, so we restore the CI default (unset) in `afterAll` to guarantee
 *    this shim is behaviour-neutral for every other suite regardless of the
 *    file execution order.
 *  - Every legacy test that spawns a worker pool terminates it in its own
 *    `finally`, so no dangling handles are leaked into the Vitest worker.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { legacyTests } from './blockchain.test';

/** Structural view of the legacy `TestResult` (the class is not exported). */
interface LegacyTestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

describe('Legacy WUNCoin suite (ts-node parity shim)', () => {
  afterAll(() => {
    // Undo the module-load side effect so sibling suites see the CI default.
    delete process.env.REQUIRE_TREASURY_SIGNATURE;
  });

  it.each(
    legacyTests.map((fn) => [fn.name, fn] as const)
  )('legacy: %s', async (_name, fn) => {
    const result = (await fn()) as LegacyTestResult;
    // Surface the captured assertion message on failure for actionable output.
    expect(result.error, result.error ?? '').toBeUndefined();
    expect(result.passed, result.error ?? 'legacy test reported failure').toBe(true);
  });
});
