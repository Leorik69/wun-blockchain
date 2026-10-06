/**
 * Async route-handler wrapper.
 *
 * Forwards a rejected promise from an async handler to Express' `next(err)` so
 * the central {@link errorHandler} produces the uniform 500 envelope. Handlers
 * that already implement their own try/catch (all of the current routes) may
 * still be wrapped safely: the inner catch produces the specific error response
 * and this outer net only fires for anything that escapes it.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** Wrap an async handler so rejections are forwarded to `next`. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
