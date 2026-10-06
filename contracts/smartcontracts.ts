/**
 * WUNCoin Smart Contract System
 *
 * Minimal contract surface consumed by the blockchain kernel. Every contract
 * operates directly on the injected `ContractState` (dependency injection), so
 * there is a single source of truth for balances — no private duplicate maps.
 *
 * Transactions are dispatched from `blockchain.ts` `applyTransactions()` by
 * `tx.type`:
 *   - transfer -> WUNCoinContract.transfer()
 *   - mint     -> WUNCoinContract.mint()
 *   - burn     -> WUNCoinContract.burn()
 *   - stake    -> StakingContract.stake()
 */

import type { ContractState } from '../src/blockchain';

/**
 * Base smart contract class.
 *
 * Holds only identity fields plus the injected contract-state reference. The
 * legacy ABI / function-registry execution path (`call`, `emit`, `getABI`,
 * `functions`, `events`) was dead code and has been removed.
 */
export abstract class SmartContract {
  protected address: string;
  protected owner: string;
  protected contractState?: ContractState;

  constructor(address: string, owner: string) {
    this.address = address;
    this.owner = owner;
  }

  public getAddress(): string {
    return this.address;
  }
}

/**
 * WUNCoin Token Contract.
 * Manages WUN token balances through the shared contract state.
 */
export class WUNCoinContract extends SmartContract {
  /**
   * Hard cap on the total WUN supply (the sum of every account balance). A
   * `mint` that would push circulation above this value is refused. Defaults to
   * `+Infinity` so directly-constructed contracts (unit tests) keep the legacy
   * uncapped behaviour; the blockchain kernel ALWAYS injects `TOTAL_SUPPLY_WUN`
   * so the fixed-supply invariant is enforced in production (H5).
   */
  private readonly totalSupplyCap: number;

  constructor(
    address: string,
    owner: string,
    contractState?: ContractState,
    totalSupplyCap: number = Number.POSITIVE_INFINITY,
  ) {
    super(address, owner);
    if (contractState !== undefined) {
      this.contractState = contractState;
    }
    this.totalSupplyCap = totalSupplyCap;
  }

  /**
   * Transfer tokens via the injected contractState.
   * Returns true on success, false if the sender balance is insufficient.
   */
  public transfer(from: string, to: string, amount: number): boolean {
    if (!this.contractState) return false;
    const fromEntry = this.contractState[from];
    if (!fromEntry || fromEntry.balance < amount) return false;
    fromEntry.balance -= amount;

    let toEntry = this.contractState[to];
    if (!toEntry) {
      toEntry = { balance: 0, nonce: 0 };
      this.contractState[to] = toEntry;
    }
    toEntry.balance += amount;
    return true;
  }

  /**
   * Burn tokens from an address via the injected contractState.
   * Returns true on success, false if the balance is insufficient.
   */
  public burn(from: string, amount: number): boolean {
    if (!this.contractState) return false;
    const fromEntry = this.contractState[from];
    if (!fromEntry || fromEntry.balance < amount) return false;
    fromEntry.balance -= amount;
    return true;
  }

  /**
   * Mint tokens to an address via the injected contractState.
   *
   * Enforces the fixed-supply cap (H5): the mint is REFUSED (returns `false`
   * with no state change) when it would raise the total supply — the sum of
   * every account balance — above `totalSupplyCap`. Because genesis already
   * issues the full fixed supply, a mint only succeeds after tokens have been
   * burned back below the cap. Returns `true` on success so the kernel can
   * propagate the outcome into the per-transaction result.
   */
  public mint(to: string, amount: number): boolean {
    if (!this.contractState) return false;
    if (this.totalSupply() + amount > this.totalSupplyCap) {
      return false;
    }
    let toEntry = this.contractState[to];
    if (!toEntry) {
      toEntry = { balance: 0, nonce: 0 };
      this.contractState[to] = toEntry;
    }
    toEntry.balance += amount;
    return true;
  }

  /**
   * Current total supply in circulation: the sum of every account balance in
   * the injected contract state. Burns reduce it; transfers and miner rewards
   * leave it constant. Exposed so the kernel can audit-log supply after a mint.
   */
  public totalSupply(): number {
    if (!this.contractState) return 0;
    let sum = 0;
    for (const address of Object.keys(this.contractState)) {
      sum += this.contractState[address]?.balance ?? 0;
    }
    return sum;
  }
}

/**
 * Staking Contract.
 * Records staked amounts directly in each address's contract-state storage.
 */
export class StakingContract extends SmartContract {
  constructor(address: string, owner: string, contractState?: ContractState) {
    super(address, owner);
    if (contractState !== undefined) {
      this.contractState = contractState;
    }
  }

  /**
   * Stake tokens from an address via the injected contractState.
   * Reduces the balance and records the staked amount in per-address storage.
   * Returns `false` (no-op) when the balance is insufficient, so the kernel can
   * mark the transaction FAILED instead of falsely confirming it (M1).
   */
  public stake(from: string, amount: number): boolean {
    if (!this.contractState) return false;
    const fromEntry = this.contractState[from];
    if (!fromEntry || fromEntry.balance < amount) return false;
    fromEntry.balance -= amount;
    if (!fromEntry.storage) {
      fromEntry.storage = {};
    }
    fromEntry.storage['staked'] = ((fromEntry.storage['staked'] as number) || 0) + amount;
    return true;
  }
}
