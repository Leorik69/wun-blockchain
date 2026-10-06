/**
 * Mining router: synchronous mine, async job submission and job polling.
 *
 * The synchronous `mine` handler is async; it is wrapped with `asyncHandler` as
 * an outer safety net while the controller keeps its own try/catch that emits
 * the specific 400/500 envelopes (so the wire contract is unchanged).
 */
import { Router } from 'express';
import type { RouterDeps } from '../context';
import { createMiningController } from '../controllers/mining.controller';
import { asyncHandler } from '../middleware/asyncHandler';

/** Build the mining router. */
export function createMiningRouter(deps: RouterDeps): Router {
  const { ctx, requireApiKey, rateLimit } = deps;
  const ctrl = createMiningController(ctx);
  const router = Router();

  router.post('/api/mining/mine', requireApiKey, rateLimit, asyncHandler(ctrl.mine));
  router.post('/api/mining/jobs', requireApiKey, rateLimit, ctrl.createJob);
  router.get('/api/mining/jobs/:jobId', rateLimit, ctrl.getJob);

  return router;
}
