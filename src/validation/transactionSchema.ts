/**
 * Transaction validation + normalization for POST /api/transactions.
 *
 * Extracted verbatim from the inline body of the transaction route in the
 * monolithic `server.ts`. Every rejection keeps its original 400 status and
 * error string so the wire contract is unchanged.
 */
import type { Transaction } from "../blockchain";
import { validateTransactionMetadata } from "./metadataPolicy";

/** ECDSA address format: 0x + 40 hex chars (per BLOCKCHAIN_GUIDE). */
export const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

/** True when `value` is a well-formed 0x-prefixed 40-hex-char address. */
export function isValidAddress(value: string): boolean {
  return typeof value === "string" && ADDRESS_REGEX.test(value.trim());
}

/** Outcome of validating/normalizing an inbound transaction payload. */
export type TransactionValidationResult =
  | { ok: true; transaction: Transaction }
  | { ok: false; status: number; error: string };

/**
 * Validate the raw request body and, when valid, build the normalized
 * {@link Transaction} the kernel expects (defaults for id/timestamp, parsed
 * amount/nonce). Returns a rejection descriptor otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function validateAndNormalizeTransaction(body: any): TransactionValidationResult {
  const { id, timestamp, from, to, amount, type, nonce, signature, publicKey, metadata } = body;

  // Required-field validation.
  if (!from || !to || amount === undefined || !type || nonce === undefined) {
    return {
      ok: false,
      status: 400,
      error: "Missing required fields: from, to, amount, type, nonce",
    };
  }

  // Amount must be numeric.
  const parsedAmount = parseFloat(amount);
  if (!Number.isFinite(parsedAmount)) {
    return { ok: false, status: 400, error: "Invalid amount" };
  }

  // H5: `mint` is NO LONGER exempt from the HTTP signature gate. Every
  // non-TREASURY submission (including a mint) must be signed and carry
  // id/timestamp + a valid from-address. TREASURY submissions remain gated
  // authoritatively by the kernel's REQUIRE_TREASURY_SIGNATURE policy (see
  // `WUNCoinBlockchain.validateTransaction`), so an unsigned TREASURY mint is
  // rejected there unless the explicit dev opt-out is set.
  if (from !== "TREASURY") {
    if (!signature || !publicKey) {
      return {
        ok: false,
        status: 400,
        error: "Transaction must be signed (missing signature or publicKey)",
      };
    }

    // Signed transactions must carry client-provided id/timestamp so the
    // signature can be verified (the server would otherwise regenerate them).
    if (!id || !timestamp) {
      return {
        ok: false,
        status: 400,
        error: "Signed transaction must include id and timestamp",
      };
    }

    // ECDSA: from must be a valid address (0x + 40 hex).
    if (!isValidAddress(from)) {
      return {
        ok: false,
        status: 400,
        error: "Invalid from address: must be 0x followed by 40 hex characters",
      };
    }
  }

  // `to` must be valid when it looks like an address (0x...).
  if (to && to.startsWith("0x") && !isValidAddress(to)) {
    return {
      ok: false,
      status: 400,
      error: "Invalid to address: must be 0x followed by 40 hex characters",
    };
  }

  // Metadata is stored permanently, hashed into txRoot and covered by the
  // signature, so it is validated (never normalized) before it reaches the
  // kernel. See validation/metadataPolicy.ts for the bounds.
  const metadataError = validateTransactionMetadata(metadata, type);
  if (metadataError) {
    return { ok: false, status: 400, error: metadataError };
  }

  const transaction: Transaction = {
    id: id || `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    from,
    to,
    amount: parsedAmount,
    nonce: parseInt(nonce),
    timestamp: timestamp ? parseInt(timestamp) : Date.now(),
    signature,
    publicKey,
    type: type as "transfer" | "mint" | "burn" | "stake" | "anchor",
    metadata,
  };

  return { ok: true, transaction };
}
