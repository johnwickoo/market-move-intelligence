import "dotenv/config";
import { connectDriftWS, type DriftWsHandle } from "./drift.ws";
import { driftTradeToInsert, driftOrderbookToMidTick } from "./drift.transform";
import { fetchDriftTrades } from "./drift.api";
import { resolveMarketsToTrack } from "./drift.markets";
import { insertTradeBatch } from "../../../storage/src/db";
import { insertMidTick } from "../../../storage/src/insertMidTick";
import { updateAggregateBuffered } from "../../../aggregates/src/updateAggregate";
import { detectMovement } from "../../../movements/src/detectMovement";
import type { TradeInsert } from "../../../storage/src/types";
import * as fs from "fs";

// ── Config ──────────────────────────────────────────────────────────
const TRADE_BUFFER_MAX = Number(process.env.DRIFT_TRADE_BUFFER_MAX ?? 100);
const TRADE_BUFFER_FLUSH_MS = Number(
  process.env.DRIFT_TRADE_BUFFER_FLUSH_MS ?? 1000
);
const TRADE_DEDUPE_TTL_MS = Number(
  process.env.DRIFT_TRADE_DEDUPE_TTL_MS ?? 10 * 60_000
);
const SLUG_SYNC_MS = Number(process.env.DRIFT_SLUG_SYNC_MS ?? 30_000);
const BACKFILL_ON_START = process.env.DRIFT_BACKFILL_ON_START !== "0";
const BACKFILL_LIMIT = Number(process.env.DRIFT_BACKFILL_LIMIT ?? 100);
const SPOOL_PATH =
  process.env.DRIFT_SPOOL_PATH ?? "/tmp/mmi-drift-trade-spool.ndjson";

// Movement gating — same logic as Polymarket adapter
const MOVEMENT_MIN_MS = Number(process.env.MOVEMENT_MIN_MS ?? 10_000);
const MOVEMENT_MIN_STEP = Number(process.env.MOVEMENT_MIN_STEP ?? 0.01);

// ── State ───────────────────────────────────────────────────────────
const recentTrades = new Map<string, number>();
const tradeBuffer: TradeInsert[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let insertFailCount = 0;
const INSERT_FAIL_THRESHOLD = 3;

// Movement gating per market:outcome
const lastMovementGate = new Map<
  string,
  { price: number; ts: number }
>();

// ── Logging ─────────────────────────────────────────────────────────
const LOG_PATH = process.env.DRIFT_LOG_PATH ?? "/tmp/mmi-drift.log";
const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function stamp() {
  return new Date().toISOString();
}

console.log = (...args: any[]) => {
  const line = `${stamp()} [LOG] ${args.join(" ")}\n`;
  logStream.write(line);
  origLog(...args);
};
console.warn = (...args: any[]) => {
  const line = `${stamp()} [WARN] ${args.join(" ")}\n`;
  logStream.write(line);
  origWarn(...args);
};
console.error = (...args: any[]) => {
  const line = `${stamp()} [ERR] ${args.join(" ")}\n`;
  logStream.write(line);
  origError(...args);
};

// ── Trade dedup ─────────────────────────────────────────────────────
function isDuplicateTrade(id: string): boolean {
  const now = Date.now();
  if (recentTrades.has(id)) return true;
  recentTrades.set(id, now);
  return false;
}

// Periodic eviction
setInterval(() => {
  const cutoff = Date.now() - TRADE_DEDUPE_TTL_MS;
  for (const [id, ts] of recentTrades) {
    if (ts < cutoff) recentTrades.delete(id);
  }
}, 60_000);

// ── Spool to disk on repeated failures ──────────────────────────────
function appendToSpool(trades: TradeInsert[]) {
  try {
    const lines = trades.map((t) => JSON.stringify(t)).join("\n") + "\n";
    fs.appendFileSync(SPOOL_PATH, lines);
    console.warn(`[drift] spooled ${trades.length} trades to ${SPOOL_PATH}`);
  } catch (err: any) {
    console.error("[drift] spool write failed:", err?.message);
  }
}

// ── Trade buffer flush ──────────────────────────────────────────────
async function flushTradeBuffer() {
  if (tradeBuffer.length === 0) return;
  const batch = tradeBuffer.splice(0, tradeBuffer.length);

  if (insertFailCount >= INSERT_FAIL_THRESHOLD) {
    appendToSpool(batch);
    return;
  }

  try {
    await insertTradeBatch(batch);
    insertFailCount = 0;
  } catch (err: any) {
    insertFailCount++;
    console.error(
      `[drift] trade insert failed (${insertFailCount}/${INSERT_FAIL_THRESHOLD}):`,
      err?.message
    );
    appendToSpool(batch);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushTradeBuffer();
  }, TRADE_BUFFER_FLUSH_MS);
}

// ── Movement gating ─────────────────────────────────────────────────
function shouldDetect(trade: TradeInsert): boolean {
  const gateKey = `${trade.market_id}:${trade.outcome}`;
  const now = Date.parse(trade.timestamp);
  if (!Number.isFinite(now)) return false;

  const prev = lastMovementGate.get(gateKey);
  if (!prev) {
    lastMovementGate.set(gateKey, { price: trade.price, ts: now });
    return true;
  }

  const enoughTime = now - prev.ts >= MOVEMENT_MIN_MS;
  const enoughMove = Math.abs(trade.price - prev.price) >= MOVEMENT_MIN_STEP;

  if (enoughTime && enoughMove) {
    lastMovementGate.set(gateKey, { price: trade.price, ts: now });
    return true;
  }

  return false;
}

// ── Backfill ────────────────────────────────────────────────────────
async function backfillMarket(marketName: string) {
  console.log(`[drift] backfilling ${marketName} (limit=${BACKFILL_LIMIT})`);
  try {
    const rawTrades = await fetchDriftTrades(marketName, {
      limit: BACKFILL_LIMIT,
    });

    let inserted = 0;
    const batch: TradeInsert[] = [];

    for (const raw of rawTrades) {
      const trade = driftTradeToInsert(raw);
      if (!trade) continue;
      if (isDuplicateTrade(trade.id)) continue;
      batch.push(trade);
      inserted++;
    }

    if (batch.length > 0) {
      await insertTradeBatch(batch);
      for (const t of batch) {
        await updateAggregateBuffered(t);
      }
    }

    console.log(
      `[drift] backfilled ${inserted} trades for ${marketName}`
    );
  } catch (err: any) {
    console.error(
      `[drift] backfill failed for ${marketName}:`,
      err?.message
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────
let tradeCount = 0;
let tickCount = 0;

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("[drift] Drift BET ingestion starting...");
  console.log(`[drift] log → ${LOG_PATH}`);
  console.log(`[drift] spool → ${SPOOL_PATH}`);
  console.log("═══════════════════════════════════════════════════════");

  // 1. Discover markets to track
  const marketNames = await resolveMarketsToTrack();
  if (marketNames.length === 0) {
    console.warn(
      "[drift] no markets to track — add drift: slugs to tracked_slugs or set DRIFT_AUTO_DISCOVER=1"
    );
  } else {
    console.log(
      `[drift] tracking ${marketNames.length} markets: ${marketNames.join(", ")}`
    );
  }

  // 2. Connect WebSocket
  const wsHandle: DriftWsHandle = connectDriftWS({
    onTrade: async (raw) => {
      const trade = driftTradeToInsert(raw);
      if (!trade) return;
      if (isDuplicateTrade(trade.id)) return;

      tradeCount++;

      // Buffer for batch insert
      tradeBuffer.push(trade);
      if (tradeBuffer.length >= TRADE_BUFFER_MAX) {
        await flushTradeBuffer();
      } else {
        scheduleFlush();
      }

      // Aggregate update (buffered)
      try {
        await updateAggregateBuffered(trade);
      } catch (err: any) {
        console.error("[drift] aggregate error:", err?.message);
      }

      // Movement detection (gated)
      if (shouldDetect(trade)) {
        try {
          await detectMovement(trade);
        } catch (err: any) {
          console.error("[drift] detectMovement error:", err?.message);
        }
      }

      if (tradeCount % 50 === 0) {
        console.log(
          `[drift] ${tradeCount} trades processed, ${tickCount} ticks`
        );
      }
    },

    onOrderbook: async (raw) => {
      const tick = driftOrderbookToMidTick(raw);
      if (!tick) return;

      tickCount++;

      try {
        await insertMidTick(tick);
      } catch (err: any) {
        const msg = err?.message ?? "";
        if (!msg.includes("duplicate key")) {
          console.error("[drift] mid-tick error:", msg);
        }
      }
    },
  });

  // 3. Subscribe to all tracked markets
  for (const name of marketNames) {
    wsHandle.subscribe(name);
  }

  // 4. Backfill recent trades
  if (BACKFILL_ON_START && marketNames.length > 0) {
    console.log("[drift] backfilling recent trades...");
    for (const name of marketNames) {
      await backfillMarket(name);
    }
    console.log("[drift] backfill complete");
  }

  // 5. Periodic slug sync — add/remove subscriptions dynamically
  setInterval(async () => {
    try {
      const current = new Set(wsHandle.subscribedMarkets());
      const desired = new Set(await resolveMarketsToTrack());

      // Subscribe to new markets
      for (const name of desired) {
        if (!current.has(name)) {
          wsHandle.subscribe(name);
          if (BACKFILL_ON_START) {
            await backfillMarket(name);
          }
        }
      }

      // Unsubscribe from removed markets
      for (const name of current) {
        if (!desired.has(name)) {
          wsHandle.unsubscribe(name);
        }
      }
    } catch (err: any) {
      console.error("[drift] slug sync error:", err?.message);
    }
  }, SLUG_SYNC_MS);

  // 6. Periodic stats
  setInterval(() => {
    console.log(
      `[drift] stats: ${tradeCount} trades, ${tickCount} ticks, ` +
        `buffer=${tradeBuffer.length}, dedup=${recentTrades.size}, ` +
        `markets=${wsHandle.subscribedMarkets().length}`
    );
  }, 60_000);

  // Graceful shutdown
  const shutdown = () => {
    console.log("[drift] shutting down...");
    wsHandle.close();
    void flushTradeBuffer().then(() => {
      logStream.end();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[drift] fatal:", err);
  process.exit(1);
});
