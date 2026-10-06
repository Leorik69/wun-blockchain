/**
 * Express application factory.
 *
 * Builds and returns a fully-configured Express app WITHOUT calling `listen()`
 * — the bootstrap (`server.ts`) owns the HTTP server, WebSocket attachment and
 * process lifecycle. All dependencies (config, runtime context, rate limiter)
 * are injected, so no module-level mutable global state is required.
 *
 * Global middleware order mirrors the former monolith exactly:
 *   trust proxy → helmet → origin guard → cors → compression → json body
 *   → routers → error handler.
 */
import express, { type Express } from 'express';
import compression from 'compression';
import helmet from 'helmet';
import type { AppConfig } from './config';
import type { AppContext, RouterDeps } from './context';
import type { RateLimiter } from './middleware/rateLimit';
import { createOriginGuard, createCorsMiddleware } from './middleware/cors';
import { createRequireApiKey } from './middleware/apiKey';
import { errorHandler } from './middleware/errorHandler';
import { metricsMiddleware } from './metrics';
import { createKeysRouter } from './routes/keys.router';
import { createTransactionsRouter } from './routes/transactions.router';
import { createBlockchainRouter } from './routes/blockchain.router';
import { createMiningRouter } from './routes/mining.router';
import { createBalanceRouter } from './routes/balance.router';
import { createLogsRouter } from './routes/logs.router';
import { createSystemRouter } from './routes/system.router';

/** Options for {@link createApp}. */
export interface CreateAppOptions {
  config: AppConfig;
  ctx: AppContext;
  rateLimiter: RateLimiter;
}

/** Create and configure the Express application (no `listen()`). */
export function createApp(opts: CreateAppOptions): Express {
  const { config, ctx, rateLimiter } = opts;

  const app: Express = express();

  // M2: `trust proxy` is config-driven (env TRUST_PROXY, default FALSE) so
  // X-Forwarded-For is never trusted — and req.ip never spoofable — unless the
  // deployment explicitly opts in behind a known reverse proxy. When enabled,
  // Express resolves req.ip from the proxy chain and the rate limiters key on it.
  app.set('trust proxy', config.trustProxy);

  // Security headers. CSP is disabled intentionally: this is a JSON API with no
  // HTML surface, and a strict CSP would only add noise.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Origin guard + CORS (shared allow-list).
  app.use(createOriginGuard(config.allowedOrigins));
  app.use(createCorsMiddleware(config.allowedOrigins));

  // Compress JSON responses (chain dumps and log exports can be large).
  app.use(compression());

  // Bound request bodies to prevent memory-exhaustion from oversized payloads.
  app.use(express.json({ limit: config.jsonBodyLimit }));

  // Phase 6.6: HTTP metrics collection (duration histogram + request counter).
  // Mounted after body parsing so req.path is fully resolved.
  app.use(metricsMiddleware);

  const deps: RouterDeps = {
    ctx,
    requireApiKey: createRequireApiKey(config),
    rateLimit: rateLimiter.middleware,
  };

  // Routers (full paths are declared inside each router).
  app.use(createKeysRouter(deps));
  app.use(createTransactionsRouter(deps));
  app.use(createBlockchainRouter(deps));
  app.use(createMiningRouter(deps));
  app.use(createBalanceRouter(deps));
  app.use(createLogsRouter(deps));
  app.use(createSystemRouter(deps));

  // Terminal error handler.
  app.use(errorHandler);

  return app;
}
