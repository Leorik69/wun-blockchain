/**
 * WebSocket upgrade authentication for the blockchain event stream.
 *
 * Owns the handshake contract: origin allow-list + optional API-key gate
 * (feature-flagged via REQUIRE_WS_AUTH, default OFF).
 *
 * Security hardening (Task 25):
 *   - H2: the origin check is EXACT-match only. The former `startsWith`
 *     branch was bypassable with lookalike hosts such as
 *     `https://app.example.com.evil.com`.
 *   - H3: the request target is parsed WITHOUT `new URL(...)`, so a malformed
 *     `Host` header can no longer throw inside `verifyClient` (which the ws
 *     upgrade path would surface as an uncaughtException). Every parse is
 *     still wrapped in try/catch and rejects with 400 on failure.
 *   - L6: the API key is preferably carried in the `Sec-WebSocket-Protocol`
 *     header (`["wun-auth-v1", "<apikey>"]`) instead of the URL query string,
 *     which proxies/access logs record. `?key=` still works for backward
 *     compatibility but emits a one-shot deprecation warning, and the key
 *     comparison is constant-time via `crypto.timingSafeEqual`.
 */
import crypto from 'crypto';
import http from 'http';
import type { AppConfig } from '../config';

/** ws verifyClient callback signature. */
export type VerifyClientCallback = (res: boolean, code?: number, message?: string) => void;

/** Info object supplied by ws to `verifyClient`. */
export interface VerifyClientInfo {
  origin: string;
  req: http.IncomingMessage;
}

/**
 * Preferred auth subprotocol token (L6). The client offers
 * `["wun-auth-v1", "<apikey>"]`; the server selects `wun-auth-v1` and reads
 * the key from the adjacent subprotocol entry, keeping the secret out of the
 * URL (and therefore out of proxy/access logs).
 */
export const WS_AUTH_SUBPROTOCOL = 'wun-auth-v1';

/** Legacy subprotocol convention (`wun.auth.<key>`), kept for compatibility. */
export const WS_AUTH_LEGACY_PREFIX = 'wun.auth.';

/** One-shot guard for the `?key=` deprecation warning (never spam logs). */
let queryKeyDeprecationWarned = false;

/**
 * Select the auth subprotocol when the client offers one. Browsers abort the
 * handshake if an offered Sec-WebSocket-Protocol is not selected, so this
 * keeps subprotocol-based auth usable from browser/native clients. When no
 * auth subprotocol is offered, no protocol is selected (unchanged behaviour).
 *
 * Prefers the `wun-auth-v1` token (the key then travels as a SEPARATE
 * subprotocol entry); falls back to the legacy `wun.auth.<key>` token.
 */
export function handleProtocols(protocols: Set<string>): string | false {
  if (protocols.has(WS_AUTH_SUBPROTOCOL)) {
    return WS_AUTH_SUBPROTOCOL;
  }
  for (const protocol of protocols) {
    if (protocol.startsWith(WS_AUTH_LEGACY_PREFIX)) {
      return protocol;
    }
  }
  return false;
}

/**
 * Constant-time API-key comparison (L6). `timingSafeEqual` throws on
 * length-mismatched buffers, so lengths are checked first; the length of the
 * EXPECTED key is already public via configuration, and the mismatch branch
 * reveals nothing about the key's content.
 */
export function safeKeyEqual(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/** Split a (possibly comma-joined) Sec-WebSocket-Protocol header into tokens. */
function parseSubprotocolTokens(header: string | string[] | undefined): string[] {
  if (!header) return [];
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Extract the API key from the subprotocol header tokens:
 *   1. `["wun-auth-v1", "<apikey>"]` — preferred convention (L6).
 *   2. `wun.auth.<key>`               — legacy convention.
 */
function extractKeyFromSubprotocols(tokens: string[]): string | undefined {
  const v1Index = tokens.indexOf(WS_AUTH_SUBPROTOCOL);
  if (v1Index !== -1 && v1Index + 1 < tokens.length) {
    return tokens[v1Index + 1];
  }
  const legacy = tokens.find((token) => token.startsWith(WS_AUTH_LEGACY_PREFIX));
  return legacy ? legacy.slice(WS_AUTH_LEGACY_PREFIX.length) : undefined;
}

/**
 * Extract `?key=` from a request target WITHOUT full URL parsing (H3): the
 * raw query string is fed straight into URLSearchParams, so a malformed
 * `Host` header can never make this throw.
 */
function extractKeyFromQuery(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  const query = rawUrl.split('?')[1];
  if (!query) return undefined;
  const key = new URLSearchParams(query.split('#')[0]).get('key');
  return key ?? undefined;
}

/**
 * Build the `verifyClient` callback bound to the resolved config.
 *
 * - Origin check (H2): allow connections without an Origin header (native
 *   clients: Flutter, curl, etc.); otherwise require an EXACT match against
 *   the CORS allow-list (`*` allows every origin).
 * - API-key auth (feature-flagged via REQUIRE_WS_AUTH, default OFF): the key
 *   is read from the Sec-WebSocket-Protocol header (preferred) or, as a
 *   deprecated fallback, from `?key=...`. Comparison is constant-time.
 */
export function createVerifyClient(config: AppConfig) {
  return (info: VerifyClientInfo, callback: VerifyClientCallback): void => {
    const origin = info.origin;
    if (origin) {
      // H2: EXACT match only — `startsWith` allowed `https://app.example.com.evil.com`.
      const isAllowed = config.allowedOrigins.some(
        (allowed) => allowed === '*' || origin === allowed,
      );
      if (!isAllowed) {
        callback(false, 403, 'Origin not allowed');
        return;
      }
    }

    if (config.requireWsAuth) {
      const expectedKey = config.apiKey;
      if (!expectedKey) {
        callback(false, 503, 'WebSocket auth not configured');
        return;
      }

      let providedKey: string | undefined;
      let keyCameFromQuery = false;
      try {
        const tokens = parseSubprotocolTokens(info.req.headers['sec-websocket-protocol']);
        providedKey = extractKeyFromSubprotocols(tokens);
        if (!providedKey) {
          // Deprecated fallback (L6): the query string is recorded by proxies
          // and server access logs, so the subprotocol header is preferred.
          providedKey = extractKeyFromQuery(info.req.url);
          keyCameFromQuery = providedKey !== undefined;
        }
      } catch {
        // H3: never let handshake parsing escalate into an uncaughtException.
        callback(false, 400, 'Bad request');
        return;
      }

      if (keyCameFromQuery && !queryKeyDeprecationWarned) {
        queryKeyDeprecationWarned = true;
        console.warn(
          '[ws-auth] DEPRECATED: passing the API key via ?key= query parameter ' +
            'leaks it into proxy/access logs. Send Sec-WebSocket-Protocol: ' +
            '["wun-auth-v1", "<apikey>"] instead.',
        );
      }

      if (!providedKey || !safeKeyEqual(providedKey, expectedKey)) {
        callback(false, 401, 'Unauthorized');
        return;
      }
    }

    callback(true);
  };
}
