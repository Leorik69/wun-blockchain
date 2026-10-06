/**
 * Unit tests for the WUNCoin durable persistence layer (Phase 6.1 / 6.2 / 6.3).
 *
 * These tests require NO live Postgres. They drive the repositories through an
 * in-memory {@link MemoryDb} implementation of the `QueryExecutor` seam, so the
 * SQL, buffering, group-commit triggers, retry/backoff → degraded signal and
 * restore round-trips are all asserted without a database.
 *
 * Runs under `npx vitest run` alongside the golden-master contract tests.
 */
import { describe, it, expect } from 'vitest';
import {
  loadPersistenceConfig,
  PERSISTENCE_DEFAULTS,
  type PersistenceConfig,
  type QueryExecutor,
  type QueryResult,
} from '../../src/persistence/db';
import { ensureSchema } from '../../src/persistence/schema';
import { BlockRepository } from '../../src/persistence/BlockRepository';
import { PendingRepository } from '../../src/persistence/PendingRepository';
import { StatusRepository } from '../../src/persistence/StatusRepository';
import { TxIndexRepository } from '../../src/persistence/TxIndexRepository';
import { SnapshotRepository } from '../../src/persistence/SnapshotRepository';
import WUNCoinBlockchain, { type Block, type Transaction } from '../../src/blockchain';
import type { BlockchainPersistence } from '../../src/persistence';
import type { TransactionStatus } from '../../src/transaction-status';

// The kernel reads this at construction; pin the dev-mode TREASURY bypass so the
// in-memory integration test can submit an unsigned TREASURY transfer.
process.env.REQUIRE_TREASURY_SIGNATURE = 'false';

// --- In-memory Postgres stub ------------------------------------------------

type Row = Record<string, unknown>;

/**
 * A minimal, white-box in-memory stand-in for a `pg` Pool. It understands just
 * the statements the repositories issue and keeps rows in plain arrays so writes
 * can be read back (round-trip). `failNext` forces the next N queries to reject
 * so retry/backoff paths can be exercised deterministically.
 */
class MemoryDb implements QueryExecutor {
  public calls: { text: string; params: readonly unknown[] }[] = [];
  public failNext = 0;
  private blocks: Row[] = [];
  private pending: Row[] = [];
  private status: Row[] = [];
  private txIndex: Row[] = [];
  private snapshots: Row[] = [];

  countCalls(fragment: string): number {
    return this.calls.filter((c) => c.text.includes(fragment)).length;
  }

  async query(text: string, params: readonly unknown[] = []): Promise<QueryResult> {
    this.calls.push({ text, params });
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated write failure');
    }
    const t = text.replace(/\s+/g, ' ').trim();

    if (t.startsWith('CREATE TABLE') || t.startsWith('CREATE INDEX')) {
      return { rows: [], rowCount: 0 };
    }
    if (t.startsWith('INSERT INTO chain_blocks')) {
      for (let i = 0; i + 3 <= params.length; i += 3) {
        this.blocks.push({ idx: params[i], hash: params[i + 1], data: params[i + 2] });
      }
      return { rows: [], rowCount: 0 };
    }
    if (t.startsWith('SELECT data FROM chain_blocks WHERE idx = $1')) {
      const idx = params[0] as number;
      const row = this.blocks.find((b) => b.idx === idx);
      return { rows: row ? [{ data: row.data }] : [], rowCount: row ? 1 : 0 };
    }
    if (t.startsWith('SELECT data FROM chain_blocks')) {
      const rows = [...this.blocks]
        .sort((a, b) => (a.idx as number) - (b.idx as number))
        .map((b) => ({ data: b.data }));
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith('INSERT INTO chain_pending_tx')) {
      for (let i = 0; i + 4 <= params.length; i += 4) {
        const row: Row = {
          id: params[i],
          tx: params[i + 1],
          nonce: params[i + 2],
          from_addr: params[i + 3],
        };
        const ex = this.pending.findIndex((p) => p.id === row.id);
        if (ex >= 0) this.pending[ex] = row;
        else this.pending.push(row);
      }
      return { rows: [], rowCount: 0 };
    }
    if (t.startsWith('DELETE FROM chain_pending_tx')) {
      const ids = params[0] as string[];
      this.pending = this.pending.filter((p) => !ids.includes(p.id as string));
      return { rows: [], rowCount: 0 };
    }
    if (t.startsWith('SELECT tx FROM chain_pending_tx')) {
      const rows = this.pending.map((p) => ({ tx: p.tx }));
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith('INSERT INTO chain_tx_status')) {
      for (let i = 0; i + 6 <= params.length; i += 6) {
        const row: Row = {
          tx_id: params[i],
          status: params[i + 1],
          block_index: params[i + 2],
          block_hash: params[i + 3],
          error: params[i + 4],
          updated_at: params[i + 5],
        };
        const ex = this.status.findIndex((s) => s.tx_id === row.tx_id);
        if (ex >= 0) this.status[ex] = row;
        else this.status.push(row);
      }
      return { rows: [], rowCount: 0 };
    }
    if (t.startsWith('SELECT tx_id, status')) {
      const rows = this.status.map((s) => ({ ...s }));
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith('INSERT INTO chain_tx_index')) {
      for (let i = 0; i + 8 <= params.length; i += 8) {
        const row: Row = {
          tx_id: params[i],
          block_index: params[i + 1],
          from_addr: params[i + 2],
          to_addr: params[i + 3],
          amount: params[i + 4],
          type: params[i + 5],
          ts: params[i + 6],
          tx: params[i + 7],
        };
        if (!this.txIndex.some((x) => x.tx_id === row.tx_id)) this.txIndex.push(row);
      }
      return { rows: [], rowCount: 0 };
    }
    if (t.startsWith('INSERT INTO chain_state_snapshot')) {
      const row: Row = {
        height: params[0],
        contract_state: params[1],
        tx_root: params[2],
      };
      const ex = this.snapshots.findIndex((s) => s.height === row.height);
      if (ex >= 0) this.snapshots[ex] = row;
      else this.snapshots.push(row);
      return { rows: [], rowCount: 0 };
    }
    if (t.startsWith('SELECT height, contract_state, tx_root FROM chain_state_snapshot')) {
      const sorted = [...this.snapshots].sort(
        (a, b) => (b.height as number) - (a.height as number),
      );
      const rows = sorted.slice(0, 1);
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith('SELECT COUNT(*)')) {
      const addr = params[0];
      const total = this.txIndex.filter(
        (x) => x.from_addr === addr || x.to_addr === addr,
      ).length;
      return { rows: [{ total }], rowCount: 1 };
    }
    if (t.startsWith('SELECT tx FROM chain_tx_index')) {
      const addr = params[0];
      const limit = params[1] as number;
      const offset = params[2] as number;
      const matched = this.txIndex
        .filter((x) => x.from_addr === addr || x.to_addr === addr)
        .sort((a, b) => (a.block_index as number) - (b.block_index as number));
      const rows = matched.slice(offset, offset + limit).map((x) => ({ tx: x.tx }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`MemoryDb: unexpected query: ${t.slice(0, 80)}`);
  }
}

// --- Fixtures / helpers -----------------------------------------------------

function cfg(overrides: Partial<PersistenceConfig> = {}): PersistenceConfig {
  return { ...PERSISTENCE_DEFAULTS, ...overrides };
}

function mkTx(id: string, from: string, to: string, amount = 10): Transaction {
  return {
    id,
    from,
    to,
    amount,
    timestamp: 1_700_000_000_000,
    nonce: 0,
    type: 'transfer',
  };
}

function mkBlock(index: number, transactions: Transaction[]): Block {
  return {
    index,
    timestamp: 1_700_000_000_000 + index,
    transactions,
    previousHash: 'prev',
    hash: `hash-${index}`,
    nonce: 1,
    miner: 'miner',
    difficulty: 4,
    version: 2,
    txRoot: `root-${index}`,
  };
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- ensureSchema -----------------------------------------------------------

describe('ensureSchema', () => {
  it('creates the block table plus all Phase 6 tables and tx-index btree indexes', async () => {
    const db = new MemoryDb();
    await ensureSchema(db);

    const ddl = db.calls.map((c) => c.text).join('\n');
    expect(ddl).toContain('chain_blocks');
    expect(ddl).toContain('chain_pending_tx');
    expect(ddl).toContain('chain_tx_status');
    expect(ddl).toContain('chain_tx_index');
    expect(ddl).toContain('chain_state_snapshot');
    // btree indexes on from_addr, to_addr, block_index
    expect(ddl).toContain('chain_tx_index (from_addr)');
    expect(ddl).toContain('chain_tx_index (to_addr)');
    expect(ddl).toContain('chain_tx_index (block_index)');
    // Idempotent DDL only.
    expect(db.calls.every((c) => /IF NOT EXISTS/i.test(c.text))).toBe(true);
  });
});

// --- BlockRepository: group commit + retry ----------------------------------

describe('BlockRepository', () => {
  it('buffers below the count threshold and flushes as ONE grouped insert when reached', async () => {
    const db = new MemoryDb();
    const repo = new BlockRepository(db, cfg({ blockFlushCount: 3, blockFlushIntervalMs: 60_000 }));

    repo.enqueue(mkBlock(1, []));
    repo.enqueue(mkBlock(2, []));
    await tick();
    expect(repo.bufferedCount).toBe(2);
    expect(db.countCalls('INSERT INTO chain_blocks')).toBe(0);

    // Third block hits the count threshold → group commit fires on its own.
    repo.enqueue(mkBlock(3, []));
    await tick();
    expect(repo.bufferedCount).toBe(0);
    expect(db.countCalls('INSERT INTO chain_blocks')).toBe(1);
  });

  it('flushes on the interval timer even when the count threshold is not met', async () => {
    const db = new MemoryDb();
    const repo = new BlockRepository(db, cfg({ blockFlushCount: 100, blockFlushIntervalMs: 10 }));
    repo.enqueue(mkBlock(1, []));
    expect(db.countCalls('INSERT INTO chain_blocks')).toBe(0);
    await tick(40);
    expect(db.countCalls('INSERT INTO chain_blocks')).toBe(1);
    expect(repo.bufferedCount).toBe(0);
  });

  it('writes multiple buffered blocks in a single multi-row statement', async () => {
    const db = new MemoryDb();
    const repo = new BlockRepository(db, cfg({ blockFlushCount: 100 }));
    repo.enqueue(mkBlock(1, []));
    repo.enqueue(mkBlock(2, []));
    await repo.flush();
    const insert = db.calls.find((c) => c.text.includes('INSERT INTO chain_blocks'));
    expect(insert).toBeTruthy();
    // 3 params per row (idx, hash, data) × 2 rows.
    expect(insert?.params.length).toBe(6);
    expect(insert?.text).toContain('ON CONFLICT (idx) DO NOTHING');
  });

  it('retries a transient failure and succeeds without going degraded', async () => {
    const db = new MemoryDb();
    db.failNext = 1; // first attempt fails, retry succeeds
    const repo = new BlockRepository(db, cfg({ maxRetries: 3, baseDelayMs: 1 }));
    repo.enqueue(mkBlock(1, []));
    await repo.flush();
    expect(repo.isDegraded()).toBe(false);
    expect(db.countCalls('INSERT INTO chain_blocks')).toBe(2);
    const loaded = await repo.loadBlocks();
    expect(loaded.length).toBe(1);
  });

  it('latches the degraded signal after exhausting retries', async () => {
    const db = new MemoryDb();
    db.failNext = 100; // every attempt fails
    let degradedCalls = 0;
    const repo = new BlockRepository(
      db,
      cfg({ maxRetries: 2, baseDelayMs: 1 }),
      { onDegraded: () => degradedCalls++ },
    );
    repo.enqueue(mkBlock(1, []));
    await repo.flush();
    expect(repo.isDegraded()).toBe(true);
    expect(degradedCalls).toBe(1);
    // maxRetries(2) + initial attempt = 3 total.
    expect(db.countCalls('INSERT INTO chain_blocks')).toBe(3);
  });

  it('round-trips persisted blocks through loadBlocks preserving hash v2 fields', async () => {
    const db = new MemoryDb();
    const repo = new BlockRepository(db, cfg());
    const block = mkBlock(7, [mkTx('t1', 'a', 'b')]);
    repo.enqueue(block);
    await repo.close();
    const [loaded] = await repo.loadBlocks();
    expect(loaded?.version).toBe(2);
    expect(loaded?.txRoot).toBe('root-7');
    expect(loaded?.transactions.length).toBe(1);
  });
});

// --- PendingRepository ------------------------------------------------------

describe('PendingRepository', () => {
  it('round-trips a saved transaction through loadAll', async () => {
    const db = new MemoryDb();
    const repo = new PendingRepository(db, cfg({ writeFlushCount: 100 }));
    const tx = mkTx('p1', 'alice', 'bob', 42);
    repo.save(tx);
    await repo.flush();
    const loaded = await repo.loadAll();
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.id).toBe('p1');
    expect(loaded[0]?.amount).toBe(42);
  });

  it('removes mined transactions so they are not restored', async () => {
    const db = new MemoryDb();
    const repo = new PendingRepository(db, cfg({ writeFlushCount: 100 }));
    repo.save(mkTx('p1', 'a', 'b'));
    repo.save(mkTx('p2', 'a', 'c'));
    await repo.flush();
    await repo.remove(['p1']);
    const loaded = await repo.loadAll();
    expect(loaded.map((t) => t.id)).toEqual(['p2']);
  });
});

// --- StatusRepository -------------------------------------------------------

describe('StatusRepository', () => {
  it('round-trips a confirmed status through loadAll', async () => {
    const db = new MemoryDb();
    const repo = new StatusRepository(db, cfg({ writeFlushCount: 100 }));
    const status: TransactionStatus = {
      id: 's1',
      status: 'confirmed',
      blockIndex: 5,
      blockHash: 'h5',
      timestamp: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    repo.upsert(status);
    await repo.flush();
    const loaded = await repo.loadAll();
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.id).toBe('s1');
    expect(loaded[0]?.status).toBe('confirmed');
    expect(loaded[0]?.blockIndex).toBe(5);
    expect(loaded[0]?.blockHash).toBe('h5');
    expect(loaded[0]?.updatedAt).toBe(1_700_000_000_000);
  });

  it('keeps only the latest snapshot per id within a batch', async () => {
    const db = new MemoryDb();
    const repo = new StatusRepository(db, cfg({ writeFlushCount: 100 }));
    repo.upsert({ id: 's1', status: 'pending', timestamp: 1, updatedAt: 1 });
    repo.upsert({ id: 's1', status: 'failed', error: 'bad', timestamp: 1, updatedAt: 2 });
    await repo.flush();
    const loaded = await repo.loadAll();
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.status).toBe('failed');
    expect(loaded[0]?.error).toBe('bad');
  });
});

// --- TxIndexRepository ------------------------------------------------------

describe('TxIndexRepository', () => {
  it('indexes block transactions and serves getAddressHistory from the index', async () => {
    const db = new MemoryDb();
    const repo = new TxIndexRepository(db, cfg({ writeFlushCount: 100 }));
    repo.indexBlock(mkBlock(1, [mkTx('t1', 'alice', 'bob'), mkTx('t2', 'carol', 'alice')]));
    repo.indexBlock(mkBlock(2, [mkTx('t3', 'alice', 'dave')]));
    await repo.flush();

    const { transactions, total } = await repo.getAddressHistory('alice', 50, 0);
    expect(total).toBe(3); // t1 (from), t2 (to), t3 (from)
    expect(transactions.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('honours limit/offset pagination against the index', async () => {
    const db = new MemoryDb();
    const repo = new TxIndexRepository(db, cfg({ writeFlushCount: 100 }));
    repo.indexBlock(mkBlock(1, [mkTx('t1', 'a', 'z'), mkTx('t2', 'a', 'z'), mkTx('t3', 'a', 'z')]));
    await repo.flush();
    const page = await repo.getAddressHistory('a', 2, 1);
    expect(page.total).toBe(3);
    expect(page.transactions.map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('backfills idempotently (tx_id conflicts ignored)', async () => {
    const db = new MemoryDb();
    const repo = new TxIndexRepository(db, cfg({ writeFlushCount: 100 }));
    const blocks = [mkBlock(1, [mkTx('t1', 'a', 'b')])];
    await repo.backfill(blocks);
    await repo.backfill(blocks); // second pass must not duplicate
    const { total } = await repo.getAddressHistory('a', 50, 0);
    expect(total).toBe(1);
  });
});

// --- Config resolution ------------------------------------------------------

describe('loadPersistenceConfig', () => {
  it('applies defaults and clamps env overrides', () => {
    const defaults = loadPersistenceConfig({});
    expect(defaults.blockFlushCount).toBe(PERSISTENCE_DEFAULTS.blockFlushCount);

    const tuned = loadPersistenceConfig({
      BLOCK_FLUSH_COUNT: '5',
      BLOCK_FLUSH_INTERVAL_MS: '250',
      PG_POOL_MAX: '4',
      PG_STATEMENT_TIMEOUT_MS: '1000',
    });
    expect(tuned.blockFlushCount).toBe(5);
    expect(tuned.blockFlushIntervalMs).toBe(250);
    expect(tuned.poolMax).toBe(4);
    expect(tuned.statementTimeoutMs).toBe(1000);

    // Out-of-range values clamp to the minimum.
    const clamped = loadPersistenceConfig({ BLOCK_FLUSH_COUNT: '0' });
    expect(clamped.blockFlushCount).toBe(1);
  });
});

// --- Kernel integration: dormancy + restore + in-memory history fallback ----

describe('WUNCoinBlockchain persistence integration', () => {
  it('stays fully dormant with no persistence (in-memory)', async () => {
    const bc = await WUNCoinBlockchain.create();
    expect(bc.getPendingCount()).toBe(0);
    expect(bc.takeRestoredStatuses()).toEqual([]);
    expect(bc.writeDegraded).toBe(false);
  });

  it('restores the mempool and stashes statuses from persistence on create()', async () => {
    const pending = [mkTx('p1', 'a', 'b'), mkTx('p2', 'a', 'c')];
    const statuses: TransactionStatus[] = [
      { id: 'p1', status: 'pending', timestamp: 1, updatedAt: 1 },
    ];
    const mock = {
      ensureSchema: async () => {},
      loadBlocks: async () => [],
      loadPendingTransactions: async () => pending,
      loadStatuses: async () => statuses,
      backfillTxIndex: async () => {},
    } as unknown as BlockchainPersistence;

    const bc = await WUNCoinBlockchain.create(mock);
    expect(bc.getPendingCount()).toBe(2);
    const restored = bc.takeRestoredStatuses();
    expect(restored.length).toBe(1);
    expect(restored[0]?.id).toBe('p1');
    // takeRestoredStatuses clears the stash.
    expect(bc.takeRestoredStatuses()).toEqual([]);
  });

  it('getAddressHistoryPaged falls back to the in-memory scan when persistence is unset', async () => {
    const bc = new WUNCoinBlockchain();
    const tx: Transaction = {
      id: 'h1',
      from: 'TREASURY',
      to: 'recipient',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };
    expect(bc.addTransaction(tx).success).toBe(true);
    const mined = await bc.minePendingTransactions('minerX');
    expect(mined).not.toBeNull();

    const full = bc.getAddressHistory('recipient');
    const paged = await bc.getAddressHistoryPaged('recipient', 50, 0);
    expect(paged.total).toBe(full.length);
    expect(paged.transactions.length).toBe(full.length);
    expect(paged.transactions[0]?.id).toBe('h1');

    // The offset/limit slice matches the controller's former in-memory behaviour.
    const empty = await bc.getAddressHistoryPaged('recipient', 50, 5);
    expect(empty.transactions.length).toBe(0);
    expect(empty.total).toBe(full.length);
  });
});

// --- SnapshotRepository (Phase 6.4) -----------------------------------------

describe('SnapshotRepository', () => {
  it('round-trips a saved snapshot through loadLatest', async () => {
    const db = new MemoryDb();
    const repo = new SnapshotRepository(db, cfg({ writeFlushCount: 100 }));
    const state = { TREASURY: { balance: 999, nonce: 0 } };
    repo.save({ height: 10, contractState: state, txRoot: 'root-10' });
    await repo.flush();
    const loaded = await repo.loadLatest();
    expect(loaded).not.toBeNull();
    expect(loaded?.height).toBe(10);
    expect(loaded?.contractState).toEqual(state);
    expect(loaded?.txRoot).toBe('root-10');
  });

  it('loadLatest returns the highest-height snapshot', async () => {
    const db = new MemoryDb();
    const repo = new SnapshotRepository(db, cfg({ writeFlushCount: 100 }));
    repo.save({ height: 5, contractState: { A: { balance: 1, nonce: 0 } }, txRoot: 'r5' });
    await repo.flush();
    repo.save({ height: 20, contractState: { B: { balance: 2, nonce: 0 } }, txRoot: 'r20' });
    await repo.flush();
    const loaded = await repo.loadLatest();
    expect(loaded?.height).toBe(20);
  });

  it('loadLatest returns null when no snapshot exists', async () => {
    const db = new MemoryDb();
    const repo = new SnapshotRepository(db, cfg());
    const loaded = await repo.loadLatest();
    expect(loaded).toBeNull();
  });
});

// --- Phase 6.4: snapshot boot (restore + partial replay) --------------------

describe('WUNCoinBlockchain snapshot boot', () => {
  it('boots from a snapshot and replays only blocks after the snapshot height', async () => {
    // Build a chain of 3 blocks (genesis + 2 mined) with known state.
    const bcFull = new WUNCoinBlockchain();
    const tx1: Transaction = {
      id: 't1', from: 'TREASURY', to: 'alice', amount: 100,
      timestamp: Date.now(), nonce: 0, type: 'transfer',
    };
    bcFull.addTransaction(tx1);
    await bcFull.minePendingTransactions('minerA');
    const tx2: Transaction = {
      id: 't2', from: 'TREASURY', to: 'bob', amount: 50,
      timestamp: Date.now(), nonce: 1, type: 'transfer',
    };
    bcFull.addTransaction(tx2);
    await bcFull.minePendingTransactions('minerB');

    // Capture the full-replay state as the reference.
    const refState = JSON.parse(JSON.stringify(bcFull.getContractState()));
    const refChain = bcFull.getChain(); // [genesis, block1, block2]

    // Snapshot at height 1: state after applying block 1 only.
    // Reconstruct it by creating a fresh chain and mining just tx1.
    const bcSnap1 = new WUNCoinBlockchain();
    bcSnap1.addTransaction(tx1);
    await bcSnap1.minePendingTransactions('minerA');
    const snapshotState = JSON.parse(JSON.stringify(bcSnap1.getContractState()));
    const snapshotHeight = 1;

    const mock = {
      ensureSchema: async () => {},
      loadBlocks: async () => refChain,
      loadPendingTransactions: async () => [],
      loadStatuses: async () => [],
      backfillTxIndex: async () => {},
      loadLatestSnapshot: async () => ({
        height: snapshotHeight,
        contractState: snapshotState,
        txRoot: refChain[snapshotHeight]?.txRoot ?? null,
      }),
    } as unknown as BlockchainPersistence;

    const bcSnap = await WUNCoinBlockchain.create(mock);
    // The snapshot-booted chain must have the same height.
    expect(bcSnap.chainHeight).toBe(refChain.length);
    // contractState must match the full-replay reference: the snapshot captures
    // the exact state at height 1, and only block 2 is replayed on top.
    expect(bcSnap.getContractState()).toEqual(refState);
  });

  it('falls back to full replay when no snapshot exists', async () => {
    const bcRef = new WUNCoinBlockchain();
    const tx: Transaction = {
      id: 't1', from: 'TREASURY', to: 'alice', amount: 100,
      timestamp: Date.now(), nonce: 0, type: 'transfer',
    };
    bcRef.addTransaction(tx);
    await bcRef.minePendingTransactions('minerA');
    const refState = JSON.parse(JSON.stringify(bcRef.getContractState()));
    const refChain = bcRef.getChain();

    const mock = {
      ensureSchema: async () => {},
      loadBlocks: async () => refChain,
      loadPendingTransactions: async () => [],
      loadStatuses: async () => [],
      backfillTxIndex: async () => {},
      loadLatestSnapshot: async () => null, // no snapshot
    } as unknown as BlockchainPersistence;

    const bc = await WUNCoinBlockchain.create(mock);
    expect(bc.chainHeight).toBe(refChain.length);
    expect(bc.getContractState()).toEqual(refState);
  });
});

// --- Phase 6.5: hot/cold eviction + lazy reload -----------------------------

describe('WUNCoinBlockchain hot/cold separation', () => {
  it('evicts cold blocks and lazily reloads them by index', async () => {
    // Use a tiny hot window so eviction fires quickly.
    const origHot = process.env.HOT_BLOCK_COUNT;
    process.env.HOT_BLOCK_COUNT = '3';
    try {
      const db = new MemoryDb();
      // Build a mock persistence that delegates to the repositories directly.
      const blockRepo = new BlockRepository(db, cfg({ blockFlushCount: 1 }));
      const mock = {
        ensureSchema: async () => { await ensureSchema(db); },
        loadBlocks: async () => blockRepo.loadBlocks(),
        loadBlockAt: async (idx: number) => blockRepo.loadBlockAt(idx),
        saveBlock: async (b: Block) => { blockRepo.enqueue(b); await blockRepo.flush(); },
        loadPendingTransactions: async () => [],
        loadStatuses: async () => [],
        backfillTxIndex: async () => {},
        loadLatestSnapshot: async () => null,
        saveSnapshot: () => {},
        isWriteDegraded: () => false,
        removePendingTransactions: async () => {},
      } as unknown as BlockchainPersistence;

      const bc = await WUNCoinBlockchain.create(mock);
      // Mine 6 blocks so the hot window (genesis + 3) overflows.
      for (let i = 0; i < 6; i++) {
        const tx: Transaction = {
          id: `tx-${i}`, from: 'TREASURY', to: `addr${i}`, amount: 10,
          timestamp: Date.now() + i, nonce: i, type: 'transfer',
        };
        bc.addTransaction(tx);
        await bc.minePendingTransactions(`miner${i}`);
      }

      // chainHeight must reflect ALL blocks (hot + cold).
      expect(bc.chainHeight).toBe(7); // genesis + 6 mined
      // Some blocks must have been evicted.
      expect(bc.getEvictedCount()).toBeGreaterThan(0);
      // Genesis is always hot.
      expect(bc.getBlockAt(0)).toBeDefined();
      expect(bc.getBlockAt(0)?.index).toBe(0);
      // The tip is hot.
      expect(bc.getBlockAt(6)).toBeDefined();
      // A cold block returns undefined synchronously.
      const coldIdx = 1; // likely evicted
      if (bc.getBlockAt(coldIdx) === undefined) {
        // Lazy reload from cold storage must return the correct block.
        const reloaded = await bc.getBlockAtAsync(coldIdx);
        expect(reloaded).toBeDefined();
        expect(reloaded?.index).toBe(coldIdx);
      }
    } finally {
      if (origHot === undefined) delete process.env.HOT_BLOCK_COUNT;
      else process.env.HOT_BLOCK_COUNT = origHot;
    }
  });

  it('chainLength stays correct after eviction (in-memory mode never evicts)', async () => {
    // In-memory mode: no persistence, so no eviction ever fires.
    const bc = new WUNCoinBlockchain();
    const tx: Transaction = {
      id: 't1', from: 'TREASURY', to: 'alice', amount: 10,
      timestamp: Date.now(), nonce: 0, type: 'transfer',
    };
    bc.addTransaction(tx);
    await bc.minePendingTransactions('miner');
    expect(bc.chainHeight).toBe(bc.getChain().length);
    expect(bc.getEvictedCount()).toBe(0);
    expect(bc.getBlockchainInfo().chainLength).toBe(2);
  });
});
