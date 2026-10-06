/**
 * Distributed (Redis) per-IP rate limiter — Phase 7.2.
 *
 * Drop-in replacement for the in-process {@link createRateLimiter} used ONLY
 * when a {@link StateStore} of kind `'redis'` is active. It exposes the SAME
 * `RateLimiter` shape (`middleware` + `startCleanup`) so `server.ts`/`app.ts`
 * wire it identically, and it preserves the exact 429 wire envelope and the
 * `NODE_ENV === 'test'` bypass.
 *
 * Behaviour differences vs the in-process limiter:
 *   - Counting is a shared sliding window in Redis, so limits hold across all
 *     replicas rather than per-process.
 *   - SAFETY: FAILS OPEN. `StateStore.rateLimitHit` already resolves
 *     `allowed:true` on a Redis error; this middleware additionally wraps the
 *     call in try/catch and calls `next()` on ANY throw, so a Redis outage can
 *     never block legitimate traffic.
 *   - Expiry is handled by Redis TTLs, so `startCleanup()` has no local buckets
 *     to evict; it returns an idle, `.unref()`'d interval purely to satisfy the
 *     shared lifecycle contract (the bootstrap clears it on shutdown).
 *
 * Metrics: increments the already-registered `wun_rate_limit_rejections_total`
 * counter on a 429. This is the middleware layer (NOT the kernel), so it does
 * not couple `blockchain.ts`/repositories to prom-client.
 */
import type { Request, Response, NextFunction } from 'express';
import type { AppConfig } from '../config';
import type { StateStore } from '../state/StateStore';
import type { RateLimiter } from './rateLimit';
import { rateLimitRejections } from '../metrics';

/** Create the Redis-backed rate limiter bound to config + store. */
export function createDistributedRateLimiter(
  config: AppConfig,
  store: StateStore,
): RateLimiter {
  const { windowMs, max } = config.rateLimit;
  const keyPrefix = `${config.redis.keyPrefix}:rl`;

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    // Preserve the in-process limiter's test-harness bypass exactly.
    if (config.isTest) {
      next();
      return;
    }

    // M2: key on req.ip — Express resolves it from the socket (and from proxy
    // headers ONLY when `trust proxy` is explicitly enabled via config). The
    // raw X-Forwarded-For header is client-spoofable and must never be trusted
    // directly. The socket fallback covers non-Express/mock request objects.
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${ip}`;

    // Fire the async probe; on ANY error FAIL OPEN (allow the request).
    void store
      .rateLimitHit(key, windowMs, max)
      .then((hit) => {
        if (!hit.allowed) {
          rateLimitRejections.inc();
          res
            .status(429)
            .set('Retry-After', String(Math.ceil(hit.resetMs / 1000)))
            .json({ success: false, error: 'Rate limit exceeded' });
          return;
        }
        next();
      })
      .catch((err) => {
        // Fail open: never block legitimate traffic because Redis is down.
        console.warn('[rate-limit] distributed probe failed, allowing (fail-open):', err);
        next();
      });
  };

  const startCleanup = (): NodeJS.Timeout => {
    // Redis TTLs evict window keys; no local buckets to sweep. Idle placeholder
    // keeps the shared RateLimiter lifecycle contract (unref'd → never holds the
    // loop; cleared by the bootstrap on shutdown).
    const interval = setInterval(() => {
      /* no-op: expiry is server-side in Redis */
    }, 3_600_000);
    interval.unref();
    return interval;
  };

  return { middleware, startCleanup };
}
