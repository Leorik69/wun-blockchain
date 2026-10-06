/**
 * Phase 8.2 — HTTP endpoint load smoke.
 *
 * A self-contained, on-demand load generator for the WUNCoin read endpoints.
 * It boots the REAL Express app in-process (importing `src/server`, exactly as
 * the contract-test harness does), waits for readiness, then drives concurrent
 * GET traffic through `node:http` and reports latency percentiles + throughput.
 *
 * RUN: `npm run perf:http` (→ `ts-node --transpile-only tests/perf/http.load.ts`)
 * It is a `.load.ts` file under `tests/perf/`, EXCLUDED from `vitest run` /
 * `npm test` (vitest.config.ts `test.exclude: ['tests/perf/**']`), so it never
 * runs in CI.
 *
 * TUNABLES (env):
 *   LOAD_PORT         port to bind the in-process server   (default 45911)
 *   LOAD_REQUESTS     total requests to issue              (default 600)
 *   LOAD_CONCURRENCY  parallel in-flight requests          (default 25)
 *   LOAD_MAX_ERROR_RATE  fail threshold for error ratio    (default 0.01)
 *
 * The server runs with NODE_ENV=test so the in-memory rate limiter is bypassed
 * (otherwise the 120 req/min/IP cap would dominate the signal). No Postgres or
 * Redis is required — persistence and the state store stay dormant.
 */
import http from 'node:http';

interface Sample {
  status: number;
  ms: number;
}

const PORT = parseInt(process.env.LOAD_PORT || '45911', 10);
const TOTAL = parseInt(process.env.LOAD_REQUESTS || '600', 10);
const CONCURRENCY = parseInt(process.env.LOAD_CONCURRENCY || '25', 10);
const MAX_ERROR_RATE = parseFloat(process.env.LOAD_MAX_ERROR_RATE || '0.01');
const BASE_HOST = '127.0.0.1';

/** Public, unauthenticated read endpoints exercised by the smoke. */
const ENDPOINTS: readonly string[] = [
  '/api/health',
  '/api/version',
  '/api/blockchain/info',
  '/api/blockchain/blocks?limit=20',
  '/api/transactions/pending',
  '/api/health/ready',
];

/** Issue a single GET and resolve with its status code and wall-clock latency. */
function get(path: string): Promise<Sample> {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const req = http.get({ host: BASE_HOST, port: PORT, path }, (res) => {
      // Drain the body so the socket can be reused/closed cleanly.
      res.resume();
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        resolve({ status: res.statusCode ?? 0, ms });
      });
    });
    req.on('error', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ status: 0, ms });
    });
    req.setTimeout(10_000, () => {
      req.destroy();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ status: 0, ms });
    });
  });
}

/** Poll the readiness probe until the async blockchain boot completes. */
async function waitForReady(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sample = await get('/api/health/ready');
    if (sample.status === 200) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms`);
}

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)] ?? 0;
}

/** Fixed-size worker pool issuing `TOTAL` requests across the endpoint set. */
async function runLoad(): Promise<Sample[]> {
  const samples: Sample[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= TOTAL) break;
      const path = ENDPOINTS[i % ENDPOINTS.length] ?? '/api/health';
      samples.push(await get(path));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return samples;
}

async function main(): Promise<void> {
  // Pin a deterministic, dependency-free environment BEFORE importing server.ts
  // (the module reads process.env at import time).
  process.env.NODE_ENV = 'test';
  process.env.PORT = String(PORT);
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;

  await import('../../src/server');
  await waitForReady();

  console.log(
    `\n🔥 HTTP load smoke: ${TOTAL} requests @ concurrency ${CONCURRENCY} → http://${BASE_HOST}:${PORT}\n`
  );

  const started = process.hrtime.bigint();
  const samples = await runLoad();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => s.status < 200 || s.status >= 400).length;
  const errorRate = samples.length > 0 ? errors / samples.length : 0;
  const mean = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);
  const throughput = (samples.length / elapsedMs) * 1000;

  const byStatus = new Map<number, number>();
  for (const s of samples) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);

  console.log('═'.repeat(64));
  console.log(`  requests      : ${samples.length}`);
  console.log(`  concurrency   : ${CONCURRENCY}`);
  console.log(`  wall time     : ${elapsedMs.toFixed(1)} ms`);
  console.log(`  throughput    : ${throughput.toFixed(1)} req/s`);
  console.log(`  errors        : ${errors} (${(errorRate * 100).toFixed(2)}%)`);
  console.log(`  status codes  : ${[...byStatus.entries()].map(([k, v]) => `${k}×${v}`).join(', ')}`);
  console.log('  latency (ms)  :');
  console.log(`    mean        : ${mean.toFixed(2)}`);
  console.log(`    p50         : ${percentile(latencies, 50).toFixed(2)}`);
  console.log(`    p90         : ${percentile(latencies, 90).toFixed(2)}`);
  console.log(`    p95         : ${percentile(latencies, 95).toFixed(2)}`);
  console.log(`    p99         : ${percentile(latencies, 99).toFixed(2)}`);
  console.log(`    max         : ${percentile(latencies, 100).toFixed(2)}`);
  console.log('═'.repeat(64));

  if (errorRate > MAX_ERROR_RATE) {
    console.error(`\n❌ error rate ${(errorRate * 100).toFixed(2)}% exceeds ${MAX_ERROR_RATE * 100}%\n`);
    process.exit(1);
  }
  console.log('\n✅ load smoke within error budget\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('HTTP load smoke failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
