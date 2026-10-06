/**
 * RedisStateStore — multi-replica {@link StateStore} backend (Phase 7.1–7.3).
 *
 * Selected by {@link createStateStore} ONLY when `REDIS_URL` is set. It provides
 * the coordination primitives that let N stateless replicas behave as one
 * logical WUNCoin node:
 *   - distributed sliding-window rate limit (fail OPEN),
 *   - distributed single-miner lock with a monotonic FENCING TOKEN (fail CLOSED),
 *   - pub/sub for WebSocket fan-out,
 *   - shared chain-tip + transaction-status coordination entries.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAZY CLIENT / DEPENDENCY ISOLATION
 * ─────────────────────────────────────────────────────────────────────────────
 * The `ioredis` client is loaded via a DYNAMIC import with a NON-LITERAL
 * specifier, executed the first time a command actually runs. Consequences:
 *   - In memory mode RedisStateStore is never constructed → `ioredis` is never
 *     imported and no socket is ever opened (the whole layer stays dormant).
 *   - Compilation never needs `ioredis` types to resolve: we code against the
 *     structural {@link RedisClient} interface below and cast, so `tsc --noEmit`
 *     and `npm run build` pass even if the optional dependency is absent.
 *   - The client is injectable ({@link RedisStateStoreOptions.clientFactory}),
 *     mirroring the `MemoryDb` seam used by the persistence tests, so unit tests
 *     drive this store with an in-memory FAKE Redis and no live server.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY SEMANTICS
 * ─────────────────────────────────────────────────────────────────────────────
 *   - rateLimitHit(): on ANY Redis error → resolves `allowed:true` (FAIL OPEN)
 *     so a Redis outage never blocks legitimate traffic.
 *   - acquireLock(): on ANY Redis error → resolves `null` (FAIL CLOSED) so a
 *     replica refuses to mine rather than risk two concurrent miners.
 * All atomic operations are single Lua scripts (Redis executes them
 * atomically), so there is no GET/SET race on the lock or the window.
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

/**
 * The subset of an `ioredis` client this store uses. A real ioredis instance
 * satisfies it structurally (cast on construction); tests provide a fake.
 */
export interface RedisClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  duplicate(): RedisClient;
  quit(): Promise<unknown>;
  disconnect?(): void;
}

/** Factory that produces a connected-or-lazy Redis client. */
export type RedisClientFactory = () => Promise<RedisClient>;

export interface RedisStateStoreOptions {
  /** Redis connection string (REDIS_URL). */
  url: string;
  /** Namespace prefix applied to every owned key. */
  keyPrefix: string;
  /** Per-command timeout; commands fail fast so fail-open/closed is decisive. */
  commandTimeoutMs?: number;
  /**
   * TEST SEAM: supply a factory returning a fake client to bypass the dynamic
   * `ioredis` import entirely (used by the unit tests). When omitted, the real
   * lazy dynamic-import factory is used.
   */
  clientFactory?: RedisClientFactory;
  /** Logger override (defaults to console). */
  logger?: Pick<Console, 'warn' | 'error'>;
}

// --- Lua scripts (each executed atomically by Redis) ------------------------

/**
 * Sliding-window counter over a sorted set.
 * KEYS[1] = window zset. ARGV = [nowMs, windowStartMs, member, max, ttlMs].
 * Returns { allowed(1|0), remaining }.
 * M2 hardening: expired entries are pruned with ZREMRANGEBYSCORE on every hit
 * and the zset is HARD-CAPPED at `max` members via ZREMRANGEBYRANK (lowest
 * scores = oldest hits dropped first), so a burst of distinct timestamps can
 * never grow the set without bound between prunes.
 */
const SLIDING_WINDOW_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[4]) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3])
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -(tonumber(ARGV[4]) + 1))
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return {1, tonumber(ARGV[4]) - count - 1}
end
return {0, 0}
`;

/**
 * Lock acquire with a monotonic fencing token.
 * KEYS[1] = lock key, KEYS[2] = fence counter key. ARGV = [ownerId, ttlMs].
 * Returns { acquired(1|0), token, secret }.
 */
const LOCK_ACQUIRE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {0, 0, ''}
end
local token = redis.call('INCR', KEYS[2])
local secret = ARGV[1] .. ':' .. token
redis.call('SET', KEYS[1], secret, 'PX', ARGV[2])
return {1, token, secret}
`;

/**
 * Renew iff we still own the lock. KEYS[1] = lock key. ARGV = [secret, ttlMs].
 * Returns 1 on success, 0 when ownership was lost.
 */
const LOCK_RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/**
 * Release iff we still own the lock. KEYS[1] = lock key. ARGV = [secret].
 * Returns 1 on success, 0 when ownership was lost.
 */
const LOCK_RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Load `ioredis` lazily via a non-literal specifier (see module docstring). */
async function loadIoRedisModule(specifier: string): Promise<{
  default: new (...args: unknown[]) => RedisClient;
}> {
  return (await import(specifier)) as {
    default: new (...args: unknown[]) => RedisClient;
  };
}

export class RedisStateStore implements StateStore {
  public readonly kind = 'redis' as const;

  private readonly url: string;
  private readonly keyPrefix: string;
  private readonly commandTimeoutMs: number;
  private readonly clientFactory: RedisClientFactory;
  private readonly log: Pick<Console, 'warn' | 'error'>;
  /** Stable per-process owner id, embedded in lock secrets for CAS. */
  private readonly ownerId = `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;

  private commandClient: RedisClient | null = null;
  private subscriberClient: RedisClient | null = null;
  private commandClientPromise: Promise<RedisClient> | null = null;

  constructor(opts: RedisStateStoreOptions) {
    this.url = opts.url;
    this.keyPrefix = opts.keyPrefix;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 2_000;
    this.log = opts.logger ?? console;
    this.clientFactory =
      opts.clientFactory ??
      (async () => {
        const mod = await loadIoRedisModule('ioredis');
        return new mod.default(this.url, {
          connectTimeout: this.commandTimeoutMs,
          commandTimeout: this.commandTimeoutMs,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          lazyConnect: false,
        });
      });
  }

  private key(suffix: string): string {
    return `${this.keyPrefix}:${suffix}`;
  }

  /**
   * Lazily create (and cache) the command client. Concurrent callers share one
   * in-flight promise so exactly one connection is established.
   */
  private ensureCommandClient(): Promise<RedisClient> {
    if (this.commandClient) return Promise.resolve(this.commandClient);
    if (!this.commandClientPromise) {
      this.commandClientPromise = this.clientFactory()
        .then((client) => {
          this.commandClient = client;
          return client;
        })
        .catch((err) => {
          this.commandClientPromise = null;
          throw err;
        });
    }
    return this.commandClientPromise;
  }

  // --- Chain tip ------------------------------------------------------------

  async getChainTip(): Promise<ChainTip | null> {
    try {
      const client = await this.ensureCommandClient();
      const raw = await client.get(this.key('tip'));
      return raw ? (JSON.parse(raw) as ChainTip) : null;
    } catch (err) {
      this.log.warn('[state] getChainTip failed (Redis unavailable):', errMsg(err));
      return null;
    }
  }

  async setChainTip(tip: ChainTip): Promise<void> {
    try {
      const client = await this.ensureCommandClient();
      await client.set(this.key('tip'), JSON.stringify(tip));
    } catch (err) {
      this.log.warn('[state] setChainTip failed (Redis unavailable):', errMsg(err));
    }
  }

  // --- Status coordination --------------------------------------------------

  async putStatus(status: TransactionStatus): Promise<void> {
    try {
      const client = await this.ensureCommandClient();
      await client.set(this.key(`status:${status.id}`), JSON.stringify(status));
    } catch (err) {
      this.log.warn('[state] putStatus failed (Redis unavailable):', errMsg(err));
    }
  }

  async getStatus(id: string): Promise<TransactionStatus | undefined> {
    try {
      const client = await this.ensureCommandClient();
      const raw = await client.get(this.key(`status:${id}`));
      return raw ? (JSON.parse(raw) as TransactionStatus) : undefined;
    } catch (err) {
      this.log.warn('[state] getStatus failed (Redis unavailable):', errMsg(err));
      return undefined;
    }
  }

  // --- Pub/Sub --------------------------------------------------------------

  async publish(channel: string, message: PubSubMessage): Promise<void> {
    try {
      const client = await this.ensureCommandClient();
      await client.publish(channel, JSON.stringify(message));
    } catch (err) {
      this.log.warn('[state] publish failed (Redis unavailable):', errMsg(err));
    }
  }

  async subscribe(
    channel: string,
    handler: (message: PubSubMessage) => void,
  ): Promise<Unsubscribe> {
    try {
      if (!this.subscriberClient) {
        // A dedicated connection is required for subscriber mode.
        const command = await this.ensureCommandClient();
        this.subscriberClient = command.duplicate();
      }
      const sub = this.subscriberClient;
      const listener = (msgChannel: string, raw: string): void => {
        if (msgChannel !== channel) return;
        try {
          handler(JSON.parse(raw) as PubSubMessage);
        } catch (err) {
          this.log.error('[state] bad pub/sub payload:', errMsg(err));
        }
      };
      sub.on('message', listener);
      await sub.subscribe(channel);
      return () => {
        // ioredis has no per-channel listener removal on the typed surface we
        // use; dropping the shared subscriber connection on close() is enough.
        // This unsubscribe is therefore best-effort/no-op for the live socket.
      };
    } catch (err) {
      this.log.error('[state] subscribe failed (Redis unavailable):', errMsg(err));
      return () => {
        /* no-op */
      };
    }
  }

  // --- Distributed lock (fail CLOSED) ---------------------------------------

  async acquireLock(key: string, ttlMs: number): Promise<LockHandle | null> {
    try {
      const client = await this.ensureCommandClient();
      const res = (await client.eval(
        LOCK_ACQUIRE_LUA,
        2,
        key,
        this.key('mining-fence'),
        this.ownerId,
        ttlMs,
      )) as [number, number, string];
      const acquired = Number(res?.[0]) === 1;
      if (!acquired) return null;
      return { token: Number(res[1]), secret: String(res[2]) };
    } catch (err) {
      // FAIL CLOSED: cannot confirm exclusivity → refuse the lock.
      this.log.error('[state] acquireLock failed, refusing (fail-closed):', errMsg(err));
      return null;
    }
  }

  async renewLock(key: string, handle: LockHandle, ttlMs: number): Promise<boolean> {
    try {
      const client = await this.ensureCommandClient();
      const res = await client.eval(LOCK_RENEW_LUA, 1, key, handle.secret, ttlMs);
      return Number(res) === 1;
    } catch (err) {
      this.log.error('[state] renewLock failed (fail-closed):', errMsg(err));
      return false;
    }
  }

  async releaseLock(key: string, handle: LockHandle): Promise<boolean> {
    try {
      const client = await this.ensureCommandClient();
      const res = await client.eval(LOCK_RELEASE_LUA, 1, key, handle.secret);
      return Number(res) === 1;
    } catch (err) {
      this.log.warn('[state] releaseLock failed (TTL will reclaim):', errMsg(err));
      return false;
    }
  }

  // --- Sliding-window rate limit (fail OPEN) --------------------------------

  async rateLimitHit(key: string, windowMs: number, max: number): Promise<RateLimitHit> {
    try {
      const client = await this.ensureCommandClient();
      const now = Date.now();
      const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
      const res = (await client.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        now,
        now - windowMs,
        member,
        max,
        windowMs,
      )) as [number, number];
      const allowed = Number(res?.[0]) === 1;
      const remaining = allowed ? Math.max(0, Number(res?.[1] ?? 0)) : 0;
      return { allowed, remaining, resetMs: windowMs };
    } catch (err) {
      // FAIL OPEN: a Redis outage must never block legitimate traffic.
      this.log.warn('[state] rateLimitHit failed, allowing (fail-open):', errMsg(err));
      return { allowed: true, remaining: max, resetMs: windowMs };
    }
  }

  // --- Lifecycle ------------------------------------------------------------

  async close(): Promise<void> {
    const sub = this.subscriberClient;
    const cmd = this.commandClient;
    this.subscriberClient = null;
    this.commandClient = null;
    this.commandClientPromise = null;
    try {
      if (sub) {
        sub.disconnect?.();
        await sub.quit();
      }
    } catch {
      /* best effort */
    }
    try {
      if (cmd) {
        cmd.disconnect?.();
        await cmd.quit();
      }
    } catch {
      /* best effort */
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
