#!/usr/bin/env npx tsx
/**
 * Stream Bucket Diagnostic — 20-minute mid-tick alignment tracker
 *
 * Connects to the dev server SSE endpoint and simulates the EXACT same
 * bucket-assignment logic as useMarketStream.ts (baseMs-aligned grid).
 * For each SSE tick it records:
 *   - raw tick ts + mid
 *   - bucket_ts (what useMarketStream would assign)
 *   - action: PUSH (new bucket), MID-HIT (existing non-tail bucket), UPDATE (tail bucket), DROP (out-of-order)
 *   - inter-tick gap (ms since previous tick for same market+outcome)
 *
 * Also polls market_mid_ticks in Supabase every 30s and compares
 * DB timestamps with what the SSE stream reported.
 *
 * Results written to .cursor/stream-diag.log
 *
 * Usage:
 *   npx tsx scripts/stream-diag.ts --slug=<slug>          # auto-detect if omitted
 *   npx tsx scripts/stream-diag.ts --market_id=<id>
 *   npx tsx scripts/stream-diag.ts --slug=<slug> --minutes=20
 *   npx tsx scripts/stream-diag.ts --port=3000            # default 3005
 */

import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, appendFileSync } from "fs";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const root = resolve(__dirname, "..");

const opts = { quiet: true } as any;
config({ ...opts, path: resolve(root, ".env") });
config({ ...opts, path: resolve(root, ".env.local") });
config({ ...opts, path: resolve(root, "apps/web/.env.local") });
config({ ...opts, path: resolve(root, "apps/web/.env") });

// ── CLI args ──────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"];
    })
);

const PORT = args.port ?? "3005";
const BASE_URL = `http://localhost:${PORT}`;
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SLUG = args.slug ?? "";
const MARKET_ID_ARG = args.market_id ?? "";
const DURATION_MS = Number(args.minutes ?? 20) * 60_000;
const BUCKET_MINUTES = 1;
const BUCKET_MS = BUCKET_MINUTES * 60_000;
const LOG_FILE = resolve(root, ".cursor/stream-diag.log");

// ── Logging ───────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function log(line: string, alsoFile = true) {
  const formatted = `[${ts()}] ${line}`;
  console.log(formatted);
  if (alsoFile) appendFileSync(LOG_FILE, formatted + "\n");
}

function logFile(line: string) {
  appendFileSync(LOG_FILE, `[${ts()}] ${line}\n`);
}

// ── Supabase REST helper ──────────────────────────────────────────────

async function pgFetch<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`pgFetch ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── Bucket helpers (mirrors useMarketStream.ts exactly) ───────────────

function toBucketIso(tsMs: number, baseMs: number): string {
  const bucketStart = baseMs + Math.floor((tsMs - baseMs) / BUCKET_MS) * BUCKET_MS;
  return new Date(bucketStart).toISOString();
}

// Wall-clock minute boundary (what stream-chart-test.ts uses)
function toWallBucketIso(tsMs: number): string {
  return new Date(Math.floor(tsMs / BUCKET_MS) * BUCKET_MS).toISOString();
}

// ── Per-outcome series state (mirrors hook's SeriesPoint[]) ───────────

type SeriesPoint = { t: string; price: number };
type TickAction = "PUSH" | "UPDATE_TAIL" | "MID_HIT" | "DROP";

function upsertBucketPoint(
  series: SeriesPoint[],
  tsMs: number,
  price: number,
  baseMs: number
): TickAction {
  const bucketIso = toBucketIso(tsMs, baseMs);
  const last = series[series.length - 1];

  if (last && last.t === bucketIso) {
    last.price = price;
    return "UPDATE_TAIL";
  }

  const existingIdx = series.findIndex((p) => p.t === bucketIso);
  if (existingIdx >= 0) {
    series[existingIdx].price = price;
    return "MID_HIT";
  }

  if (last) {
    const lastMs = Date.parse(last.t);
    if (Number.isFinite(lastMs) && tsMs < lastMs) {
      return "DROP";
    }
  }

  series.push({ t: bucketIso, price });
  return "PUSH";
}

// ── Per-outcome tracking ──────────────────────────────────────────────

type OutcomeState = {
  series: SeriesPoint[];
  lastTickMs: number;
  counts: Record<TickAction, number>;
  gaps: number[];       // ms between consecutive ticks
  bucketGaps: number[]; // ms between consecutive new bucket pushes
  lastBucketMs: number;
};

const outcomeStates = new Map<string, OutcomeState>();

function getState(marketId: string, outcome: string | null): OutcomeState {
  const key = `${marketId}:${outcome ?? ""}`;
  let s = outcomeStates.get(key);
  if (!s) {
    s = {
      series: [],
      lastTickMs: 0,
      counts: { PUSH: 0, UPDATE_TAIL: 0, MID_HIT: 0, DROP: 0 },
      gaps: [],
      bucketGaps: [],
      lastBucketMs: 0,
    };
    outcomeStates.set(key, s);
  }
  return s;
}

// ── Global counters ───────────────────────────────────────────────────

let ticksReceived = 0;
let tradesReceived = 0;
let movesReceived = 0;
let errorEvents = 0;
const startMs = Date.now();
let lastTickReceivedMs = 0;

// All raw tick entries for full log
type RawEntry = {
  wallMs: number;     // when we received it (wall clock)
  ts: string;         // tick.ts from SSE
  tsMs: number;       // Date.parse(tick.ts)
  mid: number;
  market_id: string;
  outcome: string | null;
  bucketTs: string;   // baseMs-aligned bucket
  wallBucketTs: string; // wall-clock-aligned bucket
  action: TickAction;
  interTickGap: number; // ms since previous tick for this outcome
};
const allEntries: RawEntry[] = [];

// ── Supabase comparison ───────────────────────────────────────────────

type DBTick = {
  market_id: string;
  outcome: string | null;
  ts: string;
  mid: number | null;
};

let lastDbTickTs = new Date(Date.now() - 2 * 60_000).toISOString();
const dbTicksSeenBySse = new Set<string>(); // ts+market_id keys
const dbTicksMissedBySse: Array<{ ts: string; mid: number | null; market_id: string }> = [];

async function pollDatabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const rows = await pgFetch<DBTick[]>(
      `market_mid_ticks?select=market_id,outcome,ts,mid` +
      `&ts=gt.${encodeURIComponent(lastDbTickTs)}` +
      `&order=ts.asc&limit=500`
    );
    if (!rows || rows.length === 0) return;

    lastDbTickTs = rows[rows.length - 1].ts;

    let dbNew = 0;
    let dbMissed = 0;
    for (const row of rows) {
      const key = `${row.market_id}:${row.ts}`;
      if (!dbTicksSeenBySse.has(key)) {
        dbMissed++;
        if (dbTicksMissedBySse.length < 100) {
          dbTicksMissedBySse.push({ ts: row.ts, mid: row.mid, market_id: row.market_id });
        }
      }
      dbNew++;
    }
    log(`[db-poll] ${rows.length} DB ticks | ${dbMissed} not seen by SSE | ${dbNew} total`);
  } catch (err: any) {
    log(`[db-poll] error: ${err?.message}`);
  }
}

// ── Periodic summary ──────────────────────────────────────────────────

function printSummary(label: string) {
  log(`\n── ${label} ──────────────────────────────────────────────`);
  log(`  Elapsed: ${((Date.now() - startMs) / 1000).toFixed(0)}s`);
  log(`  SSE ticks: ${ticksReceived}  trades: ${tradesReceived}  moves: ${movesReceived}  errors: ${errorEvents}`);
  log(`  Last tick: ${lastTickReceivedMs ? ((Date.now() - lastTickReceivedMs) / 1000).toFixed(1) + "s ago" : "never"}`);

  for (const [key, s] of outcomeStates) {
    const total = s.counts.PUSH + s.counts.UPDATE_TAIL + s.counts.MID_HIT + s.counts.DROP;
    if (total === 0) continue;
    const midHitPct = total > 0 ? ((s.counts.MID_HIT / total) * 100).toFixed(1) : "0.0";
    const dropPct = total > 0 ? ((s.counts.DROP / total) * 100).toFixed(1) : "0.0";
    const avgGap = s.gaps.length > 0
      ? (s.gaps.reduce((a, b) => a + b, 0) / s.gaps.length / 1000).toFixed(1)
      : "n/a";
    const maxGap = s.gaps.length > 0
      ? (Math.max(...s.gaps) / 1000).toFixed(1)
      : "n/a";
    const currentPrice = s.series[s.series.length - 1]?.price;
    log(
      `  [${key.slice(0, 40)}] series=${s.series.length} total=${total}` +
      `  PUSH=${s.counts.PUSH} UPDATE=${s.counts.UPDATE_TAIL} MID_HIT=${s.counts.MID_HIT}(${midHitPct}%) DROP=${s.counts.DROP}(${dropPct}%)` +
      `  tickGap avg=${avgGap}s max=${maxGap}s` +
      `  price=${currentPrice?.toFixed(4) ?? "n/a"}`
    );

    // Bucket gaps: how often a new bucket boundary is crossed
    if (s.bucketGaps.length > 0) {
      const avgBucketGap = s.bucketGaps.reduce((a, b) => a + b, 0) / s.bucketGaps.length / 1000;
      const maxBucketGap = Math.max(...s.bucketGaps) / 1000;
      log(
        `    bucket-push gaps: avg=${avgBucketGap.toFixed(1)}s max=${maxBucketGap.toFixed(1)}s` +
        `  (expected ~${BUCKET_MS / 1000}s for ${BUCKET_MINUTES}m buckets)`
      );
    }

    // Check for MID-HITs which indicate bucket backfilling (potential chart glitch)
    if (s.counts.MID_HIT > 0) {
      log(`    ⚠ ${s.counts.MID_HIT} MID-HITS — ticks updating non-tail buckets (backfill or out-of-order from SSE)`);
    }
  }
  log("");
}

// ── SSE connection ────────────────────────────────────────────────────

async function connect(baseMs: number, streamUrl: string) {
  log(`Connecting: ${streamUrl}`);
  log(`baseMs: ${new Date(baseMs).toISOString()} (${baseMs})`);

  const res = await fetch(streamUrl, { headers: { Accept: "text/event-stream" } });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let eventType = "";
  let partial = "";

  const processLine = (line: string) => {
    if (line.startsWith("event: ")) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith("data: ") && eventType) {
      try {
        const data = JSON.parse(line.slice(6));
        handleEvent(eventType, data, baseMs);
      } catch { /* ignore */ }
      eventType = "";
    }
  };

  const readLoop = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      partial += decoder.decode(value, { stream: true });
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) processLine(trimmed);
      }
    }
  };

  readLoop().catch((err: any) => log(`[sse] read error: ${err?.message}`));
  return reader;
}

function handleEvent(type: string, data: any, baseMs: number) {
  switch (type) {
    case "tick": {
      ticksReceived++;
      lastTickReceivedMs = Date.now();

      const tsMs = Date.parse(data.ts);
      if (!Number.isFinite(tsMs) || data.mid == null) return;

      // Mark this tick as seen (for DB comparison)
      dbTicksSeenBySse.add(`${data.market_id}:${data.ts}`);

      const s = getState(data.market_id, data.outcome);
      const interTickGap = s.lastTickMs > 0 ? tsMs - s.lastTickMs : 0;
      if (s.lastTickMs > 0) s.gaps.push(Math.abs(interTickGap));
      s.lastTickMs = tsMs;

      const action = upsertBucketPoint(s.series, tsMs, data.mid, baseMs);
      s.counts[action]++;

      if (action === "PUSH") {
        if (s.lastBucketMs > 0) s.bucketGaps.push(Date.now() - s.lastBucketMs);
        s.lastBucketMs = Date.now();
      }

      const bucketTs = toBucketIso(tsMs, baseMs);
      const wallBucketTs = toWallBucketIso(tsMs);
      const bucketDrift = Date.parse(bucketTs) - Date.parse(wallBucketTs);

      const entry: RawEntry = {
        wallMs: Date.now(),
        ts: data.ts,
        tsMs,
        mid: data.mid,
        market_id: data.market_id,
        outcome: data.outcome,
        bucketTs,
        wallBucketTs,
        action,
        interTickGap,
      };
      allEntries.push(entry);

      // Log bucket drift warnings and notable events
      if (Math.abs(bucketDrift) > 0) {
        logFile(
          `[bucket-drift] ${data.ts.slice(11, 23)} tick→bucket=${bucketTs.slice(11, 19)} wall=${wallBucketTs.slice(11, 19)}` +
          ` drift=${bucketDrift}ms market=${data.market_id.slice(0, 16)} outcome=${data.outcome}`
        );
      }

      // Log every MID_HIT and DROP verbosely — these are potential glitch causes
      if (action === "MID_HIT") {
        const seriesLen = s.series.length;
        const misplacedIdx = s.series.findIndex((p) => p.t === bucketTs);
        logFile(
          `[mid-hit] ts=${data.ts.slice(11, 23)} bucket=${bucketTs.slice(11, 19)}` +
          ` idx=${misplacedIdx}/${seriesLen - 1} (not tail)` +
          ` mid=${data.mid.toFixed(4)} market=${data.market_id.slice(0, 16)} outcome=${data.outcome}`
        );
      } else if (action === "DROP") {
        const lastBucket = s.series[s.series.length - 1]?.t ?? "none";
        logFile(
          `[drop] ts=${data.ts.slice(11, 23)} bucket=${bucketTs.slice(11, 19)}` +
          ` < last=${lastBucket.slice(11, 19)}` +
          ` mid=${data.mid.toFixed(4)} market=${data.market_id.slice(0, 16)} outcome=${data.outcome}`
        );
      }

      // Log new bucket pushes — these show the series growing correctly
      if (action === "PUSH") {
        logFile(
          `[push] ts=${data.ts.slice(11, 23)} bucket=${bucketTs.slice(11, 19)} mid=${data.mid.toFixed(4)}` +
          ` series_len=${s.series.length} market=${data.market_id.slice(0, 16)} outcome=${data.outcome}`
        );
      }
      break;
    }
    case "trade":
      tradesReceived++;
      break;
    case "movement":
      movesReceived++;
      log(`[movement] ${data.window_type} market=${data.market_id?.slice(0, 16)} outcome=${data.outcome} window=${data.window_start?.slice(11, 19)}→${data.window_end?.slice(11, 19)}`);
      break;
    case "error":
      errorEvents++;
      log(`[sse-error] ${data.message}`);
      break;
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function run() {
  writeFileSync(
    LOG_FILE,
    `=== Stream Bucket Diagnostic ===\n` +
    `Started: ${new Date().toISOString()}\n` +
    `Duration: ${DURATION_MS / 60_000} minutes\n` +
    `Base URL: ${BASE_URL}\n\n`
  );

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    log("⚠ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — DB comparison disabled");
  }

  // ── Step 1: fetch windowStart from /api/markets ───────────────────
  log("Fetching windowStart from /api/markets...");
  let baseMs = 0;
  let marketSlug = SLUG;
  let marketId = MARKET_ID_ARG;

  try {
    const marketsUrl = marketId
      ? `${BASE_URL}/api/markets?market_id=${encodeURIComponent(marketId)}&bucketMinutes=${BUCKET_MINUTES}`
      : `${BASE_URL}/api/markets?slugs=${encodeURIComponent(SLUG)}&bucketMinutes=${BUCKET_MINUTES}`;

    const res = await fetch(marketsUrl);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = await res.json();

    baseMs = Date.parse(json.windowStart ?? "");
    if (!Number.isFinite(baseMs)) throw new Error("windowStart missing or invalid");

    // Extract marketId from response if not provided
    if (!marketId && Array.isArray(json.markets) && json.markets.length > 0) {
      const m = json.markets[0];
      marketId = m.market_id ?? "";
      marketSlug = m.slug ?? SLUG;
    }

    log(`windowStart: ${json.windowStart}  (baseMs=${baseMs})`);
    log(`Market: ${marketId?.slice(0, 32)} slug=${marketSlug}`);
    log(`wall-clock minute boundary: ${toWallBucketIso(baseMs)}`);
    log(`baseMs-aligned boundary:    ${toBucketIso(baseMs, baseMs)}`);
    const wallVsBase = baseMs - Math.floor(baseMs / BUCKET_MS) * BUCKET_MS;
    if (wallVsBase === 0) {
      log("baseMs is on a wall-clock minute boundary (grids are identical)");
    } else {
      log(`⚠ baseMs offset from wall clock: +${wallVsBase}ms — bucket grids DIFFER by ${wallVsBase}ms`);
    }
  } catch (err: any) {
    log(`Failed to fetch windowStart: ${err?.message}`);
    log("Falling back to wall-clock minute boundaries");
    baseMs = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS - 24 * 60 * BUCKET_MS;
  }

  // ── Step 2: connect to SSE stream ────────────────────────────────
  const streamUrl = marketId
    ? `${BASE_URL}/api/stream?market_id=${encodeURIComponent(marketId)}&bucketMinutes=${BUCKET_MINUTES}`
    : `${BASE_URL}/api/stream?slugs=${encodeURIComponent(SLUG)}&bucketMinutes=${BUCKET_MINUTES}`;

  const reader = await connect(baseMs, streamUrl);

  // ── Step 3: diagnostic loops ──────────────────────────────────────
  let summaryCount = 0;

  // Print summary every 30s
  const summaryInterval = setInterval(async () => {
    summaryCount++;
    printSummary(`Summary #${summaryCount} (${(summaryCount * 30)}s)`);

    // Poll DB for comparison
    if (SUPABASE_URL && SUPABASE_KEY) {
      await pollDatabase().catch((e) => log(`db poll error: ${e?.message}`));
    }
  }, 30_000);

  // Stop after duration
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      clearInterval(summaryInterval);
      reader.cancel().catch(() => {});
      resolve();
    }, DURATION_MS)
  );

  // ── Step 4: final report ──────────────────────────────────────────
  log("\n═══════════════════════════════════════════════════════════");
  log("FINAL REPORT");
  log("═══════════════════════════════════════════════════════════");
  printSummary("Final");

  // Bucket alignment analysis
  log("── Bucket alignment analysis ────────────────────────────");
  const wallVsBase = baseMs - Math.floor(baseMs / BUCKET_MS) * BUCKET_MS;
  if (wallVsBase === 0) {
    log("  Bucket grids: IDENTICAL (wall-clock aligned)");
  } else {
    log(`  Bucket grids: DIFFER by ${wallVsBase}ms`);
    log(`  Wall-clock minute grid: :00, :01, :02 ...`);
    log(`  baseMs-aligned grid:    :${new Date(Math.floor(baseMs / BUCKET_MS) * BUCKET_MS).toISOString().slice(14, 19)}, ...`);
    log(`  → Ticks near a minute boundary may land in different buckets depending on grid`);
  }

  // MID_HIT analysis
  log("\n── Mid-hit analysis ─────────────────────────────────────");
  const midHitEntries = allEntries.filter((e) => e.action === "MID_HIT");
  if (midHitEntries.length === 0) {
    log("  No mid-hits detected — series grew cleanly");
  } else {
    log(`  ${midHitEntries.length} mid-hits detected:`);
    for (const e of midHitEntries.slice(0, 20)) {
      log(
        `    ${e.ts.slice(11, 23)} → bucket ${e.bucketTs.slice(11, 19)}` +
        ` mid=${e.mid.toFixed(4)} (${e.interTickGap > 0 ? "+" : ""}${e.interTickGap}ms from prev tick)`
      );
    }
    if (midHitEntries.length > 20) log(`    ... and ${midHitEntries.length - 20} more`);
  }

  // DROP analysis
  log("\n── Drop analysis ────────────────────────────────────────");
  const dropEntries = allEntries.filter((e) => e.action === "DROP");
  if (dropEntries.length === 0) {
    log("  No drops — all ticks arrived in chronological order");
  } else {
    log(`  ${dropEntries.length} drops (out-of-order or stale ticks):`);
    for (const e of dropEntries.slice(0, 10)) {
      log(
        `    ${e.ts.slice(11, 23)} → bucket ${e.bucketTs.slice(11, 19)}` +
        ` was BEFORE tail, gap=${e.interTickGap}ms`
      );
    }
  }

  // DB vs SSE comparison
  if (dbTicksMissedBySse.length > 0) {
    log(`\n── DB ticks missing from SSE (${dbTicksMissedBySse.length}) ──────────`);
    for (const t of dbTicksMissedBySse.slice(0, 20)) {
      log(`  DB ts=${t.ts.slice(11, 23)} mid=${t.mid?.toFixed(4) ?? "null"} market=${t.market_id.slice(0, 16)}`);
    }
  } else {
    log("\n  SSE covered all DB ticks in comparison window");
  }

  // Price at stabilization vs movement
  log("\n── Price series per outcome ─────────────────────────────");
  for (const [key, s] of outcomeStates) {
    if (s.series.length === 0) continue;
    const prices = s.series.map((p) => p.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const first = prices[0];
    const last = prices[prices.length - 1];
    log(
      `  [${key.slice(0, 40)}]` +
      ` series=${s.series.length} first=${first.toFixed(4)} last=${last.toFixed(4)}` +
      ` range=[${min.toFixed(4)}–${max.toFixed(4)}]` +
      ` spread=${((max - min) * 100).toFixed(2)}pp`
    );

    // Detect long flat periods (potential "stabilization" before restructure)
    let flatStart = -1;
    let flatLen = 0;
    let maxFlat = 0;
    for (let i = 1; i < s.series.length; i++) {
      if (Math.abs(s.series[i].price - s.series[i - 1].price) < 0.0001) {
        if (flatStart < 0) flatStart = i - 1;
        flatLen++;
        maxFlat = Math.max(maxFlat, flatLen);
      } else {
        flatStart = -1;
        flatLen = 0;
      }
    }
    if (maxFlat > 5) {
      log(`    ⚠ Longest flat run: ${maxFlat} consecutive identical-price buckets (possible stabilization period)`);
    }
  }

  log("\n═══════════════════════════════════════════════════════════");
  log(`Full log: ${LOG_FILE}`);
  log("Done.");
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
