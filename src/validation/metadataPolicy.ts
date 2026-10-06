/**
 * Metadata policy for inbound transactions.
 *
 * `metadata` is the only attacker-controlled blob that is stored permanently,
 * hashed into the block `txRoot` and covered by the sender signature. Anchors
 * need no balance and pay no fee, so an unchecked blob is a free way to stuff
 * the ledger with up to the whole request body (100 KB by default).
 *
 * Two rules govern the implementation:
 *  1. Bound shape and size: a flat object of primitive values, with caps on key
 *     count, key form, string length and total serialized bytes.
 *  2. NEVER normalize. The sender signed the exact bytes of the transaction
 *     (`getTransactionDataForSigning` stringifies the whole object minus the
 *     signature), so silently dropping keys, coercing NaN to null or reordering
 *     fields would break signature verification. Every violation is rejected.
 */

/** Maximum number of `metadata` keys. Existing producers use 2-9. */
export const METADATA_MAX_KEYS = 16;

/** Maximum length of a single `metadata` key. */
export const METADATA_MAX_KEY_LENGTH = 32;

/** Maximum length of a single string value. */
export const METADATA_MAX_STRING_LENGTH = 256;

/** Maximum length of `JSON.stringify(metadata)`. */
export const METADATA_MAX_SERIALIZED_BYTES = 2048;

/** Keys are restricted to snake_case identifiers to keep the on-chain vocabulary predictable. */
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Validates the free-form `metadata` blob of an inbound transaction.
 *
 * @param metadata raw value from the request body (may be absent)
 * @param txType transaction type; `anchor` additionally requires `anchor_version`
 * @returns a stable error string (HTTP 400 payload) or `null` when acceptable
 */
export function validateTransactionMetadata(metadata: unknown, txType: string): string | null {
  if (metadata === undefined || metadata === null) return null;

  const proto = typeof metadata === "object" ? Object.getPrototypeOf(metadata) : null;
  if (
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    (proto !== Object.prototype && proto !== null)
  ) {
    return "metadata must be a flat object of primitive values";
  }

  const source = metadata as Record<string, unknown>;
  const keys = Object.keys(source);

  if (keys.length > METADATA_MAX_KEYS) {
    return `metadata has too many keys (max ${METADATA_MAX_KEYS})`;
  }

  for (const key of keys) {
    if (key.length > METADATA_MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
      return `metadata has an invalid key: "${key}" (must be a flat object of snake_case names, max ${METADATA_MAX_KEY_LENGTH} chars)`;
    }

    const value = source[key];

    // JSON.stringify drops these entirely, which would desynchronize the
    // signed bytes from the stored bytes.
    if (value === undefined || typeof value === "function" || typeof value === "symbol") {
      return `metadata value for "${key}" is not serializable without loss`;
    }
    if (typeof value === "object") {
      return `metadata must be a flat object of primitive values: "${key}" is not a primitive`;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return `metadata value for "${key}" must be a finite number`;
    }
    if (typeof value === "string" && value.length > METADATA_MAX_STRING_LENGTH) {
      return `metadata value for "${key}" is too long (max ${METADATA_MAX_STRING_LENGTH} chars)`;
    }
  }

  const serialized = JSON.stringify(source) ?? "";
  if (serialized.length > METADATA_MAX_SERIALIZED_BYTES) {
    return `metadata is too large (${serialized.length} bytes, max ${METADATA_MAX_SERIALIZED_BYTES})`;
  }

  if (txType === "anchor") {
    const version = source.anchor_version;
    if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) {
      return "anchor metadata must carry a positive integer anchor_version";
    }
  }

  return null;
}
