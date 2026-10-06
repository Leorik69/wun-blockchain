/**
 * WUNCoin Blockchain Tests
 * 
 * Комплексные тесты для:
 * - Основного блокчейна
 * - Смарт-контрактов
 * - Консенсус механизма
 * - Валидации цепи
 */

import WUNCoinBlockchain, { Transaction, Block, GENESIS_TIMESTAMP, CHAIN_ID } from '../src/blockchain';
import { BlockchainPersistence } from '../src/persistence';
import {
  WUNCoinContract,
  StakingContract,
} from '../contracts/smartcontracts';
import {
  generateKeyPair,
  signTransaction,
  verifyTransaction,
  getTransactionDataForSigning,
  publicKeyToAddress,
  getPublicKeyFromPrivate,
  signMessage,
  verifySignature,
} from '../src/signature';
import { evaluateApiKeyAuth } from '../src/apiKeyAuth';
import { findNonce } from '../src/mining/pow';
import { computeRetargetDifficulty, DIFFICULTY_DEFAULTS } from '../src/mining/difficulty';
import { MiningPool } from '../src/mining/MiningPool';

// The legacy suite exercises the unsigned TREASURY transfer bypass, which is now
// disabled by default (secure by default). Pin the dev-mode flag at module load
// so every `new WUNCoinBlockchain()` below keeps the original golden-master
// semantics. Read once per construction, so this must run before any test.
process.env.REQUIRE_TREASURY_SIGNATURE = 'false';

// Утилиты для тестирования
class TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;

  constructor(name: string, passed: boolean, duration: number, error?: string) {
    this.name = name;
    this.passed = passed;
    this.duration = duration;
    this.error = error;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEquals(actual: any, expected: any, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} - Expected: ${expected}, Got: ${actual}`);
  }
}

function assertTrue(value: boolean, message: string): void {
  if (!value) {
    throw new Error(`${message} - Value is not true`);
  }
}

function assertSuccess(result: any, message: string): void {
  if (!result.success) {
    throw new Error(`${message} - Error: ${result.error}`);
  }
}

export function testApiKeyAuthFailClosed(): TestResult {
  const start = Date.now();
  try {
    const prodEmpty = evaluateApiKeyAuth({
      configuredKey: '',
      providedKey: '',
      nodeEnv: 'production',
    });
    assertEquals(prodEmpty.ok, false, 'production without key must fail');
    if (!prodEmpty.ok) {
      assertEquals(prodEmpty.status, 503, 'production empty key status');
    }

    const devEmpty = evaluateApiKeyAuth({
      configuredKey: '',
      providedKey: '',
      nodeEnv: 'development',
    });
    assertEquals(devEmpty.ok, true, 'non-prod empty key may pass');

    const badKey = evaluateApiKeyAuth({
      configuredKey: 'secret',
      providedKey: 'wrong',
      nodeEnv: 'production',
    });
    assertEquals(badKey.ok, false, 'wrong key must fail');
    if (!badKey.ok) {
      assertEquals(badKey.status, 401, 'wrong key status');
    }

    const goodKey = evaluateApiKeyAuth({
      configuredKey: 'secret',
      providedKey: 'secret',
      nodeEnv: 'production',
    });
    assertEquals(goodKey.ok, true, 'matching key must pass');

    return new TestResult('API key auth fail-closed', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'API key auth fail-closed',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============= БЛОКЧЕЙН ТЕСТЫ =============

export function testBlockchainCreation(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();
    const info = blockchain.getBlockchainInfo();

    assertEquals(info.chainLength, 1, 'Genesis block should be created');
    assertEquals(info.pendingTransactions, 0, 'No pending transactions initially');

    return new TestResult('Blockchain Creation', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Blockchain Creation',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testAddTransaction(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // Сначала даём деньги от TREASURY (nonce должен быть 0 для TREASURY)
    const fundTx: Transaction = {
      id: '0',
      from: 'TREASURY',
      to: 'user1',
      amount: 500,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };

    const result = blockchain.addTransaction(fundTx);
    assertSuccess(result, 'Fund transaction should be added');
    
    blockchain.minePendingTransactions('miner1');

    // Теперь user1 может отправить деньги, но нужна подпись
    // Генерируем ключи для user1
    const user1Keys = generateKeyPair();

    // Даём денежки user1 по его адресу
    const fundUser1Tx: Transaction = {
      id: '1',
      from: 'TREASURY',
      to: user1Keys.address,
      amount: 500,
      timestamp: Date.now(),
      nonce: 1,
      type: 'transfer',
    };

    const resultFund = blockchain.addTransaction(fundUser1Tx);
    assertSuccess(resultFund, 'Fund user1 transaction should be added');
    
    blockchain.minePendingTransactions('miner1');

    // Теперь user1 отправляет деньги с подписью
    const txToAdd: Transaction = {
      id: '2',
      from: user1Keys.address,
      to: 'user2',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0, // user1 первый раз отправляет
      publicKey: user1Keys.publicKey,
      type: 'transfer',
    };

    const txData = getTransactionDataForSigning(txToAdd);
    txToAdd.signature = signTransaction(txData, user1Keys.privateKey);

    const result2 = blockchain.addTransaction(txToAdd);
    assertSuccess(result2, 'Signed transaction should be added');

    const info = blockchain.getBlockchainInfo();
    assertEquals(info.pendingTransactions, 1, 'Should have 1 pending transaction');

    return new TestResult('Add Transaction', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Add Transaction',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testTransactionValidation(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // Недопустимая транзакция - отправка самому себе
    const invalidTx: Transaction = {
      id: '2',
      from: 'user1',
      to: 'user1',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };

    const result = blockchain.addTransaction(invalidTx);
    assertEquals(result.success, false, 'Self-transfer should be rejected');

    // Транзакция с отрицательной суммой
    const negativeTx: Transaction = {
      id: '3',
      from: 'user1',
      to: 'user2',
      amount: -100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };

    const result2 = blockchain.addTransaction(negativeTx);
    assertEquals(result2.success, false, 'Negative amount should be rejected');

    return new TestResult('Transaction Validation', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Transaction Validation',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testNonceValidation(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // Даём денежки user1 - это TREASURY транзакция, не требует подписи
    const fundTx: Transaction = {
      id: '0',
      from: 'TREASURY',
      to: 'user1',
      amount: 500,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };

    const resultFund = blockchain.addTransaction(fundTx);
    assertSuccess(resultFund, 'Fund transaction should be added');
    
    blockchain.minePendingTransactions('miner1');

    // Попытка отправить транзакцию с неправильным nonce (user1 еще не делал транзакций)
    const wrongNonceTx: Transaction = {
      id: '1',
      from: 'user1',
      to: 'user2',
      amount: 100,
      timestamp: Date.now(),
      nonce: 5, // ❌ неправильный nonce, должен быть 0
      type: 'transfer',
    };

    // Эта транзакция может быть отклонена из-за отсутствия подписи ИЛИ из-за неправильного nonce
    // Сначала проверяем что она была отклонена
    const result = blockchain.addTransaction(wrongNonceTx);
    assertEquals(result.success, false, 'Wrong nonce transaction should be rejected');

    // Теперь отправляем с правильным nonce и без подписи (просто проверяем nonce)
    // Для этого создаём TREASURY транзакцию которая не требует подписи
    const fundTx2: Transaction = {
      id: '2',
      from: 'TREASURY',
      to: 'user3',
      amount: 200,
      timestamp: Date.now(),
      nonce: 1, // TREASURY имеет nonce 1 после первой транзакции
      type: 'transfer',
    };

    const result2 = blockchain.addTransaction(fundTx2);
    assertSuccess(result2, 'Correct TREASURY nonce should be accepted');

    return new TestResult('Nonce Validation', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Nonce Validation',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testSignature(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // Генерируем ключи для пользователя
    const user1Keys = generateKeyPair();

    // Даём денежки user1
    const fundTx: Transaction = {
      id: '0',
      from: 'TREASURY',
      to: user1Keys.address,
      amount: 500,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };

    blockchain.addTransaction(fundTx);
    blockchain.minePendingTransactions('miner1');

    // Создаем подписанную транзакцию
    const txToSign: Transaction = {
      id: '1',
      from: user1Keys.address,
      to: '0xabcdef1234567890abcdef1234567890abcdef12',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      publicKey: user1Keys.publicKey,
      type: 'transfer',
    };

    // Подписываем транзакцию
    const txData = getTransactionDataForSigning(txToSign);
    const signature = signTransaction(txData, user1Keys.privateKey);
    txToSign.signature = signature;

    // Добавляем подписанную транзакцию
    const result = blockchain.addTransaction(txToSign);
    assertSuccess(result, 'Signed transaction should be accepted');

    const info = blockchain.getBlockchainInfo();
    assertEquals(info.pendingTransactions, 1, 'Should have 1 pending transaction');

    return new TestResult('Signature Validation', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Signature Validation',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testNegativeBalance(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // Генерируем ключи для пользователя
    const userKeys = generateKeyPair();

    // Попытка создать транзакцию БЕЗ денег на счёте
    const txWithoutFunds: Transaction = {
      id: '1',
      from: userKeys.address,
      to: '0xabcdef1234567890abcdef1234567890abcdef12',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      publicKey: userKeys.publicKey,
      type: 'transfer',
    };

    const txData = getTransactionDataForSigning(txWithoutFunds);
    const signature = signTransaction(txData, userKeys.privateKey);
    txWithoutFunds.signature = signature;

    // Проверяем что транзакция отклонена (недостаточно денег)
    const result = blockchain.addTransaction(txWithoutFunds);
    assertEquals(result.success, false, 'Transaction without funds should be rejected');
    assertTrue(
      result.error !== undefined && result.error.includes('Insufficient balance'),
      'Should have insufficient balance error'
    );

    // Проверяем что баланс остался 0 (не ушёл в минус!)
    const balance = blockchain.getBalance(userKeys.address);
    assertEquals(balance, 0, 'Balance should still be 0, not negative');

    return new TestResult('Negative Balance Prevention', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Negative Balance Prevention',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function testMineBlock(): Promise<TestResult> {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // Даём хотя бы какую-то валидную транзакцию
    const tx: Transaction = {
      id: '4',
      from: 'TREASURY',
      to: 'miner1',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };

    blockchain.addTransaction(tx);

    const result = await blockchain.minePendingTransactions('miner1');

    assertTrue(result !== null, 'Block should be mined');
    const minedBlock = result!.block;
    assertEquals(minedBlock.index, 1, 'Block index should be 1');
    assertEquals(minedBlock.miner, 'miner1', 'Miner should be recorded');
    // B1: txResults should report success for the valid transaction
    assertEquals(result!.txResults.length, 1, 'Should have 1 txResult');
    assertEquals(result!.txResults[0]!.success, true, 'Transaction should succeed');

    const info = blockchain.getBlockchainInfo();
    assertEquals(info.chainLength, 2, 'Chain should have 2 blocks');
    assertEquals(info.pendingTransactions, 0, 'Pending transactions should be cleared');

    return new TestResult('Mine Block', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Mine Block',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testBlockchainValidation(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // Добавляем и майним транзакции
    const tx: Transaction = {
      id: '5',
      from: 'TREASURY',
      to: 'user1',
      amount: 500,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };

    const result = blockchain.addTransaction(tx);
    assertSuccess(result, 'Transaction should be added');
    
    blockchain.minePendingTransactions('miner1');

    // Проверяем валидность цепи
    const isValid = blockchain.isChainValid();
    assertTrue(isValid, 'Blockchain should be valid');

    return new TestResult('Blockchain Validation', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Blockchain Validation',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testGetBalance(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // Создаём транзакцию и её майним
    const tx: Transaction = {
      id: '6',
      from: 'TREASURY',
      to: 'user1',
      amount: 1000,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };

    const result = blockchain.addTransaction(tx);
    assertSuccess(result, 'Transaction should be added');
    
    blockchain.minePendingTransactions('miner1');

    const balance = blockchain.getBalance('user1');
    assertEquals(balance, 1000, 'User balance should be 1000');

    const minerBalance = blockchain.getBalance('miner1');
    assertEquals(minerBalance, 10, 'Miner should receive 10 WUN reward');

    return new TestResult('Get Balance', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Get Balance',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testAddressHistory(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // Генерируем ключи для user1
    const user1Keys = generateKeyPair();

    // Первая транзакция - даём user1 деньги
    const tx1: Transaction = {
      id: '7',
      from: 'TREASURY',
      to: user1Keys.address,
      amount: 1000,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };

    const result1 = blockchain.addTransaction(tx1);
    assertSuccess(result1, 'First transaction should be added');
    
    blockchain.minePendingTransactions('miner1');

    // Вторая транзакция - user1 отправляет user2 (с подписью!)
    const tx2: Transaction = {
      id: '8',
      from: user1Keys.address,
      to: 'user2',
      amount: 500,
      timestamp: Date.now(),
      nonce: 0, // user1 первый раз отправляет
      publicKey: user1Keys.publicKey,
      type: 'transfer',
    };

    const tx2Data = getTransactionDataForSigning(tx2);
    tx2.signature = signTransaction(tx2Data, user1Keys.privateKey);

    const result2 = blockchain.addTransaction(tx2);
    assertSuccess(result2, 'Second transaction should be added');
    
    blockchain.minePendingTransactions('miner1');

    // Проверяем историю user1 (2 транзакции)
    const history = blockchain.getAddressHistory(user1Keys.address);
    assertEquals(history.length, 2, `User1 should have 2 transactions, got ${history.length}`);
    
    // Проверяем что транзакции правильные
    const incomingTx = history.find(tx => tx.to === user1Keys.address);
    const outgoingTx = history.find(tx => tx.from === user1Keys.address);
    
    assertTrue(incomingTx !== undefined, 'user1 should have incoming transaction');
    assertTrue(outgoingTx !== undefined, 'user1 should have outgoing transaction');

    return new TestResult('Address History', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Address History',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============= SIGNATURE (ECDSA) UNIT TESTS =============

export function testSignatureKeyGeneration(): TestResult {
  const start = Date.now();
  try {
    const keyPair = generateKeyPair();
    assertTrue(!!keyPair.privateKey, 'Private key should be present');
    assertTrue(!!keyPair.publicKey, 'Public key should be present');
    assertTrue(!!keyPair.address, 'Address should be present');
    assertTrue(/^[0-9a-fA-F]{64}$/.test(keyPair.privateKey), 'Private key should be 64 hex chars');
    assertTrue(
      keyPair.publicKey.length === 130 || keyPair.publicKey.length === 128,
      'Public key should be 128 or 130 hex chars'
    );
    assertTrue(/^0x[0-9a-fA-F]{40}$/.test(keyPair.address), 'Address should be 0x + 40 hex chars');
    return new TestResult('Signature Key Generation', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Signature Key Generation',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testSignatureAddressFormat(): TestResult {
  const start = Date.now();
  try {
    const keyPair = generateKeyPair();
    const address = publicKeyToAddress(keyPair.publicKey);
    assertEquals(address, keyPair.address, 'Address from publicKey should match keyPair.address');
    assertEquals(address.slice(0, 2), '0x', 'Address should have 0x prefix');
    assertEquals(address.length, 42, 'Address should be 0x + 40 hex = 42 chars');
    const recovered = getPublicKeyFromPrivate(keyPair.privateKey);
    assertEquals(recovered.address, keyPair.address, 'Recovered address should match');
    return new TestResult('Signature Address Format', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Signature Address Format',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testSignatureSignVerifyRoundtrip(): TestResult {
  const start = Date.now();
  try {
    const keyPair = generateKeyPair();
    const message = 'hello world';
    const signature = signMessage(message, keyPair.privateKey);
    assertTrue(!!signature && signature.length >= 64, 'Signature should be non-empty hex');
    const valid = verifySignature(message, signature, keyPair.publicKey);
    assertTrue(valid, 'Verify should succeed for correct message/signature/publicKey');
    const invalidMsg = verifySignature('wrong message', signature, keyPair.publicKey);
    assertEquals(invalidMsg, false, 'Verify should fail for wrong message');
    const txData = getTransactionDataForSigning({ id: '1', from: '0xa', to: '0xb', amount: 1 });
    const txSig = signTransaction(txData, keyPair.privateKey);
    const txValid = verifyTransaction(txData, txSig, keyPair.publicKey);
    assertTrue(txValid, 'Transaction sign/verify roundtrip should succeed');
    return new TestResult('Signature Sign/Verify Roundtrip', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Signature Sign/Verify Roundtrip',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============= СМАРТ-КОНТРАКТ ТЕСТЫ =============

export function testWUNCoinContractCreation(): TestResult {
  const start = Date.now();
  try {
    // Contracts operate directly on the injected ContractState (single source of truth).
    const state: any = { owner: { balance: 1_000_000, nonce: 0 } };
    const contract = new WUNCoinContract('0xWUN', 'owner', state);

    assertEquals(contract.getAddress(), '0xWUN', 'Contract address should match');
    assertEquals(state['owner'].balance, 1_000_000, 'Owner should retain the initial supply in state');

    return new TestResult('WUNCoin Contract Creation', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'WUNCoin Contract Creation',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testWUNCoinTransfer(): TestResult {
  const start = Date.now();
  try {
    const state: any = { owner: { balance: 1_000_000, nonce: 0 } };
    const contract = new WUNCoinContract('0xWUN', 'owner', state);

    const ok = contract.transfer('owner', 'recipient', 250);
    assertTrue(ok, 'Transfer within balance should succeed');
    assertEquals(state['owner'].balance, 999_750, 'Sender balance should decrease');
    assertEquals(state['recipient'].balance, 250, 'Recipient should be initialized and credited');

    // A transfer exceeding the balance must fail and leave state untouched.
    const bad = contract.transfer('owner', 'recipient', 10_000_000);
    assertEquals(bad, false, 'Transfer exceeding balance should fail');
    assertEquals(state['owner'].balance, 999_750, 'Sender balance unchanged after failed transfer');

    return new TestResult('WUNCoin Transfer', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'WUNCoin Transfer',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testStakingContract(): TestResult {
  const start = Date.now();
  try {
    const state: any = { staker: { balance: 500, nonce: 0 } };
    const stakingContract = new StakingContract('0xSTAKE', 'staker', state);

    stakingContract.stake('staker', 200);
    assertEquals(state['staker'].balance, 300, 'Balance should decrease by the staked amount');
    assertEquals(state['staker'].storage['staked'], 200, 'Staked amount should be recorded in storage');

    // Staking more than the available balance is a no-op.
    stakingContract.stake('staker', 10_000);
    assertEquals(state['staker'].balance, 300, 'Balance unchanged when stake exceeds funds');
    assertEquals(state['staker'].storage['staked'], 200, 'Staked amount unchanged on failed stake');

    return new TestResult('Staking Contract', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Staking Contract',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============= НОВЫЕ ТЕСТЫ (EDGE-CASES) =============

export function testTransferInvalidAmount(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    const tx0: Transaction = {
      id: 'inv-0',
      from: 'TREASURY',
      to: 'user1',
      amount: 0,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };
    const result0 = blockchain.addTransaction(tx0);
    assertEquals(result0.success, false, 'Transfer with amount=0 should be rejected');

    const txNeg: Transaction = {
      id: 'inv-1',
      from: 'TREASURY',
      to: 'user1',
      amount: -1,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };
    const resultNeg = blockchain.addTransaction(txNeg);
    assertEquals(resultNeg.success, false, 'Transfer with amount=-1 should be rejected');

    return new TestResult('Transfer Invalid Amount', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Transfer Invalid Amount',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testBurnExceedsBalance(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // TREASURY starts with 1,000,000 — try to burn twice that
    const burnTx: Transaction = {
      id: 'burn-exceed',
      from: 'TREASURY',
      to: 'BURN',
      amount: 2_000_000,
      timestamp: Date.now(),
      nonce: 0,
      type: 'burn',
    };
    const result = blockchain.addTransaction(burnTx);
    assertEquals(result.success, false, 'Burn exceeding balance should be rejected');
    assertTrue(
      result.error !== undefined && result.error.includes('Insufficient balance'),
      'Error should mention insufficient balance'
    );

    return new TestResult('Burn Exceeds Balance', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Burn Exceeds Balance',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testMintNotTreasury(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    const mintTx: Transaction = {
      id: 'mint-not-treasury',
      from: 'user1',
      to: 'user2',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'mint',
    };
    const result = blockchain.addTransaction(mintTx);
    assertEquals(result.success, false, 'Mint from non-TREASURY address should be rejected');

    return new TestResult('Mint Not Treasury', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Mint Not Treasury',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testNonceReplay(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    const tx1: Transaction = {
      id: 'replay-0',
      from: 'TREASURY',
      to: 'user1',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };
    const result1 = blockchain.addTransaction(tx1);
    assertSuccess(result1, 'First TREASURY tx (nonce=0) should be accepted');
    blockchain.minePendingTransactions('miner');

    // After mining, TREASURY nonce is 1 — replaying nonce=0 must fail
    const tx2: Transaction = {
      id: 'replay-1',
      from: 'TREASURY',
      to: 'user2',
      amount: 50,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };
    const result2 = blockchain.addTransaction(tx2);
    assertEquals(result2.success, false, 'Replayed nonce=0 should be rejected after mining');

    return new TestResult('Nonce Replay Protection', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Nonce Replay Protection',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function testMineEmptyPool(): Promise<TestResult> {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    const result = await blockchain.minePendingTransactions('miner');
    assertEquals(result, null, 'Mining with empty pending pool should return null');

    return new TestResult('Mine Empty Pool', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Mine Empty Pool',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testMultipleBlocks(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    for (let i = 0; i < 3; i++) {
      const tx: Transaction = {
        id: `multi-${i}`,
        from: 'TREASURY',
        to: `user${i}`,
        amount: 100,
        timestamp: Date.now(),
        nonce: i,
        type: 'transfer',
      };
      const addResult = blockchain.addTransaction(tx);
      assertSuccess(addResult, `Transaction ${i} should be added`);
      blockchain.minePendingTransactions('miner');
    }

    const info = blockchain.getBlockchainInfo();
    assertEquals(info.chainLength, 4, 'Chain should have 4 blocks (genesis + 3 mined)');
    assertTrue(blockchain.isChainValid(), 'Chain should be valid after 3 mined blocks');

    return new TestResult('Multiple Blocks', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Multiple Blocks',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testAnchorNoBalanceChange(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();
    const balanceBefore = blockchain.getBalance('TREASURY');

    const anchorTx: Transaction = {
      id: 'anchor-0',
      from: 'TREASURY',
      to: 'ANCHOR',
      amount: 0,
      timestamp: Date.now(),
      nonce: 0,
      type: 'anchor',
    };
    const addResult = blockchain.addTransaction(anchorTx);
    assertSuccess(addResult, 'Anchor transaction should be accepted');

    // Mine with TREASURY as miner so reward goes back to TREASURY (net zero)
    blockchain.minePendingTransactions('TREASURY');

    const balanceAfter = blockchain.getBalance('TREASURY');
    assertEquals(
      balanceAfter,
      balanceBefore,
      'TREASURY balance should be unchanged after anchor tx (miner reward self-cancels)'
    );

    const state = blockchain.getContractState();
    assertEquals(state['TREASURY']?.nonce, 1, 'TREASURY nonce should be 1 after anchor tx is mined');

    return new TestResult('Anchor No Balance Change', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Anchor No Balance Change',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function testInvalidSignature(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();
    const userKeys = generateKeyPair();

    // Fund the user
    const fundTx: Transaction = {
      id: 'sig-fund',
      from: 'TREASURY',
      to: userKeys.address,
      amount: 500,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };
    blockchain.addTransaction(fundTx);
    blockchain.minePendingTransactions('miner');

    // Build a correctly structured tx but attach a garbage signature
    const tx: Transaction = {
      id: 'sig-bad',
      from: userKeys.address,
      to: 'user2',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      publicKey: userKeys.publicKey,
      type: 'transfer',
      signature: 'deadbeef'.repeat(16),
    };
    const result = blockchain.addTransaction(tx);
    assertEquals(result.success, false, 'Transaction with invalid signature should be rejected');

    return new TestResult('Invalid Signature', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Invalid Signature',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============= SECURE-BY-DEFAULT TREASURY SIGNATURE TEST =============

/**
 * Verifies the secure-by-default posture (Step 3.2): when
 * REQUIRE_TREASURY_SIGNATURE is NOT explicitly 'false', an unsigned TREASURY
 * transfer must be rejected. The module-level flag pinned to 'false' for the
 * other tests is temporarily removed here and restored afterwards.
 */
export function testTreasurySignatureRequiredByDefault(): TestResult {
  const start = Date.now();
  const prev = process.env.REQUIRE_TREASURY_SIGNATURE;
  try {
    // Simulate the production default: the env var is unset.
    delete process.env.REQUIRE_TREASURY_SIGNATURE;
    const blockchain = new WUNCoinBlockchain();

    const unsignedTreasuryTx: Transaction = {
      id: 'treasury-default-0',
      from: 'TREASURY',
      to: 'user1',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };
    const result = blockchain.addTransaction(unsignedTreasuryTx);
    assertEquals(
      result.success,
      false,
      'Unsigned TREASURY transfer must be rejected under the secure default'
    );
    assertTrue(
      result.error !== undefined && result.error.includes('must be signed'),
      'Rejection reason should require a signature'
    );

    // Opt-out for local dev (REQUIRE_TREASURY_SIGNATURE=false) re-enables bypass.
    process.env.REQUIRE_TREASURY_SIGNATURE = 'false';
    const devBlockchain = new WUNCoinBlockchain();
    const devResult = devBlockchain.addTransaction({
      id: 'treasury-dev-0',
      from: 'TREASURY',
      to: 'user1',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    });
    assertSuccess(devResult, 'TREASURY bypass must work when explicitly disabled');

    return new TestResult('Treasury Signature Required By Default', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Treasury Signature Required By Default',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    // Restore the module-level dev-mode flag so the remaining tests are unaffected.
    if (prev === undefined) process.env.REQUIRE_TREASURY_SIGNATURE = 'false';
    else process.env.REQUIRE_TREASURY_SIGNATURE = prev;
  }
}

// ============= PERSISTENCE REPLAY TESTS =============

/**
 * Builds a mock BlockchainPersistence that replays the given blocks.
 * ensureSchema/saveBlock are no-ops; loadBlocks returns the stored chain.
 */
function createMockPersistence(blocks: Block[]): BlockchainPersistence {
  return {
    ensureSchema: async () => {},
    loadBlocks: async () => blocks,
    saveBlock: async () => {},
    close: async () => {},
  } as unknown as BlockchainPersistence;
}

export async function testReplayPreservesMinerRewards(): Promise<TestResult> {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // Mine several blocks with distinct miner addresses.
    const miners = ['minerA', 'minerB', 'minerC'];
    for (let i = 0; i < miners.length; i++) {
      const miner = miners[i];
      if (!miner) continue;
      const tx: Transaction = {
        id: `reward-${i}`,
        from: 'TREASURY',
        to: `recipient${i}`,
        amount: 100,
        timestamp: Date.now(),
        nonce: i,
        type: 'transfer',
      };
      assertSuccess(blockchain.addTransaction(tx), `Funding tx ${i} should be added`);
      const result = await blockchain.minePendingTransactions(miner);
      assertTrue(result !== null, `Block ${i} should be mined`);
    }

    // Snapshot balances before the simulated restart.
    const treasuryBefore = blockchain.getBalance('TREASURY');
    const minersBefore = miners.map(m => blockchain.getBalance(m));
    const savedChain = blockchain.getChain();

    // Simulate a restart: rebuild state from persisted blocks.
    const mock = createMockPersistence(savedChain);
    const restored = await WUNCoinBlockchain.create(mock);

    assertEquals(
      restored.getBalance('TREASURY'),
      treasuryBefore,
      'TREASURY balance must match after replay (rewards must be redistributed)'
    );
    for (let i = 0; i < miners.length; i++) {
      const miner = miners[i];
      if (!miner) continue;
      assertEquals(
        restored.getBalance(miner),
        minersBefore[i],
        `Miner ${miner} balance must be preserved after replay`
      );
    }

    return new TestResult('Replay Preserves Miner Rewards', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Replay Preserves Miner Rewards',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function testReplayKeepsContractStateConnected(): Promise<TestResult> {
  const start = Date.now();
  try {
    // Build a one-block chain to replay.
    const source = new WUNCoinBlockchain();
    const fundTx: Transaction = {
      id: 'conn-0',
      from: 'TREASURY',
      to: 'seedUser',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };
    assertSuccess(source.addTransaction(fundTx), 'Seed tx should be added');
    assertTrue((await source.minePendingTransactions('seedMiner')) !== null, 'Seed block should be mined');

    const mock = createMockPersistence(source.getChain());
    const restored = await WUNCoinBlockchain.create(mock);

    // After replaying one TREASURY transfer, TREASURY nonce is 1.
    const transferTx: Transaction = {
      id: 'conn-1',
      from: 'TREASURY',
      to: 'connectedUser',
      amount: 50,
      timestamp: Date.now(),
      nonce: 1,
      type: 'transfer',
    };
    assertSuccess(restored.addTransaction(transferTx), 'Transfer after replay should be added');
    assertTrue(
      (await restored.minePendingTransactions('connMiner')) !== null,
      'Block after replay should be mined'
    );

    // If the contracts and kernel shared a stale/disconnected state object, the
    // kernel getBalance would not reflect the contract-applied transfer.
    assertEquals(
      restored.getBalance('connectedUser'),
      50,
      'Kernel must see the transfer applied via contract (state stays connected)'
    );

    return new TestResult('Replay Keeps Contract State Connected', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Replay Keeps Contract State Connected',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============= B1: PER-TX CONFIRM/FAIL TESTS =============

/**
 * Verifies that applyTransactions returns per-tx results and that a failing
 * transfer is correctly reported while a successful one in the same block is
 * confirmed (B1 fix).
 */
export async function testPerTxResultsMixedSuccessFailure(): Promise<TestResult> {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();

    // Submit tx1 that will drain TREASURY almost completely
    const tx1: Transaction = {
      id: 'b1-good',
      from: 'TREASURY',
      to: 'recipientA',
      amount: 999_999,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };
    assertSuccess(blockchain.addTransaction(tx1), 'tx1 should be accepted');

    // Submit tx2 that passes validation (TREASURY still shows 1M in state)
    // but will FAIL during application because tx1 drains the balance first.
    const tx2: Transaction = {
      id: 'b1-bad',
      from: 'TREASURY',
      to: 'recipientB',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'transfer',
    };
    assertSuccess(blockchain.addTransaction(tx2), 'tx2 should be accepted into pool');

    // Mine both in one block
    const result = await blockchain.minePendingTransactions('miner');
    assertTrue(result !== null, 'Block should be mined');
    assertEquals(result!.txResults.length, 2, 'Should have 2 txResults');

    const good = result!.txResults.find(r => r.txId === 'b1-good');
    const bad = result!.txResults.find(r => r.txId === 'b1-bad');

    assertTrue(good !== undefined, 'good tx result should exist');
    assertTrue(bad !== undefined, 'bad tx result should exist');
    assertEquals(good!.success, true, 'First transfer should succeed');
    assertEquals(bad!.success, false, 'Second transfer should fail (insufficient balance)');
    assertTrue(
      bad!.error !== undefined && bad!.error.includes('insufficient balance'),
      'Failed tx should report insufficient balance'
    );

    return new TestResult('Per-Tx Results Mixed Success/Failure', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Per-Tx Results Mixed Success/Failure',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============= 5.7: DETERMINISTIC GENESIS TESTS =============

/**
 * Verifies that two independent WUNCoinBlockchain.create() calls produce
 * identical genesis hashes (deterministic timestamp + chainId).
 */
export async function testDeterministicGenesisHash(): Promise<TestResult> {
  const start = Date.now();
  try {
    const bc1 = await WUNCoinBlockchain.create();
    const bc2 = await WUNCoinBlockchain.create();

    const genesis1 = bc1.getChain()[0]!;
    const genesis2 = bc2.getChain()[0]!;

    assertEquals(genesis1.timestamp, GENESIS_TIMESTAMP, 'Genesis timestamp should use GENESIS_TIMESTAMP constant');
    assertEquals(genesis2.timestamp, GENESIS_TIMESTAMP, 'Genesis timestamp should be identical on second instance');
    assertEquals(genesis1.hash, genesis2.hash, 'Genesis hash must be deterministic across instances');
    assertTrue(genesis1.hash.length === 64, 'Genesis hash should be a 64-char hex string');

    // Verify chainId is embedded in genesis metadata
    assertEquals(
      (genesis1.metadata as Record<string, unknown>)?.chainId,
      CHAIN_ID,
      'Genesis metadata should contain chainId'
    );

    return new TestResult('Deterministic Genesis Hash', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Deterministic Genesis Hash',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============= PHASE 4.4: DIFFICULTY RETARGETING TESTS =============

/**
 * Fast blocks (elapsed << expected) must push difficulty UP, saturating at
 * MAX_DIFFICULTY. Uses the pure retarget function so no mining is required.
 */
export function testDifficultyRetargetFastIncreases(): TestResult {
  const start = Date.now();
  try {
    const cfg = DIFFICULTY_DEFAULTS;
    const expectedElapsed = (cfg.retargetInterval - 1) * cfg.targetBlockIntervalMs;

    // Much faster than target => ratio clamps to maxAdjustFactorUp (4x).
    const fast = computeRetargetDifficulty(cfg, 4, 1_000, expectedElapsed);
    assertEquals(fast, cfg.maxDifficulty, 'Fast blocks should raise difficulty to MAX');

    // A single interval can never jump more than 4x before the [MIN,MAX] clamp:
    // from difficulty 2, a 4x factor lands on 6 (== MAX), never higher.
    const fromMin = computeRetargetDifficulty(cfg, 2, 1_000, expectedElapsed);
    assertTrue(fromMin <= cfg.maxDifficulty, 'Retarget must clamp to MAX_DIFFICULTY');
    assertTrue(fromMin > 2, 'Fast blocks should increase difficulty from the floor');

    // On-target timing keeps the difficulty stable.
    const stable = computeRetargetDifficulty(cfg, 4, expectedElapsed, expectedElapsed);
    assertEquals(stable, 4, 'On-target timing should keep difficulty unchanged');

    return new TestResult('Difficulty Retarget (fast => increase)', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Difficulty Retarget (fast => increase)',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Slow blocks (elapsed >> expected) must push difficulty DOWN, saturating at
 * MIN_DIFFICULTY.
 */
export function testDifficultyRetargetSlowDecreases(): TestResult {
  const start = Date.now();
  try {
    const cfg = DIFFICULTY_DEFAULTS;
    const expectedElapsed = (cfg.retargetInterval - 1) * cfg.targetBlockIntervalMs;

    // Much slower than target => ratio clamps to maxAdjustFactorDown (0.25x).
    const slow = computeRetargetDifficulty(cfg, 4, expectedElapsed * 1000, expectedElapsed);
    assertEquals(slow, cfg.minDifficulty, 'Slow blocks should drop difficulty to MIN');

    // From MAX, an extreme slowdown bottoms out at MIN and never below.
    const fromMax = computeRetargetDifficulty(cfg, cfg.maxDifficulty, expectedElapsed * 1000, expectedElapsed);
    assertEquals(fromMax, cfg.minDifficulty, 'Retarget must clamp to MIN_DIFFICULTY');

    // Non-positive elapsed time must not produce NaN/Infinity.
    const guard = computeRetargetDifficulty(cfg, 4, 0, expectedElapsed);
    assertTrue(Number.isFinite(guard), 'Retarget must be finite for zero elapsed time');

    return new TestResult('Difficulty Retarget (slow => decrease)', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Difficulty Retarget (slow => decrease)',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Build a synthetic version-2 block whose hash is a VALID Proof-of-Work for the
 * given difficulty (brute-forced via the exported `findNonce`). Used to prove
 * `isChainValid` rejects a difficulty that violates the retarget schedule even
 * when the block's own hash/PoW are internally consistent.
 */
function makeSyntheticV2Block(params: {
  index: number;
  timestamp: number;
  previousHash: string;
  txRoot: string;
  difficulty: number;
}): Block {
  const pow = findNonce({
    index: params.index,
    timestamp: params.timestamp,
    txRoot: params.txRoot,
    previousHash: params.previousHash,
    difficulty: params.difficulty,
    maxNonce: 5_000_000,
  });
  if (!pow) {
    throw new Error(`Could not mine synthetic block at difficulty ${params.difficulty}`);
  }
  return {
    index: params.index,
    timestamp: params.timestamp,
    transactions: [],
    previousHash: params.previousHash,
    hash: pow.hash,
    nonce: pow.nonce,
    miner: 'synthetic',
    difficulty: params.difficulty,
    version: 2,
    txRoot: params.txRoot,
  };
}

/**
 * isChainValid must accept a chain whose per-block difficulty matches the
 * retarget schedule and REJECT one where a block's difficulty was tampered
 * (even though the tampered block still has a valid PoW for its own value).
 */
export function testIsChainValidRejectsTamperedDifficulty(): TestResult {
  const start = Date.now();
  const prevInterval = process.env.RETARGET_INTERVAL_BLOCKS;
  const prevTarget = process.env.TARGET_BLOCK_INTERVAL_MS;
  const prevMin = process.env.MIN_DIFFICULTY;
  const prevMax = process.env.MAX_DIFFICULTY;
  const prevInitial = process.env.INITIAL_DIFFICULTY;
  try {
    // Small interval + on-target timing so the schedule keeps difficulty at the
    // initial value across the boundary, and low difficulty for a fast brute-force.
    process.env.RETARGET_INTERVAL_BLOCKS = '2';
    process.env.TARGET_BLOCK_INTERVAL_MS = '1000';
    process.env.MIN_DIFFICULTY = '2';
    process.env.MAX_DIFFICULTY = '6';
    process.env.INITIAL_DIFFICULTY = '2';

    const bc = new WUNCoinBlockchain();
    const genesis = bc.getChain()[0]!;
    const txRoot = '0'.repeat(64);
    const T = genesis.timestamp;

    // Block 1 (non-boundary) inherits genesis difficulty (2).
    const b1 = makeSyntheticV2Block({
      index: 1,
      timestamp: T + 1000,
      previousHash: genesis.hash,
      txRoot,
      difficulty: 2,
    });
    // Block 2 is a retarget boundary: elapsed == expected => difficulty stays 2.
    const b2Good = makeSyntheticV2Block({
      index: 2,
      timestamp: T + 2000,
      previousHash: b1.hash,
      txRoot,
      difficulty: 2,
    });

    assertEquals(bc.getExpectedDifficulty(2), 2, 'Schedule should keep difficulty at 2 on-target');

    (bc as unknown as { chain: Block[] }).chain = [genesis, b1, b2Good];
    (bc as unknown as { cachedValidity: unknown }).cachedValidity = null;
    assertTrue(bc.isChainValid(), 'Chain with schedule-consistent difficulty must be valid');

    // Tamper: same block but difficulty 3 (valid PoW for 3, wrong per schedule).
    const b2Bad = makeSyntheticV2Block({
      index: 2,
      timestamp: T + 2000,
      previousHash: b1.hash,
      txRoot,
      difficulty: 3,
    });
    (bc as unknown as { chain: Block[] }).chain = [genesis, b1, b2Bad];
    (bc as unknown as { cachedValidity: unknown }).cachedValidity = null;
    assertEquals(bc.isChainValid(), false, 'Chain with tampered difficulty must be rejected');

    return new TestResult('isChainValid rejects tampered difficulty', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'isChainValid rejects tampered difficulty',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    const restore = (name: string, prev: string | undefined): void => {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    };
    restore('RETARGET_INTERVAL_BLOCKS', prevInterval);
    restore('TARGET_BLOCK_INTERVAL_MS', prevTarget);
    restore('MIN_DIFFICULTY', prevMin);
    restore('MAX_DIFFICULTY', prevMax);
    restore('INITIAL_DIFFICULTY', prevInitial);
  }
}

// ============= PHASE 4.5: BATCH ECDSA OFFLOAD TESTS =============

/** Build `count` correctly-signed transfer transactions from fresh key pairs. */
function makeSignedTransactions(count: number): Transaction[] {
  const txs: Transaction[] = [];
  for (let i = 0; i < count; i++) {
    const kp = generateKeyPair();
    const tx: Transaction = {
      id: `batch-${i}`,
      from: kp.address,
      to: '0x' + 'b'.repeat(40),
      amount: i + 1,
      timestamp: 1_700_000_000_000 + i,
      nonce: 0,
      publicKey: kp.publicKey,
      type: 'transfer',
    };
    tx.signature = signTransaction(getTransactionDataForSigning(tx), kp.privateKey);
    txs.push(tx);
  }
  return txs;
}

/**
 * A batch larger than the threshold must verify correctly through the real
 * worker pool AND match the synchronous path result exactly (parity).
 */
export async function testBatchEcdsaOffloadParity(): Promise<TestResult> {
  const start = Date.now();
  const pool = new MiningPool(2);
  try {
    const txs = makeSignedTransactions(12); // > threshold (8)

    // Synchronous reference (no pool attached).
    const bcSync = new WUNCoinBlockchain();
    const syncResults = await bcSync.verifyTransactionSignatures(txs);

    // Pool path.
    const bcPool = new WUNCoinBlockchain();
    bcPool.initMiningPool(pool);
    const poolResults = await Promise.race([
      bcPool.verifyTransactionSignatures(txs),
      new Promise<boolean[]>((_, reject) =>
        setTimeout(() => reject(new Error('Pool verification timed out')), 20_000)
      ),
    ]);

    assertEquals(syncResults.length, txs.length, 'Sync result length must match input');
    assertEquals(poolResults.length, txs.length, 'Pool result length must match input');
    assertTrue(syncResults.every((r) => r === true), 'All sync signatures must verify');
    for (let i = 0; i < txs.length; i++) {
      assertEquals(poolResults[i], syncResults[i], `Parity mismatch at index ${i}`);
    }

    return new TestResult('Batch ECDSA offload parity (>8 tx)', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Batch ECDSA offload parity (>8 tx)',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    await pool.terminate();
  }
}

/**
 * Routing: a small batch (<= threshold) must use the synchronous path and never
 * touch the pool, while a large batch (> threshold) must be offloaded.
 */
export async function testBatchEcdsaThresholdRouting(): Promise<TestResult> {
  const start = Date.now();
  try {
    let poolCalled = false;
    const fakePool = {
      submitVerify: async (): Promise<boolean[]> => {
        poolCalled = true;
        return [];
      },
    } as unknown as MiningPool;

    const bc = new WUNCoinBlockchain();
    bc.initMiningPool(fakePool);

    // Small batch (5 <= 8): synchronous path, pool untouched, all verify.
    const small = makeSignedTransactions(5);
    const smallResults = await bc.verifyTransactionSignatures(small);
    assertEquals(poolCalled, false, 'Small batch must NOT be offloaded to the pool');
    assertEquals(smallResults.length, 5, 'Small batch result length');
    assertTrue(smallResults.every((r) => r === true), 'Small batch signatures must verify synchronously');

    // Large batch (12 > 8): offloaded to the pool.
    const large = makeSignedTransactions(12);
    await bc.verifyTransactionSignatures(large);
    assertEquals(poolCalled, true, 'Large batch must be offloaded to the pool');

    return new TestResult('Batch ECDSA threshold routing', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'Batch ECDSA threshold routing',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============= ЗАПУСК ТЕСТОВ =============

/**
 * Ordered registry of every legacy test function.
 *
 * Exported so the Vitest shim (`tests/legacy.test.ts`) runs the IDENTICAL suite
 * without duplicating the list — guaranteeing zero coverage drift between the
 * original ts-node runner (`runAllTests`) and `vitest run`. Both entry points
 * consume this single source of truth.
 */
export const legacyTests: Array<() => TestResult | Promise<TestResult>> = [
    testApiKeyAuthFailClosed,
    // Blockchain tests
    testBlockchainCreation,
    testAddTransaction,
    testTransactionValidation,
    testNonceValidation,
    testSignature,
    testNegativeBalance,
    testMineBlock,
    testBlockchainValidation,
    testGetBalance,
    testAddressHistory,
    // Signature (ECDSA) unit tests
    testSignatureKeyGeneration,
    testSignatureAddressFormat,
    testSignatureSignVerifyRoundtrip,
    // Smart contract tests
    testWUNCoinContractCreation,
    testWUNCoinTransfer,
    testStakingContract,
    // Edge-case tests
    testTransferInvalidAmount,
    testBurnExceedsBalance,
    testMintNotTreasury,
    testNonceReplay,
    testMineEmptyPool,
    testMultipleBlocks,
    testAnchorNoBalanceChange,
    testInvalidSignature,
    testTreasurySignatureRequiredByDefault,
    testTransferToUninitializedAddress,
    testMintToUninitializedAddress,
    testBridgeGenesisFunding,
    // Persistence replay tests
    testReplayPreservesMinerRewards,
    testReplayKeepsContractStateConnected,
    // B1: per-tx results
    testPerTxResultsMixedSuccessFailure,
    // 5.7: deterministic genesis
    testDeterministicGenesisHash,
    // Phase 4.4: difficulty retargeting
    testDifficultyRetargetFastIncreases,
    testDifficultyRetargetSlowDecreases,
    testIsChainValidRejectsTamperedDifficulty,
    // Phase 4.5: batch ECDSA offload
    testBatchEcdsaOffloadParity,
    testBatchEcdsaThresholdRouting,
    // Task 24: M1 (failed burn/stake must NOT be confirmed) + H5 (mint signature
    // policy + fixed-supply cap)
    testM1FailedBurnStakeNotConfirmed,
    testH5UnsignedTreasuryMintSignaturePolicy,
    testH5MintSupplyCap,
  ];

export async function runAllTests(): Promise<void> {
  console.log('🧪 WUNCoin Blockchain Test Suite\n');
  console.log('═'.repeat(60));

  const tests = legacyTests;

  const results: TestResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    const result = await test();
    results.push(result);

    const status = result.passed ? '✅' : '❌';
    const time = `${result.duration}ms`;

    console.log(`${status} ${result.name.padEnd(40)} ${time.padStart(10)}`);

    if (result.error) {
      console.log(`   ⚠️  ${result.error}\n`);
    }

    if (result.passed) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log('═'.repeat(60));
  console.log(`\n📊 Результаты: ${passed} успешно, ${failed} ошибок`);
  console.log(`⏱️  Общее время: ${results.reduce((a, b) => a + b.duration, 0)}ms\n`);

  if (failed === 0) {
    console.log('🎉 Все тесты пройдены успешно!\n');
  } else {
    console.log(`⚠️  ${failed} тестов не прошло\n`);
    process.exit(1);
  }
}

export function testTransferToUninitializedAddress(): TestResult {
  const start = Date.now();
  try {
    const state: any = { 'from_addr': { balance: 100, nonce: 0 } };
    // 'to_addr' intentionally absent from state
    const contract = new WUNCoinContract('addr', 'owner', state);
    // Should not throw — should initialize 'to_addr' and transfer
    const result = contract.transfer('from_addr', 'to_addr', 50);
    assert(result === true, 'transfer should succeed');
    assert(state['to_addr'] !== undefined, 'to_addr should be initialized');
    assert(state['to_addr'].balance === 50, 'to_addr balance should be 50');
    assert(state['from_addr'].balance === 50, 'from_addr balance should be 50');
    return new TestResult('Transfer to uninitialized address', true, Date.now() - start);
  } catch (error) {
    return new TestResult('Transfer to uninitialized address', false, Date.now() - start,
      error instanceof Error ? error.message : String(error));
  }
}

export function testMintToUninitializedAddress(): TestResult {
  const start = Date.now();
  try {
    const state: any = {};
    // 'recipient' intentionally absent from state
    const contract = new WUNCoinContract('addr', 'owner', state);
    // Should not throw — should initialize 'recipient' and mint
    contract.mint('recipient', 200);
    assert(state['recipient'] !== undefined, 'recipient should be initialized');
    assert(state['recipient'].balance === 200, 'recipient balance should be 200');
    return new TestResult('Mint to uninitialized address', true, Date.now() - start);
  } catch (error) {
    return new TestResult('Mint to uninitialized address', false, Date.now() - start,
      error instanceof Error ? error.message : String(error));
  }
}

export function testBridgeGenesisFunding(): TestResult {
  const start = Date.now();
  const prevBridge = process.env.BRIDGE_ADDRESS;
  const prevBalance = process.env.BRIDGE_GENESIS_BALANCE;
  try {
    const bridgeAddr = '0x366ed3cef7e0ef18a73f39f19771a64e1b7bbe8f';

    // With BRIDGE_ADDRESS set: TREASURY is reduced and BRIDGE is funded.
    process.env.BRIDGE_ADDRESS = bridgeAddr;
    process.env.BRIDGE_GENESIS_BALANCE = '100000';
    const withBridge = new WUNCoinBlockchain();
    assertEquals(withBridge.getBalance('TREASURY'), 900_000, 'TREASURY should be 900000 with bridge');
    assertEquals(withBridge.getBalance(bridgeAddr), 100_000, 'BRIDGE should be funded 100000');

    // Total supply must be conserved.
    assertEquals(
      withBridge.getBalance('TREASURY') + withBridge.getBalance(bridgeAddr),
      1_000_000,
      'Total supply must stay 1000000',
    );

    // Without BRIDGE_ADDRESS: genesis behaves as before (TREASURY=1000000).
    delete process.env.BRIDGE_ADDRESS;
    delete process.env.BRIDGE_GENESIS_BALANCE;
    const noBridge = new WUNCoinBlockchain();
    assertEquals(noBridge.getBalance('TREASURY'), 1_000_000, 'TREASURY should be full supply without bridge');

    return new TestResult('Bridge genesis funding', true, Date.now() - start);
  } catch (error) {
    return new TestResult('Bridge genesis funding', false, Date.now() - start,
      error instanceof Error ? error.message : String(error));
  } finally {
    if (prevBridge === undefined) delete process.env.BRIDGE_ADDRESS;
    else process.env.BRIDGE_ADDRESS = prevBridge;
    if (prevBalance === undefined) delete process.env.BRIDGE_GENESIS_BALANCE;
    else process.env.BRIDGE_GENESIS_BALANCE = prevBalance;
  }
}

// ============= TASK 24: M1 + H5 REGRESSION TESTS =============

/**
 * M1 — a FAILED burn/stake must NOT be falsely confirmed.
 *
 * `applyTransactions` used to check the boolean returned by `transfer` but
 * DISCARD the results of `burn` and `stake`, leaving `txSuccess=true`. That
 * incremented the sender nonce and marked the tx CONFIRMED even though no value
 * moved (undermining the B1 per-tx result fix). This white-box test drives the
 * protected `applyTransactions` directly with zero-balance burn/stake txs and
 * asserts each FAILS with the nonce and balance untouched, plus a funded-burn
 * sanity check that the happy path still succeeds.
 */
export function testM1FailedBurnStakeNotConfirmed(): TestResult {
  const start = Date.now();
  try {
    const blockchain = new WUNCoinBlockchain();
    // White-box access to the protected kernel method + state.
    const bc = blockchain as any;

    // --- Zero-balance BURN must FAIL, not be falsely confirmed (M1). ---
    const burnTx: Transaction = {
      id: 'm1-burn',
      from: 'burner',
      to: 'BURN',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'burn',
    };
    const burnResults = bc.applyTransactions([burnTx]);
    assertEquals(burnResults.length, 1, 'burn yields one result');
    assertEquals(burnResults[0].success, false, 'zero-balance burn must FAIL (M1)');
    assertTrue(
      typeof burnResults[0].error === 'string' && burnResults[0].error.length > 0,
      'failed burn carries a descriptive error'
    );
    assertEquals(bc.contractState['burner'].nonce, 0, 'burner nonce NOT incremented on failure');
    assertEquals(bc.contractState['burner'].balance, 0, 'burner balance unchanged');

    // --- Zero-balance STAKE must FAIL, not be falsely confirmed (M1). ---
    const stakeTx: Transaction = {
      id: 'm1-stake',
      from: 'staker0',
      to: 'staker0',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'stake',
    };
    const stakeResults = bc.applyTransactions([stakeTx]);
    assertEquals(stakeResults.length, 1, 'stake yields one result');
    assertEquals(stakeResults[0].success, false, 'zero-balance stake must FAIL (M1)');
    assertTrue(
      typeof stakeResults[0].error === 'string' && stakeResults[0].error.length > 0,
      'failed stake carries a descriptive error'
    );
    assertEquals(bc.contractState['staker0'].nonce, 0, 'staker0 nonce NOT incremented on failure');
    assertEquals(bc.contractState['staker0'].balance, 0, 'staker0 balance unchanged');

    // --- Sanity: a FUNDED burn still succeeds and increments the nonce, so the
    // M1 fix did not break the happy path. ---
    bc.contractState['rich'] = { balance: 500, nonce: 0 };
    const okBurn: Transaction = {
      id: 'm1-ok-burn',
      from: 'rich',
      to: 'BURN',
      amount: 100,
      timestamp: Date.now(),
      nonce: 0,
      type: 'burn',
    };
    const okResults = bc.applyTransactions([okBurn]);
    assertEquals(okResults[0].success, true, 'funded burn succeeds');
    assertEquals(bc.contractState['rich'].nonce, 1, 'successful burn increments nonce');
    assertEquals(bc.contractState['rich'].balance, 400, 'successful burn reduces balance');

    return new TestResult('M1: Failed Burn/Stake Not Confirmed', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'M1: Failed Burn/Stake Not Confirmed',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * H5 — an unsigned TREASURY `mint` must obey the signature policy.
 *
 * BEFORE the fix, THREE layers exempted `mint` from signatures, so
 * `POST /api/transactions {from:"TREASURY", type:"mint", amount:huge}` minted
 * arbitrary WUN with NO private key. Now a TREASURY mint follows the SAME
 * `REQUIRE_TREASURY_SIGNATURE` policy as every other TREASURY tx: rejected by
 * default (secure), allowed only under the explicit dev opt-out.
 */
export function testH5UnsignedTreasuryMintSignaturePolicy(): TestResult {
  const start = Date.now();
  const prev = process.env.REQUIRE_TREASURY_SIGNATURE;
  try {
    // --- Production default (env unset): unsigned TREASURY mint is REJECTED. ---
    delete process.env.REQUIRE_TREASURY_SIGNATURE;
    const secure = new WUNCoinBlockchain();
    const unsignedMint: Transaction = {
      id: 'h5-unsigned-mint',
      from: 'TREASURY',
      to: 'attacker',
      amount: 1_000_000,
      timestamp: Date.now(),
      nonce: 0,
      type: 'mint',
    };
    const rejected = secure.addTransaction(unsignedMint);
    assertEquals(rejected.success, false, 'unsigned TREASURY mint must be REJECTED by default (H5)');
    assertTrue(
      rejected.error !== undefined && rejected.error.includes('must be signed'),
      'rejection reason must require a signature'
    );
    assertEquals(secure.getBalance('attacker'), 0, 'attacker receives nothing');
    assertEquals(secure.getBalance('TREASURY'), 1_000_000, 'supply unchanged');

    // --- Explicit dev opt-out re-enables the unsigned TREASURY bypass. ---
    process.env.REQUIRE_TREASURY_SIGNATURE = 'false';
    const dev = new WUNCoinBlockchain();
    const allowed = dev.addTransaction({
      id: 'h5-optout-mint',
      from: 'TREASURY',
      to: 'recipient',
      amount: 10,
      timestamp: Date.now(),
      nonce: 0,
      type: 'mint',
    });
    assertSuccess(allowed, 'opt-out must allow an unsigned TREASURY mint submission');

    return new TestResult('H5: Unsigned TREASURY Mint Signature Policy', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'H5: Unsigned TREASURY Mint Signature Policy',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    if (prev === undefined) process.env.REQUIRE_TREASURY_SIGNATURE = 'false';
    else process.env.REQUIRE_TREASURY_SIGNATURE = prev;
  }
}

/**
 * H5 — `mint` must never raise the total supply above the fixed cap.
 *
 * Verified at BOTH levels: (a) the contract primitive refuses an over-cap mint
 * with no state change (boundary inclusive at the cap), and (b) the kernel —
 * whose genesis already issues the FULL fixed supply to TREASURY, so the chain
 * starts AT the cap — fails any mint transaction in `applyTransactions` without
 * crediting the recipient. `applyTransactions` is signature-agnostic (the cap is
 * enforced there), so no env opt-out is needed for part (b).
 */
export function testH5MintSupplyCap(): TestResult {
  const start = Date.now();
  try {
    // --- (a) Contract-level: the cap is a HARD ceiling on total supply. ---
    const state: any = { a: { balance: 600, nonce: 0 }, b: { balance: 300, nonce: 0 } };
    const capped = new WUNCoinContract('0xCAP', 'owner', state, 1000); // supply 900, cap 1000
    assertEquals(capped.totalSupply(), 900, 'total supply is the sum of balances');
    assertEquals(capped.mint('a', 200), false, 'over-cap mint must be refused');
    assertEquals(state['a'].balance, 600, 'refused mint must not change balances');
    assertEquals(capped.totalSupply(), 900, 'refused mint must not change supply');
    assertEquals(capped.mint('a', 100), true, 'at-cap mint (boundary) must be allowed');
    assertEquals(state['a'].balance, 700, 'allowed mint credits the recipient');
    assertEquals(capped.totalSupply(), 1000, 'supply now exactly at cap');
    assertEquals(capped.mint('b', 1), false, 'any mint above the cap is refused');
    assertEquals(state['b'].balance, 300, 'b balance unchanged after refused mint');

    // --- (b) Kernel-level: genesis issues the FULL supply, so ANY mint fails. ---
    const blockchain = new WUNCoinBlockchain();
    assertEquals(blockchain.getBalance('TREASURY'), 1_000_000, 'genesis TREASURY holds full supply');
    const mintTx: Transaction = {
      id: 'h5-cap-mint',
      from: 'TREASURY',
      to: 'attacker',
      amount: 500,
      timestamp: Date.now(),
      nonce: 0,
      type: 'mint',
    };
    const results = (blockchain as any).applyTransactions([mintTx]);
    assertEquals(results[0].success, false, 'mint above the fixed supply cap must FAIL (H5)');
    assertEquals(blockchain.getBalance('attacker'), 0, 'attacker receives nothing');
    assertEquals(blockchain.getBalance('TREASURY'), 1_000_000, 'TREASURY supply unchanged');

    return new TestResult('H5: Mint Supply Cap Enforced', true, Date.now() - start);
  } catch (error) {
    return new TestResult(
      'H5: Mint Supply Cap Enforced',
      false,
      Date.now() - start,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// Запуск если это основной модуль
if (require.main === module) {
  runAllTests().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
