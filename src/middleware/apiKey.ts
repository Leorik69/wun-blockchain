/**
 * API-key gate middleware for protected blockchain routes.
 *
 * Delegates the decision to the pure {@link evaluateApiKeyAuth} helper so the
 * fail-closed-in-production policy stays unit-testable. Extracted verbatim from
 * `server.ts`'s `requireApiKey`.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { evaluateApiKeyAuth } from '../apiKeyAuth';
import type { AppConfig } from '../config';

/** Build the `requireApiKey` middleware bound to the resolved config. */
export function createRequireApiKey(config: AppConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = evaluateApiKeyAuth({
      configuredKey: config.apiKey,
      providedKey: String(req.headers['x-api-key'] || ''),
      nodeEnv: config.nodeEnv,
    });
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    return next();
  };
}
