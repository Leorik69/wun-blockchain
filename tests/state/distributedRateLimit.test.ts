/**
 * Phase 7.2 — distributed (Redis) rate limiter with a FAKE Redis client.
 *
 * Requires NO live Redis. Drives the real {@link RedisStateStore} through the
 * {@link FakeRedisClient} seam and asserts:
 *   - the sliding window allows requests under the limit and 429s over it,
 *   - the exact 429 wire envelope + Retry-After header are preserved,
 *   - on a Redis ERROR the limiter FAILS OPEN (allows the request),
 *   - the NODE_ENV==='test' bypass short-circuits before touching Redis,
 *   - the memory path (in-process limiter) is unchanged.
 */
import { describe, it, expect } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { loadConfig } from '../../src/config';
import { RedisStateStore } from '../../src/state/RedisStateStore';
import { createDistributedRateLimiter } from '../../src/middleware/distributedRateLimit';
import { createRateLimiter } from '../../src/middleware/rateLimit';
import { makeFakeFactory, flush } from './fakeRedis';

interface InvokeResult {
  next: boolean;
  status?: number;
  body?: unknown;
  retryAfter?: string;
}

/** Invoke a middleware, resolving when it either calls next() or sends a body. */
function invoke(mw: (req: Request, res: Response, next: NextFunction) => void): Promise<InvokeResult> {
  return new Promise((resolve) => {
    const req = { headers: {}, socket: { remoteAddress: '203.0.113.9' } } as unknown as Request;
    let statusCode = 0;
    let retryAfter: string | undefined;
    const res = {
      status(c: number) {
        statusCode = c;
        return this;
      },
      set(k: string, v: string) {
        if (k === 'Retry-After') retryAfter = v;
        return this;
      },
      json(b: unknown) {
        resolve({ next: false, status: statusCode, body: b, retryAfter });
        return this;
      },
    } as unknown as Response;
    const next = () => resolve({ next: true });
    mw(req, res, next);
  });
}

function makeStore() {
  const { backend, factory } = makeFakeFactory();
  const config = loadConfig({ NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379' });
  const store = new RedisStateStore({ url: config.redis.url!, keyPrefix: config.redis.keyPrefix, clientFactory: factory });
  return { backend, config, store };
}

describe('createDistributedRateLimiter — Redis sliding window', () => {
  it('allows requests under the limit and 429s over it', async () => {
    const { config, store } = makeStore();
    // Small limit for a deterministic assertion.
    const limited = { ...config, rateLimit: { windowMs: 60_000, max: 2 } };
    const limiter = createDistributedRateLimiter(limited, store);

    expect((await invoke(limiter.middleware)).next).toBe(true);
    expect((await invoke(limiter.middleware)).next).toBe(true);

    const third = await invoke(limiter.middleware);
    expect(third.next).toBe(false);
    expect(third.status).toBe(429);
    // Exact wire shape preserved.
    expect(third.body).toEqual({ success: false, error: 'Rate limit exceeded' });
    expect(typeof third.retryAfter).toBe('string');

    await store.close();
  });

  it('counts per-IP independently', async () => {
    const { config, store } = makeStore();
    const limited = { ...config, rateLimit: { windowMs: 60_000, max: 1 } };
    const limiter = createDistributedRateLimiter(limited, store);

    const hit = (ip: string) =>
      new Promise<InvokeResult>((resolve) => {
        const req = { headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } } as unknown as Request;
        let statusCode = 0;
        const res = {
          status(c: number) {
            statusCode = c;
            return this;
          },
          set() {
            return this;
          },
          json(b: unknown) {
            resolve({ next: false, status: statusCode, body: b });
            return this;
          },
        } as unknown as Response;
        limiter.middleware(req, res, () => resolve({ next: true }));
      });

    expect((await hit('1.1.1.1')).next).toBe(true);
    expect((await hit('1.1.1.1')).status).toBe(429);
    expect((await hit('2.2.2.2')).next).toBe(true); // different IP → own bucket

    await store.close();
  });

  it('FAILS OPEN when Redis errors (never blocks legitimate traffic)', async () => {
    const { backend, config, store } = makeStore();
    const limiter = createDistributedRateLimiter(config, store);
    backend.failAll = true; // every Redis command rejects

    // Well over the limit, yet all allowed because the store fails open.
    for (let i = 0; i < 200; i++) {
      const res = await invoke(limiter.middleware);
      expect(res.next).toBe(true);
    }

    await store.close();
  });

  it('bypasses entirely under NODE_ENV=test', async () => {
    const { backend, store } = makeFakeStoreForTestEnv();
    const limiter = createDistributedRateLimiter(testConfig, store);
    backend.failAll = true; // even with Redis down, the test bypass never probes it
    expect((await invoke(limiter.middleware)).next).toBe(true);
    await store.close();
  });
});

const testConfig = loadConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://localhost:6379' });

function makeFakeStoreForTestEnv() {
  const { backend, factory } = makeFakeFactory();
  const store = new RedisStateStore({ url: 'redis://localhost:6379', keyPrefix: 'wun:chain', clientFactory: factory });
  return { backend, store };
}

describe('in-process limiter (memory path) — unchanged', () => {
  it('allows under the limit and 429s over it without Redis', async () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    const limited = { ...config, rateLimit: { windowMs: 60_000, max: 2 } };
    const limiter = createRateLimiter(limited);

    // Synchronous middleware: call and inspect via a capturing res.
    const call = () => {
      let result: InvokeResult = { next: true };
      const req = { headers: {}, socket: { remoteAddress: '9.9.9.9' } } as unknown as Request;
      let statusCode = 0;
      const res = {
        status(c: number) {
          statusCode = c;
          return this;
        },
        json(b: unknown) {
          result = { next: false, status: statusCode, body: b };
          return this;
        },
      } as unknown as Response;
      limiter.middleware(req, res, () => {
        result = { next: true };
      });
      return result;
    };

    expect(call().next).toBe(true);
    expect(call().next).toBe(true);
    const third = call();
    expect(third.next).toBe(false);
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ success: false, error: 'Rate limit exceeded' });

    const cleanup = limiter.startCleanup();
    clearInterval(cleanup);
    await flush();
  });
});
