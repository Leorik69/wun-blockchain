/**
 * Batch ECDSA signature verification job (Phase 4.5).
 *
 * Verifying a large batch of transaction signatures is CPU-bound work that
 * would otherwise block the main event loop. This module packages the pure
 * verification routine so it can run inside a worker thread, dispatched by
 * `MiningPool.submitVerify`. It reuses the exact same `verifySignature`
 * implementation as the synchronous path (via `../signature`), guaranteeing
 * identical results whether run on the main thread or in a worker.
 */

import { verifySignature } from '../signature';

/** A single signature-verification unit of work. */
export interface VerifyItem {
  /** Canonical transaction payload that was signed (see getTransactionDataForSigning). */
  message: string;
  /** DER or compact hex signature. */
  signature: string;
  /** Hex-encoded uncompressed public key. */
  publicKey: string;
}

/** A batch of signature-verification units posted to a worker. */
export interface VerifyJob {
  items: VerifyItem[];
}

/**
 * Verify every item in the batch, preserving order.
 *
 * Pure function — no side effects, safe to run inside a worker thread. The
 * returned array is index-aligned with `job.items`.
 */
export function verifyBatch(job: VerifyJob): boolean[] {
  return job.items.map((item) => verifySignature(item.message, item.signature, item.publicKey));
}
