/**
 * Transaction Status Tracker
 * 
 * Отслеживает статусы транзакций:
 * - pending: добавлена в пул ожидания
 * - confirmed: включена в блок
 * - failed: не прошла валидацию
 */

export interface TransactionStatus {
  id: string;
  status: 'pending' | 'confirmed' | 'failed';
  blockIndex?: number;
  blockHash?: string;
  error?: string;
  timestamp: number;
  updatedAt: number;
}

/**
 * Optional durable sink (Phase 6.2). When provided, every status mutation is
 * mirrored (fire-and-forget) so transaction statuses survive a redeploy and the
 * `wun-anchoring` reconcile job no longer 404s on ack'd transactions. Absent in
 * in-memory mode, where the tracker behaves exactly as before.
 */
export interface TransactionStatusSink {
  upsert(status: TransactionStatus): void;
}

export class TransactionStatusTracker {
  private statuses: Map<string, TransactionStatus> = new Map();

  constructor(private readonly sink?: TransactionStatusSink) {}

  /**
   * Регистрирует новую транзакцию как pending
   */
  public addPending(transactionId: string): void {
    const status: TransactionStatus = {
      id: transactionId,
      status: 'pending',
      timestamp: Date.now(),
      updatedAt: Date.now(),
    };
    this.statuses.set(transactionId, status);
    this.sink?.upsert(status);
  }

  /**
   * Отмечает транзакцию как confirmed
   */
  public confirmTransaction(
    transactionId: string,
    blockIndex: number,
    blockHash: string
  ): void {
    const status = this.statuses.get(transactionId);
    if (status) {
      status.status = 'confirmed';
      status.blockIndex = blockIndex;
      status.blockHash = blockHash;
      status.updatedAt = Date.now();
      this.sink?.upsert(status);
    }
  }

  /**
   * Отмечает транзакцию как failed
   */
  public failTransaction(transactionId: string, error: string): void {
    const status = this.statuses.get(transactionId);
    if (status) {
      status.status = 'failed';
      status.error = error;
      status.updatedAt = Date.now();
      this.sink?.upsert(status);
    }
  }

  /**
   * Bulk-load statuses restored from durable storage on boot (Phase 6.2).
   * Does NOT write back to the sink — these rows already exist in the database.
   */
  public hydrate(statuses: TransactionStatus[]): void {
    for (const status of statuses) {
      this.statuses.set(status.id, status);
    }
  }

  /**
   * Получает статус транзакции
   */
  public getStatus(transactionId: string): TransactionStatus | undefined {
    return this.statuses.get(transactionId);
  }

  /**
   * Получает все статусы
   */
  public getAllStatuses(): TransactionStatus[] {
    return Array.from(this.statuses.values());
  }

  /**
   * Получает все pending транзакции
   */
  public getPendingTransactions(): TransactionStatus[] {
    return Array.from(this.statuses.values()).filter(
      (status) => status.status === 'pending'
    );
  }

  /**
   * Получает все confirmed транзакции
   */
  public getConfirmedTransactions(): TransactionStatus[] {
    return Array.from(this.statuses.values()).filter(
      (status) => status.status === 'confirmed'
    );
  }

  /**
   * Получает все failed транзакции
   */
  public getFailedTransactions(): TransactionStatus[] {
    return Array.from(this.statuses.values()).filter(
      (status) => status.status === 'failed'
    );
  }

  /**
   * Удаляет старые статусы (старше 1 часа)
   */
  public cleanup(maxAge: number = 3600000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    this.statuses.forEach((status, id) => {
      if (now - status.updatedAt > maxAge) {
        toDelete.push(id);
      }
    });

    toDelete.forEach((id) => this.statuses.delete(id));
  }
}
