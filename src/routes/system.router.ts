/**
 * System router: GET /api/version, GET /api/health (liveness),
 * GET /api/health/ready (readiness), GET /api/metrics (Prometheus).
 *
 * Phase 6.6 auth decision for /api/metrics: gated behind the existing API-key
 * middleware in production (prevents unauthenticated cardinality probing);
 * open in test/dev where no API key is configured so local scraping and CI
 * smoke tests work without credentials.
 */
import { Router } from 'express';
import type { RouterDeps } from '../context';
import { createSystemController } from '../controllers/system.controller';

/** Build the system router. */
export function createSystemRouter(deps: RouterDeps): Router {
  const ctrl = createSystemController(deps.ctx);
  const router = Router();

  router.get('/api/version', ctrl.version);
  // LIVENESS — always unauthenticated, O(1), golden-master contract.
  router.get('/api/health', ctrl.health);
  // READINESS — unauthenticated (load-balancer / orchestrator probe).
  router.get('/api/health/ready', ctrl.readiness);
  // METRICS — API-key gated in production; open in test/dev (no key configured).
  router.get('/api/metrics', deps.requireApiKey, ctrl.metrics);

  return router;
}
