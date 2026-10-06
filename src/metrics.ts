/**
 * Prometheus metrics for the WUNCoin blockchain service (Phase 6.6).
 *
 * Uses a dedicated `prom-client` Registry (not the global default) so the
 * metric surface is explicit and testable. All labels are bounded-cardinality:
 * route labels are normalised Express patterns (e.g. `/chain/:blockIndex`),
 * never raw URLs.
 *
 * Collected metrics:
 *   - HTTP request duration histogram + total counter (by route/method/status)
 *   - Node.js event-loop lag, heap and RSS (via prom-client default collectors)
 *   - Mining worker-pool stats (size, busy, queue depth)
 *   - Mempool size gauge
 *   - Chain height gauge (hot + cold)
 *   - Group-commit flush count / failure counter
 *   - WebSocket connections gauge
 *   - Rate-limit rejection counter
 *   - Cache hit/miss counters (validity cache + hot/cold block access)
 *
 * The registry is exposed at `GET /api/metrics` in Prometheus text format.
 * Auth decision: gated behind the existing API-key middleware in production
 * (safer — prevents unauthenticated cardinality probing); open in test/dev
 * where no API key is configured so local scraping and CI smoke tests work.
 */
import client from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

// --- Dedicated registry (never the global default) --------------------------

export const registry = new client.Registry();

// Add default Node.js process metrics (event-loop lag, heap, RSS, GC, etc.)
client.collectDefaultMetrics({ register: registry, prefix: 'wun_' });

// --- HTTP metrics -----------------------------------------------------------

/** Normalised route label patterns (bounded cardinality). */
const ROUTE_NORMALIZE: [RegExp, string][] = [
  [/^\/api\/blockchain\/chain\/\d+$/, '/api/blockchain/chain/:blockIndex'],
  [/^\/api\/blockchain\/blocks$/, '/api/blockchain/blocks'],
  [/^\/api\/blockchain\/chain$/, '/api/blockchain/chain'],
  [/^\/api\/blockchain\/info$/, '/api/blockchain/info'],
  [/^\/api\/transactions\/[^/]+\/status$/, '/api/transactions/:txId/status'],
  [/^\/api\/transactions\/status\/all$/, '/api/transactions/status/all'],
  [/^\/api\/transactions\/pending$/, '/api/transactions/pending'],
  [/^\/api\/transactions\/sign$/, '/api/transactions/sign'],
  [/^\/api\/transactions$/, '/api/transactions'],
  [/^\/api\/balance\/[^/]+$/, '/api/balance/:address'],
  [/^\/api\/address\/[^/]+\/history$/, '/api/address/:address/history'],
  [/^\/api\/mining\/jobs\/[^/]+$/, '/api/mining/jobs/:jobId'],
  [/^\/api\/mining\/jobs$/, '/api/mining/jobs'],
  [/^\/api\/mining\/mine$/, '/api/mining/mine'],
  [/^\/api\/keys\/generate$/, '/api/keys/generate'],
  [/^\/api\/validate$/, '/api/validate'],
  [/^\/api\/logs\/stats$/, '/api/logs/stats'],
  [/^\/api\/logs\/export$/, '/api/logs/export'],
  [/^\/api\/logs\/clear$/, '/api/logs/clear'],
  [/^\/api\/logs$/, '/api/logs'],
  [/^\/api\/health\/ready$/, '/api/health/ready'],
  [/^\/api\/health$/, '/api/health'],
  [/^\/api\/version$/, '/api/version'],
  [/^\/api\/metrics$/, '/api/metrics'],
];

/** Normalise a request path to a bounded-cardinality route label. */
export function normalizeRoute(path: string): string {
  for (const [pattern, label] of ROUTE_NORMALIZE) {
    if (pattern.test(path)) return label;
  }
  return 'other';
}

export const httpDuration = new client.Histogram({
  name: 'wun_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: 'wun_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

// --- Blockchain domain metrics ---------------------------------------------

export const chainHeight = new client.Gauge({
  name: 'wun_chain_height',
  help: 'Total chain height (hot + cold blocks)',
  registers: [registry],
});

export const mempoolSize = new client.Gauge({
  name: 'wun_mempool_size',
  help: 'Number of pending transactions in the mempool',
  registers: [registry],
});

export const hotWindowEvictions = new client.Counter({
  name: 'wun_hot_window_evictions_total',
  help: 'Total blocks evicted from the hot window to cold storage',
  registers: [registry],
});

/**
 * Total WUN minted via TREASURY `mint` transactions (H5). Incremented through
 * the kernel's DECOUPLED `setMintHook` callback — the kernel never imports
 * prom-client. Wiring belongs to the bootstrap (which owns `server.ts`):
 *   blockchain.setMintHook((i) => wunSupplyMintedTotal.inc(i.amount));
 * Because `mint` is refused above the fixed supply cap, this counter only grows
 * when tokens are re-issued after a burn — never by unchecked inflation.
 */
export const wunSupplyMintedTotal = new client.Counter({
  name: 'wun_supply_minted_total',
  help: 'Total WUN minted via TREASURY mint transactions (capped at fixed supply)',
  registers: [registry],
});

// --- Mining pool metrics ----------------------------------------------------

export const poolSize = new client.Gauge({
  name: 'wun_mining_pool_workers',
  help: 'Number of active mining pool workers',
  registers: [registry],
});

export const poolBusy = new client.Gauge({
  name: 'wun_mining_pool_busy_workers',
  help: 'Number of busy mining pool workers',
  registers: [registry],
});

export const poolQueueDepth = new client.Gauge({
  name: 'wun_mining_pool_queue_depth',
  help: 'Number of jobs queued in the mining pool',
  registers: [registry],
});

// --- Persistence metrics ----------------------------------------------------

export const groupCommitFlushes = new client.Counter({
  name: 'wun_group_commit_flushes_total',
  help: 'Total group-commit flush operations',
  registers: [registry],
});

export const groupCommitFailures = new client.Counter({
  name: 'wun_group_commit_failures_total',
  help: 'Total group-commit flush failures (after retries)',
  registers: [registry],
});

// --- WebSocket metrics ------------------------------------------------------

export const wsConnections = new client.Gauge({
  name: 'wun_ws_connections',
  help: 'Current number of active WebSocket connections',
  registers: [registry],
});

// --- Rate-limit metrics -----------------------------------------------------

export const rateLimitRejections = new client.Counter({
  name: 'wun_rate_limit_rejections_total',
  help: 'Total requests rejected by the rate limiter',
  registers: [registry],
});

// --- Cache metrics ----------------------------------------------------------

export const cacheHits = new client.Counter({
  name: 'wun_cache_hits_total',
  help: 'Cache hits (validity cache + hot block access)',
  labelNames: ['cache'] as const,
  registers: [registry],
});

export const cacheMisses = new client.Counter({
  name: 'wun_cache_misses_total',
  help: 'Cache misses (validity cache + cold block reload)',
  labelNames: ['cache'] as const,
  registers: [registry],
});

// --- Express middleware -----------------------------------------------------

/**
 * HTTP metrics middleware. Records request duration and increments the total
 * counter with normalised route labels. Mount BEFORE routers in `app.ts`.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = normalizeRoute(req.path);
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
}

// --- Periodic gauge refresh -------------------------------------------------

/**
 * Start a periodic interval that refreshes pull-based gauges (chain height,
 * mempool size, pool stats, WS connections). The interval is `.unref()`'d so
 * it never holds the event loop open. Returns the handle for later clearing.
 *
 * @param getters - lazy accessors so the metrics module never imports the
 *   blockchain/context directly (avoids circular deps).
 */
export function startGaugeRefresh(getters: {
  chainHeight?: () => number;
  mempoolSize?: () => number;
  poolSize?: () => number;
  poolBusy?: () => number;
  poolQueueDepth?: () => number;
  wsConnections?: () => number;
}, intervalMs = 5_000): NodeJS.Timeout {
  const tick = (): void => {
    if (getters.chainHeight) chainHeight.set(getters.chainHeight());
    if (getters.mempoolSize) mempoolSize.set(getters.mempoolSize());
    if (getters.poolSize) poolSize.set(getters.poolSize());
    if (getters.poolBusy) poolBusy.set(getters.poolBusy());
    if (getters.poolQueueDepth) poolQueueDepth.set(getters.poolQueueDepth());
    if (getters.wsConnections) wsConnections.set(getters.wsConnections());
  };
  tick(); // immediate first sample
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

/**
 * Render the registry in Prometheus text exposition format.
 * Used by the `/api/metrics` endpoint.
 */
export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

/** Content-type for the Prometheus text exposition format. */
export const METRICS_CONTENT_TYPE = registry.contentType;
