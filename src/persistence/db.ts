/**
 * Shared Postgres plumbing for the WUNCoin persistence layer (Phase 6.1).
 *
 * This module owns two concerns that every repository shares:
 *   1. A tiny {@link QueryExecutor} seam. The real implementation is a `pg`
 *      Pool, but unit tests substitute an in-memory fake so the whole
 *      persistence layer can be exercised without a live database.
 *   2. Typed resolution of the persistence tunables (group-commit thresholds,
 *      pool sizing, retry/backoff) from the environment, mirroring the style of
 *      `mining/difficulty.ts#loadDifficultyConfig`.
 *
 * The layer is DORMANT unless `DATABASE_URL` is set: nothing here opens a
 * connection until {@link createPool} is explicitly called by the aggregate
 * store, which the bootstrap only constructs when a connection string exists.
 */
import { Pool } from 'pg';

/** Minimal structural result of a query — the subset the repositories use. */
export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

/**
 * The database seam. A real `pg.Pool` satisfies this at runtime (it is cast on
 * construction); tests provide an in-memory fake that records issued SQL.
 */
export interface QueryExecutor {
  query(text: string, params?: readonly unknown[]): Promise<QueryResult>;
}

/** Fully-resolved persistence tunables. */
export interface PersistenceConfig {
  /** Flush the block buffer once it holds this many blocks (GROUP COMMIT). */
  blockFlushCount: number;
  /** Flush the block buffer after this many ms even if not full. */
  blockFlushIntervalMs: number;
  /** Flush the pending/status write buffers once they hold this many rows. */
  writeFlushCount: number;
  /** Flush the pending/status write buffers after this many ms. */
  writeFlushIntervalMs: number;
  /** Bounded write retries before signalling health-degraded. */
  maxRetries: number;
  /** Base delay for exponential backoff (doubled per attempt, plus jitter). */
  baseDelayMs: number;
  /** pg pool `max` connections. */
  poolMax: number;
  /** pg pool idle timeout (ms). */
  idleTimeoutMillis: number;
  /** pg pool connection acquisition timeout (ms). */
  connectionTimeoutMillis: number;
  /** Per-statement server-side timeout (ms). */
  statementTimeoutMs: number;
}

/** Documented defaults for the persistence tunables. */
export const PERSISTENCE_DEFAULTS: PersistenceConfig = {
  blockFlushCount: 10,
  blockFlushIntervalMs: 1_000,
  writeFlushCount: 50,
  writeFlushIntervalMs: 1_000,
  maxRetries: 3,
  baseDelayMs: 500,
  poolMax: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statementTimeoutMs: 30_000,
};

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = parseInt(env[name] ?? '', 10);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, raw));
}

/**
 * Resolve the persistence configuration from the environment, falling back to
 * {@link PERSISTENCE_DEFAULTS} for anything unset or malformed. Every value is
 * clamped into a sane range so a bad override can never wedge the write path.
 */
export function loadPersistenceConfig(
  env: NodeJS.ProcessEnv = process.env,
): PersistenceConfig {
  return {
    blockFlushCount: readInt(env, 'BLOCK_FLUSH_COUNT', PERSISTENCE_DEFAULTS.blockFlushCount, 1, 100_000),
    blockFlushIntervalMs: readInt(
      env,
      'BLOCK_FLUSH_INTERVAL_MS',
      PERSISTENCE_DEFAULTS.blockFlushIntervalMs,
      1,
      600_000,
    ),
    writeFlushCount: readInt(env, 'WRITE_FLUSH_COUNT', PERSISTENCE_DEFAULTS.writeFlushCount, 1, 100_000),
    writeFlushIntervalMs: readInt(
      env,
      'WRITE_FLUSH_INTERVAL_MS',
      PERSISTENCE_DEFAULTS.writeFlushIntervalMs,
      1,
      600_000,
    ),
    maxRetries: readInt(env, 'BLOCK_WRITE_MAX_RETRIES', PERSISTENCE_DEFAULTS.maxRetries, 0, 20),
    baseDelayMs: readInt(env, 'BLOCK_WRITE_BASE_DELAY_MS', PERSISTENCE_DEFAULTS.baseDelayMs, 1, 60_000),
    poolMax: readInt(env, 'PG_POOL_MAX', PERSISTENCE_DEFAULTS.poolMax, 1, 100),
    idleTimeoutMillis: readInt(
      env,
      'PG_IDLE_TIMEOUT_MS',
      PERSISTENCE_DEFAULTS.idleTimeoutMillis,
      0,
      600_000,
    ),
    connectionTimeoutMillis: readInt(
      env,
      'PG_CONNECTION_TIMEOUT_MS',
      PERSISTENCE_DEFAULTS.connectionTimeoutMillis,
      0,
      600_000,
    ),
    statementTimeoutMs: readInt(
      env,
      'PG_STATEMENT_TIMEOUT_MS',
      PERSISTENCE_DEFAULTS.statementTimeoutMs,
      0,
      600_000,
    ),
  };
}

/**
 * Create the real `pg` Pool with explicit sizing + timeouts.
 *
 * `ssl.rejectUnauthorized:false` preserves the existing behaviour (managed
 * Postgres providers terminate TLS with a private CA). `statement_timeout` is
 * applied server-side per connection so a hung query can never pin a client.
 */
export function createPool(connectionString: string, config: PersistenceConfig): Pool {
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    statement_timeout: config.statementTimeoutMs,
  });
}

/**
 * Compute an exponential-backoff delay with jitter, bounded by the retry index.
 * Exported so unit tests can assert the shape without depending on timing.
 */
export function backoffDelay(attempt: number, baseDelayMs: number): number {
  const exp = baseDelayMs * Math.pow(2, Math.max(0, attempt));
  return exp + Math.random() * 200;
}

/** setTimeout as a promise that never holds the event loop open. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** Bounded-retry tuning shared by every write buffer. */
export interface RetryOptions {
  /** Maximum number of retries AFTER the first attempt (0 = single try). */
  maxRetries: number;
  /** Base delay for exponential backoff. */
  baseDelayMs: number;
  /** Invoked before each retry sleep. */
  onRetry?: (error: unknown, attempt: number, nextDelayMs: number) => void;
}

/** Discriminated result of {@link runWithRetry}. */
export type RetryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * Run an async task with bounded exponential backoff + jitter. Never throws:
 * on ultimate failure it returns `{ ok:false, error }` so each caller decides
 * whether to latch a degraded signal (blocks) or swallow it (mempool/status).
 */
export async function runWithRetry<T>(
  task: () => Promise<T>,
  opts: RetryOptions,
): Promise<RetryResult<T>> {
  let attempt = 0;
  for (;;) {
    try {
      return { ok: true, value: await task() };
    } catch (error) {
      if (attempt >= opts.maxRetries) {
        return { ok: false, error };
      }
      const delay = backoffDelay(attempt, opts.baseDelayMs);
      opts.onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
      attempt++;
    }
  }
}
