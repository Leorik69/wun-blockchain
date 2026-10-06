/**
 * PendingRepository — durable mempool (Phase 6.2).
 *
 * Mirrors the kernel's in-memory `pendingTransactions` into `chain_pending_tx`
 * so a redeploy no longer silently drops transactions that were already ack'd
 * with HTTP 200. Writes are buffered and flushed as a grouped upsert on a
 * count/interval schedule (best-effort, retried with backoff); deletes flush the
 * buffer first so a just-mined transaction can never be re-inserted by a stale
 * buffered write.
 */
import type { Transaction } from '../blockchain';
import { runWithRetry, type PersistenceConfig, type QueryExecutor } from './db';

export interface PendingRepositoryHooks {
  onFail?: (error: unknown, batch: Transaction[]) => void;
}

export class PendingRepository {
  private buffer: Transaction[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: QueryExecutor,
    private readonly config: PersistenceConfig,
    private readonly hooks: PendingRepositoryHooks = {},
  ) {}

  public get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Buffer a mempool transaction for durable write (fire-and-forget). */
  public save(tx: Transaction): void {
    this.buffer.push(tx);
    if (this.buffer.length >= this.config.writeFlushCount) {
      void this.flush();
    } else {
      this.armTimer();
    }
  }

  /**
   * Remove transactions by id (called when they are mined into a block).
   * Flushes buffered saves first to avoid a stale re-insert race.
   */
  public async remove(ids: string[]): Promise<void> {
    await this.flush();
    if (ids.length === 0) return;
    const result = await runWithRetry(
      () => this.db.query('DELETE FROM chain_pending_tx WHERE id = ANY($1::text[])', [ids]),
      { maxRetries: this.config.maxRetries, baseDelayMs: this.config.baseDelayMs },
    );
    if (!result.ok) {
      this.hooks.onFail?.(result.error, []);
    }
  }

  /** Load the persisted mempool, oldest first (used on boot restore). */
  public async loadAll(): Promise<Transaction[]> {
    const res = await this.db.query(
      'SELECT tx FROM chain_pending_tx ORDER BY received_at ASC',
    );
    return res.rows.map((r) => r.tx as Transaction);
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

  private async insertBatch(batch: Transaction[]): Promise<void> {
    if (batch.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < batch.length; i++) {
      const tx = batch[i];
      if (!tx) continue;
      const p = i * 4;
      values.push(`($${p + 1}, $${p + 2}, now(), $${p + 3}, $${p + 4})`);
      params.push(tx.id, tx, tx.nonce, tx.from);
    }
    if (values.length === 0) return;
    const sql =
      `INSERT INTO chain_pending_tx (id, tx, received_at, nonce, from_addr) VALUES ${values.join(', ')} ` +
      `ON CONFLICT (id) DO UPDATE SET tx = EXCLUDED.tx, nonce = EXCLUDED.nonce, from_addr = EXCLUDED.from_addr`;
    await this.db.query(sql, params);
  }
}
