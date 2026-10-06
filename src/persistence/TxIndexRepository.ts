/**
 * TxIndexRepository — transaction index for cold reads (Phase 6.3).
 *
 * Populates `chain_tx_index` (one row per transaction, keyed by tx_id, with
 * btree indexes on from_addr / to_addr / block_index) as blocks are persisted,
 * and backfills it for blocks loaded on boot so chains persisted before this
 * feature become queryable. This replaces the O(blocks × tx) in-memory scan for
 * `/api/address/:address/history` with an indexed, paginated query WHEN
 * persistence is active.
 *
 * The full transaction is stored in the `tx` JSONB column so the indexed query
 * returns exactly the same transaction objects (and therefore the same wire
 * shape) as the in-memory scan.
 */
import type { Block, Transaction } from '../blockchain';
import { runWithRetry, type PersistenceConfig, type QueryExecutor } from './db';

export interface TxIndexHooks {
  onFail?: (error: unknown) => void;
}

/** A flattened, queryable projection of a single transaction. */
interface TxIndexRow {
  txId: string;
  blockIndex: number;
  from: string;
  to: string;
  amount: string;
  type: string;
  ts: number;
  tx: Transaction;
}

export class TxIndexRepository {
  private buffer: TxIndexRow[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: QueryExecutor,
    private readonly config: PersistenceConfig,
    private readonly hooks: TxIndexHooks = {},
  ) {}

  public get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Index every transaction of a block (buffered, fire-and-forget). */
  public indexBlock(block: Block): void {
    for (const tx of block.transactions) {
      this.buffer.push(toRow(block.index, tx));
    }
    if (this.buffer.length >= this.config.writeFlushCount) {
      void this.flush();
    } else if (this.buffer.length > 0) {
      this.armTimer();
    }
  }

  /**
   * Backfill the index for already-persisted blocks (idempotent — conflicts on
   * tx_id are ignored). Awaited on boot so the first history query is served
   * from a complete index.
   */
  public async backfill(blocks: Block[]): Promise<void> {
    for (const block of blocks) {
      for (const tx of block.transactions) {
        this.buffer.push(toRow(block.index, tx));
      }
    }
    await this.flush();
  }

  /**
   * Indexed, paginated address history. Returns the page of full transactions
   * plus the total match count, mirroring the in-memory scan's response shape.
   */
  public async getAddressHistory(
    address: string,
    limit: number,
    offset: number,
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const [pageRes, countRes] = await Promise.all([
      this.db.query(
        `SELECT tx FROM chain_tx_index
         WHERE from_addr = $1 OR to_addr = $1
         ORDER BY block_index ASC
         LIMIT $2 OFFSET $3`,
        [address, limit, offset],
      ),
      this.db.query(
        `SELECT COUNT(*)::int AS total FROM chain_tx_index
         WHERE from_addr = $1 OR to_addr = $1`,
        [address],
      ),
    ]);
    const transactions = pageRes.rows.map((r) => r.tx as Transaction);
    const totalRow = countRes.rows[0];
    const total = totalRow ? Number(totalRow.total) : 0;
    return { transactions, total };
  }

  public async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      this.clearTimer();
      return;
    }
    const batch = this.buffer;
    this.buffer = [];
    this.clearTimer();
    const result = await runWithRetry(() => this.insertBatch(batch), {
      maxRetries: this.config.maxRetries,
      baseDelayMs: this.config.baseDelayMs,
    });
    if (!result.ok) {
      this.hooks.onFail?.(result.error);
    }
  }

  public async close(): Promise<void> {
    this.clearTimer();
    await this.flush();
  }

  private armTimer(): void {
    if (this.timer) return;
    const t = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.config.writeFlushIntervalMs);
    if (typeof t.unref === 'function') t.unref();
    this.timer = t;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async insertBatch(batch: TxIndexRow[]): Promise<void> {
    if (batch.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      if (!row) continue;
      const p = i * 8;
      values.push(
        `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8})`,
      );
      params.push(
        row.txId,
        row.blockIndex,
        row.from,
        row.to,
        row.amount,
        row.type,
        row.ts,
        row.tx,
      );
    }
    if (values.length === 0) return;
    const sql =
      `INSERT INTO chain_tx_index (tx_id, block_index, from_addr, to_addr, amount, type, ts, tx) ` +
      `VALUES ${values.join(', ')} ON CONFLICT (tx_id) DO NOTHING`;
    await this.db.query(sql, params);
  }
}

function toRow(blockIndex: number, tx: Transaction): TxIndexRow {
  return {
    txId: tx.id,
    blockIndex,
    from: tx.from,
    to: tx.to,
    amount: String(tx.amount),
    type: tx.type,
    ts: tx.timestamp,
    tx,
  };
}
