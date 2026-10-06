/**
 * Phase 8.2 — long-running memory-leak soak.
 *
 * Drives the four historically unbounded structures — the in-memory rate-limit
 * buckets, the transaction status tracker, the pending mempool and the hot block
 * window — to a STEADY STATE, then samples `process.memoryUsage()` over many
 * iterations and reports the heap trend. A structure that leaks (grows without
 * bound despite steady-state input) shows up as a rising heap and fails the run.
 *
 * RUN: `npm run perf:soak` (→ `ts-node --transpile-only tests/perf/soak.ts`)
 * It is a `.soak.ts` file under `tests/perf/`, EXCLUDED from `vitest run` /
 * `npm test` (vitest.config.ts `test.exclude: ['tests/perf/**']`), so this
 * long-running soak NEVER executes in CI.
 *
 * TUNABLES (env):
 *   SOAK_ITERATIONS          total loop iterations          (default 3000)
 *   SOAK_IP_POOL             distinct client IPs to rotate  (default 2000)
 *   SOAK_MEMPOOL_TARGET      pending-tx plateau             (default 200)
 *   SOAK_MAX_HEAP_GROWTH_MB  fail threshold (MB)            (default 64)
 *   SOAK_PORT                in-process server port         (default 45912)
 *
 * Steady-state design (so a flat heap == no leak):
 *   - rate buckets : rotate through a FIXED pool of X-Forwarded-For IPs, so the
 *                    bucket Map plateaus at SOAK_IP_POOL entries.
 *   - statusTracker: add a pending status each iteration but evict everything
 *                    via `cleanup(0)` periodically → sawtooth that plateaus.
 *   - mempool      : add TREASURY transfers only until SOAK_MEMPOOL_TARGET is
 *                    reached, then stop → plateau (also below MAX_PENDING_TX).
 *   - hot window   : read-only range scans; no mining, so chain height is fixed.
 *
 * No Postgres or Redis is required (persistence + state store stay dormant).
 * NODE_ENV is left at 'development' so the in-memory rate limiter is ACTIVE and
 * the bucket path is genuinely exercised.
 */
import http from 'node:http';
import type { Transaction } from '../../src/blockchain';
import type { AppContext } from '../../src/context';

const PORT = parseInt(process.env.SOAK_PORT || '45912', 10);
const ITERATIONS = parseInt(process.env.SOAK_ITERATIONS || '3000', 10);
const IP_POOL = parseInt(process.env.SOAK_IP_POOL || '2000', 10);
const MEMPOOL_TARGET = parseInt(process.env.SOAK_MEMPOOL_TARGET || '200', 10);
const MAX_HEAP_GROWTH_MB = parseFloat(process.env.SOAK_MAX_HEAP_GROWTH_MB || '64');

const CLEANUP_EVERY = 50; // statusTracker eviction cadence
const MEMPOOL_EVERY = 5; // add a pending tx every N iterations (until target)
const HOT_EVERY = 25; // hot-window range-scan cadence
const SAMPLE_EVERY = 200; // memory sampling cadence

interface MemSample {
  iteration: number;
  heapUsedMB: number;
  rssMB: number;
  statuses: number;
  mempool: number;
  chainHeight: number;
}

/** GET a path with an optional spoofed client IP (exercises the rate buckets). */
function get(path: string, xff?: string): Promise<number> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = xff ? { 'x-forwarded-for': xff } : {};
    const req = http.get({ host: '127.0.0.1', port: PORT, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', () => resolve(0));
    req.setTimeout(10_000, () => {
      req.destroy();
      resolve(0);
    });
  });
}

/** Map a rotating index to a stable, unique-ish IPv4 string. */
function ipFor(index: number): string {
  const n = index % IP_POOL;
  return `10.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

async function waitForReady(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await get('/api/health/ready')) === 200) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms`);
}

/** Optional forced GC (only when node is run with --expose-gc). */
function tryGc(): void {
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === 'function') g.gc();
}

function mb(bytes: number): number {
  return bytes / (1024 * 1024);
}

/** Ordinary least-squares slope (MB per sample) over the heap series. */
function heapSlope(samples: MemSample[]): number {
  const n = samples.length;
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const y = samples[i]?.heapUsedMB ?? 0;
    sx += i;
    sy += y;
    sxy += i * y;
    sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

async function main(): Promise<void> {
  // Development mode keeps the rate limiter ACTIVE (see module docstring).
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';
  process.env.PORT = String(PORT);
  // Golden-master parity: allow unsigned TREASURY transfers so the soak can fill
  // the mempool without client-side signing.
  process.env.REQUIRE_TREASURY_SIGNATURE = 'false';
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;

  const mod = await import('../../src/server');
  await waitForReady();

  const ctx: AppContext = mod.ctx;
  const bc = ctx.blockchain;
  if (!bc) throw new Error('blockchain kernel did not boot');

  console.log(
    `\n🧪 memory soak: ${ITERATIONS} iterations, ipPool=${IP_POOL}, mempoolTarget=${MEMPOOL_TARGET}\n`
  );

  const samples: MemSample[] = [];

  const sample = (iteration: number): void => {
    tryGc();
    const usage = process.memoryUsage();
    const s: MemSample = {
      iteration,
      heapUsedMB: mb(usage.heapUsed),
      rssMB: mb(usage.rss),
      statuses: ctx.statusTracker.getAllStatuses().length,
      mempool: bc.getPendingCount(),
      chainHeight: bc.chainHeight,
    };
    samples.push(s);
    console.log(
      `  [${String(iteration).padStart(6)}] heap=${s.heapUsedMB.toFixed(2)}MB rss=${s.rssMB.toFixed(
        2
      )}MB statuses=${s.statuses} mempool=${s.mempool} height=${s.chainHeight}`
    );
  };

  sample(0);

  for (let i = 1; i <= ITERATIONS; i++) {
    // 1. Rate-limit buckets: rotating fixed IP pool → plateau.
    await get('/api/blockchain/info', ipFor(i));

    // 2. Status tracker: churn with periodic full eviction → plateau.
    ctx.statusTracker.addPending(`soak-${i}`);
    if (i % CLEANUP_EVERY === 0) ctx.statusTracker.cleanup(0);

    // 3. Mempool: grow to a fixed target then stop → plateau. TREASURY's state
    //    nonce only advances on mining, so every pending transfer must carry
    //    nonce 0 to pass add-time validation (the pool does not advance it).
    if (i % MEMPOOL_EVERY === 0 && bc.getPendingCount() < MEMPOOL_TARGET) {
      const tx: Transaction = {
        id: `soak-tx-${i}`,
        from: 'TREASURY',
        to: `soak-recipient-${i % 50}`,
        amount: 1,
        timestamp: Date.now(),
        nonce: 0,
        type: 'transfer',
      };
      bc.addTransaction(tx);
    }

    // 4. Hot-window read path (no growth; exercises range scans).
    if (i % HOT_EVERY === 0) {
      const end = Math.min(bc.chainHeight, 50);
      if (end > 0) await bc.getBlocksRange(0, end);
    }

    if (i % SAMPLE_EVERY === 0) sample(i);
  }

  sample(ITERATIONS);

  // Growth is measured from a post-warmup baseline (25% in) to the final sample
  // so the initial ramp of the plateaus is not mistaken for a leak.
  const baseline = samples[Math.floor(samples.length * 0.25)] ?? samples[0];
  const final = samples[samples.length - 1];
  const baselineMB = baseline?.heapUsedMB ?? 0;
  const finalMB = final?.heapUsedMB ?? 0;
  const growthMB = finalMB - baselineMB;
  const slope = heapSlope(samples);
  const peakMB = samples.reduce((m, s) => Math.max(m, s.heapUsedMB), 0);

  console.log('═'.repeat(64));
  console.log(`  baseline heap (25%) : ${baselineMB.toFixed(2)} MB`);
  console.log(`  final heap          : ${finalMB.toFixed(2)} MB`);
  console.log(`  peak heap           : ${peakMB.toFixed(2)} MB`);
  console.log(`  net growth          : ${growthMB.toFixed(2)} MB`);
  console.log(`  trend slope         : ${slope.toFixed(4)} MB/sample`);
  console.log(`  final mempool       : ${final?.mempool ?? 0}`);
  console.log(`  final statuses      : ${final?.statuses ?? 0}`);
  console.log('═'.repeat(64));

  if (growthMB > MAX_HEAP_GROWTH_MB) {
    console.error(
      `\n❌ heap grew ${growthMB.toFixed(2)}MB > ${MAX_HEAP_GROWTH_MB}MB threshold — possible leak\n`
    );
    process.exit(1);
  }
  console.log('\n✅ soak stable: heap plateaued within threshold\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Memory soak failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
