/**
 * DistributedMiningLock — cross-replica single-miner guard (Phase 7.2).
 *
 * Wraps a {@link StateStore} lock with the lifecycle the mining path needs:
 *   - ACQUIRE before mining. If the lock cannot be acquired — because another
 *     replica holds it OR Redis is configured but unreachable — the store
 *     resolves `null` (fail CLOSED) and this class throws
 *     {@link MiningLockRefusedError}, so the caller REFUSES to mine. This is the
 *     safety-critical invariant: two replicas must never mine simultaneously,
 *     even during a network partition.
 *   - RENEW on an interval shorter than the TTL while mining runs, so a long
 *     PoW search never lets the lock expire mid-flight. The interval is
 *     `.unref()`'d and always cleared in `finally` (no dangling handles).
 *   - RELEASE after mining (success or failure). Release is CAS-guarded by the
 *     lock's fencing secret, so a replica whose lock already expired cannot
 *     release someone else's lock.
 *
 * The fencing TOKEN carried by the handle is monotonic across the whole cluster
 * (Redis `INCR`), letting any downstream write reject a stale holder.
 *
 * In memory mode this class is NOT constructed — `MineJobManager` keeps its
 * existing in-process single-flight lock (see `server.ts` wiring).
 */
import type { StateStore } from './StateStore';

/** Thrown when a replica must refuse to mine (lock held or Redis unreachable). */
export class MiningLockRefusedError extends Error {
  constructor(message = 'Mining refused: distributed lock unavailable') {
    super(message);
    this.name = 'MiningLockRefusedError';
  }
}

export interface DistributedMiningLockOptions {
  /** Lock key (from `config.redis.miningLockKey`). */
  key: string;
  /** Lock TTL in ms; auto-renewed while held. */
  ttlMs: number;
  /** Renewal cadence in ms (must be < ttlMs). */
  renewMs: number;
  /** Logger override (defaults to console). */
  logger?: Pick<Console, 'warn' | 'error'>;
}

export class DistributedMiningLock {
  private readonly store: StateStore;
  private readonly key: string;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly log: Pick<Console, 'warn' | 'error'>;

  constructor(store: StateStore, opts: DistributedMiningLockOptions) {
    this.store = store;
    this.key = opts.key;
    this.ttlMs = opts.ttlMs;
    this.renewMs = Math.min(opts.renewMs, Math.max(1, Math.floor(opts.ttlMs / 2)));
    this.log = opts.logger ?? console;
  }

  /**
   * Run `fn` while holding the distributed mining lock.
   *
   * @throws {MiningLockRefusedError} when the lock cannot be acquired — the
   *   caller MUST treat this as "do not mine" (fail closed).
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const handle = await this.store.acquireLock(this.key, this.ttlMs);
    if (!handle) {
      throw new MiningLockRefusedError(
        'Mining refused: distributed lock is held by another replica or Redis is unreachable',
      );
    }

    const renewTimer = setInterval(() => {
      void this.store.renewLock(this.key, handle, this.ttlMs).then((ok) => {
        if (!ok) {
          this.log.warn('[mining-lock] renewal lost ownership (token=%d)', handle.token);
        }
      });
    }, this.renewMs);
    renewTimer.unref();

    try {
      return await fn();
    } finally {
      clearInterval(renewTimer);
      await this.store.releaseLock(this.key, handle);
    }
  }
}
