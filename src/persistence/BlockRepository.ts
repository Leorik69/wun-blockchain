/**
 * BlockRepository — batched, durable block writer with a write-ahead buffer
 * and GROUP COMMIT (Phase 6.1).
 *
 * Mining never blocks on Postgres: {@link enqueue} appends to an in-memory
 * buffer and returns synchronously. The buffer is flushed as a single
 * multi-row `INSERT ... ON CONFLICT DO NOTHING` when EITHER it reaches
 * `blockFlushCount` blocks OR `blockFlushIntervalMs` elapses, whichever comes
 * first. A flush is also forced on graceful shutdown via {@link close}.
 *
 * Write failures are retried with bounded exponential backoff + jitter. When a
 * batch ultimately fails, the repository latches a health-degraded signal
 * ({@link isDegraded}) which the kernel surfaces through `writeDegraded` —
 * consolidating the retry/degraded responsibility that previously lived in
 * `WUNCoinBlockchain.persistBlockWithRetry`.
 */
import type { Block } from '../blockchain';
import { runWithRetry, type PersistenceConfig, type QueryExecutor } from './db';

/** Optional observation hooks (logging / degraded signalling). */
export interface BlockRepositoryHooks {
  /** Invoked once when a batch ultimately fails and the repo goes degraded. */
  onDegraded?: (error: unknown, batch: Block[]) => void;
  /** Invoked before each retry with the pending attempt metadata. */
  onRetry?: (error: unknown, attempt: number, nextDelayMs: number, batch: Block[]) => void;
}

export class BlockRepository {
  private buffer: Block[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private degraded = false;

  constructor(
    private readonly db: QueryExecutor,
    private readonly config: PersistenceConfig,
    private readonly hooks: BlockRepositoryHooks = {},
  ) {}

  /** Number of blocks currently held in the write-ahead buffer. */
  public get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Whether a write ultimately failed (health-degraded signal). */
  public isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Append a block to the write-ahead buffer (fire-and-forget). Triggers an
   * immediate flush when the count threshold is reached, otherwise arms the
   * interval timer. Never throws and never blocks the caller.
   */
  public enqueue(block: Block): void {
    this.buffer.push(block);
    if (this.buffer.length >= this.config.blockFlushCount) {
      // Count threshold reached — flush now without awaiting (mining must not block).
      void this.flush();
    } else {
      this.armTimer();
    }
  }

  private armTimer(): void {
    if (this.timer) return;
    const t = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.config.blockFlushIntervalMs);
    if (typeof t.unref === 'function') t.unref();
    this.timer = t;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Durably write the currently-buffered blocks as one grouped statement.
   * Safe to call concurrently and when the buffer is empty (no-op).
   */
  public async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      this.clearTimer();
      return;
    }
    const batch = this.buffer;
    this.buffer = [];
    this.clearTimer();
    await this.writeWithRetry(batch);
  }

  /** Load the full chain, ordered by index (used on boot replay). */
  public async loadBlocks(): Promise<Block[]> {
    const res = await this.db.query('SELECT data FROM chain_blocks ORDER BY idx ASC');
    return res.rows.map((r) => r.data as Block);
  }

  /** Load a single block by index from cold storage (Phase 6.5 lazy reload). */
  public async loadBlockAt(index: number): Promise<Block | null> {
    const res = await this.db.query(
      'SELECT data FROM chain_blocks WHERE idx = $1 LIMIT 1',
      [index],
    );
    const row = res.rows[0];
    return row ? (row.data as Block) : null;
  }

  /** Flush any buffered blocks and stop the timer (graceful shutdown). */
  public async close(): Promise<void> {
    this.clearTimer();
    await this.flush();
  }

  private async writeWithRetry(batch: Block[]): Promise<void> {
    const result = await runWithRetry(() => this.insertBatch(batch), {
      maxRetries: this.config.maxRetries,
      baseDelayMs: this.config.baseDelayMs,
      onRetry: (error, attempt, nextDelayMs) =>
        this.hooks.onRetry?.(error, attempt, nextDelayMs, batch),
    });
    if (!result.ok) {
      // Ultimate failure: latch the health-degraded signal (surfaced via
      // `WUNCoinBlockchain.writeDegraded`). Swallowed so the fire-and-forget
      // mining path and shutdown flush never reject.
      this.degraded = true;
      this.hooks.onDegraded?.(result.error, batch);
    }
  }

  private async insertBatch(batch: Block[]): Promise<void> {
    if (batch.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < batch.length; i++) {
      const block = batch[i];
      if (!block) continue;
      const p = i * 3;
      values.push(`($${p + 1}, $${p + 2}, $${p + 3})`);
      params.push(block.index, block.hash, block);
    }
    if (values.length === 0) return;
    const sql =
      `INSERT INTO chain_blocks (idx, hash, data) VALUES ${values.join(', ')} ` +
      `ON CONFLICT (idx) DO NOTHING`;
    await this.db.query(sql, params);
  }
}
