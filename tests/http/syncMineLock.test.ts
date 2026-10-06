/**
 * Task 21 — the SYNCHRONOUS `POST /api/mining/mine` path must share the SAME
 * guard as the async job path: in-process single-flight coalescing + the
 * cross-replica {@link DistributedMiningLock} (fail-CLOSED).
 *
 * Requires NO live Redis: drives the real controller, {@link MineJobManager}
 * and {@link DistributedMiningLock} through the {@link RedisStateStore} +
 * {@link FakeRedisClient} seam (`tests/state/fakeRedis.ts`). These tests exercise
 * the controller directly (not the HTTP harness, which runs in `isTest` mode
 * with no worker pool / job manager) so the distributed-lock wiring is covered.
 */
import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { createMiningController } from '../../src/controllers/mining.controller';
import { MineJobManager } from '../../src/mining/MineJobManager';
import type { MiningPool } from '../../src/mining/MiningPool';
import { RedisStateStore } from '../../src/state/RedisStateStore';
import { DistributedMiningLock } from '../../src/state/DistributedMiningLock';
import type { AppContext } from '../../src/context';
import type { WUNCoinBlockchain, Block, MineResult } from '../../src/blockchain';
import { makeFakeFactory, flush } from '../state/fakeRedis';
import type { RedisClient } from '../../src/state/RedisStateStore';

const KEY = 'wun:chain:mining-lock';
const stubPool = {} as unknown as MiningPool;

/** A fake blockchain whose `minePendingTransactions` is gated and counted. */
function makeFakeBlockchain(block: Block, gate?: Promise<void>) {
  let calls = 0;
  const bc = {
    async minePendingTransactions(_minerAddress: string): Promise<MineResult | null> {
      calls++;
      if (gate) await gate;
      return { block, txResults: [{ txId: 'tx1', success: true }] } as MineResult;
    },
  };
  return { bc: bc as unknown as WUNCoinBlockchain, mineCalls: () => calls };
}

/** Build a minimal AppContext wiring the fake chain + job manager together. */
function makeCtx(blockchain: WUNCoinBlockchain, mineJobManager: MineJobManager | null): AppContext {
  const confirmTransaction = () => {};
  const failTransaction = () => {};
  const broadcast = () => {};
  return {
    config: {},
    statusTracker: { confirmTransaction, failTransaction },
    broadcaster: { broadcast },
    blockchain,
    mineJobManager,
  } as unknown as AppContext;
}

/** A manager wired to a distributed lock over the shared fake-Redis backend. */
function makeManager(factory: () => Promise<RedisClient>) {
  const store = new RedisStateStore({
    url: 'redis://localhost:6379',
    keyPrefix: 'wun:chain',
    clientFactory: factory,
  });
  const lock = new DistributedMiningLock(store, { key: KEY, ttlMs: 5_000, renewMs: 1_000 });
  return { store, mgr: new MineJobManager(stubPool, lock) };
}

function makeReq(minerAddress: string): Request {
  return { body: { minerAddress } } as unknown as Request;
}

interface FakeRes {
  statusCode: number;
  body: any;
  status(code: number): FakeRes;
  json(payload: any): FakeRes;
}
function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const fakeBlock = { index: 7, hash: '0xblock7' } as unknown as Block;

describe('POST /api/mining/mine — synchronous path shares the mining guard', () => {
  it('coalesces two concurrent /mine calls (single-flight) → mines ONCE', async () => {
    const { factory } = makeFakeFactory();
    const { store, mgr } = makeManager(factory);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { bc, mineCalls } = makeFakeBlockchain(fakeBlock, gate);
    const ctrl = createMiningController(makeCtx(bc, mgr));

    const res1 = makeRes();
    const res2 = makeRes();
    const p1 = ctrl.mine(makeReq('minerA'), res1 as unknown as Response);
    const p2 = ctrl.mine(makeReq('minerB'), res2 as unknown as Response);

    release();
    await Promise.all([p1, p2]);

    // Single-flight: the guarded operation ran exactly once (no double-mine).
    expect(mineCalls()).toBe(1);
    // Both callers await and receive the SAME mined block (unchanged contract).
    expect(res1.statusCode).toBe(200);
    expect(res1.body).toMatchObject({ success: true, block: fakeBlock });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toMatchObject({ success: true, block: fakeBlock });

    await store.close();
  });

  it('memory mode (no distributed lock): single-flight still coalesces', async () => {
    const mgr = new MineJobManager(stubPool); // no lock → memory mode
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { bc, mineCalls } = makeFakeBlockchain(fakeBlock, gate);
    const ctrl = createMiningController(makeCtx(bc, mgr));

    const res1 = makeRes();
    const res2 = makeRes();
    const p1 = ctrl.mine(makeReq('minerA'), res1 as unknown as Response);
    const p2 = ctrl.mine(makeReq('minerB'), res2 as unknown as Response);
    release();
    await Promise.all([p1, p2]);

    expect(mineCalls()).toBe(1);
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res2.body.block).toEqual(fakeBlock);
  });

  it('a second replica /mine while the lock is held is REFUSED (no fork)', async () => {
    // Two managers over the SAME fake-Redis backend = two replicas, one lock.
    const { factory } = makeFakeFactory();
    const A = makeManager(factory);
    const B = makeManager(factory);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const chainA = makeFakeBlockchain(fakeBlock, gate); // A holds the lock, gated
    const chainB = makeFakeBlockchain(fakeBlock); // B must never mine
    const ctrlA = createMiningController(makeCtx(chainA.bc, A.mgr));
    const ctrlB = createMiningController(makeCtx(chainB.bc, B.mgr));

    const resA = makeRes();
    const resB = makeRes();
    const pA = ctrlA.mine(makeReq('minerA'), resA as unknown as Response);
    await flush(5); // let replica A acquire the distributed lock

    // Replica B tries to mine the same height while A holds the lock.
    await ctrlB.mine(makeReq('minerB'), resB as unknown as Response);

    expect(resB.statusCode).toBe(500);
    expect(resB.body).toMatchObject({ success: false });
    expect(resB.body.error).toContain('Mining refused');
    expect(chainB.mineCalls()).toBe(0); // B refused → no second block → no fork

    release();
    await pA;
    expect(resA.statusCode).toBe(200);
    expect(chainA.mineCalls()).toBe(1);

    await A.store.close();
    await B.store.close();
  });

  it('FAILS CLOSED: on a Redis error during lock acquire, /mine refuses (never mines)', async () => {
    const { backend, factory } = makeFakeFactory();
    backend.failAll = true; // Redis unreachable
    const { store, mgr } = makeManager(factory);

    const { bc, mineCalls } = makeFakeBlockchain(fakeBlock);
    const ctrl = createMiningController(makeCtx(bc, mgr));

    const res = makeRes();
    await ctrl.mine(makeReq('minerA'), res as unknown as Response);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toContain('Mining refused');
    expect(mineCalls()).toBe(0); // refused, did NOT mine unguarded

    await store.close();
  });

  it('returns the 400 "nothing to mine" envelope when the pending pool is empty', async () => {
    const { factory } = makeFakeFactory();
    const { store, mgr } = makeManager(factory);

    // A chain that reports "no transactions" (minePendingTransactions → null).
    const bc = {
      async minePendingTransactions(): Promise<MineResult | null> {
        return null;
      },
    } as unknown as WUNCoinBlockchain;
    const ctrl = createMiningController(makeCtx(bc, mgr));

    const res = makeRes();
    await ctrl.mine(makeReq('minerA'), res as unknown as Response);

    // Preserved contract: empty pool → 400 with the existing error message.
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: 'No transactions to mine or validation failed',
    });

    await store.close();
  });
});
