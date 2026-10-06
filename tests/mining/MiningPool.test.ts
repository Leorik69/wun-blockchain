/**
 * C7 regression tests — MiningPool worker-crash / job-timeout / terminate
 * resilience.
 *
 * BEFORE the fix, a worker that errored, exited or hung mid-job left the
 * dispatched task's promise pending FOREVER: its resolve/reject lived only
 * inside the dead worker's `on('message')` closure, and there was no job
 * timeout. That wedged `submit()` → `minePendingTransactions()` →
 * `MineJobManager.inFlightPromise`, so every subsequent `/api/mining/mine` and
 * `/api/mining/jobs` coalesced onto the dead promise and hung, holding sockets.
 * `terminate()` also rejected only QUEUED (not dispatched) tasks.
 *
 * These tests assert the pool now:
 *   1. REJECTS the in-flight task when a worker is killed mid-job, then
 *      respawns a replacement (self-healing);
 *   2. REJECTS a job that exceeds `POW_JOB_TIMEOUT_MS` and recovers the worker;
 *   3. REJECTS BOTH dispatched and queued tasks on `terminate()`.
 *
 * A real worker thread is spawned (as in production). The PoW job uses an
 * effectively unreachable difficulty so it is still running when we act on it —
 * removing any race between "job finished" and "we crashed/timed it out".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MiningPool } from '../../src/mining/MiningPool';
import type { PowJob } from '../../src/mining/pow';

/**
 * A PoW job that cannot complete quickly: `difficulty` is the count of leading
 * hex zeros required, so 20 (~80 bits) is effectively unreachable and the
 * search runs until `maxNonce` — seconds of work. The job is therefore guaranteed
 * to still be in flight at the 20–100ms marks the tests act on.
 */
function heavyJob(): PowJob {
  return {
    index: 1,
    timestamp: Date.now(),
    txRoot: '00'.repeat(32),
    previousHash: '00'.repeat(32),
    difficulty: 20,
    maxNonce: 5_000_000,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('MiningPool C7 resilience', () => {
  let pool: MiningPool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.terminate();
      pool = undefined;
    }
  });

  it('rejects the in-flight task and respawns when a worker is killed mid-job', async () => {
    pool = new MiningPool(1);
    const initialSize = pool.size;
    expect(initialSize).toBe(1);

    // submit() dispatches the task synchronously inside its Promise executor,
    // so the single worker is busy immediately after this line.
    const submitted = pool.submit(heavyJob());
    // Attach the rejection handler BEFORE crashing the worker. The 'exit'
    // handler rejects `submitted` asynchronously; without a pre-attached
    // handler Node would emit a transient unhandled-rejection warning.
    const rejected = expect(submitted).rejects.toThrow();
    await sleep(50);

    // Simulate a worker crash by force-terminating the underlying thread. The
    // pool's 'exit' handler must reject the outstanding task (C7) and respawn.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const worker = (pool as any).workers[0].worker;
    await worker.terminate();

    // Core C7 assertion: the promise REJECTS instead of hanging forever.
    await rejected;

    // Self-healing: the dead worker is replaced so capacity is restored.
    await sleep(50);
    expect(pool.size).toBe(initialSize);
  });

  it('rejects a job that exceeds POW_JOB_TIMEOUT_MS and recovers the worker', async () => {
    // Resolved once at construction, so the env must be set before `new`.
    process.env.POW_JOB_TIMEOUT_MS = '100';
    try {
      pool = new MiningPool(1);
      const submitted = pool.submit(heavyJob());

      // The 100ms watchdog fires long before the (seconds-long) job finishes,
      // rejecting the task and terminating + respawning the stuck worker. The
      // handler is attached synchronously here, well before the 100ms rejection.
      const rejected = expect(submitted).rejects.toThrow(/timed out/);
      await rejected;

      await sleep(80);
      expect(pool.size).toBe(1);
    } finally {
      delete process.env.POW_JOB_TIMEOUT_MS;
    }
  });

  it('terminate() rejects BOTH dispatched and queued tasks', async () => {
    pool = new MiningPool(1);

    const dispatched = pool.submit(heavyJob()); // → the single worker (busy)
    const queued = pool.submit(heavyJob()); // → no free worker, stays queued
    await sleep(20);
    expect(pool.queueDepth).toBe(1);

    // terminate() rejects BOTH tasks SYNCHRONOUSLY (before its internal await),
    // so attach the handlers FIRST — otherwise the rejections are transiently
    // unhandled and Vitest flags them as unhandled errors.
    const dispatchedRejected = expect(dispatched).rejects.toThrow(/terminated/);
    const queuedRejected = expect(queued).rejects.toThrow(/terminated/);

    await pool.terminate();
    pool = undefined; // already terminated; skip the afterEach re-terminate

    // BEFORE the fix only `queued` was rejected; `dispatched` hung forever.
    await dispatchedRejected;
    await queuedRejected;
  });
});
