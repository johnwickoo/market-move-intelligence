import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
import { createJupiterPoller } from "./jupiter.poller";
import {
  jupiterTradeToInsert,
  jupiterOrderbookToMidTick,
} from "./jupiter.transform";
import { resolveMarketsToTrack } from "./jupiter.markets";
import { insertTradeBatch } from "../../../storage/src/db";
import { insertMidTick } from "../../../storage/src/insertMidTick";
import { updateAggregateBuffered } from "../../../aggregates/src/updateAggregate";
import { detectMovement } from "../../../movements/src/detectMovement";
import type { TradeInsert } from "../../../storage/src/types";
import * as fs from "fs";

// ── Config ──────────────────────────────────────────────────────────
const TRADE_BUFFER_MAX = Number(process.env.JUP_TRADE_BUFFER_MAX ?? 100);
const TRADE_BUFFER_FLUSH_MS = Number(
  process.env.JUP_TRADE_BUFFER_FLUSH_MS ?? 1000
);
const TRADE_DEDUPE_TTL_MS = Number(
  process.env.JUP_TRADE_DEDUPE_TTL_MS ?? 10 * 60_000
);
const SLUG_SYNC_MS = Number(process.env.JUP_SLUG_SYNC_MS ?? 30_000);
// Free tier: 1 RPS. Trades poll every 5s + orderbook round-robin with 1.5s gap
// between each request. 10 markets = full orderbook cycle every ~15s.
const TRADE_POLL_MS = Number(process.env.JUP_TRADE_POLL_MS ?? 5_000);
const MIN_REQUEST_GAP_MS = Number(process.env.JUP_MIN_REQUEST_GAP_MS ?? 1_500);
// Max markets to poll orderbooks for (top N by 24h volume).
// Trades are tracked for ALL discovered markets regardless.
const MAX_ORDERBOOK_MARKETS = Number(process.env.JUP_MAX_ORDERBOOK_MARKETS ?? 20);
const SPOOL_PATH =
  process.env.JUP_SPOOL_PATH ?? "/tmp/mmi-jup-trade-spool.ndjson";

// Movement gating
const MOVEMENT_MIN_MS = Number(process.env.MOVEMENT_MIN_MS ?? 10_000);
const MOVEMENT_MIN_STEP = Number(process.env.MOVEMENT_MIN_STEP ?? 0.01);

// ── State ───────────────────────────────────────────────────────────
const recentTrades = new Map<string, number>();
const tradeBuffer: TradeInsert[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let insertFailCount = 0;
const INSERT_FAIL_THRESHOLD = 3;
const trackedMarketIds = new Set<string>(); // raw Jupiter market IDs

const lastMovementGate = new Map<
  string,
  { price: number; ts: number }
>();

// ── Logging ─────────────────────────────────────────────────────────
const LOG_PATH = process.env.JUP_LOG_PATH ?? "/tmp/mmi-jupiter.log";
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
  if (recentTrades.has(id)) return true;
  recentTrades.set(id, Date.now());
  return false;
}

setInterval(() => {
  const cutoff = Date.now() - TRADE_DEDUPE_TTL_MS;
  for (const [id, ts] of recentTrades) {
    if (ts < cutoff) recentTrades.delete(id);
  }
}, 60_000);

// ── Spool ───────────────────────────────────────────────────────────
function appendToSpool(trades: TradeInsert[]) {
  try {
    const lines = trades.map((t) => JSON.stringify(t)).join("\n") + "\n";
    fs.appendFileSync(SPOOL_PATH, lines);
    console.warn(`[jup] spooled ${trades.length} trades to ${SPOOL_PATH}`);
  } catch (err: any) {
    console.error("[jup] spool write failed:", err?.message);
  }
}

// ── Trade buffer ────────────────────────────────────────────────────
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
      `[jup] trade insert failed (${insertFailCount}/${INSERT_FAIL_THRESHOLD}):`,
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

// ── Main ────────────────────────────────────────────────────────────
let tradeCount = 0;
let tickCount = 0;

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("[jup] Jupiter Prediction Market ingestion starting...");
  console.log(`[jup] log → ${LOG_PATH}`);
  console.log(`[jup] spool → ${SPOOL_PATH}`);
  console.log(
    `[jup] trade poll: ${TRADE_POLL_MS}ms, orderbook gap: ${MIN_REQUEST_GAP_MS}ms`
  );
  const hasKey = !!(process.env.JUP_API_KEY);
  console.log(`[jup] API key: ${hasKey ? "loaded" : "MISSING — get one at portal.jup.ag"}`);
  console.log("═══════════════════════════════════════════════════════");

  // 1. Discover markets
  const markets = await resolveMarketsToTrack();
  if (markets.length === 0) {
    console.warn(
      "[jup] no markets to track — add jup: slugs to tracked_slugs or set JUP_AUTO_DISCOVER=1"
    );
  } else {
    console.log(
      `[jup] tracking ${markets.length} markets`
    );
    for (const m of markets.slice(0, 10)) {
      console.log(`  → ${m.title} (${m.marketId.slice(0, 20)}...)`);
    }
    if (markets.length > 10) {
      console.log(`  ... and ${markets.length - 10} more`);
    }
  }

  // Build tracked set for trade filtering
  for (const m of markets) trackedMarketIds.add(m.marketId);

  // 2. Create poller
  const poller = createJupiterPoller({
    tradePollMs: TRADE_POLL_MS,
    minRequestGapMs: MIN_REQUEST_GAP_MS,

    onTrade: async (raw) => {
      // Filter: only process trades for tracked markets
      if (trackedMarketIds.size > 0 && !trackedMarketIds.has(raw.marketId)) {
        return;
      }

      const trade = jupiterTradeToInsert(raw);
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

      // Aggregate
      try {
        await updateAggregateBuffered(trade);
      } catch (err: any) {
        console.error("[jup] aggregate error:", err?.message);
      }

      // Movement detection
      if (shouldDetect(trade)) {
        try {
          await detectMovement(trade);
        } catch (err: any) {
          console.error("[jup] detectMovement error:", err?.message);
        }
      }

      if (tradeCount % 50 === 0) {
        console.log(
          `[jup] ${tradeCount} trades processed, ${tickCount} ticks`
        );
      }
    },

    onOrderbook: async (marketId, book) => {
      const tick = jupiterOrderbookToMidTick(marketId, book);
      if (!tick) return;

      tickCount++;

      try {
        await insertMidTick(tick);
      } catch (err: any) {
        const msg = err?.message ?? "";
        if (!msg.includes("duplicate key")) {
          console.error("[jup] mid-tick error:", msg);
        }
      }
    },
  });

  // 3. Start trade polling
  poller.startTradePoller();

  // 4. Start orderbook polling for top N markets by 24h volume
  const orderbookMarkets = [...markets]
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, MAX_ORDERBOOK_MARKETS);

  console.log(
    `[jup] orderbook polling top ${orderbookMarkets.length} of ${markets.length} markets by volume`
  );
  for (const m of orderbookMarkets) {
    poller.addOrderbookMarket(m.marketId);
  }

  // 5. Periodic market sync — add/remove markets dynamically
  setInterval(async () => {
    try {
      const desired = await resolveMarketsToTrack();

      // Update trade tracking set (all markets)
      trackedMarketIds.clear();
      for (const m of desired) trackedMarketIds.add(m.marketId);

      // Orderbook: only top N by volume
      const topN = [...desired]
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, MAX_ORDERBOOK_MARKETS);
      const desiredOB = new Set(topN.map((m) => m.marketId));
      const currentOB = new Set(poller.orderbookMarkets());

      // Add new top markets
      for (const m of topN) {
        if (!currentOB.has(m.marketId)) {
          poller.addOrderbookMarket(m.marketId);
        }
      }

      // Remove markets that dropped out of top N
      for (const id of currentOB) {
        if (!desiredOB.has(id)) {
          poller.removeOrderbookMarket(id);
        }
      }
    } catch (err: any) {
      console.error("[jup] market sync error:", err?.message);
    }
  }, SLUG_SYNC_MS);

  // 6. Stats
  setInterval(() => {
    console.log(
      `[jup] stats: ${tradeCount} trades, ${tickCount} ticks, ` +
        `buffer=${tradeBuffer.length}, dedup=${recentTrades.size}, ` +
        `markets=${trackedMarketIds.size}`
    );
  }, 60_000);

  // Graceful shutdown
  const shutdown = () => {
    console.log("[jup] shutting down...");
    poller.close();
    void flushTradeBuffer().then(() => {
      logStream.end();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[jup] fatal:", err);
  process.exit(1);
});
