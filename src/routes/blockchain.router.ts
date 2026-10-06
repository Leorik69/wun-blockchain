/**
 * Blockchain router: info, paginated blocks, full chain, single block and
 * chain validation.
 *
 * Route order mirrors the monolith so `/api/blockchain/chain` is matched before
 * the parameterized `/api/blockchain/chain/:blockIndex`.
 */
import { Router } from 'express';
import type { RouterDeps } from '../context';
import { createBlockchainController } from '../controllers/blockchain.controller';

/** Build the blockchain router. */
export function createBlockchainRouter(deps: RouterDeps): Router {
  const { ctx, requireApiKey, rateLimit } = deps;
  const ctrl = createBlockchainController(ctx);
  const router = Router();

  router.get('/api/blockchain/info', rateLimit, ctrl.info);
  router.get('/api/blockchain/blocks', rateLimit, ctrl.blocks);
  router.get('/api/blockchain/chain', rateLimit, ctrl.chain);
  router.get('/api/blockchain/chain/:blockIndex', ctrl.blockByIndex);
  router.post('/api/validate', requireApiKey, rateLimit, ctrl.validate);

  return router;
}
