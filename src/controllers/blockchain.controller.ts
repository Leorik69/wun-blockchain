/**
 * Blockchain read/validation controllers.
 *
 * Extracted verbatim from `server.ts`: info, paginated blocks, full chain,
 * single block by index (400 on non-integer/negative, 404 on out-of-range) and
 * chain validation. Response envelopes and Cache-Control headers are unchanged.
 *
 * Phase 6.5: `blockByIndex` and `blocks` are now async so they can transparently
 * lazy-load cold (evicted) blocks from Postgres when persistence is active. In
 * in-memory mode the async path resolves immediately from the hot array.
 */
import type { RequestHandler } from 'express';
import type { AppContext } from '../context';
import { requireBlockchain } from '../context';
import { setReadCacheHeaders } from './shared';

/** Create the blockchain controller handlers. */
export function createBlockchainController(ctx: AppContext): {
  info: RequestHandler;
  blocks: RequestHandler;
  chain: RequestHandler;
  blockByIndex: RequestHandler;
  validate: RequestHandler;
} {
  const info: RequestHandler = (_req, res) => {
    try {
      setReadCacheHeaders(res);
      const data = requireBlockchain(ctx).getBlockchainInfo();
      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const blocks: RequestHandler = async (req, res) => {
    try {
      setReadCacheHeaders(res, 5);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const beforeParam = req.query.before as string | undefined;
      const bc = requireBlockchain(ctx);
      const chainLength = bc.chainHeight;

      let endIndex: number;
      if (beforeParam !== undefined) {
        endIndex = parseInt(beforeParam);
        if (isNaN(endIndex) || endIndex < 0 || endIndex >= chainLength) {
          return res
            .status(400)
            .json({
              success: false,
              error: 'Invalid "before" parameter. Must be a valid block index.',
            });
        }
      } else {
        endIndex = chainLength; // exclusive — return from the tip
      }

      const startIndex = Math.max(0, endIndex - limit);
      // Phase 6.5: use async range fetch so cold blocks are lazily reloaded.
      const page = (await bc.getBlocksRange(startIndex, endIndex)).reverse(); // newest first

      res.json({
        success: true,
        data: page,
        pagination: {
          limit,
          count: page.length,
          hasMore: startIndex > 0,
          nextBefore: startIndex > 0 ? startIndex : null,
          totalBlocks: chainLength,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const chain: RequestHandler = (_req, res) => {
    try {
      setReadCacheHeaders(res);
      const data = requireBlockchain(ctx).getChain();
      res.json({ success: true, data, length: data.length });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const blockByIndex: RequestHandler = async (req, res) => {
    try {
      setReadCacheHeaders(res);
      const raw = req.params.blockIndex ?? '';
      const index = Number(raw);

      // B3: reject non-integer or negative values with 400.
      if (!Number.isInteger(index) || index < 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid block index: must be a non-negative integer',
        });
      }

      const bc = requireBlockchain(ctx);

      if (index >= bc.chainHeight) {
        return res.status(404).json({ success: false, error: 'Block not found' });
      }

      // Phase 6.5: async access transparently lazy-loads cold blocks.
      const block = await bc.getBlockAtAsync(index);
      if (!block) {
        return res.status(404).json({ success: false, error: 'Block not found' });
      }

      res.json({ success: true, data: block });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const validate: RequestHandler = (_req, res) => {
    try {
      const isValid = requireBlockchain(ctx).isChainValid();
      res.json({
        success: true,
        isValid,
        message: isValid ? 'Blockchain is valid' : 'Blockchain is corrupted',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  return { info, blocks, chain, blockByIndex, validate };
}
