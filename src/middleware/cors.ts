/**
 * CORS + origin-guard middleware.
 *
 * Two layers, extracted verbatim from `server.ts`:
 *  1. A hard origin guard that 403s disallowed cross-origin requests before
 *     they reach the router stack.
 *  2. The `cors` middleware that sets the permissive CORS response headers for
 *     allowed origins.
 * Both share the same resolved allow-list from {@link AppConfig}.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';

/** Reject requests whose Origin header is present but not in the allow-list. */
export function createOriginGuard(allowedOrigins: readonly string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    if (allowedOrigins.includes(origin)) return next();
    return res.status(403).json({ success: false, error: 'Origin not allowed' });
  };
}

/** Build the `cors` middleware bound to the resolved allow-list. */
export function createCorsMiddleware(allowedOrigins: readonly string[]): RequestHandler {
  return cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-api-key'],
    credentials: false,
  });
}
