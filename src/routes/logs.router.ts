/**
 * Logs router: stats, filtered listing, JSON export and clear (all protected).
 *
 * Route order mirrors the monolith: `/api/logs/stats` is registered before the
 * more general `/api/logs`.
 */
import { Router } from 'express';
import type { RouterDeps } from '../context';
import { createLogsController } from '../controllers/logs.controller';

/** Build the logs router. */
export function createLogsRouter(deps: RouterDeps): Router {
  const { ctx, requireApiKey, rateLimit } = deps;
  const ctrl = createLogsController(ctx);
  const router = Router();

  router.get('/api/logs/stats', requireApiKey, rateLimit, ctrl.stats);
  router.get('/api/logs', requireApiKey, rateLimit, ctrl.list);
  router.post('/api/logs/export', requireApiKey, rateLimit, ctrl.exportLogs);
  router.post('/api/logs/clear', requireApiKey, rateLimit, ctrl.clear);

  return router;
}
