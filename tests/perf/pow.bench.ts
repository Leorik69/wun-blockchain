/**
 * Phase 8.2 — Proof-of-Work / hash-v2 / difficulty micro-benchmarks.
 *
 * Runs ONLY on demand via `npm run bench` (→ `vitest bench --run`). It is a
 * `.bench.ts` file under `tests/perf/`, which is EXCLUDED from `vitest run` /
 * `npm test` (see vitest.config.ts `test.exclude` + `benchmark.include`), so it
 * never executes in CI.
 *
 * What it measures:
 *  - `findNonce` (the version-2, txRoot-based preimage) across difficulties.
 *    The v2 preimage is fixed-size and independent of transaction count, so the
 *    loop only ever hashes a small constant-length string — the ~41–558x PoW
 *    speedup over the legacy full-JSON (v1) hashing comes from that. To make the
 *    comparison concrete we also hash a representative v1-style preimage that
 *    embeds a full serialized transaction set.
 *  - The pure difficulty-retarget functions (`computeRetargetDifficulty`,
 *    `expectedDifficultyAtIndex`), which run on the main thread inside
 *    `isChainValid` and must stay cheap.
 *
 * These are relative throughput/latency signals for a fixed machine, not
 * pass/fail gates; there are no assertions.
 */
import { bench, describe } from 'vitest';
import crypto from 'node:crypto';
import { findNonce, buildPreimage, type PowJob } from '../../src/mining/pow';
import {
  computeRetargetDifficulty,
  expectedDifficultyAtIndex,
  loadDifficultyConfig,
  DIFFICULTY_DEFAULTS,
  type BlockLike,
} from '../../src/mining/difficulty';

/** A representative miner address / previous hash for synthetic jobs. */
const PREV_HASH = 'a'.repeat(64);
const TX_ROOT = 'b'.repeat(64);

/** Build a version-2 PoW job for the given difficulty. */
function v2Job(difficulty: number, maxNonce = 5_000_000): PowJob {
  return {
    index: 1,
    timestamp: 1_700_000_000_000,
    txRoot: TX_ROOT,
    previousHash: PREV_HASH,
    difficulty,
    maxNonce,
  };
}

/**
 * Build a legacy version-1-style preimage: the full block JSON including a
 * serialized transaction set. This is what the old hashing scheme re-stringified
 * and re-hashed on EVERY nonce attempt, which is why v2 (fixed-size txRoot
 * preimage) is dramatically faster for blocks carrying many transactions.
 */
function v1Preimage(nonce: number, txCount: number): string {
  const transactions = new Array(txCount)
    .fill(0)
    .map((_, i) => ({
      id: `tx_${i}`,
      from: '0x' + 'a'.repeat(40),
      to: '0x' + 'b'.repeat(40),
      amount: i + 1,
      timestamp: 1_700_000_000_000 + i,
      nonce: i,
      type: 'transfer',
    }));
  return JSON.stringify({
    index: 1,
    timestamp: 1_700_000_000_000,
    transactions,
    previousHash: PREV_HASH,
    nonce,
    difficulty: 3,
  });
}

describe('PoW — hash v2 (txRoot preimage) findNonce', () => {
  // Difficulty drives the expected number of SHA-256 attempts (~16^d). These
  // stay in the documented [MIN=2, MAX=6] band so a single run is quick.
  for (const difficulty of [2, 3, 4]) {
    bench(`findNonce difficulty=${difficulty}`, () => {
      findNonce(v2Job(difficulty));
    });
  }

  bench('buildPreimage (v2 string assembly only)', () => {
    buildPreimage(v2Job(3), 12345);
  });
});

describe('PoW — v1 vs v2 hashing cost at a fixed nonce budget', () => {
  // Fixed iteration budget so both sides do the SAME number of hashes; the only
  // variable is preimage construction cost. txCount=64 mirrors a full block.
  const ITERATIONS = 200;
  const TX_COUNT = 64;

  bench(`v1 full-JSON preimage x${ITERATIONS} (${TX_COUNT} tx)`, () => {
    for (let nonce = 0; nonce < ITERATIONS; nonce++) {
      crypto.createHash('sha256').update(v1Preimage(nonce, TX_COUNT)).digest('hex');
    }
  });

  bench(`v2 txRoot preimage x${ITERATIONS}`, () => {
    const job = v2Job(3);
    for (let nonce = 0; nonce < ITERATIONS; nonce++) {
      crypto.createHash('sha256').update(buildPreimage(job, nonce)).digest('hex');
    }
  });
});

describe('Difficulty retargeting (pure functions)', () => {
  const cfg = loadDifficultyConfig({});

  bench('computeRetargetDifficulty (on-target)', () => {
    computeRetargetDifficulty(cfg, 4, 19 * 60_000, 19 * 60_000);
  });

  bench('computeRetargetDifficulty (fast => clamp up)', () => {
    computeRetargetDifficulty(cfg, 4, 1_000, 19 * 60_000);
  });

  // A synthetic 40-block chain so `expectedDifficultyAtIndex` crosses a retarget
  // boundary (default interval = 20) during the sample.
  const chain: BlockLike[] = Array.from({ length: 40 }, (_, i) => ({
    timestamp: 1_700_000_000_000 + i * DIFFICULTY_DEFAULTS.targetBlockIntervalMs,
    difficulty: DIFFICULTY_DEFAULTS.initialDifficulty,
  }));

  bench('expectedDifficultyAtIndex (non-boundary)', () => {
    expectedDifficultyAtIndex(cfg, chain, 21);
  });

  bench('expectedDifficultyAtIndex (boundary @20)', () => {
    expectedDifficultyAtIndex(cfg, chain, 20);
  });
});
