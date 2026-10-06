/**
 * Logging controllers: stats, filtered listing, JSON export and clear.
 *
 * Extracted verbatim from `server.ts`. All four read the blockchain kernel's
 * logger; the export keeps its attachment Content-Disposition header and the
 * listing keeps its level/limit filtering behaviour.
 */
import type { RequestHandler } from 'express';
import type { AppContext } from '../context';
import { requireBlockchain } from '../context';

/** Create the logs controller handlers. */
export function createLogsController(ctx: AppContext): {
  stats: RequestHandler;
  list: RequestHandler;
  exportLogs: RequestHandler;
  clear: RequestHandler;
} {
  const stats: RequestHandler = (_req, res) => {
    try {
      const logger = requireBlockchain(ctx).getLogger();
      res.json({ success: true, stats: logger.getStats() });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const list: RequestHandler = (req, res) => {
    try {
      const { level, limit } = req.query;
      const logger = requireBlockchain(ctx).getLogger();

      let logs = logger.getLogs();

      // Filter by level when provided.
      if (level) {
        logs = logs.filter((log) => log.level === (level as string).toUpperCase());
      }

      // Limit the count when provided.
      if (limit) {
        const limitNum = parseInt(limit as string);
        logs = logs.slice(-limitNum);
      }

      res.json({ success: true, count: logs.length, logs });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const exportLogs: RequestHandler = (_req, res) => {
    try {
      const logger = requireBlockchain(ctx).getLogger();
      const logsJson = logger.export();

      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="blockchain-logs-${Date.now()}.json"`
      );
      res.send(logsJson);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const clear: RequestHandler = (_req, res) => {
    try {
      const logger = requireBlockchain(ctx).getLogger();
      logger.clear();
      res.json({ success: true, message: 'Logs cleared' });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  return { stats, list, exportLogs, clear };
}
