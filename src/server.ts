/**
 * WUNCoin Blockchain API Server — bootstrap entry point.
 *
 * This module is intentionally thin: it wires the layered structure together
 * (config → context → app factory → HTTP server → WebSocket hub → listen) and
 * owns the process lifecycle (async blockchain boot, cleanup intervals and
 * graceful shutdown). All route/middleware/WS logic now lives in dedicated
 * modules under `src/{config,app,context,middleware,routes,controllers,ws,validation}`.
 *
 * ENTRY-POINT CONTRACT: `node dist/src/server.js` remains the Dockerfile CMD and
 * the `start`/`dev`/`start:prod` script target. The contract-test harness also
 * imports this module and reads its `app` export, so `http.createServer(app)` is
 * invoked synchronously at import time (as before).
 */
import http from 'http';
import WUNCoinBlockchain from './blockchain';
import { BlockchainPersistence } from './persistence';
import { TransactionStatusTracker } from './transaction-status';
import { MiningPool, MineJobManager } from './mining';
import { loadConfig } from './config';
import type { AppContext } from './context';
import { createApp } from './app';
import { createRateLimiter } from './middleware/rateLimit';
import { createDistributedRateLimiter } from './middleware/distributedRateLimit';
import { createBroadcaster, attachWebSocket } from './ws/hub';
import { attachWsFanout, type WsFanout } from './ws/fanout';
import { createStateStore, DistributedMiningLock, type StateStore, type Unsubscribe } from './state';
import { startGaugeRefresh, wunSupplyMintedTotal } from './metrics';

// --- 1. Configuration + dependency-injection context ------------------------
const config = loadConfig(process.env);

// --- 1a. Process-level error guards (H3) -------------------------------------
// Registered EARLY, before any async work, so an unexpected throw or rejection
// is logged and triggers the graceful shutdown path instead of a silent crash.
// Skipped under the test harness: the contract tests import this module inside
// a Vitest worker, where swallowing rejections would break the runner's own
// unhandled-rejection reporting.
if (!config.isTest) {
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception — shutting down gracefully:', err);
    gracefulShutdown(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection — shutting down gracefully:', reason);
    gracefulShutdown(1);
  });
}

// Persistence is constructed ONLY when DATABASE_URL is set. With no connection
// string the entire durable layer stays dormant and the chain runs purely
// in-memory (local dev + all tests need no Postgres).
const persistence: BlockchainPersistence | undefined = config.databaseUrl
  ? new BlockchainPersistence(config.databaseUrl)
  : undefined;
// Cross-replica coordination store (Phase 7). Constructing it NEVER opens a
// socket: with no REDIS_URL it is a MemoryStateStore (dormant), otherwise a
// RedisStateStore whose client is lazily dynamic-imported on first command.
const stateStore: StateStore = createStateStore(config);
const redisActive = stateStore.kind === 'redis';
// When persistence is active, mirror every status mutation into chain_tx_status
// (Phase 6.2) so ack'd transactions survive a redeploy.
const statusTracker = new TransactionStatusTracker(
  persistence ? { upsert: (status) => persistence.saveStatus(status) } : undefined,
);
// Rate limiter: Redis sliding-window (shared across replicas) when Redis is
// active, otherwise the existing in-process buckets. Both fail-safe and share
// the same RateLimiter shape + 429 envelope.
const rateLimiter = redisActive
  ? createDistributedRateLimiter(config, stateStore)
  : createRateLimiter(config);
// Broadcaster: in Redis mode wrap it with pub/sub fan-out so every replica's
// `block_mined`/`transaction_added` events reach all replicas' local clients.
// In memory mode this is the plain direct broadcaster (byte-identical).
const localBroadcaster = createBroadcaster();
let wsFanout: WsFanout | undefined;
let broadcaster = localBroadcaster;
if (redisActive) {
  wsFanout = attachWsFanout(localBroadcaster, stateStore, config);
  broadcaster = wsFanout.broadcaster;
}

const ctx: AppContext = {
  config,
  statusTracker,
  broadcaster,
  stateStore,
  miningPool: null,
  mineJobManager: null,
};

// --- 2. Express app + HTTP server (created synchronously at import time) -----
const app = createApp({ config, ctx, rateLimiter });
const server = http.createServer(app);

// --- 3. WebSocket hub (shares the broadcaster with the HTTP controllers) -----
// The wss handle is kept so graceful shutdown can close upgrade sockets too.
const wss = attachWebSocket({ server, config, ctx, broadcaster });

// Phase 7.3: when Redis is active, subscribe to the shared fan-out channel so
// events published by OTHER replicas are re-broadcast to this replica's local
// WS clients. Held for graceful shutdown. Never runs in memory mode.
let fanoutUnsub: Unsubscribe | undefined;
if (wsFanout) {
  wsFanout
    .start()
    .then((unsub) => {
      fanoutUnsub = unsub;
      console.log('[ws] Redis fan-out subscription active');
    })
    .catch((err) => console.error('[ws] Redis fan-out subscription failed:', err));
}

// Phase 7.2: distributed single-miner lock, present ONLY in Redis mode. It is
// handed to MineJobManager so blockchain mining runs under a TTL lock with a
// monotonic fencing token and FAILS CLOSED (refuses to mine) if Redis is
// configured but unreachable. In memory mode this stays undefined and the
// in-process single-flight lock is the sole guard.
const miningLock = redisActive
  ? new DistributedMiningLock(stateStore, {
      key: config.redis.miningLockKey,
      ttlMs: config.redis.miningLockTtlMs,
      renewMs: config.redis.miningLockRenewMs,
    })
  : undefined;

// --- 4. Periodic cleanup intervals (both unref'd so they never hold the loop) --
// Evict stale rate-limit buckets (older than 2× the window).
const rateCleanupInterval = rateLimiter.startCleanup();
// Evict stale transaction statuses (older than 1 hour).
const statusCleanupInterval = setInterval(() => {
  statusTracker.cleanup(3_600_000);
}, 600_000);
statusCleanupInterval.unref();

// --- 5. Async blockchain boot, then listen ----------------------------------
WUNCoinBlockchain.create(persistence)
  .then((instance) => {
    ctx.blockchain = instance;

    // Task 24/25: feed the wun_supply_minted_total counter through the kernel's
    // decoupled mint hook — the kernel never imports prom-client; wiring lives
    // here in the bootstrap.
    instance.setMintHook((info) => {
      wunSupplyMintedTotal.inc(info.amount);
    });

    // Hydrate the status tracker from durable storage (Phase 6.2). No-op when
    // persistence is inactive (empty array).
    const restoredStatuses = instance.takeRestoredStatuses();
    if (restoredStatuses.length > 0) {
      statusTracker.hydrate(restoredStatuses);
      console.log(`Restored ${restoredStatuses.length} transaction status(es) from storage`);
    }

    // Attach a worker-thread mining pool so PoW runs off the event loop.
    // Skipped under the test harness: contract tests never mine a real block and
    // spawning worker threads there would leave dangling handles in the fork.
    if (!config.isTest) {
      const miningPool = new MiningPool();
      instance.initMiningPool(miningPool);
      ctx.miningPool = miningPool;
      ctx.mineJobManager = new MineJobManager(miningPool, miningLock);
      console.log(`Mining pool initialized with ${miningPool.size} worker(s)`);
    }

    // Phase 6.6: start periodic Prometheus gauge refresh (unref'd, never holds
    // the loop). Pull-based gauges are sampled every 5 s from the live context.
    startGaugeRefresh({
      chainHeight: () => ctx.blockchain?.chainHeight ?? 0,
      mempoolSize: () => ctx.blockchain?.getPendingCount() ?? 0,
      poolSize: () => ctx.miningPool?.size ?? 0,
      poolBusy: () => ctx.miningPool?.busyCount ?? 0,
      poolQueueDepth: () => ctx.miningPool?.queueDepth ?? 0,
      wsConnections: () => broadcaster.clients.size,
    });

    server.listen(config.port, () => {
      console.log('\n🚀 WUNCoin Blockchain API Server');
      console.log('═'.repeat(60));
      console.log(`HTTP Server listening on port ${config.port}`);
      console.log(`WebSocket listening on ws://localhost:${config.port}`);
      console.log('═'.repeat(60));
      console.log('\nEndpoints:');
      console.log('  GET  /api/health                      - Server health check');
      console.log('  GET  /api/version                     - Deploy git SHA (Railway CI)');
      console.log('  GET  /api/blockchain/info             - Blockchain information');
      console.log('  GET  /api/blockchain/blocks           - Paginated blocks (limit/before)');
      console.log('  GET  /api/blockchain/chain            - Full blockchain');
      console.log('  GET  /api/blockchain/chain/:idx       - Specific block');
      console.log('  POST /api/keys/generate               - Generate key pair');
      console.log('  POST /api/transactions/sign           - Sign transaction');
      console.log('  POST /api/transactions                - Add transaction');
      console.log('  GET  /api/transactions/pending        - Pending transactions');
      console.log('  GET  /api/transactions/:txId/status   - Transaction status');
      console.log('  GET  /api/transactions/status/all     - All transaction statuses');
      console.log('  POST /api/mining/mine                 - Mine new block');
      console.log('  POST /api/mining/jobs                 - Start async mining job');
      console.log('  GET  /api/mining/jobs/:jobId          - Poll async mining job');
      console.log('  GET  /api/balance/:address            - Get address balance');
      console.log('  GET  /api/address/:address/history    - Address history');
      console.log('  POST /api/validate                    - Validate blockchain');
      console.log('  GET  /api/logs/stats                  - Logging statistics');
      console.log('  GET  /api/logs                        - Get logs (with filtering)');
      console.log('  POST /api/logs/export                 - Export logs to JSON');
      console.log('  POST /api/logs/clear                  - Clear logs');
      console.log('═'.repeat(60) + '\n');
    });
  })
  .catch((err) => {
    console.error('Failed to initialize blockchain:', err);
    process.exit(1);
  });

// --- 6. Graceful shutdown ---------------------------------------------------
/** Re-entrancy guard so concurrent signals/errors shut down exactly once. */
let shuttingDown = false;

/**
 * Ordered teardown: clear intervals → hard-exit deadline → close HTTP + WS
 * servers → terminate the mining pool → release fan-out → close the state
 * store → flush persistence → exit. Shared by SIGTERM and the H3 process
 * error handlers (which exit non-zero after draining).
 */
function gracefulShutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Initiating graceful shutdown (exit code ${exitCode})`);
  clearInterval(rateCleanupInterval);
  clearInterval(statusCleanupInterval);
  // Hard deadline: if anything in the chain hangs, force-exit after 10 s.
  const deadline = setTimeout(() => process.exit(exitCode), 10_000);
  deadline.unref();
  server.close(() => {
    console.log('HTTP server closed');
    const closeWs = wss
      ? new Promise<void>((resolve) => {
          try {
            wss.close(() => resolve());
          } catch {
            resolve();
          }
        })
      : Promise.resolve();
    closeWs.then(() => {
      const terminatePool = ctx.miningPool ? ctx.miningPool.terminate() : Promise.resolve();
      terminatePool
        .catch((err) => console.error('Error terminating mining pool:', err))
        .finally(() => {
          // Phase 7: release the WS fan-out subscription and close the state
          // store (both no-ops in memory mode) BEFORE flushing persistence.
          const teardownFanout = fanoutUnsub
            ? Promise.resolve(fanoutUnsub())
            : Promise.resolve();
          teardownFanout
            .catch((err) => console.error('Error closing WS fan-out:', err))
            .finally(() => {
              stateStore
                .close()
                .catch((err) => console.error('Error closing state store:', err))
                .finally(() => {
                  if (persistence) {
                    // flush() durably writes every buffered block/mempool/status
                    // batch before the pool is closed (Phase 6.1 shutdown hook).
                    persistence.close().finally(() => process.exit(exitCode));
                  } else {
                    process.exit(exitCode);
                  }
                });
            });
        });
    });
  });
}

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  gracefulShutdown(0);
});

export { app, ctx };
