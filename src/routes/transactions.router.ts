/**
 * Transactions router: sign, submit, pending count and status queries.
 *
 * Route order mirrors the monolith. `/api/transactions/:txId/status` and
 * `/api/transactions/status/all` do not collide because the former requires the
 * literal trailing segment `status` while the latter ends in `all`.
 */
import { Router } from 'express';
import type { RouterDeps } from '../context';
import { createTransactionsController } from '../controllers/transactions.controller';

/** Build the transactions router. */
export function createTransactionsRouter(deps: RouterDeps): Router {
  const { ctx, requireApiKey, rateLimit } = deps;
  const ctrl = createTransactionsController(ctx);
  const router = Router();

  router.post('/api/transactions/sign', requireApiKey, rateLimit, ctrl.sign);
  router.post('/api/transactions', requireApiKey, rateLimit, ctrl.create);
  router.get('/api/transactions/pending', rateLimit, ctrl.pending);
  router.get('/api/transactions/:txId/status', rateLimit, ctrl.status);
  router.get('/api/transactions/status/all', rateLimit, ctrl.statusAll);

  return router;
}
