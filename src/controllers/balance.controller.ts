/**
 * Balance and address-history controllers.
 *
 * Extracted verbatim from `server.ts`. Balance returns the address, its balance
 * and the contract-state nonce; history is paginated (limit default 50, max 200;
 * offset default 0) with the full-history total in the pagination envelope.
 */
import type { Request, Response, RequestHandler } from 'express';
import type { AppContext } from '../context';
import { requireBlockchain } from '../context';
import { setReadCacheHeaders } from './shared';

/** Create the balance controller handlers. */
export function createBalanceController(ctx: AppContext): {
  balance: RequestHandler;
  history: (req: Request, res: Response) => Promise<void>;
} {
  const balance: RequestHandler = (req, res) => {
    try {
      setReadCacheHeaders(res);
      const address = req.params.address ?? '';
      const blockchain = requireBlockchain(ctx);
      const bal = blockchain.getBalance(address);
      const contractState = blockchain.getContractState();
      const nonce = contractState[address]?.nonce ?? 0;

      res.json({ success: true, address, balance: bal, nonce });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const history = async (req: Request, res: Response): Promise<void> => {
    try {
      const address = req.params.address ?? '';
      const blockchain = requireBlockchain(ctx);

      // Pagination: `limit` (default 50, max 200), `offset` (default 0). `count`
      // reflects the returned page size; `pagination.total` is the full history.
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      // When persistence is active this is served by an indexed query (Phase
      // 6.3); otherwise it slices the in-memory scan. Either way the returned
      // shape (transactions/count/pagination.total) is identical.
      const { transactions, total } = await blockchain.getAddressHistoryPaged(
        address,
        limit,
        offset,
      );

      res.json({
        success: true,
        address,
        transactions,
        count: transactions.length,
        pagination: {
          limit,
          offset,
          total,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  return { balance, history };
}
