/**
 * Minimal in-memory per-IP rate limiter for sensitive endpoints.
 *
 * Extracted verbatim from `server.ts`. The limiter is disabled entirely under
 * the test harness (NODE_ENV === 'test') because contract tests issue many
 * requests from a single IP and never assert on 429 behaviour.
 *
 * The stale-bucket cleanup interval is created lazily via {@link RateLimiter.startCleanup}
 * so the bootstrap owns its lifecycle (and can `.unref()` + clear it on
 * shutdown), matching the former module-level interval.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AppConfig } from '../config';

interface Bucket {
  windowStart: number;
  count: number;
}

/** Rate limiter middleware plus its cleanup-interval lifecycle hook. */
export interface RateLimiter {
  middleware: RequestHandler;
  /**
   * Start the periodic stale-bucket eviction interval (already `.unref()`'d so
   * it never keeps the process alive). Returns the handle for later clearing.
   */
  startCleanup(): NodeJS.Timeout;
}

/** Create a rate limiter bound to the resolved config. */
export function createRateLimiter(config: AppConfig): RateLimiter {
  const { windowMs, max } = config.rateLimit;
  const buckets = new Map<string, Bucket>();

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    // Disabled under the test harness (see module docstring).
    if (config.isTest) {
      return next();
    }
    // M2: key on req.ip — Express resolves it from the socket (and from proxy
    // headers ONLY when `trust proxy` is explicitly enabled via config). The
    // raw X-Forwarded-For header is client-spoofable and must never be trusted
    // directly. The socket fallback covers non-Express/mock request objects.
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = buckets.get(ip);
    if (!bucket || now - bucket.windowStart > windowMs) {
      buckets.set(ip, { windowStart: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }
    return next();
  };

  const startCleanup = (): NodeJS.Timeout => {
    const interval = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of buckets.entries()) {
        if (now - bucket.windowStart > windowMs * 2) {
          buckets.delete(key);
        }
      }
    }, 60_000);
    interval.unref();
    return interval;
  };

  return { middleware, startCleanup };
}
