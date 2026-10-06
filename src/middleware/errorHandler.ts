/**
 * Central error-handling middleware.
 *
 * Extracted verbatim from the tail of `server.ts`. Catches anything that
 * escapes a route handler and emits the uniform 500 envelope.
 */
import type { ErrorRequestHandler } from 'express';

/** Terminal error handler: logs and returns a 500 JSON envelope. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err instanceof Error ? err.message : String(err),
  });
};
