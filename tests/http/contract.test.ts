/**
 * Golden-master HTTP contract tests for the WUNCoin blockchain API.
 *
 * These tests snapshot the *wire contract* of every REST route exposed by
 * `src/server.ts`: status codes, response envelope shape and payload keys.
 * They are the objective guard that future refactors preserve the JSON shape
 * clients (web, Flutter, blockchain-demo) depend on.
 *
 * The suite drives the REAL Express app through supertest (see ./setup.ts),
 * so the assertions below describe actual production behaviour rather than a
 * re-implementation. It runs independently of the legacy `npm test` runner:
 *   cd blockchain && npx vitest run
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, waitForBlockchainReady, closeTestServer } from "./setup";
import { createSystemController } from "../../src/controllers/system.controller";
import type { AppContext } from "../../src/context";

/** ECDSA address format: 0x + 40 hex chars. */
const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Blockchain API Contract Tests", () => {
  let app: Express;

  beforeAll(async () => {
    app = await getTestApp();
    // The blockchain boots asynchronously inside server.ts; wait until the
    // module-scoped instance is assigned and routes stop returning 500.
    await waitForBlockchainReady(app);
  });

  afterAll(async () => {
    await closeTestServer();
  });

  // ---------------------------------------------------------------- health --
  describe("GET /api/health", () => {
    it("returns the health envelope with the documented shape", async () => {
      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("status", "OK");
      expect(res.body).toHaveProperty("timestamp");
      expect(res.body).toHaveProperty("git_sha");
      expect(typeof res.body.timestamp).toBe("string");
    });
  });

  // --------------------------------------------------------------- version --
  describe("GET /api/version", () => {
    it("returns deploy identity under data", async () => {
      const res = await request(app).get("/api/version");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("data");
      expect(res.body.data).toHaveProperty("git_sha");
      expect(res.body.data).toHaveProperty("node_env");
      // Phase 8.4: additive OpenAPI schema-version field (never removes the
      // existing git_sha/node_env keys, so prior consumers are unaffected).
      expect(res.body.data).toHaveProperty("openapi");
      expect(typeof res.body.data.openapi).toBe("string");
    });
  });

  // --------------------------------------------------------- blockchain/info --
  describe("GET /api/blockchain/info", () => {
    it("returns chain info with the documented shape and types", async () => {
      const res = await request(app).get("/api/blockchain/info");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("data");
      expect(res.body.data).toHaveProperty("chainLength");
      expect(res.body.data).toHaveProperty("pendingTransactions");
      expect(res.body.data).toHaveProperty("difficulty");
      expect(res.body.data).toHaveProperty("validators");
      expect(res.body.data).toHaveProperty("consensus");
      expect(res.body.data).toHaveProperty("isValid");
      expect(typeof res.body.data.chainLength).toBe("number");
      expect(typeof res.body.data.pendingTransactions).toBe("number");
      expect(typeof res.body.data.difficulty).toBe("number");
      expect(typeof res.body.data.isValid).toBe("boolean");
      expect(Array.isArray(res.body.data.validators)).toBe(true);
      expect(res.body.data.consensus).toBe("POW");
    });
  });

  // -------------------------------------------------------- blockchain/chain --
  describe("GET /api/blockchain/chain", () => {
    it("returns the full chain with a per-block shape", async () => {
      const res = await request(app).get("/api/blockchain/chain");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("length");
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(typeof res.body.length).toBe("number");
      expect(res.body.length).toBe(res.body.data.length);

      // The genesis block always exists.
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      const block = res.body.data[0];
      expect(block).toHaveProperty("index");
      expect(block).toHaveProperty("timestamp");
      expect(block).toHaveProperty("transactions");
      expect(block).toHaveProperty("previousHash");
      expect(block).toHaveProperty("hash");
      expect(block).toHaveProperty("nonce");
      expect(block).toHaveProperty("miner");
      expect(block).toHaveProperty("difficulty");
      expect(Array.isArray(block.transactions)).toBe(true);
    });
  });

  // ------------------------------------------------------- blockchain/blocks --
  describe("GET /api/blockchain/blocks", () => {
    it("returns paginated blocks with a pagination envelope", async () => {
      const res = await request(app).get("/api/blockchain/blocks?limit=5");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("pagination");
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toHaveProperty("limit", 5);
      expect(res.body.pagination).toHaveProperty("count");
      expect(res.body.pagination).toHaveProperty("hasMore");
      expect(res.body.pagination).toHaveProperty("nextBefore");
      expect(res.body.pagination).toHaveProperty("totalBlocks");
      expect(typeof res.body.pagination.count).toBe("number");
      expect(typeof res.body.pagination.hasMore).toBe("boolean");
      expect(typeof res.body.pagination.totalBlocks).toBe("number");
    });

    it('rejects an invalid "before" parameter with a 400 error envelope', async () => {
      const res = await request(app).get("/api/blockchain/blocks?before=abc");
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
      expect(typeof res.body.error).toBe("string");
    });
  });

  // ------------------------------------------------ blockchain/chain/:index --
  describe("GET /api/blockchain/chain/:blockIndex", () => {
    it("returns the genesis block at index 0", async () => {
      const res = await request(app).get("/api/blockchain/chain/0");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("data");
      expect(res.body.data).toHaveProperty("index", 0);
      expect(res.body.data).toHaveProperty("hash");
      expect(res.body.data).toHaveProperty("previousHash", "0");
      expect(res.body.data).toHaveProperty("miner", "GENESIS");
      // 5.7: genesis block includes chainId metadata
      expect(res.body.data).toHaveProperty("metadata");
      expect(res.body.data.metadata).toHaveProperty("chainId");
    });

    it("returns 404 for a valid non-negative integer index that is out of range", async () => {
      const res = await request(app).get("/api/blockchain/chain/99999");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
    });

    // B3: non-integer and negative values return 400
    it('returns 400 for a non-integer block index (e.g. "abc")', async () => {
      const res = await request(app).get("/api/blockchain/chain/abc");
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
      expect(typeof res.body.error).toBe("string");
    });

    it("returns 400 for a negative block index", async () => {
      const res = await request(app).get("/api/blockchain/chain/-1");
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
      expect(typeof res.body.error).toBe("string");
    });

    it("returns 400 for a float block index", async () => {
      const res = await request(app).get("/api/blockchain/chain/1.5");
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
    });
  });

  // --------------------------------------------------- transactions/pending --
  describe("GET /api/transactions/pending", () => {
    it("returns the pending count envelope", async () => {
      const res = await request(app).get("/api/transactions/pending");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("pendingCount");
      expect(res.body).toHaveProperty("message");
      expect(typeof res.body.pendingCount).toBe("number");
    });
  });

  // ---------------------------------------------- transactions/:txId/status --
  describe("GET /api/transactions/:txId/status", () => {
    it("returns 404 for an unknown transaction id", async () => {
      const res = await request(app).get("/api/transactions/nonexistent-id/status");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
    });
  });

  // ------------------------------------------------- transactions/status/all --
  describe("GET /api/transactions/status/all", () => {
    it("returns the status summary envelope", async () => {
      const res = await request(app).get("/api/transactions/status/all");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("total");
      expect(res.body).toHaveProperty("pending");
      expect(res.body).toHaveProperty("confirmed");
      expect(res.body).toHaveProperty("failed");
      expect(res.body).toHaveProperty("statuses");
      expect(Array.isArray(res.body.statuses)).toBe(true);
      expect(typeof res.body.total).toBe("number");
      expect(typeof res.body.pending).toBe("number");
      expect(typeof res.body.confirmed).toBe("number");
      expect(typeof res.body.failed).toBe("number");
      // Pagination envelope (Step 3.5): default limit 50, offset 0.
      expect(res.body).toHaveProperty("pagination");
      expect(res.body.pagination).toHaveProperty("limit", 50);
      expect(res.body.pagination).toHaveProperty("offset", 0);
      expect(res.body.pagination).toHaveProperty("total");
      expect(typeof res.body.pagination.total).toBe("number");
      expect(res.body.pagination.total).toBe(res.body.total);
    });

    it("honours limit/offset query params and clamps the limit to 200", async () => {
      const res = await request(app).get("/api/transactions/status/all?limit=500&offset=0");
      expect(res.status).toBe(200);
      expect(res.body.pagination).toHaveProperty("limit", 200);
      expect(res.body.statuses.length).toBeLessThanOrEqual(200);
    });
  });

  // --------------------------------------------------------- balance/:addr --
  describe("GET /api/balance/:address", () => {
    it("returns balance and nonce for TREASURY", async () => {
      const res = await request(app).get("/api/balance/TREASURY");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("address", "TREASURY");
      expect(res.body).toHaveProperty("balance");
      expect(res.body).toHaveProperty("nonce");
      expect(typeof res.body.balance).toBe("number");
      expect(typeof res.body.nonce).toBe("number");
    });

    it("returns a zero balance for an unknown address", async () => {
      const res = await request(app).get("/api/balance/UNKNOWN_ADDRESS");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("balance", 0);
      expect(res.body).toHaveProperty("nonce", 0);
    });
  });

  // ------------------------------------------------- address/:addr/history --
  describe("GET /api/address/:address/history", () => {
    it("returns the transaction history envelope", async () => {
      const res = await request(app).get("/api/address/TREASURY/history");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("address", "TREASURY");
      expect(res.body).toHaveProperty("transactions");
      expect(res.body).toHaveProperty("count");
      expect(Array.isArray(res.body.transactions)).toBe(true);
      expect(typeof res.body.count).toBe("number");
      expect(res.body.count).toBe(res.body.transactions.length);
      // Pagination envelope (Step 3.5): default limit 50, offset 0.
      expect(res.body).toHaveProperty("pagination");
      expect(res.body.pagination).toHaveProperty("limit", 50);
      expect(res.body.pagination).toHaveProperty("offset", 0);
      expect(res.body.pagination).toHaveProperty("total");
      expect(typeof res.body.pagination.total).toBe("number");
    });
  });

  // --------------------------------------------------- keys/generate (prot.) --
  describe("POST /api/keys/generate (protected)", () => {
    it("returns a key pair in dev/test mode (no API key configured)", async () => {
      const res = await request(app).post("/api/keys/generate");
      // Non-production + no configured key => the gate allows the request.
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("keyPair");
      expect(res.body).toHaveProperty("message");
      expect(res.body.keyPair).toHaveProperty("privateKey");
      expect(res.body.keyPair).toHaveProperty("publicKey");
      expect(res.body.keyPair).toHaveProperty("address");
      expect(res.body.keyPair.address).toMatch(ADDRESS_REGEX);
    });
  });

  // ------------------------------------------------ transactions/sign (prot.) --
  describe("POST /api/transactions/sign (protected)", () => {
    it("rejects a request missing transaction/privateKey", async () => {
      const res = await request(app).post("/api/transactions/sign").send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
      expect(typeof res.body.error).toBe("string");
    });
  });

  // --------------------------------------------------- transactions (prot.) --
  describe("POST /api/transactions (protected)", () => {
    it("rejects an empty body with the missing-fields error", async () => {
      const res = await request(app).post("/api/transactions").send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
      expect(typeof res.body.error).toBe("string");
    });

    it("rejects oversized metadata with a metadata-specific 400", async () => {
      const res = await request(app)
        .post("/api/transactions")
        .send({
          id: "tx_big_meta",
          timestamp: 1730000000000,
          from: "0x" + "a".repeat(40),
          to: "0x" + "b".repeat(40),
          amount: 1,
          type: "transfer",
          nonce: 0,
          signature: "ab",
          publicKey: "04" + "c".repeat(128),
          metadata: { blob: "x".repeat(4096) },
        });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("success", false);
      expect(String(res.body.error)).toMatch(/metadata/);
    });

    it("rejects an anchor whose metadata carries no anchor_version", async () => {
      const res = await request(app)
        .post("/api/transactions")
        .send({
          id: "tx_anchor_no_version",
          timestamp: 1730000000000,
          from: "0x" + "a".repeat(40),
          to: "ANCHOR",
          amount: 0,
          type: "anchor",
          nonce: 0,
          signature: "ab",
          publicKey: "04" + "c".repeat(128),
          metadata: { batch_hash: "cd" },
        });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/anchor_version/);
    });

    it("rejects an unsigned transfer with a signature error", async () => {
      const res = await request(app)
        .post("/api/transactions")
        .send({
          from: "0x" + "a".repeat(40),
          to: "0x" + "b".repeat(40),
          amount: 1,
          type: "transfer",
          nonce: 0,
        });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
    });
  });

  // ---------------------------------------------------- mining/mine (prot.) --
  describe("POST /api/mining/mine (protected)", () => {
    it("rejects a request without minerAddress", async () => {
      const res = await request(app).post("/api/mining/mine").send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
    });

    it("rejects mining when the pending pool is empty", async () => {
      const res = await request(app)
        .post("/api/mining/mine")
        .send({ minerAddress: "0x" + "c".repeat(40) });
      // No pending transactions => nothing to mine.
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
    });
  });

  // ------------------------------------------------------- validate (prot.) --
  describe("POST /api/validate (protected)", () => {
    it("validates the chain and returns the isValid envelope", async () => {
      const res = await request(app).post("/api/validate");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("isValid");
      expect(res.body).toHaveProperty("message");
      expect(typeof res.body.isValid).toBe("boolean");
      expect(res.body.isValid).toBe(true);
    });
  });

  // ----------------------------------------------------------- logs (prot.) --
  describe("GET /api/logs (protected)", () => {
    it("returns the logs envelope", async () => {
      const res = await request(app).get("/api/logs");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("count");
      expect(res.body).toHaveProperty("logs");
      expect(typeof res.body.count).toBe("number");
      expect(Array.isArray(res.body.logs)).toBe(true);
      expect(res.body.count).toBe(res.body.logs.length);
    });

    it("honours the limit query parameter", async () => {
      const res = await request(app).get("/api/logs?limit=1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body.logs.length).toBeLessThanOrEqual(1);
    });
  });

  describe("GET /api/logs/stats (protected)", () => {
    it("returns the logging statistics envelope", async () => {
      const res = await request(app).get("/api/logs/stats");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("stats");
      expect(res.body.stats).toHaveProperty("total");
      expect(res.body.stats).toHaveProperty("byLevel");
      expect(typeof res.body.stats.total).toBe("number");
    });
  });

  describe("POST /api/logs/export (protected)", () => {
    it("returns a downloadable JSON export", async () => {
      const res = await request(app).post("/api/logs/export");
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toMatch(/attachment; filename="blockchain-logs-/);
      // Body is the exported log array (JSON string parsed by supertest).
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /api/logs/clear (protected)", () => {
    it("clears the log buffer and returns a confirmation", async () => {
      const res = await request(app).post("/api/logs/clear");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("message");

      // After clearing, the logs endpoint reports an empty buffer.
      const after = await request(app).get("/api/logs");
      expect(after.body).toHaveProperty("count", 0);
    });
  });

  // ------------------------------------------------------------ error shape --
  describe("Error envelope format", () => {
    it("returns 404 for an unknown route", async () => {
      const res = await request(app).get("/api/nonexistent");
      expect(res.status).toBe(404);
    });

    it("uses a consistent { success:false, error } envelope for handled errors", async () => {
      // B3: negative index is now 400 (bad input), not 404
      const res = await request(app).get("/api/blockchain/chain/-1");
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("success", false);
      expect(res.body).toHaveProperty("error");
      expect(typeof res.body.error).toBe("string");
    });
  });

  // ------------------------------------------------- health/ready (Phase 6.6) --
  describe("GET /api/health/ready", () => {
    it("returns 200 with a readiness body when the in-memory chain is booted", async () => {
      const res = await request(app).get("/api/health/ready");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "ready");
      expect(res.body).toHaveProperty("checks");
      expect(res.body.checks).toHaveProperty("blockchainBooted", true);
      expect(res.body).toHaveProperty("timestamp");
      expect(typeof res.body.timestamp).toBe("string");
    });
  });

  // ------------------------------------------------------ metrics (Phase 6.6) --
  describe("GET /api/metrics", () => {
    it("returns Prometheus text format with registered metric names", async () => {
      const res = await request(app).get("/api/metrics");
      // In test mode no API key is configured, so the gate is permissive.
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      const body = res.text as string;
      // Spot-check a few registered metric families.
      expect(body).toContain("wun_http_request_duration_seconds");
      expect(body).toContain("wun_chain_height");
      expect(body).toContain("wun_mempool_size");
    });
  });

  // ------------------------------------- readiness 503 (dependency not ready) --
  describe("readiness controller (503 path)", () => {
    it("returns 503 not_ready when the write path reports degraded", () => {
      // The live in-memory app is always ready, so exercise the not-ready branch
      // by driving the controller with a mock context whose blockchain reports a
      // degraded write path (the signal it would surface when Postgres is down).
      const mockBlockchain = {
        writeDegraded: true,
        getMiningPool: () => null,
      };
      const mockCtx = { blockchain: mockBlockchain } as unknown as AppContext;
      const ctrl = createSystemController(mockCtx);

      let statusCode = 0;
      let payload: { status?: string; checks?: Record<string, boolean> } = {};
      const res = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(body: typeof payload) {
          payload = body;
          return this;
        },
      };
      ctrl.readiness(
        {} as Parameters<typeof ctrl.readiness>[0],
        res as unknown as Parameters<typeof ctrl.readiness>[1],
        () => {}
      );

      expect(statusCode).toBe(503);
      expect(payload.status).toBe("not_ready");
      expect(payload.checks?.writeHealthy).toBe(false);
    });

    it("returns 503 not_ready when the blockchain kernel has not booted", () => {
      const mockCtx = { blockchain: undefined } as unknown as AppContext;
      const ctrl = createSystemController(mockCtx);

      let statusCode = 0;
      let payload: { status?: string; checks?: Record<string, boolean> } = {};
      const res = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(body: typeof payload) {
          payload = body;
          return this;
        },
      };
      ctrl.readiness(
        {} as Parameters<typeof ctrl.readiness>[0],
        res as unknown as Parameters<typeof ctrl.readiness>[1],
        () => {}
      );

      expect(statusCode).toBe(503);
      expect(payload.status).toBe("not_ready");
      expect(payload.checks?.blockchainBooted).toBe(false);
    });
  });
});
