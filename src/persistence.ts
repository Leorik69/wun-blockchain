import type { Pool } from 'pg';
import type { Block, ContractState, Transaction } from './blockchain';
import type { TransactionStatus } from './transaction-status';
import {
  createPool,
  loadPersistenceConfig,
  type PersistenceConfig,
  type QueryExecutor,
} from './persistence/db';
import { ensureSchema as ensureSchemaSql } from './persistence/schema';
import { BlockRepository } from './persistence/BlockRepository';
import { PendingRepository } from './persistence/PendingRepository';
import { StatusRepository } from './persistence/StatusRepository';
import { TxIndexRepository } from './persistence/TxIndexRepository';
import { SnapshotRepository, type StateSnapshot } from './persistence/SnapshotRepository';

/**
 * Aggregate persistence facade over Postgres (Phase 6).
 *
 * Backward-compatible with the original single-table implementation: it still
 * exposes `ensureSchema()`, `loadBlocks()`, `saveBlock()` and `close()`, and the
 * `chain_blocks` schema is unchanged. Internally it now delegates to focused
 * repositories that share one tuned `pg` pool:
 *   - {@link BlockRepository}   — group-commit block writes + retry/degraded.
 *   - {@link PendingRepository} — durable mempool (`chain_pending_tx`).
 *   - {@link StatusRepository}  — durable status tracker (`chain_tx_status`).
 *   - {@link TxIndexRepository} — cold-read index (`chain_tx_index`).
 *
 * The whole layer is constructed ONLY when `DATABASE_URL` is set (see
 * `server.ts`); with no connection string the kernel runs purely in-memory and
 * never touches this class.
 */
export class BlockchainPersistence {
  private readonly pool: Pool;
  private readonly db: QueryExecutor;
  private readonly config: PersistenceConfig;
  private readonly blocks: BlockRepository;
  private readonly pending: PendingRepository;
  private readonly status: StatusRepository;
  private readonly txIndex: TxIndexRepository;
  private readonly snapshots: SnapshotRepository;

  constructor(connectionString: string, env: NodeJS.ProcessEnv = process.env) {
    this.config = loadPersistenceConfig(env);
    this.pool = createPool(connectionString, this.config);
    // A real pg.Pool structurally satisfies QueryExecutor; the cast avoids
    // fighting pg's overloaded `query` signatures.
    this.db = this.pool as unknown as QueryExecutor;

    this.blocks = new BlockRepository(this.db, this.config, {
      onDegraded: (error, batch) => {
        console.error(
          `[persistence] block write degraded after retries (batch=${batch.length}):`,
          error instanceof Error ? error.message : error,
        );
      },
      onRetry: (error, attempt, nextDelayMs) => {
        console.warn(
          `[persistence] block write failed, retrying (attempt=${attempt}, next=${Math.round(nextDelayMs)}ms):`,
          error instanceof Error ? error.message : error,
        );
      },
    });
    this.pending = new PendingRepository(this.db, this.config);
    this.status = new StatusRepository(this.db, this.config);
    this.txIndex = new TxIndexRepository(this.db, this.config);
    this.snapshots = new SnapshotRepository(this.db, this.config);
  }

  /** Create every persistence table + index if absent (idempotent). */
  async ensureSchema(): Promise<void> {
    await ensureSchemaSql(this.db);
  }

  /** Load the full chain ordered by index (boot replay). */
  async loadBlocks(): Promise<Block[]> {
    return this.blocks.loadBlocks();
  }

  /**
   * Enqueue a mined block for durable, group-committed write and index its
   * transactions for cold reads. Fire-and-forget: resolves immediately; the
   * actual write (with bounded retry) happens on the flush schedule. Mining
   * never blocks on Postgres.
   */
  async saveBlock(block: Block): Promise<void> {
    this.blocks.enqueue(block);
    this.txIndex.indexBlock(block);
  }

  /** Whether block writes have degraded (a batch failed after retries). */
  isWriteDegraded(): boolean {
    return this.blocks.isDegraded();
  }

  // --- Phase 6.2: durable mempool + status tracker -------------------------

  /** Load the persisted mempool (boot restore). */
  async loadPendingTransactions(): Promise<Transaction[]> {
    return this.pending.loadAll();
  }

  /** Buffer a mempool transaction for durable write. */
  savePendingTransaction(tx: Transaction): void {
    this.pending.save(tx);
  }

  /** Remove mined transactions from the durable mempool. */
  async removePendingTransactions(ids: string[]): Promise<void> {
    await this.pending.remove(ids);
  }

  /** Load persisted transaction statuses (boot restore). */
  async loadStatuses(): Promise<TransactionStatus[]> {
    return this.status.loadAll();
  }

  /** Buffer a status snapshot for durable write. */
  saveStatus(status: TransactionStatus): void {
    this.status.upsert(status);
  }

  // --- Phase 6.3: transaction index for cold reads -------------------------

  /** Backfill the tx index for already-persisted blocks (idempotent). */
  async backfillTxIndex(blocks: Block[]): Promise<void> {
    await this.txIndex.backfill(blocks);
  }

  /** Indexed, paginated address history (used when persistence is active). */
  async getAddressHistoryIndexed(
    address: string,
    limit: number,
    offset: number,
  ): Promise<{ transactions: Transaction[]; total: number }> {
    return this.txIndex.getAddressHistory(address, limit, offset);
  }

  // --- Phase 6.4: state snapshots for fast boot ----------------------------

  /** Load the latest state snapshot (highest height), or null. */
  async loadLatestSnapshot(): Promise<StateSnapshot | null> {
    return this.snapshots.loadLatest();
  }

  /** Buffer a state snapshot for durable write (fire-and-forget). */
  saveSnapshot(height: number, contractState: ContractState, txRoot: string | null): void {
    this.snapshots.save({ height, contractState, txRoot });
  }

  // --- Phase 6.5: single-block cold read -----------------------------------

  /** Load a single block by index from cold storage (lazy reload). */
  async loadBlockAt(index: number): Promise<Block | null> {
    return this.blocks.loadBlockAt(index);
  }

  // --- lifecycle -----------------------------------------------------------

  /** Durably flush every write buffer (graceful shutdown / SIGTERM). */
  async flush(): Promise<void> {
    await Promise.all([
      this.blocks.flush(),
      this.pending.flush(),
      this.status.flush(),
      this.txIndex.flush(),
      this.snapshots.flush(),
    ]);
  }

  /** Flush all buffers, then close the pool. */
  async close(): Promise<void> {
    await this.flush();
    await this.pool.end();
  }
}
