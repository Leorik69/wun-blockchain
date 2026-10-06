/**
 * Application dependency-injection container.
 *
 * Replaces the module-level `let blockchain` mutable global of the former
 * monolithic `server.ts`. A single {@link AppContext} instance is created by the
 * bootstrap, handed to the app factory, routers, controllers and the WebSocket
 * hub, and mutated only by the bootstrap once the async blockchain factory
 * resolves. This keeps the wiring explicit and testable while preserving the
 * original "routes 500 until the chain is ready" boot behaviour.
 */
import type { RequestHandler } from 'express';
import type { WUNCoinBlockchain } from './blockchain';
import type { TransactionStatusTracker } from './transaction-status';
import type { MineJobManager, MiningPool } from './mining';
import type { AppConfig } from './config';
import type { Broadcaster } from './ws/hub';
import type { StateStore } from './state/StateStore';

/** Shared, mutable runtime dependencies threaded through the whole app. */
export interface AppContext {
  /** Resolved, immutable configuration. */
  config: AppConfig;
  /** Transaction lifecycle tracker (pending/confirmed/failed). */
  statusTracker: TransactionStatusTracker;
  /** WebSocket broadcast sink shared between controllers and the WS hub. */
  broadcaster: Broadcaster;
  /**
   * Cross-replica coordination backend (Phase 7). MemoryStateStore when
   * `REDIS_URL` is unset (default/dormant), RedisStateStore otherwise.
   */
  stateStore?: StateStore;
  /** Blockchain kernel; assigned asynchronously by the bootstrap. */
  blockchain?: WUNCoinBlockchain;
  /** Worker-thread PoW pool; null under the test harness (sync fallback). */
  miningPool?: MiningPool | null;
  /** Async mining job manager; null under the test harness. */
  mineJobManager?: MineJobManager | null;
}

/** Dependencies handed to each router factory. */
export interface RouterDeps {
  ctx: AppContext;
  /** API-key gate for protected routes. */
  requireApiKey: RequestHandler;
  /** Per-IP rate limiter for sensitive/public routes. */
  rateLimit: RequestHandler;
}

/**
 * Return the blockchain kernel or throw when it has not finished booting.
 *
 * Mirrors the former behaviour where the unassigned module-level `blockchain`
 * caused a TypeError (→ HTTP 500) for requests that arrived before the async
 * `WUNCoinBlockchain.create()` promise resolved.
 */
export function requireBlockchain(ctx: AppContext): WUNCoinBlockchain {
  if (!ctx.blockchain) {
    throw new Error('Blockchain is not initialized');
  }
  return ctx.blockchain;
}
