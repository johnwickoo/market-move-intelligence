#!/usr/bin/env npx tsx
/**
 * Midtick Diagnostic — 10-minute sampling test
 *
 * Polls market_mid_ticks every 15s for 10 minutes.
 * For each sample it records:
 *   - interval since previous sample
 *   - all new ticks since last poll (gap, mid, bid, ask, source)
 *   - latest trade price for the same market (for comparison)
 *
 * Results are written to .cursor/debug.log
 *
 * Usage:
 *   npx tsx scripts/midtick-diag.ts                # 10 min default
 *   npx tsx scripts/midtick-diag.ts --minutes=5    # custom duration
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

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const LOG_FILE = resolve(root, ".cursor/debug.log");
const POLL_MS = 15_000;

const minutesArg = process.argv.find((a) => a.startsWith("--minutes="));
const DURATION_MS = (minutesArg ? Number(minutesArg.split("=")[1]) : 10) * 60_000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────

type TickRow = {
  market_id: string;
  outcome: string | null;
  asset_id: string | null;
  ts: string;
  mid: number | null;
  best_bid: number | null;
  best_ask: number | null;
  spread_pct: number | null;
  raw: any;
};

type TradeRow = {
  market_id: string;
  outcome: string | null;
  timestamp: string;
  price: number;
  size: number;
  side: string;
};

async function pgFetch<T = unknown>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function log(line: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
  const formatted = `[${ts}] ${line}`;
  console.log(formatted);
  appendFileSync(LOG_FILE, formatted + "\n");
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── main loop ────────────────────────────────────────────────────────

async function run() {
  writeFileSync(LOG_FILE, `=== Midtick Diagnostic ===\nStarted: ${new Date().toISOString()}\nDuration: ${DURATION_MS / 60_000} minutes\nPoll interval: ${POLL_MS / 1000}s\n\n`);

  // Discover active markets from the last 5 minutes of ticks
  const recent = await pgFetch<TickRow[]>(
    "market_mid_ticks?select=market_id,outcome,asset_id,ts,mid,best_bid,best_ask,spread_pct,raw" +
    "&order=ts.desc&limit=50"
  );

  if (!recent || recent.length === 0) {
    log("ERROR: No recent ticks found in database. Is ingestion running?");
    process.exit(1);
  }

  // Group by market_id — track all active markets
  const marketIds = [...new Set(recent.map((t) => t.market_id))];
  log(`Found ${marketIds.length} active market(s): ${marketIds.map((m) => m.slice(0, 16)).join(", ")}`);
  log("");

  // Track last seen tick per market
  let lastTickTs = recent[0].ts; // most recent tick timestamp
  let lastPollMs = Date.now();
  let sampleNum = 0;
  const startMs = Date.now();

  // Per-market stats
  const stats = new Map<string, {
    tickCount: number;
    gaps: number[];  // ms between consecutive ticks
    lastTickTs: number;
    prices: Array<{ ts: string; mid: number; bid: number | null; ask: number | null; source: string }>;
    tradeComparisons: Array<{ tickMid: number; tradePrice: number; diff: number; tickTs: string; tradeTs: string }>;
  }>();

  for (const mId of marketIds) {
    stats.set(mId, { tickCount: 0, gaps: [], lastTickTs: 0, prices: [], tradeComparisons: [] });
  }

  log("── Starting sampling loop ──────────────────────────────────");
  log("");

  const poll = async () => {
    sampleNum++;
    const nowMs = Date.now();
    const sinceLastPoll = nowMs - lastPollMs;
    lastPollMs = nowMs;

    // Fetch new ticks since last poll
    const newTicks = await pgFetch<TickRow[]>(
      `market_mid_ticks?select=market_id,outcome,asset_id,ts,mid,best_bid,best_ask,spread_pct,raw` +
      `&ts=gt.${encodeURIComponent(lastTickTs)}` +
      `&order=ts.asc&limit=500`
    );

    // Fetch recent trades for comparison
    const recentTrades = await pgFetch<TradeRow[]>(
      `trades?select=market_id,outcome,timestamp,price,size,side` +
      `&timestamp=gt.${encodeURIComponent(lastTickTs)}` +
      `&order=timestamp.desc&limit=100`
    );

    const ticks = newTicks ?? [];
    const trades = recentTrades ?? [];

    // Build latest trade price per market
    const latestTradeByMarket = new Map<string, TradeRow>();
    for (const tr of trades) {
      if (!latestTradeByMarket.has(tr.market_id)) {
        latestTradeByMarket.set(tr.market_id, tr);
      }
    }

    if (ticks.length > 0) {
      lastTickTs = ticks[ticks.length - 1].ts;
    }

    log(`── Sample #${sampleNum} (poll gap: ${fmtMs(sinceLastPoll)}) ──`);
    log(`  New ticks: ${ticks.length}   New trades: ${trades.length}`);

    if (ticks.length === 0) {
      log(`  ⚠ NO NEW TICKS since last poll — CLOB may be silent`);
      // Check if trades exist (CLOB down but trades flowing)
      if (trades.length > 0) {
        log(`  ⚠ Trades ARE flowing (${trades.length}) but no CLOB ticks — trade fallback should activate`);
        for (const tr of trades.slice(0, 3)) {
          log(`    trade: market=${tr.market_id.slice(0, 16)} price=${tr.price} side=${tr.side} ts=${tr.timestamp}`);
        }
      }
    }

    // Process each tick
    for (const tick of ticks) {
      const mId = tick.market_id;
      let s = stats.get(mId);
      if (!s) {
        s = { tickCount: 0, gaps: [], lastTickTs: 0, prices: [], tradeComparisons: [] };
        stats.set(mId, s);
      }

      const tickMs = Date.parse(tick.ts);
      if (s.lastTickTs > 0) {
        const gap = tickMs - s.lastTickTs;
        s.gaps.push(gap);
      }
      s.lastTickTs = tickMs;
      s.tickCount++;

      const source = tick.raw?.source === "trade_fallback" ? "TRADE" : "CLOB";
      const oneSided = (tick.best_bid == null || tick.best_ask == null) && source === "CLOB" ? " (one-sided)" : "";

      s.prices.push({
        ts: tick.ts,
        mid: tick.mid ?? 0,
        bid: tick.best_bid,
        ask: tick.best_ask,
        source,
      });

      // Compare with latest trade
      const latestTrade = latestTradeByMarket.get(mId);
      if (latestTrade && tick.mid != null) {
        const diff = Math.abs(tick.mid - latestTrade.price);
        s.tradeComparisons.push({
          tickMid: tick.mid,
          tradePrice: latestTrade.price,
          diff,
          tickTs: tick.ts,
          tradeTs: latestTrade.timestamp,
        });
      }

      log(
        `  [${source}${oneSided}] market=${mId.slice(0, 16)} outcome=${tick.outcome ?? "n/a"} ` +
        `mid=${tick.mid?.toFixed(4) ?? "null"} bid=${tick.best_bid?.toFixed(4) ?? "n/a"} ` +
        `ask=${tick.best_ask?.toFixed(4) ?? "n/a"} spread%=${tick.spread_pct?.toFixed(4) ?? "n/a"} ` +
        `gap=${s.gaps.length > 0 ? fmtMs(s.gaps[s.gaps.length - 1]) : "first"}` +
        (latestTrade ? ` | trade=${latestTrade.price.toFixed(4)} Δ=${Math.abs((tick.mid ?? 0) - latestTrade.price).toFixed(4)}` : "")
      );
    }

    log("");
  };

  // Initial poll
  await poll();

  // Set up interval
  const timer = setInterval(poll, POLL_MS);

  // Wait for duration
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, DURATION_MS);
  });

  // ── Final summary ──────────────────────────────────────────────────
  log("═══════════════════════════════════════════════════════════");
  log("SUMMARY");
  log("═══════════════════════════════════════════════════════════");
  log(`Duration: ${((Date.now() - startMs) / 60_000).toFixed(1)} minutes`);
  log(`Samples: ${sampleNum}`);
  log("");

  for (const [mId, s] of stats) {
    log(`── Market: ${mId.slice(0, 24)} ──`);
    log(`  Total ticks: ${s.tickCount}`);

    if (s.gaps.length > 0) {
      const sorted = [...s.gaps].sort((a, b) => a - b);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const median = sorted[Math.floor(sorted.length / 2)];
      const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      log(`  Tick intervals: min=${fmtMs(min)} median=${fmtMs(median)} avg=${fmtMs(avg)} max=${fmtMs(max)}`);

      // Identify long gaps (>30s)
      const longGaps = sorted.filter((g) => g > 30_000);
      if (longGaps.length > 0) {
        log(`  ⚠ Long gaps (>30s): ${longGaps.length} occurrences, longest=${fmtMs(max)}`);
      }
    }

    if (s.prices.length > 0) {
      const mids = s.prices.map((p) => p.mid).filter((m) => m > 0);
      const clobCount = s.prices.filter((p) => p.source === "CLOB").length;
      const tradeCount = s.prices.filter((p) => p.source === "TRADE").length;
      log(`  Sources: CLOB=${clobCount} TRADE_FALLBACK=${tradeCount}`);

      if (mids.length > 0) {
        const min = Math.min(...mids);
        const max = Math.max(...mids);
        const last = mids[mids.length - 1];
        log(`  Price range: ${min.toFixed(4)} – ${max.toFixed(4)} (last: ${last.toFixed(4)}, spread: ${((max - min) * 100).toFixed(2)}pp)`);
      }
    }

    if (s.tradeComparisons.length > 0) {
      const diffs = s.tradeComparisons.map((c) => c.diff);
      const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const maxDiff = Math.max(...diffs);
      log(`  Mid vs Trade price: avgΔ=${avgDiff.toFixed(4)} maxΔ=${maxDiff.toFixed(4)}`);
      if (maxDiff > 0.01) {
        log(`  ⚠ Large divergence detected (>1¢) — CLOB mid may be stale`);
      }
    }

    log("");
  }

  log("═══════════════════════════════════════════════════════════");
  log(`Full log: ${LOG_FILE}`);
  log("Done.");
}

run().catch((err) => {
  console.error("Diagnostic error:", err);
  process.exit(1);
});
