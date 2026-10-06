/**
 * System controllers: deploy identity, health (liveness), readiness and metrics.
 *
 * Extracted from `server.ts`. Both endpoints resolve the git SHA from the config
 * (RAILWAY_GIT_COMMIT_SHA → GITHUB_SHA → VERCEL_GIT_COMMIT_SHA), preserving the
 * original per-endpoint fallbacks ('unknown' for version, null for health).
 *
 * Phase 6.6 additions:
 *   - `readiness` — GET /api/health/ready: returns 200 when every dependency is
 *     healthy, 503 otherwise. In in-memory mode (no DATABASE_URL) readiness is
 *     satisfied by process/boot readiness only.
 *   - `metrics` — GET /api/metrics: Prometheus text exposition format.
 */
import type { RequestHandler } from 'express';
import type { AppContext } from '../context';
import { setReadCacheHeaders, setNoStoreHeaders } from './shared';
import { renderMetrics, METRICS_CONTENT_TYPE } from '../metrics';

/**
 * Version of the OpenAPI specification (`blockchain/openapi.yaml`) this build
 * implements. Surfaced additively via `GET /api/version` so clients and tooling
 * can pin/verify the wire contract. Bump in lockstep with `openapi.yaml`.
 */
export const OPENAPI_SPEC_VERSION = '1.0.0';

/** Create the system controller handlers. */
export function createSystemController(ctx: AppContext): {
  version: RequestHandler;
  health: RequestHandler;
  readiness: RequestHandler;
  metrics: RequestHandler;
} {
  const version: RequestHandler = (_req, res) => {
    setReadCacheHeaders(res);
    res.json({
      success: true,
      data: {
        git_sha: ctx.config.gitSha || 'unknown',
        node_env: ctx.config.nodeEnv || 'development',
        // Additive (Phase 8.4): OpenAPI schema/spec version. Existing consumers
        // read git_sha/node_env only, so this field never breaks the contract.
        openapi: OPENAPI_SPEC_VERSION,
      },
    });
  };

  /**
   * LIVENESS probe — O(1), always returns 200 when the process is up.
   * Wire shape is guarded by the golden-master contract test; do NOT change.
   *
   * L4: `no-store` — a liveness probe must never be served from (or masked by)
   * a CDN/proxy cache, otherwise an outage could read as healthy.
   */
  const health: RequestHandler = (_req, res) => {
    setNoStoreHeaders(res);
    res.json({
      success: true,
      status: 'OK',
      timestamp: new Date().toISOString(),
      git_sha: ctx.config.gitSha || null,
    });
  };

  /**
   * READINESS probe (Phase 6.6). Returns 200 when the service can accept
   * traffic, 503 when a dependency is unhealthy.
   *
   * Checks (only when persistence is configured):
   *   - blockchain kernel booted (ctx.blockchain assigned)
   *   - write path not degraded
   *   - mining pool alive (when attached)
   *
   * In in-memory mode (no DATABASE_URL) readiness is satisfied by boot alone.
   *
   * L4: `no-store` — same rationale as the liveness probe: a cached 200 would
   * hide a degraded replica from the orchestrator's readiness checks.
   */
  const readiness: RequestHandler = (_req, res) => {
    const checks: Record<string, boolean> = {};

    // 1. Blockchain kernel must have finished booting.
    checks.blockchainBooted = ctx.blockchain !== undefined;

    if (ctx.blockchain) {
      // 2. Write path health (only meaningful when persistence is active).
      checks.writeHealthy = !ctx.blockchain.writeDegraded;

      // 3. Mining pool alive (when attached; null under test harness is OK).
      const pool = ctx.blockchain.getMiningPool();
      checks.miningPoolAlive = pool === null || !pool.isTerminated;
    }

    const ready = Object.values(checks).every(Boolean);
    const status = ready ? 200 : 503;
    setNoStoreHeaders(res);
    res.status(status).json({
      status: ready ? 'ready' : 'not_ready',
      checks,
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * Prometheus metrics endpoint (Phase 6.6).
   * Returns the registry in text exposition format.
   */
  const metrics: RequestHandler = async (_req, res) => {
    try {
      const body = await renderMetrics();
      res.set('Content-Type', METRICS_CONTENT_TYPE);
      res.send(body);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  return { version, health, readiness, metrics };
}
