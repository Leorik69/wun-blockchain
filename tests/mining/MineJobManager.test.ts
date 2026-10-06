/**
 * C7 regression tests — MineJobManager single-flight recovery + watchdog.
 *
 * `MineJobManager` coalesces every concurrent `/api/mining/mine` and
 * `/api/mining/jobs` caller onto ONE in-flight promise (`inFlightPromise`,
 * keyed by `inFlightJobId`). BEFORE the fix, if that promise never settled
 * (because the underlying MiningPool task was wedged by a crashed worker — see
 * MiningPool.test.ts), the single-flight lock stayed pinned FOREVER and every
 * later request coalesced onto the dead promise and hung.
 *
 * Two guarantees are asserted here:
 *   1. RECOVERY — when the mining `runFn` rejects, the `.finally()` clears
 *      `inFlightJobId`/`inFlightPromise`, so the manager is immediately
 *      reusable and the next mine runs fresh (never coalesced onto the corpse).
 *   2. WATCHDOG — even a `runFn` that NEVER settles is force-rejected after
 *      `MINE_JOB_TIMEOUT_MS`, and the lock is cleared, so a wedged promise can
 *      never permanently disable mining.
 *
 * A stub pool is injected because `acquire()` drives mining through `runFn`
 * (which internally uses the pool); the manager never calls `pool.submit` on
 * this path, so the stub keeps the test hermetic and worker-free.
 */
import { describe, it, expect } from 'vitest';
import { MineJobManager } from '../../src/mining/MineJobManager';
import type { MiningPool } from '../../src/mining/MiningPool';

/** Minimal stand-in for {@link MiningPool}; `acquire()` never touches it. */
function stubPool(): MiningPool {
  return {
    submit: async () => {
      throw new Error('stub pool: submit must not be called by acquire()');
    },
    submitVerify: async () => {
      throw new Error('stub pool: submitVerify must not be called by acquire()');
    },
    terminate: async () => {},
  } as unknown as MiningPool;
}

describe('MineJobManager C7 recovery + watchdog', () => {
  it('clears the single-flight lock after a rejected mine (no permanent wedge)', async () => {
    const mgr = new MineJobManager(stubPool());

    const failing = async (): Promise<null> => {
      throw new Error('mine failed');
    };
    await expect(mgr.mineSync('miner', failing)).rejects.toThrow('mine failed');

    // The lock must be released even though the job rejected.
    expect(mgr.isMining).toBe(false);

    // A subsequent mine must run FRESH — not coalesce onto the rejected promise.
    let secondRan = false;
    const ok = async (): Promise<null> => {
      secondRan = true;
      return null;
    };
    const second = await mgr.mineSync('miner', ok);

    expect(secondRan).toBe(true);
    expect(second.coalesced).toBe(false);
    expect(second.block).toBeNull();
    expect(mgr.isMining).toBe(false);
  });

  it('watchdog force-rejects a runFn that NEVER settles and frees the lock', async () => {
    // Resolved once at construction; set before `new`. 80ms keeps the test fast.
    process.env.MINE_JOB_TIMEOUT_MS = '80';
    try {
      const mgr = new MineJobManager(stubPool());

      // A promise with no timer/IO that never settles — the exact "wedged"
      // scenario the pool crash produced before C7. It holds the event loop
      // open for nothing, so the watchdog is the only way out.
      const neverSettles = (): Promise<never> => new Promise<never>(() => {});

      await expect(mgr.mineSync('miner', neverSettles)).rejects.toThrow(/watchdog/);

      // The watchdog rejection ran the `.finally()`, clearing the lock so the
      // manager is reusable rather than permanently wedged.
      expect(mgr.isMining).toBe(false);
    } finally {
      delete process.env.MINE_JOB_TIMEOUT_MS;
    }
  });
});
