/**
 * Shared controller helpers.
 */
import type { Response } from 'express';

/**
 * Set Cache-Control headers for read-only blockchain data endpoints.
 * Extracted verbatim from `server.ts`'s `setReadCacheHeaders`.
 */
export function setReadCacheHeaders(res: Response, maxAgeSeconds: number = 5): void {
  res.set('Cache-Control', `public, max-age=${maxAgeSeconds}`);
}

/**
 * Set `Cache-Control: no-store` for liveness/readiness probes (L4): a cached
 * probe response could mask an outage behind a CDN/proxy cache.
 *
 * Tolerates minimal mock `res` objects without `.set` (the readiness
 * controller unit tests in `tests/http/contract.test.ts` drive the handler
 * with a status/json-only stub), falling back to `.setHeader` when present.
 */
export function setNoStoreHeaders(res: Response): void {
  if (typeof res.set === 'function') {
    res.set('Cache-Control', 'no-store');
    return;
  }
  const raw = res as unknown as { setHeader?: (name: string, value: string) => void };
  if (typeof raw.setHeader === 'function') {
    raw.setHeader('Cache-Control', 'no-store');
  }
}
