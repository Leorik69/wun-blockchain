/**
 * In-memory FAKE Redis client for the Phase 7 unit tests.
 *
 * Mirrors the `MemoryDb` seam used by the persistence tests: it implements the
 * structural {@link RedisClient} interface so {@link RedisStateStore} can be
 * driven end-to-end with NO live Redis. The Lua scripts the store issues are
 * recognised by a distinctive substring and their semantics emulated against
 * plain in-memory data structures shared by every client cloned from the same
 * {@link FakeRedisBackend} (so pub/sub crosses "replicas").
 *
 * `failAll` / `failNext` force command errors so the fail-OPEN (rate limit) and
 * fail-CLOSED (mining lock) safety paths can be asserted deterministically.
 */
import type { RedisClient } from '../../src/state/RedisStateStore';

interface WindowEntry {
  score: number;
  member: string;
}

interface LockEntry {
  secret: string;
  expiresAt: number;
}

/** Shared backing state for all clients cloned from one backend. */
export class FakeRedisBackend {
  public readonly kv = new Map<string, string>();
  public readonly locks = new Map<string, LockEntry>();
  public readonly fence = new Map<string, number>();
  public readonly windows = new Map<string, WindowEntry[]>();
  public readonly channelSubs = new Map<string, Set<FakeRedisClient>>();
  /** Force every subsequent command to reject. */
  public failAll = false;
  /** Force the next N commands to reject. */
  public failNext = 0;

  publish(channel: string, message: string): number {
    const subs = this.channelSubs.get(channel);
    if (!subs) return 0;
    for (const client of [...subs]) {
      client.dispatch(channel, message);
    }
    return subs.size;
  }
}

/** A fake ioredis-compatible client bound to a shared {@link FakeRedisBackend}. */
export class FakeRedisClient implements RedisClient {
  private readonly messageListeners: ((channel: string, message: string) => void)[] = [];
  private readonly subscribed = new Set<string>();

  constructor(private readonly backend: FakeRedisBackend) {}

  private maybeFail(): void {
    if (this.backend.failAll) {
      throw new Error('simulated redis failure');
    }
    if (this.backend.failNext > 0) {
      this.backend.failNext--;
      throw new Error('simulated redis failure');
    }
  }

  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.maybeFail();
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys);

    // --- Sliding-window rate limit ------------------------------------------
    if (script.includes('ZREMRANGEBYSCORE')) {
      const key = keys[0] ?? '';
      const now = Number(argv[0] ?? 0);
      const windowStart = Number(argv[1] ?? 0);
      const member = String(argv[2] ?? '');
      const max = Number(argv[3] ?? 0);
      const existing = this.backend.windows.get(key) ?? [];
      const kept = existing.filter((e) => e.score > windowStart);
      const count = kept.length;
      if (count < max) {
        kept.push({ score: now, member });
        this.backend.windows.set(key, kept);
        return [1, max - count - 1];
      }
      this.backend.windows.set(key, kept);
      return [0, 0];
    }

    // --- Lock acquire (fencing token via INCR) ------------------------------
    if (script.includes('INCR')) {
      const lockKey = keys[0] ?? '';
      const fenceKey = keys[1] ?? '';
      const ownerId = String(argv[0] ?? '');
      const ttl = Number(argv[1] ?? 0);
      const existing = this.backend.locks.get(lockKey);
      if (existing && existing.expiresAt > Date.now()) {
        return [0, 0, '']; // held by someone else → refuse
      }
      const token = (this.backend.fence.get(fenceKey) ?? 0) + 1;
      this.backend.fence.set(fenceKey, token);
      const secret = `${ownerId}:${token}`;
      this.backend.locks.set(lockKey, { secret, expiresAt: Date.now() + ttl });
      return [1, token, secret];
    }

    // --- Lock release (DEL) — checked before renew (PEXPIRE) ----------------
    if (script.includes('DEL')) {
      const lockKey = keys[0] ?? '';
      const secret = String(argv[0] ?? '');
      const existing = this.backend.locks.get(lockKey);
      if (existing && existing.secret === secret) {
        this.backend.locks.delete(lockKey);
        return 1;
      }
      return 0;
    }

    // --- Lock renew (PEXPIRE) -----------------------------------------------
    if (script.includes('PEXPIRE')) {
      const lockKey = keys[0] ?? '';
      const secret = String(argv[0] ?? '');
      const ttl = Number(argv[1] ?? 0);
      const existing = this.backend.locks.get(lockKey);
      if (existing && existing.secret === secret && existing.expiresAt > Date.now()) {
        existing.expiresAt = Date.now() + ttl;
        return 1;
      }
      return 0;
    }

    throw new Error(`FakeRedisClient.eval: unrecognised script`);
  }

  async get(key: string): Promise<string | null> {
    this.maybeFail();
    return this.backend.kv.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.maybeFail();
    this.backend.kv.set(key, value);
    return 'OK';
  }

  async publish(channel: string, message: string): Promise<unknown> {
    this.maybeFail();
    return this.backend.publish(channel, message);
  }

  async subscribe(channel: string): Promise<unknown> {
    this.maybeFail();
    this.subscribed.add(channel);
    let subs = this.backend.channelSubs.get(channel);
    if (!subs) {
      subs = new Set();
      this.backend.channelSubs.set(channel, subs);
    }
    subs.add(this);
    return 1;
  }

  on(event: 'message', listener: (channel: string, message: string) => void): unknown {
    if (event === 'message') {
      this.messageListeners.push(listener);
    }
    return this;
  }

  duplicate(): RedisClient {
    return new FakeRedisClient(this.backend);
  }

  async quit(): Promise<unknown> {
    for (const channel of this.subscribed) {
      this.backend.channelSubs.get(channel)?.delete(this);
    }
    this.subscribed.clear();
    return 'OK';
  }

  disconnect(): void {
    /* no-op */
  }

  /** Deliver a published message to this client's listeners (called by backend). */
  dispatch(channel: string, message: string): void {
    for (const listener of [...this.messageListeners]) {
      listener(channel, message);
    }
  }
}

/** Create a client factory bound to a single shared backend. */
export function makeFakeFactory(): { backend: FakeRedisBackend; factory: () => Promise<RedisClient> } {
  const backend = new FakeRedisBackend();
  return { backend, factory: async () => new FakeRedisClient(backend) };
}

/** Let pending microtasks/timers flush (async middleware + pub/sub delivery). */
export function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
