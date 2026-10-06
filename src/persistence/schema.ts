/**
 * Schema bootstrap for the WUNCoin persistence layer (Phase 6.1 / 6.2 / 6.3).
 *
 * A single idempotent `ensureSchema()` creates every table the layer owns. The
 * original `chain_blocks` definition is preserved byte-for-byte for backward
 * compatibility; the new tables are additive only. All statements use
 * `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so booting an
 * existing database is a no-op and booting a fresh one lays down the full schema.
 */
import type { QueryExecutor } from './db';

/** DDL for the append-only block store (unchanged from the original schema). */
const CREATE_CHAIN_BLOCKS = `
  CREATE TABLE IF NOT EXISTS chain_blocks (
    idx      INTEGER PRIMARY KEY,
    hash     TEXT NOT NULL,
    data     JSONB NOT NULL,
    saved_at TIMESTAMPTZ DEFAULT now()
  )
`;

/** DDL for the durable mempool (Phase 6.2). */
const CREATE_CHAIN_PENDING_TX = `
  CREATE TABLE IF NOT EXISTS chain_pending_tx (
    id          TEXT PRIMARY KEY,
    tx          JSONB NOT NULL,
    received_at TIMESTAMPTZ DEFAULT now(),
    nonce       BIGINT,
    from_addr   TEXT
  )
`;

/** DDL for the durable transaction-status tracker (Phase 6.2). */
const CREATE_CHAIN_TX_STATUS = `
  CREATE TABLE IF NOT EXISTS chain_tx_status (
    tx_id       TEXT PRIMARY KEY,
    status      TEXT NOT NULL,
    block_index INTEGER,
    block_hash  TEXT,
    error       TEXT,
    updated_at  TIMESTAMPTZ DEFAULT now()
  )
`;

/**
 * DDL for the transaction index used by cold reads (Phase 6.3).
 *
 * `tx` (JSONB) carries the full transaction so the indexed `/history` query can
 * return the exact same transaction objects as the in-memory scan without a
 * second round-trip into `chain_blocks`.
 */
const CREATE_CHAIN_TX_INDEX = `
  CREATE TABLE IF NOT EXISTS chain_tx_index (
    tx_id       TEXT PRIMARY KEY,
    block_index INTEGER NOT NULL,
    from_addr   TEXT,
    to_addr     TEXT,
    amount      TEXT,
    type        TEXT,
    ts          BIGINT,
    tx          JSONB NOT NULL
  )
`;

/** DDL for state snapshots enabling fast boot (Phase 6.4). */
const CREATE_CHAIN_STATE_SNAPSHOT = `
  CREATE TABLE IF NOT EXISTS chain_state_snapshot (
    height         INTEGER PRIMARY KEY,
    contract_state JSONB NOT NULL,
    tx_root        TEXT,
    taken_at       TIMESTAMPTZ DEFAULT now()
  )
`;

const CREATE_TX_INDEX_FROM =
  'CREATE INDEX IF NOT EXISTS chain_tx_index_from_addr ON chain_tx_index (from_addr)';
const CREATE_TX_INDEX_TO =
  'CREATE INDEX IF NOT EXISTS chain_tx_index_to_addr ON chain_tx_index (to_addr)';
const CREATE_TX_INDEX_BLOCK =
  'CREATE INDEX IF NOT EXISTS chain_tx_index_block_index ON chain_tx_index (block_index)';

/**
 * Create every persistence table + index if absent. Safe to call on every boot.
 */
export async function ensureSchema(db: QueryExecutor): Promise<void> {
  await db.query(CREATE_CHAIN_BLOCKS);
  await db.query(CREATE_CHAIN_PENDING_TX);
  await db.query(CREATE_CHAIN_TX_STATUS);
  await db.query(CREATE_CHAIN_TX_INDEX);
  await db.query(CREATE_CHAIN_STATE_SNAPSHOT);
  await db.query(CREATE_TX_INDEX_FROM);
  await db.query(CREATE_TX_INDEX_TO);
  await db.query(CREATE_TX_INDEX_BLOCK);
}
