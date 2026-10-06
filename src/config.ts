/**
 * Centralized, typed configuration for the WUNCoin blockchain API server.
 *
 * Every environment variable read by the HTTP/WS presentation layer is resolved
 * here exactly once, so the rest of the codebase depends on a typed
 * {@link AppConfig} object rather than reaching into `process.env`. This keeps
 * the wire behaviour identical to the previous monolithic `server.ts` while
 * making the configuration surface explicit and unit-testable.
 *
 * NOTE: Domain-level env reads that live inside the blockchain kernel
 * (REQUIRE_TREASURY_SIGNATURE, difficulty/retarget params, ECDSA_BATCH_THRESHOLD,
 * MAX_PENDING_TX, BRIDGE_*) are intentionally NOT moved here — they are consumed
 * by `blockchain.ts` / `mining/difficulty.ts` at construction time and belong to
 * the core domain layer, not the server presentation layer.
 */

/** Built-in CORS/WS origin allow-list used when `CORS_ORIGINS` is unset. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:8080',
  'http://localhost:8081',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8081',
  'http://127.0.0.1:5173',
];

/** In-memory rate-limit parameters for sensitive endpoints. */
export interface RateLimitConfig {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Maximum requests per window per IP before returning 429. */
  max: number;
}

/**
 * Cross-replica coordination (Redis) configuration — Phase 7.
 *
 * The whole layer is DORMANT unless `REDIS_URL` is set: `url` stays `undefined`
 * and the bootstrap selects the in-process paths (MemoryStateStore, in-memory
 * rate limiter, in-process mining lock, direct WS broadcast). No connection is
 * attempted and the `ioredis` client is never even loaded in memory mode.
 */
export interface RedisConfig {
  /** Redis connection string; `undefined` → memory mode (single-process). */
  url: string | undefined;
  /** Namespace prefix for every key this service owns (multi-tenant safety). */
  keyPrefix: string;
  /** Pub/Sub channel used for WebSocket fan-out across replicas. */
  channel: string;
  /** Key of the distributed single-miner lock. */
  miningLockKey: string;
  /** TTL of the mining lock; auto-renewed while a replica holds it. */
  miningLockTtlMs: number;
  /** Renewal cadence for the mining lock (must be < TTL). */
  miningLockRenewMs: number;
  /** Redis command/connect timeout in milliseconds. */
  commandTimeoutMs: number;
}

/** Fully-resolved, immutable server configuration. */
export interface AppConfig {
  /** Raw NODE_ENV value, defaulted to 'development' when unset. */
  nodeEnv: string;
  /** Convenience flag: NODE_ENV === 'test'. */
  isTest: boolean;
  /** Convenience flag: NODE_ENV === 'production'. */
  isProduction: boolean;
  /** HTTP/WS listen port. */
  port: number;
  /** Configured API key ('' when unset → gate is permissive outside prod). */
  apiKey: string;
  /** Effective origin allow-list (CORS_ORIGINS or built-in defaults). */
  allowedOrigins: string[];
  /** Feature flag: require API-key auth on the WebSocket upgrade path. */
  requireWsAuth: boolean;
  /** Feature flag: allow POST /api/transactions/sign in production. */
  allowSignEndpoint: boolean;
  /** Postgres connection string (undefined → in-memory chain only). */
  databaseUrl: string | undefined;
  /**
   * Express `trust proxy` setting (M2). DEFAULTS TO `false`: X-Forwarded-For
   * is spoofable, so proxy headers are only trusted when a deployment behind
   * a known reverse proxy opts in explicitly via `TRUST_PROXY`
   * ('true' | 'false' | hop count | loopback/subnet string, e.g. '1' or 'loopback').
   */
  trustProxy: boolean | string | number;
  /** express.json body size limit. */
  jsonBodyLimit: string;
  /** Rate-limit parameters. */
  rateLimit: RateLimitConfig;
  /** Cross-replica coordination (Redis) config; dormant when `url` is undefined. */
  redis: RedisConfig;
  /** Resolved deploy git SHA (undefined when no provider env var is set). */
  gitSha: string | undefined;
}

/**
 * Resolve the server configuration from an environment object.
 *
 * @param env - Environment source; defaults to `process.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV || 'development';

  const configuredOrigins = (env.CORS_ORIGINS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const allowedOrigins =
    configuredOrigins.length > 0 ? configuredOrigins : [...DEFAULT_ALLOWED_ORIGINS];

  const rawPort = parseInt(env.PORT || '3001', 10);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3001;

  const gitSha =
    env.RAILWAY_GIT_COMMIT_SHA || env.GITHUB_SHA || env.VERCEL_GIT_COMMIT_SHA || undefined;

  // Redis coordination layer — entirely optional. An empty/blank REDIS_URL is
  // treated as unset so memory mode never opens a socket.
  const redisUrl = (env.REDIS_URL || '').trim() || undefined;
  const keyPrefix = (env.REDIS_KEY_PREFIX || 'wun:chain').trim() || 'wun:chain';
  const miningLockTtlMs = readPositiveInt(env.REDIS_MINING_LOCK_TTL_MS, 30_000);

  return {
    nodeEnv,
    isTest: nodeEnv === 'test',
    isProduction: nodeEnv === 'production',
    port,
    apiKey: env.BLOCKCHAIN_API_KEY || '',
    allowedOrigins,
    requireWsAuth: env.REQUIRE_WS_AUTH === 'true',
    allowSignEndpoint: (env.ALLOW_SIGN_ENDPOINT || '').toLowerCase() === 'true',
    databaseUrl: env.DATABASE_URL,
    trustProxy: readTrustProxy(env.TRUST_PROXY),
    jsonBodyLimit: '100kb',
    rateLimit: { windowMs: 60_000, max: 120 },
    redis: {
      url: redisUrl,
      keyPrefix,
      channel: `${keyPrefix}:events`,
      miningLockKey: `${keyPrefix}:mining-lock`,
      miningLockTtlMs,
      // Renew at ~1/3 of the TTL so a missed renewal never expires a live lock.
      miningLockRenewMs: Math.max(1_000, Math.floor(miningLockTtlMs / 3)),
      commandTimeoutMs: readPositiveInt(env.REDIS_COMMAND_TIMEOUT_MS, 2_000),
    },
    gitSha,
  };
}

/** Parse a positive integer env override, falling back when unset/invalid. */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse the `TRUST_PROXY` env override (M2). Unset/blank/'false' → `false`
 * (never trust client-supplied proxy headers); 'true' → `true`; a numeric
 * value → hop count; any other string (e.g. 'loopback', '10.0.0.0/8') is
 * passed through to Express verbatim.
 */
function readTrustProxy(raw: string | undefined): boolean | string | number {
  const value = (raw ?? '').trim();
  if (!value || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}
