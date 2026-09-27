#!/usr/bin/env node
/**
 * Pi 5 load check for /v2/search and /v2/scrape.
 *
 *   node apps/api/scripts/pi5-bench.mjs
 *   node apps/api/scripts/pi5-bench.mjs --strict
 *
 * --strict fails unless fetch-path traffic holds 2000 rpm for two minutes
 * and 16 Chromium tabs can be open together. Run that on the Pi.
 */

const baseUrl = process.env.PI5_BENCH_URL ?? "http://127.0.0.1:3002";
const apiKey =
  process.env.PI5_API_KEY ??
  (process.env.PI5_API_KEYS ?? "pi5-local-key").split(",")[0].trim();
const strict = process.argv.includes("--strict");
const durationMs = Number(process.env.PI5_BENCH_MS ?? (strict ? 120_000 : 15_000));
const targetRpm = Number(process.env.PI5_BENCH_RPM ?? 2000);
const fetchUrl = process.env.PI5_BENCH_FETCH_URL ?? "https://example.com";
const searchQuery = process.env.PI5_BENCH_QUERY ?? "raspberry pi";

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function call(path, body) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
  return { ok: response.ok, ms: performance.now() - started, status: response.status };
}

async function runFetchPhase() {
  const latencies = [];
  let ok = 0;
  let failed = 0;
  const started = Date.now();
  let stopped = false;
  const inFlight = new Set();

  async function one() {
    const useSearch = Math.random() < 0.25;
    try {
      const result = useSearch
        ? await call("/v2/search", { query: searchQuery, limit: 3 })
        : await call("/v2/scrape", { url: fetchUrl, formats: ["markdown"] });
      latencies.push(result.ms);
      if (result.ok) ok += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }

  while (Date.now() - started < durationMs) {
    while (inFlight.size < 48 && Date.now() - started < durationMs) {
      const job = one().finally(() => inFlight.delete(job));
      inFlight.add(job);
    }
    if (inFlight.size === 0) break;
    await Promise.race(inFlight);
  }
  stopped = true;
  await Promise.all(inFlight);
  const elapsedMin = Math.max((Date.now() - started) / 60000, 1 / 60000);
  const rpm = ok / elapsedMin;
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    stopped,
    rpm,
    ok,
    failed,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}

async function runTabPhase() {
  const waits = Array.from({ length: 16 }, () =>
    call("/v2/scrape", {
      url: fetchUrl,
      formats: ["markdown"],
      forceBrowser: true,
      waitFor: 12000,
    }),
  );
  let stats = { maxConcurrentPages: 0, activePages: 0 };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const statsResponse = await fetch(`${baseUrl}/pi5/browser`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    stats = await statsResponse.json();
    if ((stats.activePages ?? 0) >= 12) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await Promise.allSettled(waits);
  return stats;
}

const fetchResult = await runFetchPhase();
console.log(
  JSON.stringify(
    {
      phase: "fetch",
      targetRpm,
      ...fetchResult,
    },
    null,
    2,
  ),
);

let tabsOk = false;
let tabStats = null;
try {
  tabStats = await runTabPhase();
  tabsOk =
    tabStats.maxConcurrentPages >= 16 &&
    typeof tabStats.activePages === "number";
  console.log(JSON.stringify({ phase: "tabs", ...tabStats }, null, 2));
} catch (error) {
  console.log(
    JSON.stringify(
      {
        phase: "tabs",
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
}

if (strict) {
  const rpmOk = fetchResult.rpm >= targetRpm && fetchResult.failed === 0;
  const openTogether = (tabStats?.activePages ?? 0) >= 12;
  if (!rpmOk || !tabsOk || !openTogether) {
    console.error(
      `strict check failed: rpm=${fetchResult.rpm.toFixed(0)} failed=${fetchResult.failed} activePages=${tabStats?.activePages}`,
    );
    process.exit(1);
  }
  console.log("strict check passed");
}
