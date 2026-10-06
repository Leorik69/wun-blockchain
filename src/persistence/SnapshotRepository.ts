/**
 * SnapshotRepository — state snapshots for fast boot (Phase 6.4).
 *
 * Persists a point-in-time snapshot of the full `contractState` at a given
 * chain height so that a restart can skip replaying every block from genesis.
 * On boot the kernel loads the LATEST snapshot, restores `contractState` from
 * it, and replays only blocks with `index > snapshot.height`.
 *
 * Writes are fire-and-forget (buffered + flushed on the persistence schedule)
 * so snapshotting never blocks mining. The table uses `height` as the primary
 * key with `ON CONFLICT DO UPDATE` so re-snapshotting the same height is safe.
 */
import type { ContractState } from '../blockchain';
import { runWithRetry, type PersistenceConfig, type QueryExecutor } from './db';

/** A persisted state snapshot row. */
export interface StateSnapshot {
  height: number;
  contractState: ContractState;
  txRoot: string | null;
}

export interface SnapshotRepositoryHooks {
  onFail?: (error: unknown) => void;
}

export class SnapshotRepository {
  private buffer: StateSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: QueryExecutor,
    private readonly config: PersistenceConfig,
    private readonly hooks: SnapshotRepositoryHooks = {},
  ) {}

  /**
   * Buffer a snapshot for durable write. Only the latest buffered snapshot is
   * kept (older buffered snapshots are superseded). Fire-and-forget.
   */
  public save(snapshot: StateSnapshot): void {
    this.buffer = snapshot;
    this.armTimer();
  }

  /** Load the latest (highest) snapshot, or null when none exists. */
  public async loadLatest(): Promise<StateSnapshot | null> {
    const res = await this.db.query(
      `SELECT height, contract_state, tx_root FROM chain_state_snapshot
       ORDER BY height DESC LIMIT 1`,
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      height: row.height as number,
      contractState: row.contract_state as ContractState,
      txRoot: (row.tx_root as string) ?? null,
    };
  }

  /** Durably write the buffered snapshot (if any). */
  public async flush(): Promise<void> {
    this.clearTimer();
    const snapshot = this.buffer;
    if (!snapshot) return;
    this.buffer = null;
    const result = await runWithRetry(() => this.upsert(snapshot), {
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

  private async upsert(snapshot: StateSnapshot): Promise<void> {
    await this.db.query(
      `INSERT INTO chain_state_snapshot (height, contract_state, tx_root)
       VALUES ($1, $2, $3)
       ON CONFLICT (height) DO UPDATE
         SET contract_state = EXCLUDED.contract_state,
             tx_root = EXCLUDED.tx_root,
             taken_at = now()`,
      [snapshot.height, snapshot.contractState, snapshot.txRoot],
    );
  }
}
