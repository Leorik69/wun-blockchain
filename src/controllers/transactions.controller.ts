/**
 * Transaction controllers: sign, submit, pending count and status queries.
 *
 * Extracted verbatim from `server.ts`. Payload validation/normalization lives in
 * `validation/transactionSchema.ts`; the submit path keeps its status-tracker
 * side effects and the `transaction_added` WebSocket broadcast. The "pool full"
 * condition still maps to HTTP 503.
 */
import type { RequestHandler } from 'express';
import type { AppContext } from '../context';
import { requireBlockchain } from '../context';
import { signTransaction, getTransactionDataForSigning } from '../signature';
import { validateAndNormalizeTransaction } from '../validation/transactionSchema';

/** Create the transactions controller handlers. */
export function createTransactionsController(ctx: AppContext): {
  sign: RequestHandler;
  create: RequestHandler;
  pending: RequestHandler;
  status: RequestHandler;
  statusAll: RequestHandler;
} {
  const sign: RequestHandler = (req, res) => {
    try {
      // Hardening: disabled in production unless explicitly allowed.
      if (ctx.config.isProduction && !ctx.config.allowSignEndpoint) {
        return res.status(403).json({
          success: false,
          error: 'Signing endpoint is disabled in production',
        });
      }

      const { transaction, privateKey } = req.body;

      if (!transaction || !privateKey) {
        return res.status(400).json({
          success: false,
          error: 'Missing transaction or privateKey',
        });
      }

      const txData = getTransactionDataForSigning(transaction);
      const signature = signTransaction(txData, privateKey);

      res.json({
        success: true,
        signature,
        message: 'Transaction signed successfully',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const create: RequestHandler = (req, res) => {
    try {
      const validation = validateAndNormalizeTransaction(req.body);
      if (!validation.ok) {
        return res.status(validation.status).json({
          success: false,
          error: validation.error,
        });
      }
      const transaction = validation.transaction;

      const result = requireBlockchain(ctx).addTransaction(transaction);

      if (!result.success) {
        // Register the failed status.
        ctx.statusTracker.addPending(transaction.id);
        ctx.statusTracker.failTransaction(transaction.id, result.error || 'Unknown error');

        return res.status(400).json({ success: false, error: result.error });
      }

      // Register as pending.
      ctx.statusTracker.addPending(transaction.id);

      // Notify subscribed WebSocket clients.
      ctx.broadcaster.broadcast(
        { type: 'transaction_added', transaction, status: 'pending' },
        'transaction_added'
      );

      res.json({
        success: true,
        transaction,
        status: 'pending',
        message: 'Transaction added to pending pool',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Pending pool is bounded (see addTransaction): map "pool full" to 503 so
      // clients back off and retry instead of treating it as a server fault.
      if (message.includes('Transaction pool is full')) {
        return res.status(503).json({ success: false, error: message });
      }
      res.status(500).json({ success: false, error: message });
    }
  };

  const pending: RequestHandler = (_req, res) => {
    try {
      // O(1) pending count: avoid getBlockchainInfo() (full chain validation).
      const pendingCount = requireBlockchain(ctx).getPendingCount();
      res.json({
        success: true,
        pendingCount,
        message: `${pendingCount} transactions waiting to be mined`,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const status: RequestHandler = (req, res) => {
    try {
      const txId = req.params.txId ?? '';
      const found = ctx.statusTracker.getStatus(txId);

      if (!found) {
        return res.status(404).json({ success: false, error: 'Transaction not found' });
      }

      res.json({
        success: true,
        transactionId: txId,
        status: found.status,
        blockIndex: found.blockIndex,
        blockHash: found.blockHash,
        error: found.error,
        timestamp: found.timestamp,
        updatedAt: found.updatedAt,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const statusAll: RequestHandler = (req, res) => {
    try {
      const allStatuses = ctx.statusTracker.getAllStatuses();

      // Pagination: `limit` (default 50, max 200), `offset` (default 0). The
      // summary counters always describe the FULL set; `statuses` is the page.
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const pagedStatuses = allStatuses.slice(offset, offset + limit);

      res.json({
        success: true,
        total: allStatuses.length,
        pending: ctx.statusTracker.getPendingTransactions().length,
        confirmed: ctx.statusTracker.getConfirmedTransactions().length,
        failed: ctx.statusTracker.getFailedTransactions().length,
        statuses: pagedStatuses,
        pagination: {
          limit,
          offset,
          total: allStatuses.length,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  return { sign, create, pending, status, statusAll };
}
