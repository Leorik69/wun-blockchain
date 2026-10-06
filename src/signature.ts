/**
 * ECDSA signature utilities for WUNCoin blockchain.
 *
 * Canonical address derivation: sha256(UTF-8 hex string of public key)[0:20].
 * See @wun/blockchain-crypto for the shared implementation.
 * This file is kept as the authoritative backend implementation;
 * the shared package mirrors it for frontend consumers.
 *
 * Реализует ECDSA подписи для транзакций
 * - Генерация пар ключей (приватный/публичный)
 * - Подпись транзакций
 * - Верификация подписей
 * - Вывод адреса из публичного ключа
 */

import crypto from 'node:crypto';
import * as secp from '@noble/secp256k1';

secp.hashes.sha256 = (msg) => new Uint8Array(crypto.createHash('sha256').update(msg).digest());
secp.hashes.hmacSha256 = (key, msg) =>
  new Uint8Array(crypto.createHmac('sha256', Buffer.from(key)).update(msg).digest());

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("Invalid hex");
  }
  return new Uint8Array(Buffer.from(clean, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export interface KeyPair {
  privateKey: string;
  publicKey: string;
  address: string;
}

/**
 * Генерирует новую пару ключей (приватный и публичный)
 */
export function generateKeyPair(): KeyPair {
  const secretKey = secp.utils.randomSecretKey();
  const publicKeyBytes = secp.getPublicKey(secretKey, false);
  const privateKey = bytesToHex(secretKey);
  const publicKey = bytesToHex(publicKeyBytes);
  const address = publicKeyToAddress(publicKey);

  return {
    privateKey,
    publicKey,
    address,
  };
}

/**
 * Преобразует публичный ключ в адрес
 * Адрес = первые 20 байт хеша SHA-256 публичного ключа
 *
 * CANONICAL: hashes the UTF-8 hex STRING of the public key (not raw bytes).
 * `crypto.createHash('sha256').update(publicKey)` treats the string as UTF-8.
 * Frontend/Flutter MUST match this — see @wun/blockchain-crypto.
 */
export function publicKeyToAddress(publicKey: string): string {
  const hash = crypto.createHash('sha256').update(publicKey).digest();
  const address = hash.slice(0, 20).toString('hex');
  return `0x${address}`;
}

/**
 * Получает публичный ключ и адрес из приватного ключа
 */
export function getPublicKeyFromPrivate(privateKey: string): { publicKey: string; address: string } {
  const secretKey = hexToBytes(privateKey);
  const publicKey = bytesToHex(secp.getPublicKey(secretKey, false));
  const address = publicKeyToAddress(publicKey);
  return { publicKey, address };
}

/**
 * Подписывает сообщение приватным ключом
 */
export function signMessage(message: string, privateKey: string): string {
  try {
    const secretKey = hexToBytes(privateKey);
    const messageHash = new Uint8Array(crypto.createHash('sha256').update(message).digest());
    const sigDer = secp.sign(messageHash, secretKey, { prehash: false, format: "der" });
    return bytesToHex(sigDer);
  } catch (error) {
    throw new Error(`Failed to sign message: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Проверяет подпись сообщения с использованием публичного ключа
 */
export function verifySignature(message: string, signature: string, publicKey: string): boolean {
  try {
    const pub = hexToBytes(publicKey);
    const messageHash = new Uint8Array(crypto.createHash('sha256').update(message).digest());
    const sigHex = typeof signature === "string" ? signature.trim() : String(signature);
    if (!/^[0-9a-fA-F]+$/.test(sigHex)) return false;
    const sigBytes = hexToBytes(sigHex);
    const format = sigHex.length === 128 ? "compact" : "der";
    return secp.verify(sigBytes, messageHash, pub, { prehash: false, format });
  } catch (error) {
    console.error('Signature verification failed:', error);
    return false;
  }
}

/**
 * Подписывает транзакцию
 */
export function signTransaction(transactionData: string, privateKey: string): string {
  return signMessage(transactionData, privateKey);
}

/**
 * Проверяет подпись транзакции
 */
export function verifyTransaction(transactionData: string, signature: string, publicKey: string): boolean {
  return verifySignature(transactionData, signature, publicKey);
}

/**
 * Генерирует канонический формат транзакции для подписания
 * (исключает саму подпись из данных для подписи)
 */
export function getTransactionDataForSigning(transaction: object): string {
  const rec = transaction as Record<string, unknown>;
  const { signature: _sig, ...txWithoutSignature } = rec;
  return JSON.stringify(txWithoutSignature);
}
