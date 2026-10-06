import crypto from 'node:crypto';

/**
 * A single Proof-of-Work unit of work.
 *
 * The preimage is fixed-size and independent of the transaction count: the
 * (already computed) `txRoot` summarises the block payload, so the mining loop
 * only ever hashes a small, constant-length string. This mirrors the version 2
 * hashing scheme used by `WUNCoinBlockchain.calculateHashForMining`.
 */
export interface PowJob {
  index: number;
  timestamp: number;
  txRoot: string;
  previousHash: string;
  difficulty: number;
  maxNonce: number;
}

/** Outcome of a successful PoW search. */
export interface PowResult {
  nonce: number;
  hash: string;
}

/**
 * Build the exact preimage hashed during mining.
 * Exported so the kernel and the worker always agree on the byte layout.
 */
export function buildPreimage(job: PowJob, nonce: number): string {
  return `2|${job.index}|${job.timestamp}|${job.txRoot}|${job.previousHash}|${nonce}|${job.difficulty}`;
}

/**
 * Find a nonce that produces a hash with the required leading zeros.
 *
 * Pure function — no side effects, no I/O, safe to run inside a worker thread.
 * Returns `null` when `maxNonce` iterations are exhausted without a solution
 * (a safety guard against an effectively unreachable difficulty target).
 */
export function findNonce(job: PowJob): PowResult | null {
  const target = '0'.repeat(job.difficulty);

  for (let nonce = 0; nonce < job.maxNonce; nonce++) {
    const preimage = buildPreimage(job, nonce);
    const hash = crypto.createHash('sha256').update(preimage).digest('hex');
    if (hash.startsWith(target)) {
      return { nonce, hash };
    }
  }

  return null; // MAX_NONCE exceeded
}
