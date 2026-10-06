import { parentPort } from 'worker_threads';
import { findNonce, PowJob, PowResult } from './pow';
import { verifyBatch, VerifyJob } from './verify';

/**
 * Worker thread entry point for CPU-bound blockchain jobs.
 *
 * The parent (MiningPool) posts an envelope `{ type, job }`:
 *   - `{ type: 'pow', job: PowJob }`     → runs the pure `findNonce` search and
 *     replies `{ type: 'powResult', result: PowResult | null }`.
 *   - `{ type: 'verify', job: VerifyJob }` → runs batch ECDSA verification and
 *     replies `{ type: 'verifyResult', results: boolean[] }`.
 *
 * A one-off `{ type: 'ready' }` signal is emitted at startup so the pool can
 * distinguish lifecycle messages from job results. Running verification here
 * reuses `../signature`, whose `@noble/secp256k1` hashing setup executes on
 * import inside this worker context.
 */

// Signal readiness to the parent pool.
parentPort?.postMessage({ type: 'ready' });

interface WorkerMessage {
  type: string;
  job: unknown;
}

// Receive a job from the parent, compute it off the event loop, send the result back.
parentPort?.on('message', (msg: WorkerMessage) => {
  if (!msg || typeof msg !== 'object') {
    return;
  }

  if (msg.type === 'pow') {
    const result: PowResult | null = findNonce(msg.job as PowJob);
    parentPort?.postMessage({ type: 'powResult', result });
    return;
  }

  if (msg.type === 'verify') {
    const results: boolean[] = verifyBatch(msg.job as VerifyJob);
    parentPort?.postMessage({ type: 'verifyResult', results });
  }
});
