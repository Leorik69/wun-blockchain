import { Worker } from 'worker_threads';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { PowJob, PowResult } from './pow';
import { VerifyItem } from './verify';

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  /**
   * The task currently dispatched to this worker, or `null` when idle. Tracked
   * so a worker crash / non-zero exit / job timeout can REJECT the outstanding
   * promise instead of leaving it pending forever (C7). Previously the
   * resolve/reject lived only inside the dead worker's `on('message')` closure,
   * so a crash wedged `submit()` — and everything awaiting it — permanently.
   */
  task: PoolTask | null;
  /** Per-job watchdog timer that rejects + terminates a stuck worker (C7). */
  timer: NodeJS.Timeout | null;
}

/**
 * A queued unit of work. The pool carries two job kinds on the same workers:
 *   - `pow`: a Proof-of-Work nonce search (mining).
 *   - `verify`: a batch of ECDSA signature verifications.
 * Both are dispatched through the single FIFO queue so worker capacity is
 * shared and self-healing regardless of job type.
 */
type PoolTask =
  | {
      kind: 'pow';
      payload: PowJob;
      resolve: (r: PowResult | null) => void;
      reject: (e: Error) => void;
    }
  | {
      kind: 'verify';
      payload: { items: VerifyItem[] };
      resolve: (r: boolean[]) => void;
      reject: (e: Error) => void;
    };

/** Hard cap on pool size for shared-vCPU environments (e.g. Railway). */
const MAX_POOL_SIZE = 4;

/**
 * Default per-job timeout (ms). A PoW search is bounded by `maxNonce` (10M
 * iterations ≈ a few seconds) and a verify batch is far faster, so 30s is a
 * generous ceiling that legitimate jobs never hit while still recovering a
 * wedged worker quickly. Override with `POW_JOB_TIMEOUT_MS`.
 */
const DEFAULT_JOB_TIMEOUT_MS = 30_000;

/** Resolve the per-job timeout from `POW_JOB_TIMEOUT_MS` (or the default). */
function resolveJobTimeoutMs(): number {
  const fromEnv = parseInt(process.env.POW_JOB_TIMEOUT_MS || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_JOB_TIMEOUT_MS;
}

/**
 * Resolve the miner worker entry point.
 *
 * Production runs the compiled `dist/src/mining/miner.worker.js`; local
 * development via `ts-node` only has the `.ts` source. We prefer the compiled
 * file when present and fall back to the TypeScript source (loaded through the
 * `ts-node/register/transpile-only` hook) otherwise.
 */
function resolveWorkerEntry(): { path: string; isTs: boolean } {
  const jsPath = path.join(__dirname, 'miner.worker.js');
  if (fs.existsSync(jsPath)) {
    return { path: jsPath, isTs: false };
  }
  const tsPath = path.join(__dirname, 'miner.worker.ts');
  return { path: tsPath, isTs: true };
}

/**
 * Thread pool for Proof-of-Work computation.
 *
 * Moves the CPU-intensive hashing loop off the main event loop so the HTTP
 * server stays responsive while a block is being mined. Jobs submitted beyond
 * the available worker count are queued and dispatched as workers free up.
 */
export class MiningPool {
  private workers: PoolWorker[] = [];
  private queue: PoolTask[] = [];
  private terminated = false;
  /** Per-job timeout (ms), resolved once at construction (C7). */
  private readonly jobTimeoutMs: number;

  constructor(size?: number) {
    this.jobTimeoutMs = resolveJobTimeoutMs();
    const poolSize = this.resolvePoolSize(size);
    for (let i = 0; i < poolSize; i++) {
      this.addWorker();
    }
  }

  /**
   * Determine the effective pool size.
   * Precedence: explicit argument → MINING_WORKERS env → (parallelism - 1),
   * always clamped to [1, MAX_POOL_SIZE].
   */
  private resolvePoolSize(size?: number): number {
    const parallelism = os.availableParallelism?.() ?? os.cpus().length ?? 2;
    const fromEnv = parseInt(process.env.MINING_WORKERS || '', 10);
    const requested =
      size && size > 0 ? size : Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : parallelism - 1;
    return Math.max(1, Math.min(requested, MAX_POOL_SIZE));
  }

  private addWorker(): void {
    const entry = resolveWorkerEntry();
    const worker = entry.isTs
      ? new Worker(entry.path, { execArgv: ['-r', 'ts-node/register/transpile-only'] })
      : new Worker(entry.path);

    const poolWorker: PoolWorker = { worker, busy: false, task: null, timer: null };

    worker.on('error', (err) => {
      console.error('[MiningPool] Worker error:', err.message);
      // Reject the in-flight task (if any) and replace the worker so pool
      // capacity self-heals AND callers never hang (C7). Node emits 'exit' right
      // after 'error'; failWorker is idempotent, so the second call is a no-op.
      this.failWorker(poolWorker, err);
    });

    worker.on('exit', (code) => {
      // Any exit (crash, terminate(), or a stuck worker we killed on timeout)
      // means the dispatched task will never receive its result message — reject
      // it and, unless shutting down, respawn so the pool self-heals (C7).
      this.failWorker(poolWorker, new Error(`Mining worker exited with code ${code}`));
    });

    this.workers.push(poolWorker);
  }

  /**
   * Settle (reject) the task dispatched to a worker that crashed, errored, timed
   * out or exited, then drop it from the roster and — unless terminating —
   * respawn a fresh worker and drain the queue.
   *
   * Idempotent: a crashing worker emits BOTH 'error' and 'exit', and a
   * timeout-terminated worker emits 'exit' after its task was already settled.
   * A repeat call finds no task and an already-spliced worker, so it neither
   * double-rejects nor double-respawns.
   */
  private failWorker(poolWorker: PoolWorker, reason: Error): void {
    this.settleWorkerTask(poolWorker, reason);
    const idx = this.workers.indexOf(poolWorker);
    if (idx !== -1) {
      this.workers.splice(idx, 1);
      if (!this.terminated) {
        this.addWorker();
        this.processQueue();
      }
    }
  }

  /**
   * Clear a worker's per-job timer and REJECT its outstanding task (if any),
   * marking it idle. Does NOT touch the worker roster — callers decide whether
   * to respawn. Rejecting here is what guarantees `submit()`/`submitVerify()`
   * always settle even when the worker dies mid-job (C7).
   */
  private settleWorkerTask(poolWorker: PoolWorker, reason: Error): void {
    if (poolWorker.timer) {
      clearTimeout(poolWorker.timer);
      poolWorker.timer = null;
    }
    const task = poolWorker.task;
    poolWorker.task = null;
    poolWorker.busy = false;
    if (task) {
      task.reject(reason);
    }
  }

  /**
   * Clear a worker's per-job timer + task and mark it idle WITHOUT settling the
   * task (the caller resolves it). Used on the normal success path.
   */
  private completeWorkerJob(poolWorker: PoolWorker): void {
    if (poolWorker.timer) {
      clearTimeout(poolWorker.timer);
      poolWorker.timer = null;
    }
    poolWorker.task = null;
    poolWorker.busy = false;
  }

  /**
   * Submit a PoW job. Resolves with the nonce+hash, or `null` when the nonce
   * space was exhausted. Rejects if the pool has been terminated.
   */
  async submit(job: PowJob): Promise<PowResult | null> {
    if (this.terminated) {
      throw new Error('Mining pool is terminated');
    }

    return new Promise<PowResult | null>((resolve, reject) => {
      this.queue.push({ kind: 'pow', payload: job, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Submit a batch of ECDSA signature verifications. Resolves with a
   * boolean array index-aligned with `items`. Rejects if the pool has been
   * terminated. Used to offload large batch verifications off the main thread.
   */
  async submitVerify(items: VerifyItem[]): Promise<boolean[]> {
    if (this.terminated) {
      throw new Error('Mining pool is terminated');
    }

    return new Promise<boolean[]>((resolve, reject) => {
      this.queue.push({ kind: 'verify', payload: { items }, resolve, reject });
      this.processQueue();
    });
  }

  private processQueue(): void {
    while (this.queue.length > 0) {
      const freeWorker = this.workers.find((w) => !w.busy);
      if (!freeWorker) break;

      const task = this.queue.shift();
      if (!task) break;
      // Track the dispatched task on the worker so a crash/exit/timeout can
      // settle its promise (C7). Without this the resolve/reject lived only in
      // the message closure below and a dead worker wedged the caller forever.
      freeWorker.busy = true;
      freeWorker.task = task;

      const messageHandler = (message: unknown): void => {
        // Ignore the one-off lifecycle 'ready' signal; wait for the job result.
        const msg = message as { type?: string; result?: PowResult | null; results?: boolean[] };
        if (msg && typeof msg === 'object' && msg.type === 'ready') {
          return;
        }
        // Success path: clear the timer + task WITHOUT rejecting, then resolve.
        this.completeWorkerJob(freeWorker);
        freeWorker.worker.removeListener('message', messageHandler);
        if (task.kind === 'pow') {
          task.resolve((msg?.result ?? null) as PowResult | null);
        } else {
          task.resolve((msg?.results ?? []) as boolean[]);
        }
        this.processQueue(); // Dispatch the next queued job, if any.
      };

      freeWorker.worker.on('message', messageHandler);

      // Per-job watchdog: if the worker never replies, REJECT the outstanding
      // task and terminate the stuck worker. The resulting 'exit' triggers
      // failWorker → respawn → processQueue, so the pool self-heals (C7).
      const timer = setTimeout(() => {
        freeWorker.timer = null;
        const stuck = freeWorker.task;
        // Leave busy=true so processQueue won't dispatch onto this dying worker;
        // failWorker (on the terminate-induced 'exit') will reset it.
        freeWorker.task = null;
        freeWorker.worker.removeListener('message', messageHandler);
        if (stuck) {
          stuck.reject(new Error(`Mining job timed out after ${this.jobTimeoutMs}ms`));
        }
        void freeWorker.worker.terminate();
      }, this.jobTimeoutMs);
      timer.unref();
      freeWorker.timer = timer;

      freeWorker.worker.postMessage({ type: task.kind, job: task.payload });
    }
  }

  /**
   * Gracefully terminate all workers, rejecting BOTH still-queued jobs AND any
   * tasks currently dispatched to a worker (C7). Rejecting the dispatched tasks
   * is what prevents an in-flight `submit()` — and the `minePendingTransactions`
   * awaiting it — from hanging during shutdown.
   */
  async terminate(): Promise<void> {
    this.terminated = true;
    const reason = new Error('Mining pool terminated');
    for (const task of this.queue) {
      task.reject(reason);
    }
    this.queue = [];
    for (const poolWorker of this.workers) {
      this.settleWorkerTask(poolWorker, reason);
    }
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
    this.workers = [];
  }

  get size(): number {
    return this.workers.length;
  }

  get busyCount(): number {
    return this.workers.filter((w) => w.busy).length;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  get isTerminated(): boolean {
    return this.terminated;
  }
}
