/**
 * Proof-of-Work difficulty retargeting (Phase 4.4).
 *
 * The retarget algorithm is deterministic and based purely on block
 * timestamps, so every node that sees the same chain agrees on the difficulty
 * a given block must carry. This module is intentionally free of I/O and side
 * effects so it can run on the main thread (kernel) and inside `isChainValid`
 * without touching the worker pool.
 *
 * Algorithm (Bitcoin-inspired, bounded):
 *   - Every `retargetInterval` blocks (at indices that are a non-zero multiple
 *     of the interval) the difficulty is recomputed. Between boundaries a block
 *     simply inherits the previous block's difficulty.
 *   - At a boundary we measure the actual elapsed time across the previous
 *     `retargetInterval` blocks (from block `index - interval` to block
 *     `index - 1`, i.e. `interval - 1` gaps) and compare it to the expected
 *     elapsed time (`(interval - 1) * targetBlockIntervalMs`).
 *   - The adjustment ratio `expected / actual` is clamped to
 *     `[maxAdjustFactorDown, maxAdjustFactorUp]` (default `[0.25, 4]`) so a
 *     single interval can never move the difficulty by more than 4x in either
 *     direction, then applied to the previous difficulty, rounded to the
 *     nearest integer and finally clamped to `[minDifficulty, maxDifficulty]`.
 */

/** Structural view of a block — only the fields the retarget needs. */
export interface BlockLike {
  timestamp: number;
  difficulty: number;
}

/** Fully-resolved difficulty retargeting parameters. */
export interface DifficultyConfig {
  /** Number of blocks between retarget boundaries. */
  retargetInterval: number;
  /** Desired wall-clock time between two consecutive blocks, in milliseconds. */
  targetBlockIntervalMs: number;
  /** Lower clamp for the difficulty. */
  minDifficulty: number;
  /** Upper clamp for the difficulty. */
  maxDifficulty: number;
  /** Difficulty used by genesis and by every block before the first boundary. */
  initialDifficulty: number;
  /** Maximum upward adjustment factor applied at a single boundary. */
  maxAdjustFactorUp: number;
  /** Maximum downward adjustment factor applied at a single boundary. */
  maxAdjustFactorDown: number;
}

/**
 * Documented defaults.
 *
 * `targetBlockIntervalMs` defaults to 60_000 (one minute): a sensible target
 * for WUNCoin's small, low-throughput chain that keeps retargeting observable
 * without demanding Bitcoin's 10-minute cadence. It is fully overridable via
 * the `TARGET_BLOCK_INTERVAL_MS` environment variable.
 */
export const DIFFICULTY_DEFAULTS: DifficultyConfig = {
  retargetInterval: 20,
  targetBlockIntervalMs: 60_000,
  minDifficulty: 2,
  maxDifficulty: 6,
  initialDifficulty: 4,
  maxAdjustFactorUp: 4,
  maxAdjustFactorDown: 0.25,
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
 * Build the difficulty configuration from the environment, falling back to
 * `DIFFICULTY_DEFAULTS` for anything unset or malformed. `initialDifficulty`
 * is clamped into `[minDifficulty, maxDifficulty]` so an out-of-range override
 * can never produce an un-mineable genesis block.
 */
export function loadDifficultyConfig(env: NodeJS.ProcessEnv = process.env): DifficultyConfig {
  const minDifficulty = readInt(env, 'MIN_DIFFICULTY', DIFFICULTY_DEFAULTS.minDifficulty, 1, 32);
  const maxDifficulty = readInt(
    env,
    'MAX_DIFFICULTY',
    DIFFICULTY_DEFAULTS.maxDifficulty,
    minDifficulty,
    32,
  );
  const retargetInterval = readInt(
    env,
    'RETARGET_INTERVAL_BLOCKS',
    DIFFICULTY_DEFAULTS.retargetInterval,
    1,
    1_000_000,
  );
  const targetBlockIntervalMs = readInt(
    env,
    'TARGET_BLOCK_INTERVAL_MS',
    DIFFICULTY_DEFAULTS.targetBlockIntervalMs,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const initialDifficulty = readInt(
    env,
    'INITIAL_DIFFICULTY',
    DIFFICULTY_DEFAULTS.initialDifficulty,
    minDifficulty,
    maxDifficulty,
  );

  return {
    retargetInterval,
    targetBlockIntervalMs,
    minDifficulty,
    maxDifficulty,
    initialDifficulty,
    maxAdjustFactorUp: DIFFICULTY_DEFAULTS.maxAdjustFactorUp,
    maxAdjustFactorDown: DIFFICULTY_DEFAULTS.maxAdjustFactorDown,
  };
}

/**
 * Compute the retargeted difficulty from a single interval measurement.
 *
 * Pure function — exported for direct unit testing of the increase / decrease
 * / clamp behaviour without having to mine a chain.
 */
export function computeRetargetDifficulty(
  cfg: DifficultyConfig,
  prevDifficulty: number,
  actualElapsedMs: number,
  expectedElapsedMs: number,
): number {
  // Guard against non-positive elapsed times (identical or out-of-order block
  // timestamps). A zero/negative actual time means "as fast as possible", which
  // saturates the ratio at the upward clamp below.
  const actual = actualElapsedMs > 0 ? actualElapsedMs : 1;
  const expected = expectedElapsedMs > 0 ? expectedElapsedMs : 1;

  let ratio = expected / actual;
  ratio = Math.min(cfg.maxAdjustFactorUp, Math.max(cfg.maxAdjustFactorDown, ratio));

  const next = Math.round(prevDifficulty * ratio);
  return Math.min(cfg.maxDifficulty, Math.max(cfg.minDifficulty, next));
}

/**
 * The difficulty that the block at `index` MUST carry, derived deterministically
 * from the preceding blocks in `chain` (which must contain at least indices
 * `0 .. index - 1`).
 *
 *   - index 0 (genesis): the configured initial difficulty.
 *   - index < interval, or any non-boundary index: inherits the previous
 *     block's difficulty.
 *   - index === k * interval (k >= 1): retarget from the timestamps of the
 *     previous `interval` blocks.
 */
export function expectedDifficultyAtIndex(
  cfg: DifficultyConfig,
  chain: BlockLike[],
  index: number,
): number {
  if (index <= 0) {
    return cfg.initialDifficulty;
  }

  const interval = cfg.retargetInterval;

  // Non-boundary block: inherit the previous block's (already validated) difficulty.
  if (index % interval !== 0) {
    const prev = chain[index - 1];
    return prev ? prev.difficulty : cfg.initialDifficulty;
  }

  // Boundary block: measure the previous `interval` blocks.
  const startBlock = chain[index - interval];
  const endBlock = chain[index - 1];
  if (!startBlock || !endBlock) {
    return cfg.initialDifficulty;
  }

  const gaps = interval - 1;
  const actualElapsed = endBlock.timestamp - startBlock.timestamp;
  const expectedElapsed = gaps * cfg.targetBlockIntervalMs;

  return computeRetargetDifficulty(cfg, endBlock.difficulty, actualElapsed, expectedElapsed);
}
