/**
 * Metadata policy for inbound transactions.
 *
 * `metadata` is the only attacker-controlled blob that gets (a) stored
 * permanently, (b) hashed into the block `txRoot` and (c) covered by the sender
 * signature, yet the HTTP layer used to pass it through without any check —
 * a free way to stuff 100 KB per transaction into the ledger (anchors need no
 * balance and pay no fee).
 *
 * Two rules shape the policy:
 *  1. Bound shape and size (flat object, primitive values, hard byte cap).
 *  2. NEVER normalize. Any transformation (dropping keys, reordering, turning
 *     NaN into null) changes the bytes the client signed and would break ECDSA
 *     verification downstream, so every violation is a rejection, not a fixup.
 */
import { describe, expect, it } from "vitest";

import {
  METADATA_MAX_KEYS,
  METADATA_MAX_SERIALIZED_BYTES,
  METADATA_MAX_STRING_LENGTH,
  validateTransactionMetadata,
} from "../../src/validation/metadataPolicy";
import { validateAndNormalizeTransaction } from "../../src/validation/transactionSchema";

const FROM = `0x${"a".repeat(40)}`;
const TO = `0x${"b".repeat(40)}`;

/** A schema-valid signed body; the HTTP layer only checks presence/format of signature fields. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function signedBody(overrides: Record<string, any> = {}): any {
  return {
    id: "tx_metadata_1",
    timestamp: "1700000000000",
    from: FROM,
    to: TO,
    amount: 1,
    type: "transfer",
    nonce: 0,
    signature: "abcd",
    publicKey: `04${"c".repeat(128)}`,
    ...overrides,
  };
}

/** Shape produced by supabase/functions/wun-anchoring. */
const LEDGER_ANCHOR_METADATA = {
  anchor_version: 1,
  batch_hash: "f".repeat(64),
  batch_size: 128,
  range_start_created_at: "2026-10-01T00:00:00+00:00",
  range_end_created_at: "2026-10-02T00:00:00+00:00",
  supabase_env: "production",
  anchor_id: "3f2b1c9a-7d4e-4b21-9a6f-1234567890ab",
};

/** Shape produced by supabase/functions/wun-civic-anchoring. */
const CIVIC_ANCHOR_METADATA = {
  ...LEDGER_ANCHOR_METADATA,
  batch_kind: "civic_receipt",
  merkle_root: "a".repeat(64),
};

/** Shape produced by supabase/functions/wun-withdrawals (a transfer, not an anchor). */
const WITHDRAWAL_METADATA = {
  withdrawal_id: "9c1d2e3f-1111-4aaa-8bbb-222233334444",
  user_id: "9c1d2e3f-1111-4aaa-8bbb-222233335555",
};

describe("validateTransactionMetadata", () => {
  it("accepts every metadata shape the existing edge functions produce", () => {
    expect(validateTransactionMetadata(LEDGER_ANCHOR_METADATA, "anchor")).toBeNull();
    expect(validateTransactionMetadata(CIVIC_ANCHOR_METADATA, "anchor")).toBeNull();
    expect(validateTransactionMetadata(WITHDRAWAL_METADATA, "transfer")).toBeNull();
  });

  it("treats absent metadata as valid", () => {
    expect(validateTransactionMetadata(undefined, "transfer")).toBeNull();
    expect(validateTransactionMetadata(null, "transfer")).toBeNull();
    expect(validateTransactionMetadata({}, "transfer")).toBeNull();
  });

  it("rejects metadata that is not a plain object", () => {
    expect(validateTransactionMetadata([], "transfer")).toMatch(/flat object/);
    expect(validateTransactionMetadata("hello", "transfer")).toMatch(/flat object/);
    expect(validateTransactionMetadata(42, "transfer")).toMatch(/flat object/);
    expect(validateTransactionMetadata(true, "transfer")).toMatch(/flat object/);
  });

  it("rejects nested values instead of flattening them", () => {
    expect(validateTransactionMetadata({ nested: { a: 1 } }, "transfer")).toMatch(/flat object/);
    expect(validateTransactionMetadata({ list: [1, 2] }, "transfer")).toMatch(/flat object/);
  });

  it("rejects values that JSON would silently rewrite, because the signature covers them", () => {
    expect(validateTransactionMetadata({ bad: Number.NaN }, "transfer")).toMatch(/finite number/);
    expect(validateTransactionMetadata({ bad: Number.POSITIVE_INFINITY }, "transfer")).toMatch(
      /finite number/
    );
    expect(validateTransactionMetadata({ bad: undefined }, "transfer")).toMatch(/not serializable/);
    expect(validateTransactionMetadata({ bad: () => 1 }, "transfer")).toMatch(/not serializable/);
  });

  it("rejects keys that are not snake_case identifiers", () => {
    expect(validateTransactionMetadata({ "Bad Key": 1 }, "transfer")).toMatch(/invalid key/);
    expect(validateTransactionMetadata({ "9lead": 1 }, "transfer")).toMatch(/invalid key/);
    expect(validateTransactionMetadata({ camelCase: 1 }, "transfer")).toMatch(/invalid key/);
  });

  it("bounds key count, string length and total serialized size", () => {
    const tooMany: Record<string, number> = {};
    for (let i = 0; i < METADATA_MAX_KEYS + 1; i += 1) tooMany[`k_${i}`] = 1;
    expect(validateTransactionMetadata(tooMany, "transfer")).toMatch(/too many keys/);

    const longString: Record<string, string> = { note: "x".repeat(METADATA_MAX_STRING_LENGTH + 1) };
    expect(validateTransactionMetadata(longString, "transfer")).toMatch(/too long/);

    const fat: Record<string, string> = {};
    for (let i = 0; i < METADATA_MAX_KEYS; i += 1) {
      fat[`k_${i}`] = "x".repeat(METADATA_MAX_STRING_LENGTH);
    }
    expect(JSON.stringify(fat).length).toBeGreaterThan(METADATA_MAX_SERIALIZED_BYTES);
    expect(validateTransactionMetadata(fat, "anchor")).toMatch(/too large/);
  });

  it("requires anchor_version on anchors only", () => {
    expect(validateTransactionMetadata({ batch_hash: "x" }, "anchor")).toMatch(/anchor_version/);
    expect(validateTransactionMetadata({}, "transfer")).toBeNull();
    expect(validateTransactionMetadata({ anchor_version: 1 }, "anchor")).toBeNull();
    expect(validateTransactionMetadata({ anchor_version: "one" }, "anchor")).toMatch(
      /anchor_version/
    );
  });
});

describe("validateAndNormalizeTransaction metadata gate", () => {
  it("passes valid metadata through untouched (byte-identical for the signature)", () => {
    const result = validateAndNormalizeTransaction(signedBody({ metadata: WITHDRAWAL_METADATA }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transaction.metadata).toEqual(WITHDRAWAL_METADATA);
      expect(JSON.stringify(result.transaction.metadata)).toBe(JSON.stringify(WITHDRAWAL_METADATA));
    }
  });

  it("rejects oversized metadata with 400 and a metadata-specific error", () => {
    const fat: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) fat[`k_${i}`] = "x".repeat(METADATA_MAX_STRING_LENGTH);
    const result = validateAndNormalizeTransaction(signedBody({ metadata: fat }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/metadata/);
    }
  });

  it("rejects an anchor whose metadata has no anchor_version", () => {
    const result = validateAndNormalizeTransaction(
      signedBody({ type: "anchor", amount: 0, metadata: { batch_hash: "x" } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/anchor_version/);
    }
  });

  it("still accepts a transaction with no metadata at all", () => {
    const result = validateAndNormalizeTransaction(signedBody());
    expect(result.ok).toBe(true);
  });
});
