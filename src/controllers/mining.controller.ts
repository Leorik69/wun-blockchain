/**
 * Mining controllers: synchronous mine, async job submission and job polling.
 *
 * Extracted verbatim from `server.ts`. BOTH mining paths share one guarded
 * `runMine` closure that mines the pending set, confirms/fails each transaction
 * from the apply results (B1) and broadcasts `block_mined`:
 *  - The synchronous `mine` handler AWAITS and returns the mined block in the
 *    same response body as before, routed through `MineJobManager.mineSync` so
 *    it shares the in-process single-flight lock AND the distributed lock (when
 *    Redis is configured) with the async path. Concurrent `/mine` calls coalesce
 *    (never double-mine); when the distributed lock cannot be acquired the
 *    handler FAILS CLOSED and surfaces the refusal (500) instead of mining.
 *  - The async job path coalesces onto the in-flight job via
 *    `MineJobManager.startMining` and returns 202 with a jobId; it responds 503
 *    when the worker pool is unavailable (e.g. under the test harness).
 *
 * Under the test harness `mineJobManager` is null (no worker pool is spawned),
 * so the synchronous handler mines directly — byte-identical to the prior
 * behaviour, since no lock is configured in that mode anyway.
 */
import type { Request, Response, RequestHandler } from 'express';
import type { AppContext } from '../context';
import { requireBlockchain } from '../context';
import type { Block } from '../blockchain';

/** Create the mining controller handlers. */
export function createMiningController(ctx: AppContext): {
  mine: (req: Request, res: Response) => Promise<void>;
  createJob: RequestHandler;
  getJob: RequestHandler;
} {
  /**
   * Build the guarded mining operation for `minerAddress`: mine the pending set,
   * apply per-transaction status tracking (B1) and broadcast `block_mined`.
   * Returns the mined block, or `null` when there was nothing to mine / mining
   * failed validation. Shared by the synchronous and asynchronous handlers so
   * both run the identical body under the identical lock.
   */
  const buildRunMine = (minerAddress: string): (() => Promise<Block | null>) => async () => {
    const result = await requireBlockchain(ctx).minePendingTransactions(minerAddress);
    if (!result) {
      return null;
    }
    const block = result.block;
    // B1: per-transaction confirm/fail status based on actual apply results.
    for (const txResult of result.txResults) {
      if (txResult.success) {
        ctx.statusTracker.confirmTransaction(txResult.txId, block.index, block.hash);
      } else {
        ctx.statusTracker.failTransaction(
          txResult.txId,
          txResult.error || 'Transaction failed during block application'
        );
      }
    }
    // Notify subscribed WebSocket clients.
    ctx.broadcaster.broadcast({ type: 'block_mined', block }, 'block_mined');
    return block;
  };

  const mine = async (req: Request, res: Response): Promise<void> => {
    try {
      const { minerAddress } = req.body;

      if (!minerAddress) {
        res.status(400).json({ success: false, error: 'Miner address is required' });
        return;
      }

      const runMine = buildRunMine(minerAddress);
      const jobManager = ctx.mineJobManager;

      // Route through the SAME single-flight + distributed-lock guard as the
      // async path so two replicas (or two concurrent sync calls) never mine
      // the same height. `mineSync` awaits and returns the block, preserving
      // the synchronous wire contract; it FAILS CLOSED (rejects with
      // MiningLockRefusedError → 500 below) when the lock cannot be acquired.
      // When no job manager exists (test harness / no worker pool) there is no
      // lock configured, so mine directly — byte-identical to prior behaviour.
      const minedBlock = jobManager
        ? (await jobManager.mineSync(minerAddress, runMine)).block
        : await runMine();

      if (!minedBlock) {
        res.status(400).json({
          success: false,
          error: 'No transactions to mine or validation failed',
        });
        return;
      }

      res.json({
        success: true,
        block: minedBlock,
        message: `Block #${minedBlock.index} mined successfully`,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const createJob: RequestHandler = (req, res) => {
    try {
      const { minerAddress } = req.body;

      if (!minerAddress) {
        return res.status(400).json({ success: false, error: 'Miner address is required' });
      }

      const jobManager = ctx.mineJobManager;
      if (!jobManager) {
        return res.status(503).json({
          success: false,
          error: 'Async mining is not available',
        });
      }

      const { jobId, coalesced } = jobManager.startMining(
        minerAddress,
        buildRunMine(minerAddress)
      );

      res.status(202).json({
        success: true,
        jobId,
        status: 'mining',
        coalesced,
        message: coalesced ? 'Coalesced onto in-flight mining job' : 'Mining job started',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const getJob: RequestHandler = (req, res) => {
    try {
      const job = ctx.mineJobManager?.getJob(req.params.jobId ?? '');
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }
      res.json({ success: true, ...job });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  return { mine, createJob, getJob };
}
