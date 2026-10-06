/**
 * StatusRepository — durable transaction-status tracker (Phase 6.2).
 *
 * Mirrors `TransactionStatusTracker` into `chain_tx_status` so that, after a
 * redeploy, `/api/transactions/:id/status` and the `wun-anchoring` reconcile job
 * still resolve transactions that were ack'd before the restart instead of
 * returning 404 (which previously left anchors stuck `pending` forever).
 *
 * Writes are buffered and flushed as a grouped upsert on a count/interval
 * schedule; the flush is best-effort (retried with backoff) and never throws.
 */
import type { TransactionStatus } from '../transaction-status';
import { runWithRetry, type PersistenceConfig, type QueryExecutor } from './db';

export interface StatusRepositoryHooks {
  onFail?: (error: unknown, batch: TransactionStatus[]) => void;
}

export class StatusRepository {
  private buffer: TransactionStatus[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: QueryExecutor,
    private readonly config: PersistenceConfig,
    private readonly hooks: StatusRepositoryHooks = {},
  ) {}

  public get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Buffer a status snapshot for durable write (fire-and-forget). */
  public upsert(status: TransactionStatus): void {
    // De-dupe by id within the buffer so only the latest snapshot is written.
    const existing = this.buffer.findIndex((s) => s.id === status.id);
    if (existing >= 0) {
      this.buffer[existing] = status;
    } else {
      this.buffer.push(status);
    }
    if (this.buffer.length >= this.config.writeFlushCount) {
      void this.flush();
    } else {
      this.armTimer();
    }
  }

  /** Load all persisted statuses (used on boot restore). */
  public async loadAll(): Promise<TransactionStatus[]> {
    const res = await this.db.query(
      'SELECT tx_id, status, block_index, block_hash, error, updated_at FROM chain_tx_status',
    );
    return res.rows.map((r) => {
      const updatedAt = toEpochMs(r.updated_at);
      return {
        id: String(r.tx_id),
        status: r.status as TransactionStatus['status'],
        blockIndex: r.block_index == null ? undefined : Number(r.block_index),
        blockHash: r.block_hash == null ? undefined : String(r.block_hash),
        error: r.error == null ? undefined : String(r.error),
        // The DDL stores a single `updated_at`; the creation timestamp is
        // reconstructed from it on restore (both are epoch-ms in the tracker).
        timestamp: updatedAt,
        updatedAt,
      };
    });
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
      this.hooks.onFail?.(result.error, batch);
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

  private async insertBatch(batch: TransactionStatus[]): Promise<void> {
    if (batch.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < batch.length; i++) {
      const s = batch[i];
      if (!s) continue;
      const p = i * 6;
      values.push(
        `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, to_timestamp($${p + 6} / 1000.0))`,
      );
      params.push(
        s.id,
        s.status,
        s.blockIndex ?? null,
        s.blockHash ?? null,
        s.error ?? null,
        s.updatedAt,
      );
    }
    if (values.length === 0) return;
    const sql =
      `INSERT INTO chain_tx_status (tx_id, status, block_index, block_hash, error, updated_at) ` +
      `VALUES ${values.join(', ')} ON CONFLICT (tx_id) DO UPDATE SET ` +
      `status = EXCLUDED.status, block_index = EXCLUDED.block_index, ` +
      `block_hash = EXCLUDED.block_hash, error = EXCLUDED.error, updated_at = EXCLUDED.updated_at`;
    await this.db.query(sql, params);
  }
}

/** Coerce a pg TIMESTAMPTZ (Date | string | number) into epoch milliseconds. */
function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}
