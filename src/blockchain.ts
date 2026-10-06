/**
 * WUNCoin Blockchain - Главный модуль
 *
 * Это основной модуль блокчейна, который управляет:
 * - Создание блоков
 * - Валидация цепи
 * - Управление состоянием (смарт-контракты)
 * - Консенсус (Proof of Work)
 * - Верификация цифровых подписей (ECDSA)
 * - Логирование операций
 */

import crypto from 'node:crypto';
import { verifyTransaction, getTransactionDataForSigning, publicKeyToAddress } from './signature';
import { BlockchainLogger, LogLevel } from './logger';
import { WUNCoinContract, StakingContract } from '../contracts/smartcontracts';
import { BlockchainPersistence } from './persistence';
import type { TransactionStatus } from './transaction-status';
import { MiningPool } from './mining/MiningPool';
import { findNonce, PowJob, PowResult } from './mining/pow';
import {
  DifficultyConfig,
  loadDifficultyConfig,
  expectedDifficultyAtIndex,
  type BlockLike,
} from './mining/difficulty';
import { VerifyItem } from './mining/verify';

export interface Transaction {
  id: string;
  from: string;
  to: string;
  amount: number;
  timestamp: number;
  nonce: number;
  publicKey?: string; // ✅ НОВОЕ: публичный ключ отправителя
  signature?: string;
  type: 'transfer' | 'mint' | 'burn' | 'stake' | 'anchor';
  metadata?: Record<string, any>;
}

export interface Block {
  index: number;
  timestamp: number;
  transactions: Transaction[];
  previousHash: string;
  hash: string;
  nonce: number;
  miner: string;
  difficulty: number;
  // Hash v2 fields
  version?: number;      // 1 = legacy (full JSON), 2 = txRoot-based
  txRoot?: string;       // Merkle/simple root of transactions (version 2 only)
  // Optional metadata (genesis uses { chainId })
  metadata?: Record<string, unknown>;
}

export interface ContractState {
  [address: string]: {
    balance: number;
    nonce: number;
    code?: string;
    storage?: Record<string, any>;
  };
}


/** Fixed total WUN supply for Phase 1 (grams peg 1:1). */
export const TOTAL_SUPPLY_WUN = 1_000_000;

/**
 * Deterministic genesis timestamp. Using a fixed epoch value ensures the
 * genesis hash is reproducible across nodes and restarts.
 */
export const GENESIS_TIMESTAMP: number = parseInt(
  process.env.GENESIS_TIMESTAMP || '1700000000000', 10
);

/**
 * Chain identifier included in genesis metadata so that different networks
 * (mainnet, testnet) produce distinct genesis hashes.
 */
export const CHAIN_ID: string = process.env.CHAIN_ID || 'wun-mainnet';

/** Per-transaction result returned by applyTransactions. */
export interface TxApplyResult {
  txId: string;
  success: boolean;
  error?: string;
}

/** Rich result from minePendingTransactions (block + per-tx outcomes). */
export interface MineResult {
  block: Block;
  txResults: TxApplyResult[];
}

export class WUNCoinBlockchain {
  protected chain: Block[] = [];
  private pendingTransactions: Transaction[] = [];
  protected contractState: ContractState = {};
  private difficulty: number = 4;
  /**
   * Difficulty retargeting parameters (Phase 4.4), resolved from the
   * environment at construction time so each instance honours the current env
   * (important for tests that override the interval/clamps per-instance).
   */
  private difficultyConfig: DifficultyConfig = loadDifficultyConfig(process.env);
  /**
   * Batch ECDSA offload threshold (Phase 4.5). Signature verification for a
   * batch larger than this is dispatched to the worker pool instead of running
   * serially on the main thread.
   */
  private ecdsaBatchThreshold: number = 8;
  private validators: Set<string> = new Set();
  private consensusMechanism = 'POW' as const;
  protected logger: BlockchainLogger;
  private requireTreasurySignature: boolean;
  private coinContract: WUNCoinContract;
  private stakingContract: StakingContract;
  private persistence?: BlockchainPersistence;
  /** Memoized isChainValid() result keyed by chain length (invalidated on new blocks). */
  private cachedValidity: { chainLength: number; value: boolean } | null = null;
  /**
   * Phase 6.4: number of blocks between state snapshots. Resolved from
   * SNAPSHOT_INTERVAL_BLOCKS (default 100). Only meaningful when persistence
   * is active; snapshotting is a no-op in in-memory mode.
   */
  private snapshotIntervalBlocks: number;
  /**
   * Phase 6.5: size of the hot block window kept in memory. Resolved from
   * HOT_BLOCK_COUNT (default 1000). When persistence is active and the chain
   * exceeds this count, older blocks (except genesis) are evicted and lazily
   * reloaded from Postgres on demand. In in-memory mode the full chain always
   * stays resident — eviction never fires.
   */
  private hotBlockCount: number;
  /**
   * Phase 6.5: number of non-genesis blocks evicted from the front of `chain`.
   * Always 0 in in-memory mode. `chainHeight = evictedCount + chain.length`.
   */
  private evictedCount = 0;
  /**
   * Optional worker-thread pool for Proof-of-Work. When present, mining runs
   * off the main event loop; when null (tests, embedded use), the kernel falls
   * back to a synchronous in-process search.
   */
  private miningPool: MiningPool | null = null;
  /**
   * Flips to true when a block save ultimately fails after bounded retries.
   * Exposed as a health signal for monitoring (Phase 5.7 B2). With the Phase 6.1
   * group-commit BlockRepository, the retry/degraded responsibility moved into
   * the persistence layer; this local flag remains as a synchronous fallback
   * (e.g. if enqueueing itself throws) and is OR-combined with the repository's
   * degraded state in the {@link writeDegraded} getter.
   */
  private _writeDegraded = false;
  /**
   * Transaction statuses restored from durable storage on boot (Phase 6.2).
   * The status tracker lives in the presentation layer, so the kernel stashes
   * the loaded rows here for the bootstrap to hydrate the tracker, then clears
   * them. Empty when persistence is inactive.
   */
  private restoredStatuses: TransactionStatus[] = [];
  /**
   * Optional hook invoked after a SUCCESSFUL mint (H5). Lets the presentation
   * layer feed a `wun_supply_minted_total` metric WITHOUT the kernel importing
   * prom-client — the kernel stays decoupled and the hook is a no-op when unset.
   */
  private mintHook?: (info: { to: string; amount: number; totalSupply: number }) => void;

  constructor(persistence?: BlockchainPersistence) {
    this.logger = new BlockchainLogger(LogLevel.INFO);
    // Secure by default: require signature for TREASURY transactions.
    // Set REQUIRE_TREASURY_SIGNATURE=false explicitly for local development only.
    this.requireTreasurySignature =
      (process.env.REQUIRE_TREASURY_SIGNATURE || '').toLowerCase() !== 'false';
    this.persistence = persistence;

    // Resolve difficulty retargeting + batch-verify parameters BEFORE genesis so
    // the genesis block carries the configured initial difficulty.
    this.difficultyConfig = loadDifficultyConfig(process.env);
    this.difficulty = this.difficultyConfig.initialDifficulty;
    const threshold = parseInt(process.env.ECDSA_BATCH_THRESHOLD || '', 10);
    this.ecdsaBatchThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 8;

    // Phase 6.4: snapshot interval (blocks between state snapshots).
    const snapRaw = parseInt(process.env.SNAPSHOT_INTERVAL_BLOCKS || '', 10);
    this.snapshotIntervalBlocks =
      Number.isFinite(snapRaw) && snapRaw > 0 ? snapRaw : 100;

    // Phase 6.5: hot block window size.
    const hotRaw = parseInt(process.env.HOT_BLOCK_COUNT || '', 10);
    this.hotBlockCount =
      Number.isFinite(hotRaw) && hotRaw > 0 ? hotRaw : 1000;

    // Initialize blockchain with genesis block first (sets up contractState)
    this.createGenesisBlock();

    // Initialize contracts with DI reference to contractState. The coin contract
    // receives the fixed total-supply cap so `mint` can never inflate WUN (H5).
    this.coinContract = new WUNCoinContract(
      '0xWUN_CONTRACT', 'TREASURY', this.contractState, TOTAL_SUPPLY_WUN,
    );
    this.stakingContract = new StakingContract('0xSTAKE_CONTRACT', 'TREASURY', this.contractState);

    this.logger.info('Blockchain initialized');
  }

  /**
   * Async factory: creates an instance and optionally loads chain from Postgres.
   *
   * Phase 6.4 boot path: when persistence is active, the latest state snapshot
   * is loaded IN PARALLEL with blocks, mempool and statuses. If a snapshot
   * exists, `contractState` is restored from it and only blocks with
   * `index > snapshot.height` are replayed — skipping the full genesis replay.
   * When no snapshot exists the factory falls back to the original full replay
   * so correctness is always preserved.
   */
  public static async create(persistence?: BlockchainPersistence): Promise<WUNCoinBlockchain> {
    const instance = new WUNCoinBlockchain(persistence);
    if (persistence) {
      await persistence.ensureSchema();
      // Load blocks, mempool, statuses AND the latest snapshot in parallel
      // (Phase 6.2 + 6.4). Optional-call guards keep the legacy mock
      // persistence (loadBlocks/saveBlock/ensureSchema/close only) working.
      const [blocks, pending, statuses, snapshot] = await Promise.all([
        persistence.loadBlocks(),
        persistence.loadPendingTransactions?.() ?? Promise.resolve([] as Transaction[]),
        persistence.loadStatuses?.() ?? Promise.resolve([] as TransactionStatus[]),
        persistence.loadLatestSnapshot?.() ?? Promise.resolve(null),
      ]);
      if (blocks.length > 0) {
        instance.chain = blocks;
        if (snapshot && snapshot.height > 0 && snapshot.height < blocks.length) {
          // --- Fast boot from snapshot (Phase 6.4) -------------------------
          // Restore contractState verbatim from the snapshot, then replay ONLY
          // blocks after the snapshot height. The snapshot captures the exact
          // contractState produced by applying every block up to `height`, so
          // partial replay reproduces identical state and hashes.
          instance.contractState = snapshot.contractState;
          // Re-bind the contracts to the restored state object.
          instance.coinContract = new WUNCoinContract(
            '0xWUN_CONTRACT', 'TREASURY', instance.contractState, TOTAL_SUPPLY_WUN,
          );
          instance.stakingContract = new StakingContract(
            '0xSTAKE_CONTRACT', 'TREASURY', instance.contractState,
          );
          for (const block of blocks.slice(snapshot.height + 1)) {
            instance.applyTransactions(block.transactions);
            if (block.miner && block.miner !== 'GENESIS') {
              instance.applyMinerReward(block.miner);
            }
          }
          instance.logger.info('Boot from snapshot', {
            snapshotHeight: snapshot.height,
            replayedBlocks: blocks.length - snapshot.height - 1,
            totalBlocks: blocks.length,
          });
        } else {
          // --- Full replay (no snapshot or snapshot at genesis) --------------
          instance.applyGenesisDistribution();
          for (const block of blocks.slice(1)) {
            instance.applyTransactions(block.transactions);
            if (block.miner && block.miner !== 'GENESIS') {
              instance.applyMinerReward(block.miner);
            }
          }
        }
        // Backfill the tx index for already-persisted blocks so cold reads work
        // even for chains written before Phase 6.3 (idempotent).
        const backfill = persistence.backfillTxIndex?.(blocks);
        if (backfill) await backfill;
      }
      // Restore the in-memory mempool from durable storage.
      if (pending.length > 0) {
        instance.pendingTransactions = pending;
      }
      // Stash restored statuses for the bootstrap to hydrate the tracker.
      instance.restoredStatuses = statuses;
    }
    return instance;
  }

  /**
   * Take (and clear) the transaction statuses restored from durable storage on
   * boot. Called once by the bootstrap to hydrate the presentation-layer status
   * tracker. Returns an empty array when persistence is inactive.
   */
  public takeRestoredStatuses(): TransactionStatus[] {
    const statuses = this.restoredStatuses;
    this.restoredStatuses = [];
    return statuses;
  }

  /**
   * Attach a worker-thread mining pool. Pass an existing pool to share it
   * across components, or omit the argument to create a default-sized pool.
   * Until this is called, mining uses the synchronous in-process fallback.
   */
  public initMiningPool(pool?: MiningPool): void {
    this.miningPool = pool ?? new MiningPool();
  }

  /** Returns the attached mining pool, or null when using the sync fallback. */
  public getMiningPool(): MiningPool | null {
    return this.miningPool;
  }

  /**
   * Register a hook invoked after every successful mint (H5). The bootstrap uses
   * it to increment a supply metric WITHOUT coupling the kernel to prom-client.
   * Passing `undefined` clears the hook (default: no-op).
   */
  public setMintHook(
    hook?: (info: { to: string; amount: number; totalSupply: number }) => void,
  ): void {
    this.mintHook = hook;
  }

  /** Returns the resolved difficulty retargeting configuration (Phase 4.4). */
  public getDifficultyConfig(): DifficultyConfig {
    return this.difficultyConfig;
  }

  /**
   * The difficulty the block at `index` must carry, per the retarget schedule,
   * given the current chain. Exposed for validation tooling and tests.
   */
  public getExpectedDifficulty(index: number): number {
    return expectedDifficultyAtIndex(this.difficultyConfig, this.chain, index);
  }

  /**
   * Difficulty the block at FULL-chain index `fullIndex` must carry, correctly
   * handling the Phase 6.5 hot/cold split.
   *
   * `expectedDifficultyAtIndex` requires a full-index-addressable array
   * (`chain[index-1]`, `chain[index-interval]`). When nothing has been evicted
   * `this.chain` already satisfies that, so we pass it directly (identical to
   * the pre-6.5 behaviour). After eviction `this.chain` is a window
   * `[genesis, b_{e+1}, …]` whose positions no longer equal full indices, so we
   * build a sparse view holding only the two blocks the retarget schedule reads
   * (both are hot because `retargetInterval` ≪ `hotBlockCount`). Cold blocks
   * resolve to `undefined`, which `expectedDifficultyAtIndex` already tolerates.
   */
  private expectedDifficultyAtFullIndex(fullIndex: number): number {
    if (this.evictedCount === 0) {
      return expectedDifficultyAtIndex(this.difficultyConfig, this.chain, fullIndex);
    }
    const view: BlockLike[] = [];
    const prev = this.getBlockAt(fullIndex - 1);
    if (prev) view[fullIndex - 1] = prev;
    const interval = this.difficultyConfig.retargetInterval;
    if (fullIndex % interval === 0) {
      const start = this.getBlockAt(fullIndex - interval);
      if (start) view[fullIndex - interval] = start;
    }
    return expectedDifficultyAtIndex(this.difficultyConfig, view, fullIndex);
  }

  /**
   * Verify the ECDSA signatures of a batch of transactions (Phase 4.5).
   *
   * Returns a boolean array index-aligned with `transactions`. When the batch
   * is larger than `ecdsaBatchThreshold` (default 8) AND a worker pool is
   * attached, the CPU-bound verification is offloaded to the pool so it runs
   * off the main event loop; otherwise (small batches, tests, or no pool) it
   * falls back to the identical synchronous path. If the pool rejects, the
   * method transparently retries synchronously so correctness never depends on
   * worker availability.
   */
  public async verifyTransactionSignatures(transactions: Transaction[]): Promise<boolean[]> {
    if (transactions.length === 0) {
      return [];
    }

    // Build the signing payloads once on the main thread (cheap, non-crypto).
    const items: VerifyItem[] = transactions.map((tx) => ({
      message: getTransactionDataForSigning(tx),
      signature: tx.signature ?? '',
      publicKey: tx.publicKey ?? '',
    }));

    const verifySync = (): boolean[] =>
      items.map((item) => verifyTransaction(item.message, item.signature, item.publicKey));

    if (this.miningPool && transactions.length > this.ecdsaBatchThreshold) {
      try {
        return await this.miningPool.submitVerify(items);
      } catch (err) {
        this.logger.warn('Batch ECDSA offload failed, falling back to sync verification', {
          batchSize: transactions.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return verifySync();
  }

  /**
   * Создание первого блока (Genesis Block)
   * Uses deterministic GENESIS_TIMESTAMP and CHAIN_ID so the genesis hash is
   * reproducible across nodes and restarts.
   */
  private createGenesisBlock(): void {
    const genesisBlock: Block = {
      index: 0,
      timestamp: GENESIS_TIMESTAMP,
      transactions: [],
      previousHash: '0',
      hash: '',
      nonce: 0,
      miner: 'GENESIS',
      difficulty: this.difficulty,
      metadata: { chainId: CHAIN_ID },
    };

    genesisBlock.hash = this.calculateHash(genesisBlock);
    this.chain.push(genesisBlock);

    // Initialize contract state with the genesis distribution.
    this.applyGenesisDistribution();
  }

  /**
   * Applies the genesis token distribution to contractState.
   *
   * The full fixed supply (`TOTAL_SUPPLY_WUN`) is held by TREASURY. When
   * `BRIDGE_ADDRESS` is set, BRIDGE_GENESIS_BALANCE (default 100 000) is
   * carved out of TREASURY to fund the custodial bridge wallet, keeping the
   * total supply constant.
   */
  private applyGenesisDistribution(): void {
    const totalSupply = TOTAL_SUPPLY_WUN;
    const bridgeAddr = process.env.BRIDGE_ADDRESS;
    const bridgeBalance = bridgeAddr ? this.getBridgeGenesisBalance() : 0;

    this.contractState['TREASURY'] = {
      balance: totalSupply - bridgeBalance,
      nonce: 0,
    };

    if (bridgeAddr) {
      this.contractState[bridgeAddr] = {
        balance: bridgeBalance,
        nonce: 0,
      };
    }
  }

  /**
   * Returns the BRIDGE genesis balance carved out of TREASURY.
   */
  private getBridgeGenesisBalance(): number {
    const fromEnv = Number(process.env.BRIDGE_GENESIS_BALANCE);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 100_000;
  }

  /**
   * Расчёт хеша блока (legacy version 1)
   * Includes optional metadata (e.g. chainId in genesis) in the hash preimage.
   */
  public calculateHash(block: Partial<Block>): string {
    const payload: Record<string, unknown> = {
      index: block.index,
      timestamp: block.timestamp,
      transactions: block.transactions,
      previousHash: block.previousHash,
      nonce: block.nonce,
      difficulty: block.difficulty,
    };
    // Include metadata in hash when present (genesis chainId)
    if (block.metadata) {
      payload.metadata = block.metadata;
    }

    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  /**
   * Compute a transaction root hash for a block's transactions.
   * This is computed ONCE before the PoW loop, making mining cost
   * independent of transaction count.
   *
   * Uses sha256 of canonical JSON serialization of the tx array.
   */
  private computeTxRoot(transactions: Transaction[]): string {
    if (transactions.length === 0) {
      return crypto.createHash('sha256').update('empty').digest('hex');
    }
    // Canonical serialization: sorted fields for determinism
    const canonical = JSON.stringify(transactions.map(tx => ({
      id: tx.id,
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      timestamp: tx.timestamp,
      type: tx.type,
      nonce: tx.nonce,
      publicKey: tx.publicKey || '',
      signature: tx.signature || '',
      metadata: tx.metadata || null,
    })));
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Calculate block hash using version 2 scheme.
   * Fixed-size preimage — independent of transaction count.
   * This makes mining cost O(1) per iteration regardless of tx count.
   */
  private calculateHashForMining(
    index: number,
    timestamp: number,
    txRoot: string,
    previousHash: string,
    nonce: number,
    difficulty: number,
  ): string {
    const preimage = `2|${index}|${timestamp}|${txRoot}|${previousHash}|${nonce}|${difficulty}`;
    return crypto.createHash('sha256').update(preimage).digest('hex');
  }

  /**
   * Добавление новой транзакции
   */
  public addTransaction(transaction: Transaction): { success: boolean; error?: string } {
    // Denial-of-service guard: bound the in-memory pending pool. Configurable via
    // MAX_PENDING_TX; throws so the HTTP layer can map it to 503 (pool full).
    const maxPendingTransactions = parseInt(process.env.MAX_PENDING_TX || '10000', 10);
    if (this.pendingTransactions.length >= maxPendingTransactions) {
      throw new Error('Transaction pool is full. Try again later.');
    }

    // Валидация транзакции
    const validationError = this.validateTransaction(transaction);
    if (validationError) {
      this.logger.warn('Transaction validation failed', {
        txId: transaction.id,
        from: transaction.from,
        to: transaction.to,
        amount: transaction.amount,
        error: validationError,
      });
      return { success: false, error: validationError };
    }

    // Проверка nonce (предотвращение double-spending)
    const expectedNonce = this.contractState[transaction.from]?.nonce ?? 0;
    if (transaction.nonce !== expectedNonce) {
      const error = `Invalid nonce for address ${transaction.from}. Expected: ${expectedNonce}, Got: ${transaction.nonce}`;
      this.logger.warn('Invalid nonce', {
        address: transaction.from,
        expected: expectedNonce,
        got: transaction.nonce,
      });
      return {
        success: false,
        error,
      };
    }

    // Проверка баланса только для transfer и burn
    if (transaction.type === 'transfer' || transaction.type === 'burn') {
      const fromBalance = this.getBalance(transaction.from);
      if (fromBalance < transaction.amount) {
        const error = `Insufficient balance for ${transaction.from} (balance: ${fromBalance}, required: ${transaction.amount})`;
        this.logger.warn('Insufficient balance', {
          address: transaction.from,
          balance: fromBalance,
          required: transaction.amount,
        });
        return {
          success: false,
          error,
        };
      }
    }

    // Для mint проверяем что отправитель это TREASURY
    if (transaction.type === 'mint' && transaction.from !== 'TREASURY') {
      const error = 'Only TREASURY can mint coins';
      this.logger.warn('Unauthorized mint attempt', { address: transaction.from });
      return {
        success: false,
        error,
      };
    }

    this.pendingTransactions.push(transaction);
    // Mirror into the durable mempool (Phase 6.2) so an ack'd tx survives a
    // redeploy. Fire-and-forget and a no-op when persistence is inactive.
    this.persistence?.savePendingTransaction?.(transaction);
    this.logger.info('Transaction added to pending pool', {
      txId: transaction.id,
      from: transaction.from,
      to: transaction.to,
      amount: transaction.amount,
      type: transaction.type,
    });
    return { success: true };
  }

  /**
   * Валидация транзакции
   */
  private validateTransaction(tx: Transaction): string | null {
    // Базовые проверки
    if (!tx.from || !tx.to) {
      return 'Invalid from or to';
    }

    // Amount rules
    if (tx.type === 'anchor') {
      if (tx.amount !== 0) {
        return 'Anchor transaction amount must be 0';
      }
    } else {
      if (tx.amount <= 0) {
        return 'Invalid amount';
      }
    }

    // Не может отправлять себе (кроме стейкинга)
    if (tx.from === tx.to && tx.type !== 'stake' && tx.type !== 'anchor') {
      return 'Cannot send to yourself';
    }

    // Проверка типа транзакции
    const validTypes = ['transfer', 'mint', 'burn', 'stake', 'anchor'];
    if (!validTypes.includes(tx.type)) {
      return `Invalid transaction type: ${tx.type}`;
    }

    // Проверка nonce (должно быть число >= 0)
    if (typeof tx.nonce !== 'number' || tx.nonce < 0) {
      return 'Invalid nonce';
    }

    // ✅ НОВОЕ: Проверка подписи
    // TREASURY transactions require a signature by default (secure by default).
    // Set REQUIRE_TREASURY_SIGNATURE=false to enable the unsigned TREASURY bypass
    // for local development only.
    // H5: `mint` is NO LONGER exempt from signatures. A TREASURY mint now obeys
    // the same REQUIRE_TREASURY_SIGNATURE policy as every other TREASURY tx, so
    // an attacker cannot inflate the fixed supply with an unsigned mint. The
    // explicit dev opt-out (REQUIRE_TREASURY_SIGNATURE=false) still bypasses it.
    const treasuryBypassEnabled = !this.requireTreasurySignature;
    const requiresSignature = !(treasuryBypassEnabled && tx.from === 'TREASURY');

    if (requiresSignature) {
      if (!tx.signature || !tx.publicKey) {
        return 'Transaction must be signed (missing signature or publicKey)';
      }

      // Дополнительная защита: from должен соответствовать publicKey.
      // Canonical derivation first (sha256 of the hex STRING), then a temporary
      // legacy fallback (sha256 of the raw bytes) for clients that predate the fix.
      try {
        const derivedAddress = publicKeyToAddress(tx.publicKey);
        if (derivedAddress !== tx.from) {
          // Legacy fallback: sha256(raw bytes) — deprecated, will be removed.
          const legacyHash = crypto.createHash('sha256')
            .update(Buffer.from(tx.publicKey, 'hex'))
            .digest('hex');
          const legacyAddress = '0x' + legacyHash.slice(0, 40);
          if (legacyAddress === tx.from) {
            this.logger.warn('LEGACY_ADDRESS_DERIVATION', {
              message: 'Transaction uses legacy address derivation (sha256 of raw bytes). Will be removed in a future version.',
              from: tx.from,
              canonicalAddress: derivedAddress,
            });
          } else {
            return `Public key does not match from address (derived: ${derivedAddress}, from: ${tx.from})`;
          }
        }
      } catch {
        return 'Invalid publicKey (cannot derive address)';
      }

      // Получаем данные транзакции для проверки подписи
      const txData = getTransactionDataForSigning(tx);

      // Проверяем подпись
      if (!verifyTransaction(txData, tx.signature, tx.publicKey)) {
        return 'Invalid transaction signature';
      }
    }

    return null;
  }

  /**
   * Добытие нового блока (Proof of Work) — version 2 with precomputed txRoot.
   * Mining cost is now O(iterations × constant) instead of O(iterations × block_payload).
   * Returns a MineResult with per-transaction outcomes so callers can update
   * status tracking individually (B1).
   */
  public async minePendingTransactions(minerAddress: string): Promise<MineResult | null> {
    if (this.pendingTransactions.length === 0) {
      this.logger.warn('No transactions to mine');
      return null;
    }

    const startTime = performance.now();
    const previousBlock = this.getLastBlock();
    // Phase 6.5: the new block's index is the FULL chain height (hot + cold),
    // NOT `chain.length`. After eviction `chain.length` stays constant while the
    // height keeps growing, so using it here would mint duplicate indices.
    const index = this.chainHeight;
    const timestamp = Date.now();
    // Difficulty for this block is derived deterministically from the retarget
    // schedule (Phase 4.4). Mining and validation both call the same function,
    // so the PoW prefix check always uses the block's own difficulty.
    const difficulty = this.expectedDifficultyAtFullIndex(index);
    this.difficulty = difficulty;

    // Compute txRoot ONCE — this is the only O(n) operation over transactions
    const txRoot = this.computeTxRoot(this.pendingTransactions);

    this.logger.info('Starting to mine block', {
      blockIndex: index,
      transactionCount: this.pendingTransactions.length,
      miner: minerAddress,
      version: 2,
    });

    // Proof-of-Work over the small fixed-size preimage (version 2). When a
    // worker pool is attached the search runs off the event loop; otherwise we
    // fall back to a synchronous in-process search (tests / embedded use).
    const MAX_NONCE = 10_000_000; // Safety guard against an unbounded search
    const powJob: PowJob = {
      index,
      timestamp,
      txRoot,
      previousHash: previousBlock.hash,
      difficulty,
      maxNonce: MAX_NONCE,
    };

    const powResult: PowResult | null = this.miningPool
      ? await this.miningPool.submit(powJob)
      : findNonce(powJob);

    if (!powResult) {
      this.logger.error('MINING_MAX_NONCE', {
        message: 'Mining exceeded max nonce without finding valid hash',
        index,
        difficulty,
      });
      return null;
    }

    const { nonce, hash } = powResult;

    const newBlock: Block = {
      index,
      timestamp,
      transactions: [...this.pendingTransactions],
      previousHash: previousBlock.hash,
      hash,
      nonce,
      miner: minerAddress,
      difficulty,
      version: 2,
      txRoot,
    };

    const mineTime = performance.now() - startTime;
    this.logger.info('BLOCK_MINED', {
      message: `Block ${index} mined`,
      blockIndex: index,
      hash: newBlock.hash,
      nonce,
      mineTimeMs: Math.round(mineTime),
      txCount: newBlock.transactions.length,
      miner: minerAddress,
      version: 2,
    });

    // Применяем транзакции к состоянию (это увеличивает nonce адресов)
    const txResults = this.applyTransactions(newBlock.transactions);

    // Pay the miner reward (redistributed from TREASURY).
    this.applyMinerReward(minerAddress);

    this.chain.push(newBlock);
    this.cachedValidity = null; // Invalidate validity cache on new block
    this.pendingTransactions = [];

    if (this.persistence) {
      this.persistBlockWithRetry(newBlock);
      // Remove the now-mined transactions from the durable mempool (Phase 6.2).
      // Fire-and-forget; failures are handled/retried inside the repository.
      const minedIds = newBlock.transactions.map((tx) => tx.id);
      void this.persistence.removePendingTransactions?.(minedIds);

      // Phase 6.4: periodically persist a state snapshot so the next boot can
      // skip full replay. Fire-and-forget — snapshotting never blocks mining.
      // The snapshot height is the index of the block just mined: the captured
      // contractState reflects every block with index <= newBlock.index, so the
      // boot path replays blocks.slice(height + 1) (index > height) on top of it.
      const height = newBlock.index;
      if (height > 0 && height % this.snapshotIntervalBlocks === 0) {
        this.persistence.saveSnapshot?.(
          height,
          this.contractState,
          newBlock.txRoot ?? null,
        );
      }

      // Phase 6.5: evict cold blocks from the hot window. Genesis (index 0) is
      // never evicted so the chain anchor stays resident. Only fires when the
      // in-memory chain exceeds hotBlockCount + 1 (genesis + K hot blocks).
      this.evictColdBlocks();
    }

    return { block: newBlock, txResults };
  }

  /**
   * Applies the per-block miner reward.
   *
   * The reward is redistributed from TREASURY rather than newly minted,
   * since the full fixed supply was already issued at genesis.
   */
  private applyMinerReward(minerAddress: string): void {
    const minerReward = 10; // 10 WUN per block
    let minerEntry = this.contractState[minerAddress];
    if (!minerEntry) {
      minerEntry = { balance: 0, nonce: 0 };
      this.contractState[minerAddress] = minerEntry;
    }
    let treasuryEntry = this.contractState['TREASURY'];
    if (!treasuryEntry) {
      treasuryEntry = { balance: 0, nonce: 0 };
      this.contractState['TREASURY'] = treasuryEntry;
    }
    if (treasuryEntry.balance >= minerReward) {
      treasuryEntry.balance -= minerReward;
      minerEntry.balance += minerReward;
    } else {
      this.logger.warn('TREASURY has insufficient balance to pay miner reward', {
        treasuryBalance: treasuryEntry.balance,
        minerReward,
      });
    }
  }

  /**
   * Apply transactions to contract state by dispatching to contract methods.
   * Returns per-transaction results so callers can accurately track which
   * transactions succeeded and which failed during block application (B1).
   */
  protected applyTransactions(transactions: Transaction[]): TxApplyResult[] {
    const results: TxApplyResult[] = [];

    for (const tx of transactions) {
      // Address initialization stays in the kernel
      let fromEntry = this.contractState[tx.from];
      if (!fromEntry) {
        fromEntry = { balance: 0, nonce: 0 };
        this.contractState[tx.from] = fromEntry;
      }
      if (!this.contractState[tx.to]) {
        this.contractState[tx.to] = { balance: 0, nonce: 0 };
      }

      let txSuccess = true;
      let txError: string | undefined;

      switch (tx.type) {
        case 'transfer':
          if (!this.coinContract.transfer(tx.from, tx.to, tx.amount)) {
            txSuccess = false;
            txError = `Transfer failed: insufficient balance for ${tx.from}`;
            console.error(txError);
          }
          break;

        case 'mint':
          // Only TREASURY can mint, and never above the fixed supply cap (H5).
          if (tx.from !== 'TREASURY') {
            txSuccess = false;
            txError = 'Only TREASURY can mint';
          } else if (!this.coinContract.mint(tx.to, tx.amount)) {
            txSuccess = false;
            txError = `Mint failed: would exceed the fixed total supply cap (${TOTAL_SUPPLY_WUN} WUN)`;
            this.logger.warn('WUN_SUPPLY_MINT_REJECTED', {
              message: txError,
              to: tx.to,
              amount: tx.amount,
              totalSupply: this.coinContract.totalSupply(),
            });
          } else {
            // Audit every successful mint + feed the optional decoupled metric.
            const totalSupply = this.coinContract.totalSupply();
            this.logger.info('WUN_SUPPLY_MINTED', {
              message: `Minted ${tx.amount} WUN to ${tx.to}`,
              to: tx.to,
              amount: tx.amount,
              totalSupply,
            });
            this.mintHook?.({ to: tx.to, amount: tx.amount, totalSupply });
          }
          break;

        case 'burn':
          // M1: a failed burn (insufficient balance) must NOT be confirmed.
          if (!this.coinContract.burn(tx.from, tx.amount)) {
            txSuccess = false;
            txError = `Burn failed: insufficient balance for ${tx.from}`;
          }
          break;

        case 'stake':
          // M1: a failed stake (insufficient balance) must NOT be confirmed.
          if (!this.stakingContract.stake(tx.from, tx.amount)) {
            txSuccess = false;
            txError = `Stake failed: insufficient balance for ${tx.from}`;
          }
          break;

        case 'anchor':
          // No-op: anchor transactions only record data in the chain
          break;
      }

      if (txSuccess) {
        // Nonce increment stays in kernel (only on success)
        fromEntry.nonce++;
      }

      results.push({ txId: tx.id, success: txSuccess, error: txError });
    }

    return results;
  }

  /**
   * Получение баланса адреса
   */
  public getBalance(address: string): number {
    return this.contractState[address]?.balance || 0;
  }

  /**
   * Получение последнего блока
   */
  public getLastBlock(): Block {
    const last = this.chain[this.chain.length - 1];
    if (!last) {
      throw new Error('Blockchain has no blocks');
    }
    return last;
  }

  /**
   * Total number of blocks in the chain, including cold (evicted) blocks.
   * Phase 6.5: in in-memory mode this equals `chain.length`; when persistence
   * is active and blocks have been evicted it is `evictedCount + chain.length`.
   */
  public get chainHeight(): number {
    return this.evictedCount + this.chain.length;
  }

  /**
   * Hot-window size configured for this instance (Phase 6.5).
   */
  public getHotBlockCount(): number {
    return this.hotBlockCount;
  }

  /**
   * Number of non-genesis blocks evicted from the hot window (Phase 6.5).
   * Always 0 in in-memory mode.
   */
  public getEvictedCount(): number {
    return this.evictedCount;
  }

  /**
   * Synchronous access to a block by its full-chain index. Returns the block
   * when it resides in the hot window, `undefined` when it has been evicted
   * to cold storage. Genesis (index 0) is always hot.
   */
  public getBlockAt(index: number): Block | undefined {
    if (index < 0 || index >= this.chainHeight) return undefined;
    if (index === 0) return this.chain[0];
    if (index <= this.evictedCount) return undefined; // cold
    return this.chain[index - this.evictedCount];
  }

  /**
   * Async block access with transparent cold-storage lazy reload (Phase 6.5).
   * When persistence is active and the block was evicted, it is fetched from
   * Postgres via BlockRepository. In in-memory mode this is equivalent to the
   * synchronous {@link getBlockAt}.
   */
  public async getBlockAtAsync(index: number): Promise<Block | undefined> {
    const hot = this.getBlockAt(index);
    if (hot) return hot;
    if (index < 0 || index >= this.chainHeight) return undefined;
    // Cold path: lazy-load from Postgres.
    if (this.persistence) {
      const block = await this.persistence.loadBlockAt?.(index);
      return block ?? undefined;
    }
    return undefined;
  }

  /**
   * Async paginated block range [start, end) with transparent cold reload
   * (Phase 6.5). Used by the `/api/blockchain/blocks` controller so that
   * paginated reads work correctly even when the hot window has been evicted.
   */
  public async getBlocksRange(start: number, end: number): Promise<Block[]> {
    const clampedStart = Math.max(0, start);
    const clampedEnd = Math.min(end, this.chainHeight);
    const result: Block[] = [];
    for (let i = clampedStart; i < clampedEnd; i++) {
      const block = await this.getBlockAtAsync(i);
      if (block) result.push(block);
    }
    return result;
  }

  /**
   * Получение всей цепи
   */
  public getChain(): Block[] {
    return this.chain;
  }

  /**
   * Валидация всей цепи (supports both version 1 and version 2 blocks).
   *
   * Phase 6.5: when persistence is active and blocks have been evicted from
   * the hot window, the full audit is BOUNDED to the resident (hot) portion of
   * the chain. The cachedValidity O(1) fast path is preserved unchanged. Cold
   * blocks are not re-loaded during validation — this is a documented
   * limitation of the hot/cold separation (the auth-gated `/api/validate`
   * endpoint validates the hot window; a full cold-tail audit would require
   * streaming every block from Postgres).
   */
  public isChainValid(): boolean {
    // Return cached result if the chain hasn't changed (avoids O(n) rehashing on every call)
    if (this.cachedValidity && this.cachedValidity.chainLength === this.chain.length) {
      return this.cachedValidity.value;
    }

    let result = true;
    // When blocks have been evicted, start validation from the first hot block
    // (index 1 in the `chain` array) rather than from full-chain index 1.
    for (let i = 1; i < this.chain.length; i++) {
      const currentBlock = this.chain[i];
      const previousBlock = this.chain[i - 1];
      if (!currentBlock || !previousBlock) {
        continue;
      }

      // Recalculate hash depending on block version
      let recalculatedHash: string;
      if (currentBlock.version === 2 && currentBlock.txRoot) {
        // Version 2: fixed-size preimage
        recalculatedHash = this.calculateHashForMining(
          currentBlock.index,
          currentBlock.timestamp,
          currentBlock.txRoot,
          currentBlock.previousHash,
          currentBlock.nonce,
          currentBlock.difficulty,
        );
      } else {
        // Version 1 (legacy): full JSON serialization
        recalculatedHash = this.calculateHash(currentBlock);
      }

      // Проверяем хеш текущего блока
      if (currentBlock.hash !== recalculatedHash) {
        console.error(`Неверный хеш на блоке ${i}`);
        result = false;
        break;
      }

      // Проверяем связь с предыдущим блоком
      if (currentBlock.previousHash !== previousBlock.hash) {
        console.error(`Нарушена цепь на блоке ${i}`);
        result = false;
        break;
      }

      // Проверяем difficulty: он должен совпадать со значением, которое
      // детерминированно выводит алгоритм ретаргета по предыдущим блокам
      // (Phase 4.4). Подделанный difficulty отклоняется даже при валидном PoW.
      // Phase 6.5: when blocks have been evicted, the retarget schedule needs
      // the full chain prefix. We pass the hot `chain` array which starts at
      // genesis (always resident) so the schedule resolves correctly for the
      // hot window. Cold-block difficulty validation is bounded (documented).
      const fullIndex = this.evictedCount + i;
      const expectedDifficulty = this.expectedDifficultyAtFullIndex(fullIndex);
      if (currentBlock.difficulty !== expectedDifficulty) {
        console.error(`Неверный difficulty на блоке ${fullIndex}: ожидалось ${expectedDifficulty}, получено ${currentBlock.difficulty}`);
        result = false;
        break;
      }

      // Проверяем Proof of Work
      if (!currentBlock.hash.startsWith('0'.repeat(currentBlock.difficulty))) {
        console.error(`Неверный PoW на блоке ${i}`);
        result = false;
        break;
      }
    }

    // Cache the result
    this.cachedValidity = { chainLength: this.chain.length, value: result };
    return result;
  }

  /**
   * Получение состояния контракта
   */
  public getContractState(): ContractState {
    return this.contractState;
  }

  /**
   * Получение истории транзакций адреса
   */
  public getAddressHistory(address: string): Transaction[] {
    const history: Transaction[] = [];

    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.from === address || tx.to === address) {
          history.push(tx);
        }
      }
    }

    return history;
  }

  /**
   * Paginated address history (Phase 6.3).
   *
   * When persistence is active this is served by an INDEXED query over
   * `chain_tx_index` (btree on from_addr/to_addr) with LIMIT/OFFSET plus a
   * COUNT for the total, replacing the O(blocks × tx) in-memory scan. When
   * `DATABASE_URL` is unset it falls back to the exact in-memory behaviour:
   * a slice of {@link getAddressHistory} and `total` = the full history length,
   * so the response wire shape is byte-for-byte preserved.
   */
  public async getAddressHistoryPaged(
    address: string,
    limit: number,
    offset: number,
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const indexed = this.persistence?.getAddressHistoryIndexed;
    if (this.persistence && typeof indexed === 'function') {
      return indexed.call(this.persistence, address, limit, offset);
    }
    const full = this.getAddressHistory(address);
    return { transactions: full.slice(offset, offset + limit), total: full.length };
  }

  /**
   * Получить информацию о блокчейне.
   * Phase 6.5: `chainLength` reports the TOTAL height (hot + cold) so the wire
   * shape stays correct even after eviction.
   */
  public getBlockchainInfo() {
    return {
      chainLength: this.chainHeight,
      pendingTransactions: this.pendingTransactions.length,
      difficulty: this.difficulty,
      validators: Array.from(this.validators),
      consensus: this.consensusMechanism,
      isValid: this.isChainValid(),
      writeDegraded: this.writeDegraded,
    };
  }

  /**
   * Whether persistence writes have degraded. OR-combines the local synchronous
   * fallback flag with the group-commit BlockRepository's degraded state
   * (Phase 6.1) so a single signal reflects both write paths.
   */
  public get writeDegraded(): boolean {
    return this._writeDegraded || (this.persistence?.isWriteDegraded?.() ?? false);
  }

  /**
   * O(1) pending transactions count (avoids full chain validation via getBlockchainInfo)
   */
  public getPendingCount(): number {
    return this.pendingTransactions.length;
  }
  /**
   * Получить логгер для доступа к логам
   */
  public getLogger(): BlockchainLogger {
    return this.logger;
  }

  // ============= Phase 6.5: hot/cold eviction =============

  /**
   * Evict the oldest non-genesis blocks from the in-memory hot window when the
   * chain exceeds `hotBlockCount + 1` (genesis + K hot blocks). Only fires when
   * persistence is active — in in-memory mode the full chain always stays
   * resident and this method is a no-op.
   *
   * Evicted blocks are dropped from the front of `chain` (after genesis) and
   * `evictedCount` is incremented so `chainHeight` stays correct. Cold blocks
   * are lazily reloaded from Postgres on demand via {@link getBlockAtAsync}.
   */
  private evictColdBlocks(): void {
    if (!this.persistence) return; // in-memory mode: never evict
    // Keep genesis (index 0) + the last hotBlockCount blocks.
    const maxHot = this.hotBlockCount + 1;
    if (this.chain.length <= maxHot) return;
    const toEvict = this.chain.length - maxHot;
    // Splice out blocks [1 .. toEvict] (genesis at [0] is preserved).
    this.chain.splice(1, toEvict);
    this.evictedCount += toEvict;
    // Invalidate the validity cache since the hot window changed.
    this.cachedValidity = null;
    this.logger.info('Evicted cold blocks from hot window', {
      evicted: toEvict,
      evictedCount: this.evictedCount,
      hotLength: this.chain.length,
      chainHeight: this.chainHeight,
    });
  }

  // ============= B2 / Phase 6.1: block persistence =============

  /**
   * Fire-and-forget block persistence.
   *
   * The group-commit buffer, bounded exponential backoff + jitter and the
   * health-degraded latch now live in the {@link BlockRepository} (Phase 6.1);
   * `saveBlock` merely enqueues the block (and indexes its transactions) and
   * never blocks mining. This method only guards against a synchronous enqueue
   * failure, in which case it sets the local `_writeDegraded` fallback flag. The
   * authoritative degraded state is read back through the {@link writeDegraded}
   * getter, which OR-combines both signals (consolidated — no duplicate retry).
   */
  private persistBlockWithRetry(block: Block): void {
    if (!this.persistence) return;
    Promise.resolve(this.persistence.saveBlock(block)).catch((err: unknown) => {
      this._writeDegraded = true;
      this.logger.error('Block enqueue failed — writeDegraded', {
        blockIndex: block.index,
        error: err,
      });
    });
  }
}

export default WUNCoinBlockchain;