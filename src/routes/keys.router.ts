/**
 * Keys router: POST /api/keys/generate.
 */
import { Router } from 'express';
import type { RouterDeps } from '../context';
import { createKeysController } from '../controllers/keys.controller';

/** Build the keys router. */
export function createKeysRouter(deps: RouterDeps): Router {
  const { requireApiKey, rateLimit } = deps;
  const ctrl = createKeysController();
  const router = Router();

  router.post('/api/keys/generate', requireApiKey, rateLimit, ctrl.generate);

  return router;
}
