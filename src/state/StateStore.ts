/**
 * StateStore — cross-replica shared COORDINATION state (Phase 7.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS INTERFACE EXISTS (and what it deliberately does NOT do)
 * ─────────────────────────────────────────────────────────────────────────────
 * The WUNCoin kernel (`blockchain.ts`) reads its `contractState`
 * SYNCHRONOUSLY on hot paths — `applyTransactions`, `validateTransaction` and
 * `getBalance` are all sync and are called in tight loops during mining and
 * validation. Forcing an async Redis round-trip into those reads would (a) break
 * the synchronous kernel contract and (b) add network latency to every balance
 * lookup. We therefore DO NOT mirror `contractState` through the StateStore.
 *
 * Cross-replica contractState consistency is instead achieved WITHOUT async
 * kernel reads, via three cooperating mechanisms:
 *
 *   1. SINGLE-MINER LOCK (Phase 7.2 — `acquireLock`/`renewLock`/`releaseLock`):
 *      only ONE replica may mine at a time. This guarantees blocks are produced
 *      serially, so no two replicas ever apply conflicting state transitions.
 *
 *   2. `block_mined` PUB/SUB (Phase 7.3 — `publish`/`subscribe`): when the
 *      miner appends a block it broadcasts the event. Every other replica
 *      receives it, loads the new block from the shared Postgres persistence
 *      layer (Phase 6) and DETERMINISTICALLY re-applies it to its OWN local,
 *      in-memory `contractState`. Because block application is a pure function
 *      of (prior state + block transactions), all replicas converge on identical
 *      state while keeping their hot-path reads fully synchronous.
 *
 *   3. CHAIN-TIP COORDINATION (`getChainTip`/`setChainTip`): a lightweight,
 *      async, off-hot-path record of the canonical tip so a lagging replica can
 *      detect it is behind and catch up from persistence.
 *
 * The StateStore MAY expose an OPTIONAL contractState cache seam for a future
 * optimisation, but the default MemoryStateStore keeps the kernel's synchronous
 * behaviour byte-identical: in memory mode nothing here is on any hot path.
 *
 * The StateStore abstracts ONLY: chain tip/height, transaction-status
 * coordination entries, the pub/sub primitives (7.3), the distributed lock
 * primitives (7.2) and the sliding-window rate-limit counter (7.2).
 *
 * TWO BACKENDS:
 *   - {@link MemoryStateStore} (DEFAULT): single-process, in-memory, loopback
 *     pub/sub. Used whenever `REDIS_URL` is unset — local dev and ALL tests.
 *   - RedisStateStore: multi-replica coordination over Redis (lazy client).
 *
 * Every method is async so the Redis backend can round-trip uniformly; the
 * memory backend resolves immediately. NO method is ever called from the
 * kernel's synchronous hot paths.
 */
import type { TransactionStatus } from '../transaction-status';

/** Canonical chain tip shared across replicas (coordination metadata only). */
export interface ChainTip {
  /** Full chain height (hot + cold), i.e. the next block index. */
  height: number;
  /** Hash of the tip block. */
  hash: string;
  /** Index of the tip block. */
  index: number;
}

/** A message published on a pub/sub channel (JSON-serialisable). */
export type PubSubMessage = Record<string, unknown>;

/** Removes a previously-registered subscription. Idempotent. */
export type Unsubscribe = () => void | Promise<void>;

/**
 * Opaque handle returned by a successful {@link StateStore.acquireLock}.
 *
 * The `token` is a monotonically increasing FENCING TOKEN: any downstream
 * write can carry it so a stale lock holder (whose TTL expired during a pause)
 * is rejected. The `secret` is the CAS value used to renew/release only the
 * lock this handle actually owns.
 */
export interface LockHandle {
  /** Monotonic fencing token (Redis `INCR` on a persistent counter key). */
  token: number;
  /** Opaque owner secret for compare-and-set renew/release. */
  secret: string;
}

/** Outcome of a single sliding-window rate-limit probe. */
export interface RateLimitHit {
  /** True when the request is within the limit and should be allowed. */
  allowed: boolean;
  /** Remaining allowed requests in the current window (>= 0). */
  remaining: number;
  /** Milliseconds until the window fully drains (for Retry-After). */
  resetMs: number;
}

/** Which backend a StateStore instance represents. */
export type StateStoreKind = 'memory' | 'redis';

/**
 * Cross-replica shared coordination state. See the module docstring for the
 * consistency model — the kernel's synchronous `contractState` reads are NOT
 * routed through this interface.
 */
export interface StateStore {
  /** Discriminator so the bootstrap can pick in-process vs distributed paths. */
  readonly kind: StateStoreKind;

  // --- Chain-tip coordination (off hot path) --------------------------------

  /** Read the canonical chain tip, or `null` when none has been published. */
  getChainTip(): Promise<ChainTip | null>;
  /** Publish the canonical chain tip after a block is appended. */
  setChainTip(tip: ChainTip): Promise<void>;

  // --- Transaction-status coordination (cross-replica visibility) -----------

  /** Mirror a status entry so any replica can answer a status query. */
  putStatus(status: TransactionStatus): Promise<void>;
  /** Read a coordinated status entry, or `undefined` when unknown. */
  getStatus(id: string): Promise<TransactionStatus | undefined>;

  // --- Pub/Sub (Phase 7.3 — WebSocket fan-out) ------------------------------

  /** Publish an event to all subscribers of `channel`. */
  publish(channel: string, message: PubSubMessage): Promise<void>;
  /**
   * Subscribe to `channel`; returns an {@link Unsubscribe}. In memory mode the
   * loopback delivers to same-process subscribers only (no cross-replica hop,
   * because there is exactly one replica).
   */
  subscribe(
    channel: string,
    handler: (message: PubSubMessage) => void,
  ): Promise<Unsubscribe>;

  // --- Distributed lock (Phase 7.2 — single-miner) --------------------------

  /**
   * Attempt to acquire `key` with a TTL. Resolves to a {@link LockHandle} on
   * success, or `null` when the lock is held by someone else OR the backend is
   * unreachable. Implementations MUST fail CLOSED (return `null`, never throw)
   * so a caller can refuse to proceed safely.
   */
  acquireLock(key: string, ttlMs: number): Promise<LockHandle | null>;
  /** Extend the TTL of a lock this handle owns. False when ownership is lost. */
  renewLock(key: string, handle: LockHandle, ttlMs: number): Promise<boolean>;
  /** Release a lock iff this handle still owns it. False when already lost. */
  releaseLock(key: string, handle: LockHandle): Promise<boolean>;

  // --- Sliding-window rate limit (Phase 7.2) --------------------------------

  /**
   * Register one hit against `key` within a sliding `windowMs` window bounded
   * by `max`. Resolves `allowed:false` once the window is saturated. On a
   * backend error implementations MUST fail OPEN (`allowed:true`) so a Redis
   * outage never blocks legitimate traffic.
   */
  rateLimitHit(key: string, windowMs: number, max: number): Promise<RateLimitHit>;

  // --- Lifecycle ------------------------------------------------------------

  /** Release all resources (sockets, subscriptions). No-op in memory mode. */
  close(): Promise<void>;
}

/**
 * OPTIONAL contractState cache seam (future use — Phase 7.1 leaves it unused).
 *
 * Declared separately (not on {@link StateStore}) so the default memory backend
 * never has to implement it and the kernel's synchronous reads stay untouched.
 * A future Redis backend MAY implement this to warm a read-through cache, but
 * it must NEVER be placed on a synchronous kernel hot path.
 */
export interface ContractStateCache {
  getContractStateSnapshot(): Promise<Record<string, unknown> | null>;
  setContractStateSnapshot(snapshot: Record<string, unknown>): Promise<void>;
}
