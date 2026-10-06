/**
 * Phase 7.2 — distributed mining lock (fail-CLOSED) + fencing token.
 *
 * Requires NO live Redis: drives the real {@link RedisStateStore} and
 * {@link DistributedMiningLock} through the {@link FakeRedisClient} seam, and
 * asserts the in-process {@link MineJobManager} single-flight still coalesces in
 * memory mode (no distributed lock injected).
 */
import { describe, it, expect } from 'vitest';
import { RedisStateStore } from '../../src/state/RedisStateStore';
import {
  DistributedMiningLock,
  MiningLockRefusedError,
} from '../../src/state/DistributedMiningLock';
import { MineJobManager } from '../../src/mining/MineJobManager';
import type { MiningPool } from '../../src/mining/MiningPool';
import type { Block } from '../../src/blockchain';
import { makeFakeFactory, flush } from './fakeRedis';

function makeStore() {
  const { backend, factory } = makeFakeFactory();
  const store = new RedisStateStore({
    url: 'redis://localhost:6379',
    keyPrefix: 'wun:chain',
    clientFactory: factory,
  });
  return { backend, store };
}

const KEY = 'wun:chain:mining-lock';

describe('RedisStateStore lock primitives (fake Redis)', () => {
  it('acquires, refuses a concurrent acquire, renews and releases', async () => {
    const { store } = makeStore();
    const h1 = await store.acquireLock(KEY, 5_000);
    expect(h1).not.toBeNull();
    expect(h1!.token).toBe(1);

    // Second acquire while held → refused.
    expect(await store.acquireLock(KEY, 5_000)).toBeNull();

    // Renew with the owning handle succeeds.
    expect(await store.renewLock(KEY, h1!, 5_000)).toBe(true);
    // Renew with a foreign secret fails.
    expect(await store.renewLock(KEY, { token: 42, secret: 'wrong' }, 5_000)).toBe(false);

    // Release, then a fresh acquire gets a strictly larger fencing token.
    expect(await store.releaseLock(KEY, h1!)).toBe(true);
    const h2 = await store.acquireLock(KEY, 5_000);
    expect(h2).not.toBeNull();
    expect(h2!.token).toBeGreaterThan(h1!.token);

    await store.close();
  });

  it('fencing tokens are monotonic across acquire/release cycles', async () => {
    const { store } = makeStore();
    let prev = 0;
    for (let i = 0; i < 5; i++) {
      const h = await store.acquireLock(KEY, 5_000);
      expect(h).not.toBeNull();
      expect(h!.token).toBeGreaterThan(prev);
      prev = h!.token;
      await store.releaseLock(KEY, h!);
    }
    await store.close();
  });

  it('FAILS CLOSED on a Redis error (returns null, never throws)', async () => {
    const { backend, store } = makeStore();
    backend.failAll = true;
    await expect(store.acquireLock(KEY, 5_000)).resolves.toBeNull();
    await store.close();
  });
});

describe('DistributedMiningLock.runExclusive', () => {
  it('runs the operation while holding the lock and releases it after', async () => {
    const { store } = makeStore();
    const lock = new DistributedMiningLock(store, { key: KEY, ttlMs: 5_000, renewMs: 1_000 });
    const result = await lock.runExclusive(async () => 'mined');
    expect(result).toBe('mined');
    // Lock released → a fresh acquire now succeeds.
    expect(await store.acquireLock(KEY, 5_000)).not.toBeNull();
    await store.close();
  });

  it('refuses to mine (throws MiningLockRefusedError) when the lock is held', async () => {
    const { store } = makeStore();
    const held = await store.acquireLock(KEY, 30_000);
    expect(held).not.toBeNull();
    const lock = new DistributedMiningLock(store, { key: KEY, ttlMs: 5_000, renewMs: 1_000 });
    let ran = false;
    await expect(
      lock.runExclusive(async () => {
        ran = true;
        return 'nope';
      }),
    ).rejects.toBeInstanceOf(MiningLockRefusedError);
    expect(ran).toBe(false); // the guarded operation never executed
    await store.close();
  });

  it('refuses to mine (FAILS CLOSED) when Redis is unreachable', async () => {
    const { backend, store } = makeStore();
    backend.failAll = true;
    const lock = new DistributedMiningLock(store, { key: KEY, ttlMs: 5_000, renewMs: 1_000 });
    await expect(lock.runExclusive(async () => 'x')).rejects.toBeInstanceOf(MiningLockRefusedError);
    await store.close();
  });

  it('releases the lock even when the operation throws', async () => {
    const { store } = makeStore();
    const lock = new DistributedMiningLock(store, { key: KEY, ttlMs: 5_000, renewMs: 1_000 });
    await expect(
      lock.runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Released in the finally → free again.
    expect(await store.acquireLock(KEY, 5_000)).not.toBeNull();
    await store.close();
  });
});

describe('MineJobManager in-process single-flight (memory mode, no distributed lock)', () => {
  const stubPool = {} as unknown as MiningPool;
  const fakeBlock = { index: 1, hash: '0x1' } as unknown as Block;

  it('coalesces a concurrent submission onto the in-flight job', async () => {
    const mgr = new MineJobManager(stubPool); // no distributed lock → memory mode
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runFn = async () => {
      await gate;
      return fakeBlock;
    };

    const first = mgr.startMining('minerA', runFn);
    expect(first.coalesced).toBe(false);
    expect(mgr.isMining).toBe(true);

    const second = mgr.startMining('minerB', runFn);
    expect(second.coalesced).toBe(true);
    expect(second.jobId).toBe(first.jobId);

    release!();
    await flush(5);
    expect(mgr.getJob(first.jobId)?.status).toBe('completed');
    expect(mgr.isMining).toBe(false);
  });

  it('marks the job failed when the distributed lock refuses (fail-closed wiring)', async () => {
    const { backend, store } = makeStore();
    backend.failAll = true; // Redis unreachable → runExclusive throws
    const lock = new DistributedMiningLock(store, { key: KEY, ttlMs: 5_000, renewMs: 1_000 });
    const mgr = new MineJobManager(stubPool, lock);

    let mined = false;
    const { jobId, coalesced } = mgr.startMining('minerA', async () => {
      mined = true;
      return fakeBlock;
    });
    expect(coalesced).toBe(false);
    await flush(5);

    expect(mined).toBe(false); // never mined — refused
    const job = mgr.getJob(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('Mining refused');
    await store.close();
  });
});
