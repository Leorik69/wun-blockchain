/**
 * Phase 7.1 — StateStore contract + factory selection.
 *
 * Requires NO Redis: exercises MemoryStateStore directly and asserts the factory
 * picks the memory backend when REDIS_URL is unset (local dev + all tests) and a
 * Redis backend only when it is set (constructed lazily — no socket opened).
 */
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config';
import { MemoryStateStore } from '../../src/state/MemoryStateStore';
import { createStateStore } from '../../src/state/createStateStore';
import type { PubSubMessage } from '../../src/state/StateStore';
import type { TransactionStatus } from '../../src/transaction-status';

describe('MemoryStateStore — StateStore interface contract', () => {
  it('reports kind=memory', () => {
    expect(new MemoryStateStore().kind).toBe('memory');
  });

  it('round-trips the chain tip (null before set)', async () => {
    const store = new MemoryStateStore();
    expect(await store.getChainTip()).toBeNull();
    await store.setChainTip({ height: 7, hash: '0xabc', index: 6 });
    expect(await store.getChainTip()).toEqual({ height: 7, hash: '0xabc', index: 6 });
  });

  it('round-trips a status entry (undefined before put)', async () => {
    const store = new MemoryStateStore();
    expect(await store.getStatus('tx1')).toBeUndefined();
    const status: TransactionStatus = {
      id: 'tx1',
      status: 'confirmed',
      blockIndex: 3,
      blockHash: '0xdead',
      timestamp: 1,
      updatedAt: 2,
    };
    await store.putStatus(status);
    expect(await store.getStatus('tx1')).toEqual(status);
  });

  it('delivers publish→subscribe loopback and honours unsubscribe', async () => {
    const store = new MemoryStateStore();
    const received: PubSubMessage[] = [];
    const unsub = await store.subscribe('ch', (m) => received.push(m));

    await store.publish('ch', { type: 'block_mined', n: 1 });
    expect(received).toEqual([{ type: 'block_mined', n: 1 }]);

    await unsub();
    await store.publish('ch', { type: 'block_mined', n: 2 });
    expect(received).toHaveLength(1); // no delivery after unsubscribe
  });

  it('does not cross channels', async () => {
    const store = new MemoryStateStore();
    const a: PubSubMessage[] = [];
    await store.subscribe('a', (m) => a.push(m));
    await store.publish('b', { x: 1 });
    expect(a).toHaveLength(0);
  });

  it('acquires, refuses a second acquire while held, renews and releases a lock', async () => {
    const store = new MemoryStateStore();
    const h1 = await store.acquireLock('lock', 5_000);
    expect(h1).not.toBeNull();

    // Second acquire while held is refused.
    expect(await store.acquireLock('lock', 5_000)).toBeNull();

    // Renew with the owning handle succeeds; a foreign handle fails.
    expect(await store.renewLock('lock', h1!, 5_000)).toBe(true);
    expect(await store.renewLock('lock', { token: 999, secret: 'nope' }, 5_000)).toBe(false);

    // Release by the owner, then the lock is free again.
    expect(await store.releaseLock('lock', h1!)).toBe(true);
    expect(await store.releaseLock('lock', h1!)).toBe(false);
    const h2 = await store.acquireLock('lock', 5_000);
    expect(h2).not.toBeNull();
    expect(h2!.token).toBeGreaterThan(h1!.token); // monotonic fencing token
  });

  it('counts a sliding window and blocks over the limit', async () => {
    const store = new MemoryStateStore();
    expect((await store.rateLimitHit('ip', 60_000, 2)).allowed).toBe(true);
    expect((await store.rateLimitHit('ip', 60_000, 2)).allowed).toBe(true);
    const third = await store.rateLimitHit('ip', 60_000, 2);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });
});

describe('createStateStore — backend selection', () => {
  it('selects MemoryStateStore when REDIS_URL is unset (default/dormant)', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    const store = createStateStore(config);
    expect(store.kind).toBe('memory');
    expect(store).toBeInstanceOf(MemoryStateStore);
  });

  it('treats a blank REDIS_URL as unset', () => {
    const config = loadConfig({ NODE_ENV: 'development', REDIS_URL: '   ' });
    expect(config.redis.url).toBeUndefined();
    expect(createStateStore(config).kind).toBe('memory');
  });

  it('selects the Redis backend when REDIS_URL is set', () => {
    const config = loadConfig({ NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379' });
    const store = createStateStore(config);
    expect(store.kind).toBe('redis');
    // Derives namespaced keys/channel/lock from the prefix.
    expect(config.redis.channel).toBe('wun:chain:events');
    expect(config.redis.miningLockKey).toBe('wun:chain:mining-lock');
  });
});
