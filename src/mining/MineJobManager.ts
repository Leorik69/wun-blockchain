import { PowJob, PowResult } from './pow';
import { MiningPool } from './MiningPool';
import type { Block } from '../blockchain';
import type { DistributedMiningLock } from '../state/DistributedMiningLock';

export type MiningJobStatus = 'pending' | 'mining' | 'completed' | 'failed';

export interface MiningJob {
  id: string;
  status: MiningJobStatus;
  /** Miner address for blockchain-level jobs (async HTTP path). */
  minerAddress?: string;
  /** PoW result for pool-level jobs. */
  result?: PowResult | null;
  /** Mined block for blockchain-level jobs. */
  block?: Block | null;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

/**
 * Default watchdog timeout (ms) for a blockchain mining job. Deliberately
 * LARGER than the pool's per-job timeout (`POW_JOB_TIMEOUT_MS`, 30s default) so
 * the pool's graceful rejection normally wins; this is a last-resort guard
 * against a `runFn` that NEVER settles and would otherwise wedge the
 * single-flight lock permanently (C7). Override with `MINE_JOB_TIMEOUT_MS`.
 */
const DEFAULT_MINE_JOB_TIMEOUT_MS = 120_000;

/** Resolve the mining watchdog timeout from `MINE_JOB_TIMEOUT_MS` (or default). */
function resolveWatchdogTimeoutMs(): number {
  const fromEnv = parseInt(process.env.MINE_JOB_TIMEOUT_MS || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MINE_JOB_TIMEOUT_MS;
}

/**
 * Manages mining jobs with a single-flight lock.
 *
 * Two entry points are supported:
 *  - `mine(job)`: submit a raw PoW job to the worker pool and await the result.
 *  - `startMining(minerAddress, runFn)`: run a full blockchain mining operation
 *    in the background and track it by id (the async HTTP path). Only one
 *    blockchain mining operation runs at a time; concurrent submissions
 *    coalesce onto the in-flight job.
 *  - `mineSync(minerAddress, runFn)`: run the SAME guarded blockchain mining
 *    operation but await and return the block (the synchronous HTTP path). It
 *    shares the in-process single-flight lock and the distributed lock with
 *    `startMining`, so the sync and async paths never mine the same height
 *    concurrently — on one replica or across replicas.
 */
export class MineJobManager {
  private pool: MiningPool;
  private jobs: Map<string, MiningJob> = new Map();
  private jobIdCounter = 0;
  /** Id of the currently in-flight blockchain mining job (single-flight lock). */
  private inFlightJobId: string | null = null;
  /**
   * Shared in-flight mining promise. BOTH entry points ({@link startMining} for
   * the async HTTP path and {@link mineSync} for the synchronous path) coalesce
   * onto this single promise, so concurrent callers never double-mine and the
   * distributed lock is acquired at most once per height. `null` when idle.
   */
  private inFlightPromise: Promise<Block | null> | null = null;
  /**
   * Optional cross-replica single-miner lock (Phase 7.2). Present ONLY when
   * `REDIS_URL` is set; in memory mode it is undefined and the in-process
   * single-flight lock above is the sole guard (unchanged behaviour).
   */
  private distributedLock?: DistributedMiningLock;
  /** Watchdog timeout (ms) guarding against a never-settling mining job (C7). */
  private readonly watchdogTimeoutMs: number;

  constructor(pool: MiningPool, distributedLock?: DistributedMiningLock) {
    this.pool = pool;
    this.distributedLock = distributedLock;
    this.watchdogTimeoutMs = resolveWatchdogTimeoutMs();
  }

  private nextId(prefix: string): string {
    return `${prefix}-${++this.jobIdCounter}-${Date.now()}`;
  }

  /**
   * Submit a raw PoW job to the worker pool and await its result.
   */
  async mine(job: PowJob): Promise<{ jobId: string; result: PowResult | null }> {
    const jobId = this.nextId('mine');

    const miningJob: MiningJob = {
      id: jobId,
      status: 'mining',
      startedAt: Date.now(),
    };
    this.jobs.set(jobId, miningJob);
    this.cleanup();

    try {
      const result = await this.pool.submit(job);
      miningJob.status = 'completed';
      miningJob.result = result;
      miningJob.completedAt = Date.now();
      return { jobId, result };
    } catch (err) {
      miningJob.status = 'failed';
      miningJob.error = err instanceof Error ? err.message : 'Unknown error';
      miningJob.completedAt = Date.now();
      throw err;
    }
  }

  /**
   * Shared single-flight + distributed-lock guard for a blockchain mining
   * operation. Returns the in-flight job id, whether this call coalesced onto
   * an already-running job, and the shared promise that settles with the mined
   * block (or `null`).
   *
   * Cross-replica guard (Phase 7.2): when a distributed lock is configured, the
   * operation runs under it so only ONE replica mines at a time. `runExclusive`
   * FAILS CLOSED — if the lock is held elsewhere or Redis is unreachable it
   * throws MiningLockRefusedError, which rejects the returned promise (and marks
   * the job failed) so the caller REFUSES to mine. In memory mode
   * `distributedLock` is undefined and `runFn` runs directly under the
   * in-process single-flight lock only (unchanged behaviour).
   */
  private acquire(
    minerAddress: string,
    runFn: () => Promise<Block | null>,
  ): { jobId: string; coalesced: boolean; promise: Promise<Block | null> } {
    // Single-flight lock: coalesce onto the in-flight job when present.
    if (this.inFlightJobId && this.inFlightPromise) {
      return { jobId: this.inFlightJobId, coalesced: true, promise: this.inFlightPromise };
    }

    const jobId = this.nextId('job');
    const miningJob: MiningJob = {
      id: jobId,
      status: 'mining',
      minerAddress,
      startedAt: Date.now(),
    };
    this.jobs.set(jobId, miningJob);
    this.inFlightJobId = jobId;
    this.cleanup();

    const lock = this.distributedLock;
    const run = lock ? () => lock.runExclusive(runFn) : runFn;

    // C7 watchdog: guard against a `runFn` (or the pool beneath it) that NEVER
    // settles. Without this a wedged promise would pin `inFlightJobId` forever
    // and every subsequent `/api/mining/mine` and `/api/mining/jobs` call would
    // coalesce onto the dead promise and hang, holding sockets. `Promise.race`
    // subscribes to BOTH promises, so a late `run()` settlement after the
    // watchdog wins is handled (never surfaces as an unhandled rejection). The
    // timer is `.unref()`'d and always cleared in `finally` (no dangling
    // handles).
    let watchdog: NodeJS.Timeout | undefined;
    const watchdogPromise = new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => {
        reject(
          new Error(
            `Mining job ${jobId} exceeded watchdog timeout (${this.watchdogTimeoutMs}ms)`,
          ),
        );
      }, this.watchdogTimeoutMs);
      watchdog.unref();
    });

    const promise = Promise.race([run(), watchdogPromise])
      .then((block) => {
        miningJob.status = 'completed';
        miningJob.block = block;
        miningJob.completedAt = Date.now();
        return block;
      })
      .catch((err: unknown) => {
        miningJob.status = 'failed';
        miningJob.error = err instanceof Error ? err.message : 'Unknown error';
        miningJob.completedAt = Date.now();
        throw err;
      })
      .finally(() => {
        if (watchdog) clearTimeout(watchdog);
        // ALWAYS clear the single-flight lock when this job settles — even on
        // rejection — so a failed/timed-out mine can never wedge future mines.
        if (this.inFlightJobId === jobId) {
          this.inFlightJobId = null;
          this.inFlightPromise = null;
        }
      });

    this.inFlightPromise = promise;
    return { jobId, coalesced: false, promise };
  }

  /**
   * Start a blockchain-level mining operation in the background (ASYNC HTTP path).
   *
   * Returns immediately with the job id; the result is polled via
   * {@link getJob}. If another blockchain mining job is already in flight, this
   * coalesces onto it (the pending set is shared, so a second concurrent mine
   * would produce the same block) and returns that id.
   */
  startMining(minerAddress: string, runFn: () => Promise<Block | null>): { jobId: string; coalesced: boolean } {
    const { jobId, coalesced, promise } = this.acquire(minerAddress, runFn);
    // Fire-and-forget: rejections are already recorded on the job; swallow them
    // here so the background promise never surfaces as an unhandled rejection.
    promise.catch(() => {});
    return { jobId, coalesced };
  }

  /**
   * Run a blockchain mining operation to completion under the SAME single-flight
   * + distributed-lock guard as {@link startMining}, but AWAIT and return the
   * mined block (the SYNCHRONOUS HTTP `POST /api/mining/mine` path).
   *
   * Concurrent callers coalesce onto the in-flight job (never double-mine, even
   * on a single replica). FAILS CLOSED: when the distributed lock is configured
   * but held/unreachable, the returned promise rejects with
   * {@link MiningLockRefusedError} and the operation never mines.
   */
  async mineSync(
    minerAddress: string,
    runFn: () => Promise<Block | null>,
  ): Promise<{ block: Block | null; jobId: string; coalesced: boolean }> {
    const { jobId, coalesced, promise } = this.acquire(minerAddress, runFn);
    const block = await promise;
    return { block, jobId, coalesced };
  }

  getJob(jobId: string): MiningJob | undefined {
    return this.jobs.get(jobId);
  }

  /** True when a blockchain mining job is currently running. */
  get isMining(): boolean {
    return this.inFlightJobId !== null;
  }

  /** Cleanup old jobs (keep the most recent 100 by start time). */
  cleanup(): void {
    if (this.jobs.size > 100) {
      const stale = [...this.jobs.entries()]
        .sort((a, b) => b[1].startedAt - a[1].startedAt)
        .slice(100);
      for (const [key] of stale) {
        this.jobs.delete(key);
      }
    }
  }

  async terminate(): Promise<void> {
    await this.pool.terminate();
  }
}
