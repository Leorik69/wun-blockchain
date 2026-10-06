/**
 * MemoryStateStore — DEFAULT, single-process {@link StateStore} backend.
 *
 * Selected by {@link createStateStore} whenever `REDIS_URL` is unset (local dev
 * and ALL tests). It keeps every coordination primitive in plain in-process
 * data structures:
 *   - chain tip + status entries in `Map`s,
 *   - a same-process loopback pub/sub (there is exactly one replica in memory
 *     mode, so publishing to local subscribers is fully equivalent),
 *   - an in-memory mutex with a monotonic fencing counter and TTL expiry,
 *   - a fixed-window counter for the rate-limit probe.
 *
 * CRITICAL: in memory mode the bootstrap does NOT route the WS broadcast, the
 * rate limiter or the mining lock through this store — it uses the existing
 * in-process paths (`createRateLimiter`, direct `Broadcaster.broadcast`,
 * `MineJobManager` single-flight). This store therefore creates NO sockets and
 * NO timers, so it can never introduce open handles that would keep the test
 * worker alive. Its methods exist to satisfy the interface contract and to back
 * the unit tests.
 */
import type { TransactionStatus } from '../transaction-status';
import type {
  ChainTip,
  LockHandle,
  PubSubMessage,
  RateLimitHit,
  StateStore,
  Unsubscribe,
} from './StateStore';

interface MemoryLock {
  secret: string;
  expiresAt: number;
}

interface MemoryWindow {
  count: number;
  resetAt: number;
}

export class MemoryStateStore implements StateStore {
  public readonly kind = 'memory' as const;

  private tip: ChainTip | null = null;
  private readonly statuses = new Map<string, TransactionStatus>();
  private readonly channels = new Map<string, Set<(m: PubSubMessage) => void>>();
  private readonly locks = new Map<string, MemoryLock>();
  private readonly windows = new Map<string, MemoryWindow>();
  private fenceCounter = 0;

  // --- Chain tip ------------------------------------------------------------

  async getChainTip(): Promise<ChainTip | null> {
    return this.tip;
  }

  async setChainTip(tip: ChainTip): Promise<void> {
    this.tip = tip;
  }

  // --- Status coordination --------------------------------------------------

  async putStatus(status: TransactionStatus): Promise<void> {
    this.statuses.set(status.id, status);
  }

  async getStatus(id: string): Promise<TransactionStatus | undefined> {
    return this.statuses.get(id);
  }

  // --- Loopback pub/sub -----------------------------------------------------

  async publish(channel: string, message: PubSubMessage): Promise<void> {
    const subs = this.channels.get(channel);
    if (!subs) return;
    // Copy so a handler that unsubscribes during delivery cannot skip entries.
    for (const handler of [...subs]) {
      handler(message);
    }
  }

  async subscribe(
    channel: string,
    handler: (message: PubSubMessage) => void,
  ): Promise<Unsubscribe> {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(handler);
    return () => {
      subs?.delete(handler);
    };
  }

  // --- In-memory mutex with fencing token + TTL -----------------------------

  async acquireLock(key: string, ttlMs: number): Promise<LockHandle | null> {
    const now = Date.now();
    const existing = this.locks.get(key);
    if (existing && existing.expiresAt > now) {
      return null; // held by someone else → refuse (fail closed).
    }
    const token = ++this.fenceCounter;
    const secret = `${token}:${now.toString(36)}`;
    this.locks.set(key, { secret, expiresAt: now + ttlMs });
    return { token, secret };
  }

  async renewLock(key: string, handle: LockHandle, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const existing = this.locks.get(key);
    if (!existing || existing.secret !== handle.secret || existing.expiresAt <= now) {
      return false;
    }
    existing.expiresAt = now + ttlMs;
    return true;
  }

  async releaseLock(key: string, handle: LockHandle): Promise<boolean> {
    const existing = this.locks.get(key);
    if (!existing || existing.secret !== handle.secret) {
      return false;
    }
    this.locks.delete(key);
    return true;
  }

  // --- Fixed-window rate-limit probe ----------------------------------------

  async rateLimitHit(key: string, windowMs: number, max: number): Promise<RateLimitHit> {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || now >= window.resetAt) {
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count > max) {
      return { allowed: false, remaining: 0, resetMs: Math.max(0, window.resetAt - now) };
    }
    return { allowed: true, remaining: max - window.count, resetMs: Math.max(0, window.resetAt - now) };
  }

  // --- Lifecycle ------------------------------------------------------------

  async close(): Promise<void> {
    this.channels.clear();
    this.locks.clear();
    this.windows.clear();
    this.statuses.clear();
    this.tip = null;
  }
}
