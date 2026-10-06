/**
 * Balance router: address balance and transaction history.
 */
import { Router } from 'express';
import type { RouterDeps } from '../context';
import { createBalanceController } from '../controllers/balance.controller';

/** Build the balance router. */
export function createBalanceRouter(deps: RouterDeps): Router {
  const { ctx, rateLimit } = deps;
  const ctrl = createBalanceController(ctx);
  const router = Router();

  router.get('/api/balance/:address', rateLimit, ctrl.balance);
  router.get('/api/address/:address/history', rateLimit, ctrl.history);

  return router;
}
