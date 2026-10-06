# Persistence & Scaling Enablement Checklist

> **Status of the items below: DORMANT, not fixed.**
>
> The blockchain service currently runs in a single-replica, in-memory configuration:
> `DATABASE_URL` is unset (no Postgres persistence) and `REDIS_URL` is unset (no distributed
> state / mining lock / fan-out). The defects catalogued here are **unreachable** in that
> configuration and were **deliberately deferred by product decision**.
>
> They are **BLOCKING** before persistence (`DATABASE_URL`) or multi-replica scaling
> (`REDIS_URL`) is enabled: every item below must be fixed (or explicitly re-triaged and
> signed off) before flipping the corresponding env var in any environment.

Each item lists: ID + severity, `file:symbol` reference, impact/risk, and the concrete fix
direction. Work through the sections in order; Section 5 is the staged rollout runbook that
gates the actual enablement.

---

## Section 1 — BLOCKING before enabling persistence (`DATABASE_URL`; plan step 3.3)

- [ ] **C1 (Critical)** — `blockchain.ts:isChainValid` + `blockchain.ts:expectedDifficultyAtFullIndex` + `mining/difficulty.ts:expectedDifficultyAtIndex`
  - **Impact:** once hot/cold eviction starts (> `HOT_BLOCK_COUNT` blocks), the difficulty schedule reads a cold predecessor → `undefined` → silently falls back to `initialDifficulty`, so `isChainValid()` returns false forever (`/api/validate` and `/api/blockchain/info` report corrupted), permanently masking real corruption.
  - **Fix:**
    - Keep a resident ring of the last `retargetInterval + 1` `{timestamp, difficulty}` pairs (never evicted) **OR** persist a `chain_difficulty_epoch {index, difficulty}` table and resolve the enclosing epoch from it.
    - Make `expectedDifficultyAtIndex` return a distinct "unknown" sentinel / throw when a required predecessor is absent — never silently substitute `initialDifficulty`.

- [ ] **C2 (Critical)** — `persistence/BlockRepository.ts:flush` / `writeWithRetry` / `insertBatch`
  - **Impact:** a failed batch is dropped (buffer cleared before write; failure only latches `degraded`) → permanent hole in `chain_blocks`; on reboot `loadBlocks()` returns a sparse array, `chainHeight = evictedCount + blocks.length` under-reports the tip, the next mined block reuses an existing index, and `ON CONFLICT (idx) DO NOTHING` silently discards it → unrecoverable ledger divergence.
  - **Fix:**
    - Never discard failed batches: re-queue at the buffer head with a bounded cap + loud alarm, or spill to a local append-only dead-letter file reconciled at boot.
    - In `create()`, validate density (`blocks[0].index === 0` and `blocks[i].index === blocks[i-1].index + 1`) and refuse to boot on violation.
    - Derive `chainHeight` / `evictedCount` from `SELECT max(idx) + 1`, not `blocks.length`.
    - Change `ON CONFLICT DO NOTHING` to include a post-write rowcount check that alarms on a discarded block.

- [ ] **C3 (Critical)** — `persistence/BlockRepository.ts:loadBlocks` + `blockchain.ts:create` + `server.ts` boot ordering
  - **Impact:** `SELECT data FROM chain_blocks ORDER BY idx ASC` has no LIMIT and `create()` sets `evictedCount = 0`, so the entire chain materializes in heap at boot (defeats Phase 6.5); `server.listen()` sits inside the boot `.then()` → slow boot → health-check failure → orchestrator restart → worsening restart loop → OOM.
  - **Fix:**
    - Load only the needed window: `WHERE idx >= $1` with `$1 = max(snapshot.height + 1, (SELECT max(idx) + 1) - hotBlockCount)`; set `evictedCount` to the first loaded idx; replay state from `snapshot.height + 1` over the loaded window.
    - Bind the listen socket BEFORE boot (serve 503 from readiness until `ctx.blockchain` is set) and add a boot deadline.

- [ ] **C4 (Critical)** — `blockchain.ts:minePendingTransactions`
  - **Impact:** `persistBlockWithRetry(newBlock)` only BUFFERS the block, but `removePendingTransactions(minedIds)` flushes + DELETEs immediately, so the mempool removal becomes durable ~1s BEFORE the block; a crash in that window loses already-ack'd (HTTP 200) transactions from both stores while they were reported CONFIRMED.
  - **Fix:**
    - Invert the order: make the block write durable (`saveBlockDurably`: flush + confirm rowcount) BEFORE deleting from the mempool; **or** defer the mempool delete into the block-flush success hook (`BlockRepositoryHooks.onFlushed(committedBatch)` → delete only ids of blocks actually committed).

- [ ] **C5 (Critical)** — `persistence/SnapshotRepository.ts:save/upsert` + the kernel `saveSnapshot` call
  - **Impact:** `save()` stores a LIVE reference to `contractState` and serializes only at `upsert()` (up to 1s later); `applyTransactions` mutates `contractState` in place, so the row written under `height = H` contains state at `H + k`; on boot, replaying `blocks.slice(H + 1)` double-applies → inflated balances, double-credited rewards, advanced nonces. The existing test passes only because it deep-copies, so it does not exercise the aliasing path.
  - **Fix:**
    - Deep-copy at capture (`structuredClone(this.contractState)`) in the kernel call or defensively inside `SnapshotRepository.save()`.
    - Add a regression test that mines a further block between `saveSnapshot` and `flush` and asserts the persisted row equals the state at `height`.

- [ ] **C6 (Critical)** — `server.ts` SIGTERM handler + `ws/hub.ts` (wss not returned/closed)
  - **Impact:** teardown is nested inside `server.close(cb)` which waits for long-lived WS/keep-alive sockets; there is no `server.closeAllConnections()`, the `WebSocket.Server` is a local variable never closed, and no shutdown deadline → the callback never fires → `persistence.close()` / `flush()` never runs → SIGKILL loses up to ~10 buffered blocks + mempool + snapshot EVERY deploy; no SIGINT handler; `process.exit(0)` unconditionally; no `uncaughtException` / `unhandledRejection` handlers anywhere.
  - **Fix:**
    - Implement a `shutdown(signal)` that: clears intervals; sets a hard `setTimeout(() => process.exit(1), 10_000)` deadline; calls `server.closeAllConnections()`; awaits `server.close`; awaits `wss.close()` (requires `attachWebSocket` to RETURN the wss); terminates the mining pool; unsubscribes fanout + closes the state store; then awaits `persistence.close()` and exits non-zero if the flush failed.
    - Register SIGTERM + SIGINT and `uncaughtException` / `unhandledRejection` handlers.

- [ ] **H4 (High)** — `controllers/system.controller.ts:readiness` + `blockchain.ts:writeDegraded` + `persistence/BlockRepository.ts:degraded`
  - **Impact:** readiness gates on a LATCHING `writeDegraded` that is never cleared, so one transient Postgres blip → permanent 503 → LB removal / restart flapping.
  - **Fix:**
    - Report a LIVE signal `writeHealthyNow()` (e.g. `lastSuccessfulFlushAt` within 3× flush interval).
    - Clear `degraded` on the next successful `writeWithRetry`; keep the latch only as an informational metric/log (`writeEverDegraded`).

- [ ] **H6 (High)** — `blockchain.ts` constructor (`hotBlockCount`) + `mining/difficulty.ts`
  - **Impact:** `HOT_BLOCK_COUNT` is only validated `> 0`; if it is `< RETARGET_INTERVAL_BLOCKS` (the shipped test itself uses `HOT_BLOCK_COUNT=3`), the retarget predecessor is cold at mine time → difficulty silently collapses to initial, and two replicas with different hot-window sizes derive different difficulties → fork. `RETARGET_INTERVAL_BLOCKS` is allowed up to 1,000,000 (> default hot window 1000).
  - **Fix:**
    - `hotBlockCount = max(hotRaw || 1000, retargetInterval + 1)` with an error log when raised.
    - Adopting the C1 resident ring removes the coupling entirely.
    - Make `expectedDifficultyAtIndex` distinguish a missing vs a present predecessor.

---

## Section 2 — BLOCKING before enabling multi-replica (`REDIS_URL`; plan step 7.4)

- [ ] **H1 (High)** — `state/DistributedMiningLock.ts:runExclusive` + `state/RedisStateStore.ts` + `blockchain.ts:minePendingTransactions` + persistence write paths
  - **Impact:** acquire correctly fails CLOSED, but ownership LOSS fails OPEN — a failed `renewLock` only logs a warning while PoW + block append run to completion; the monotonic fencing token is computed but NEVER checked by any write path (`saveBlock`, `removePendingTransactions`, `saveSnapshot`, `setChainTip`). A Redis partition longer than the TTL → two concurrent miners at the same height → chain fork (and C2's `DO NOTHING` silently drops one).
  - **Fix:**
    - Propagate renewal loss into an abort-check callback evaluated immediately before `chain.push` and before every persistence write (throw `MiningLockLostError`).
    - Enforce the fencing token on `chain_blocks`: `ON CONFLICT (idx) DO UPDATE ... WHERE chain_blocks.fence_token < EXCLUDED.fence_token`; make `setChainTip` a compare-and-set on the token.
    - Treat N consecutive renew failures as loss.
    - Add a two-replica test where the lock is stolen mid-PoW and the original holder's block is rejected.

---

## Section 3 — Recommended in the same pass (before `DATABASE_URL`)

- [ ] **M4 (Medium)** — `persistence/TxIndexRepository.ts:getAddressHistory`
  - **Impact:** OFFSET pagination with `ORDER BY block_index ASC` has no deterministic tiebreaker → rows duplicated/skipped across pages.
  - **Fix:** `ORDER BY block_index ASC, ts ASC, tx_id ASC` + composite index `(address, block_index, ts, tx_id)`; prefer keyset pagination (consistent with `/api/blockchain/blocks`).

- [ ] **M6 (Medium)** — `metrics.ts`
  - **Impact:** five metric families declared but never incremented (`hotWindowEvictions`, `cacheHits`, `cacheMisses`, `groupCommitFlushes`, `groupCommitFailures`); `rateLimitRejections` only in the distributed limiter, not the in-memory one. Permanently-zero series report healthy during the very incidents they should detect.
  - **Fix:** wire them at the real sites via injected callback hooks (the `BlockRepositoryHooks` pattern already exists) to keep the kernel decoupled from prom-client.

- [ ] **M8 (Medium)** — `tests/persistence/persistence.test.ts`
  - **Impact:** no test calls `isChainValid()` after eviction, none crosses a retarget boundary, none covers snapshot-mine-between-save-and-flush or boot-against-sparse-table.
  - **Fix:** add these — mine past a retarget boundary with a small hot window asserting `isChainValid() === true` after every mine + a tamper negative control; snapshot aliasing test; sparse `chain_blocks` boot test.

- [ ] **M9 (Medium)** — `server.ts` shutdown + `persistence.ts:close`
  - **Impact:** `close().finally(() => process.exit(0))` with no `.catch()` and unconditional exit 0 → a fully failed final flush still reports success (invisible data loss).
  - **Fix:** return/throw an aggregate failure signal, exit non-zero on failure, increment `groupCommitFailures`.

- [ ] **L1 (Low)** — `persistence/BlockRepository.ts:insertBatch` (and `TxIndexRepository.insertBatch`)
  - **Impact:** defensive `if (!block) continue` desyncs SQL placeholders from params (`$7` with 6 params) → whole batch fails deterministically.
  - **Fix:** derive the placeholder offset from `params.length`, not the loop index.

- [ ] **L5 (Low)** — `blockchain.ts:isChainValid`
  - **Impact:** cache keyed on the HOT `chain.length`, which is constant once the window saturates; sound only because eviction nulls the cache synchronously.
  - **Fix:** key on `{chainHeight, tipHash}` or a monotonic `chainRevision`.

- [ ] **L9 (Low)** — `server.ts`
  - **Impact:** `startGaugeRefresh` handle discarded (never cleared) and the boot `.catch` exits without `persistence?.close()` (leaks the pg pool).
  - **Fix:** hold + clear the gauge timer in shutdown; close persistence in the boot catch.

- [ ] **L10 (Low)** — `tsconfig.json` + `Dockerfile`
  - **Impact:** `include: tests/**` ships `dist/tests/**` into the production image.
  - **Fix:** a `tsconfig.build.json` with `include: [src, contracts]` for the `build` script; optionally add a HEALTHCHECK + `.dockerignore`.

---

## Section 4 — Separate follow-ups

- [ ] **M5 (Medium)** — `packages/blockchain-crypto` orphan package
  - **Impact:** nothing imports it (backend/frontend/Dart each keep their own copy), and `parity.test.ts` re-derives the expected value inline instead of importing the real modules, so drift would go uncaught.
  - **Fix:** actually wire `signature.ts` + `src/lib/blockchainSign.ts` to import the package (workspace `file:` link + `COPY packages/` into the Docker builder stage — current build context is `blockchain/` only); make `parity.test.ts` import the REAL backend + frontend modules and pin the Dart vector as a golden constant.

- [ ] **M7 (Medium)** — `tests/blockchain.test.ts` env mutation
  - **Impact:** mutates `process.env.REQUIRE_TREASURY_SIGNATURE` at module load; with vitest `singleFork`, results depend on file execution order.
  - **Fix:** move env mutation into `beforeAll` / `afterEach` and pass the flag explicitly via a constructor option; ideally export a `createServer(deps)` factory so each suite gets an isolated app.

---

## Section 5 — Staged rollout procedure (before flipping `DATABASE_URL` on)

Runbook — execute in order, do not skip steps:

1. Fix **all Section 1 items** (C1–C6, H4, H6) and add the **M8** test coverage.
2. Enable `DATABASE_URL` on a **SINGLE replica** pointed at a **COPY of production data** (never live prod first).
3. Mine **several hundred blocks** past the eviction threshold (> 1001 blocks) and across **multiple retarget boundaries**.
4. **Restart the process twice.**
5. **Assert after each step:**
   - `isValid === true`;
   - `chainHeight` monotonic;
   - `SELECT max(idx) === chainHeight - 1` with **NO gaps**;
   - TREASURY total supply unchanged (`== 1,000,000`).

Only then consider `REDIS_URL` / multi-replica: complete **Section 2 (H1)** and follow the
plan step 7.4 runbook — preconditions verified at N=1, scale replica 1→2, watch mining-lock
contention + fail-closed behavior on Redis outage + WS fan-out exactly-once delivery;
rollback = replica→1 and/or unset `REDIS_URL`.
