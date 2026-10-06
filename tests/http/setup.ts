/**
 * Shared harness for the WUNCoin HTTP contract tests.
 *
 * `src/server.ts` builds its Express app, HTTP server and WebSocket server at
 * import time and boots the blockchain asynchronously via
 * `WUNCoinBlockchain.create()`. The contract tests need the *real* route
 * handlers (so the snapshots reflect production behaviour), but importing the
 * module naively would leave a listening socket open and provide no way to
 * know when the async blockchain bootstrap finished.
 *
 * This harness solves both problems without touching `src/server.ts`:
 *   1. Pins environment variables BEFORE importing so the API-key gate stays
 *      permissive (non-production, no configured key) and no Postgres
 *      connection is attempted (in-memory chain only).
 *   2. Temporarily intercepts `http.createServer` to capture the server the
 *      module creates (and swallow any bind error), then restores the original
 *      factory so supertest can create its own ephemeral servers normally.
 *   3. Exposes helpers to fetch the app, wait for blockchain readiness and
 *      close the captured server during teardown.
 */
import http from 'node:http';
import type { Express } from 'express';
import request from 'supertest';
import { vi } from 'vitest';

// --- 0. Stub the `ws` module ------------------------------------------------
// `ws@8` resolves its ESM `import` condition to `wrapper.mjs`, whose default
// export is the bare WebSocket class WITHOUT the `.Server` static (that is only
// attached in the CJS `index.js` used by the ts-node/tsc production build).
// `src/server.ts` does `new WebSocket.Server(...)`, which therefore throws under
// Vitest's ESM resolution. The HTTP contract tests never touch WebSockets, so we
// provide a minimal stub that satisfies the constructor + `.on()` usage.
vi.mock('ws', () => {
  class MockWebSocketServer {
    public clients = new Set<unknown>();
    constructor(_opts?: unknown) {
      /* no real socket is opened during contract tests */
    }
    on(_event: string, _listener: (...args: unknown[]) => void): this {
      return this;
    }
    close(cb?: () => void): void {
      if (cb) cb();
    }
  }
  const WebSocketStub = class MockWebSocket {} as unknown as Record<string, unknown>;
  WebSocketStub.Server = MockWebSocketServer;
  WebSocketStub.WebSocketServer = MockWebSocketServer;
  return {
    default: WebSocketStub,
    WebSocket: WebSocketStub,
    WebSocketServer: MockWebSocketServer,
    Server: MockWebSocketServer,
  };
});

// --- 1. Deterministic, dependency-free test configuration -------------------
process.env.NODE_ENV = 'test';
// Uncommon port; the socket is closed during teardown and bind errors are
// swallowed, so a collision here never fails the suite.
if (!process.env.PORT) {
  process.env.PORT = '45999';
}
// Force an in-memory chain: no DATABASE_URL means no `pg` connection.
delete process.env.DATABASE_URL;
// No configured key + non-production => requireApiKey lets requests through.
delete process.env.BLOCKCHAIN_API_KEY;

// --- 2. Capture the HTTP server created by src/server.ts --------------------
let capturedServer: http.Server | undefined;
const httpAny = http as unknown as { createServer: (...args: unknown[]) => http.Server };
const originalCreateServer = httpAny.createServer;

httpAny.createServer = function patchedCreateServer(...args: unknown[]): http.Server {
  const srv = originalCreateServer.apply(http, args as []);
  capturedServer = srv;
  // Prevent an unhandled 'error' (e.g. EADDRINUSE) from crashing the worker.
  srv.on('error', () => {
    /* no-op: the socket is irrelevant to supertest-driven contract tests */
  });
  return srv;
};

let appPromise: Promise<Express> | undefined;

/**
 * Import the production server module exactly once and return its Express app.
 * `http.createServer` is restored immediately after import so supertest's own
 * servers are created with the untouched factory.
 */
export function getTestApp(): Promise<Express> {
  if (!appPromise) {
    appPromise = import('../../src/server').then((mod) => {
      httpAny.createServer = originalCreateServer;
      return mod.app as Express;
    });
  }
  return appPromise;
}

/**
 * Poll `/api/blockchain/info` until it stops returning 500. The route reads the
 * module-scoped `blockchain`, which is assigned inside the async bootstrap
 * promise; a 200 response is therefore a reliable readiness signal.
 */
export async function waitForBlockchainReady(app: Express, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const res = await request(app).get('/api/blockchain/info');
      lastStatus = res.status;
      if (res.status === 200) return;
    } catch {
      /* keep polling until the deadline */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Blockchain did not become ready within ${timeoutMs}ms (last status: ${lastStatus})`
  );
}

/** Close the HTTP server opened by the imported module (avoids open handles). */
export async function closeTestServer(): Promise<void> {
  httpAny.createServer = originalCreateServer;
  const srv = capturedServer;
  capturedServer = undefined;
  if (srv) {
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  }
}
