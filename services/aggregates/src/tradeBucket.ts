import { supabase } from "../../storage/src/db";
import type { TradeInsert } from "../../storage/src/types";

// ── Types ──────────────────────────────────────────────────────────────
type BucketState = {
  market_id: string;
  outcome: string;
  minute_ts: string; // ISO string floored to minute
  open: number;
  high: number;
  low: number;
  close: number;
  volume_total: number;
  buy_volume: number;
  sell_volume: number;
  trade_count: number;
  vwapNumerator: number; // price * size accumulator (not stored directly)
  priceLevels: Set<number>;
  max_trade_size: number;
  last_trade_ts: string;
};

// ── In-memory buffer ───────────────────────────────────────────────────
// Key: "market_id:outcome:minute_ts"
const buckets = new Map<string, BucketState>();

const FLUSH_INTERVAL_MS = Number(process.env.BUCKET_FLUSH_INTERVAL_MS ?? 10_000);
let flushTimer: ReturnType<typeof setInterval> | null = null;

function floorMinute(isoTs: string): string {
  const d = new Date(isoTs);
  d.setSeconds(0, 0);
  return d.toISOString();
}

function bucketKey(marketId: string, outcome: string, minuteTs: string): string {
  return `${marketId}:${outcome}:${minuteTs}`;
}

// ── Accumulate a trade into its minute bucket ──────────────────────────
export function accumulateTrade(trade: TradeInsert) {
  const outcome = trade.outcome ? String(trade.outcome) : "";
  const minuteTs = floorMinute(trade.timestamp);
  const key = bucketKey(trade.market_id, outcome, minuteTs);
  const price = Number(trade.price);
  const size = Number(trade.size);
  const side = String(trade.side).toUpperCase();

  if (!Number.isFinite(price) || !Number.isFinite(size)) return;

  const existing = buckets.get(key);
  if (existing) {
    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
    existing.volume_total += size;
    if (side === "BUY") existing.buy_volume += size;
    else existing.sell_volume += size;
    existing.trade_count += 1;
    existing.vwapNumerator += price * size;
    existing.priceLevels.add(Number(price.toFixed(2)));
    existing.max_trade_size = Math.max(existing.max_trade_size, size);
    if (trade.timestamp > existing.last_trade_ts) {
      existing.last_trade_ts = trade.timestamp;
    }
  } else {
    buckets.set(key, {
      market_id: trade.market_id,
      outcome,
      minute_ts: minuteTs,
      open: price,
      high: price,
      low: price,
      close: price,
      volume_total: size,
      buy_volume: side === "BUY" ? size : 0,
      sell_volume: side === "BUY" ? 0 : size,
      trade_count: 1,
      vwapNumerator: price * size,
      priceLevels: new Set([Number(price.toFixed(2))]),
      max_trade_size: size,
      last_trade_ts: trade.timestamp,
    });
  }
}

// ── Flush all completed minute buckets to DB ───────────────────────────
// "Completed" = minute_ts is older than the current minute.
// The current (still-accumulating) minute stays in memory.
export async function flushBuckets() {
  const nowMinute = floorMinute(new Date().toISOString());
  const toFlush: BucketState[] = [];

  for (const [key, bucket] of buckets) {
    if (bucket.minute_ts < nowMinute) {
      toFlush.push(bucket);
      buckets.delete(key);
    }
  }

  if (toFlush.length === 0) return;

  const rows = toFlush.map((b) => ({
    market_id: b.market_id,
    outcome: b.outcome,
    minute_ts: b.minute_ts,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume_total: b.volume_total,
    buy_volume: b.buy_volume,
    sell_volume: b.sell_volume,
    trade_count: b.trade_count,
    vwap: b.volume_total > 0 ? b.vwapNumerator / b.volume_total : null,
    unique_price_levels: b.priceLevels.size,
    max_trade_size: b.max_trade_size,
    last_trade_ts: b.last_trade_ts,
  }));

  // Upsert in chunks to stay within Supabase payload limits
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("trade_1m")
      .upsert(chunk, { onConflict: "market_id,outcome,minute_ts" });

    if (error) {
      console.error(
        `[trade_1m] flush failed chunk=${i}/${rows.length}:`,
        error.message
      );
      // Put failed buckets back so they retry next flush
      for (const row of chunk) {
        const key = bucketKey(row.market_id, row.outcome ?? "", row.minute_ts);
        // Only re-add if not already re-populated by new trades
        if (!buckets.has(key)) {
          buckets.set(key, {
            ...row,
            outcome: row.outcome ?? "",
            vwapNumerator: (row.vwap ?? 0) * row.volume_total,
            priceLevels: new Set(), // lost on retry, acceptable
            max_trade_size: row.max_trade_size,
            last_trade_ts: row.last_trade_ts,
          });
        }
      }
    } else {
      console.log(`[trade_1m] flushed ${chunk.length} buckets`);
    }
  }
}

// ── Force-flush everything (including current minute) ──────────────────
// Call on graceful shutdown to avoid losing the in-progress minute.
export async function flushAllBuckets() {
  const toFlush = [...buckets.values()];
  buckets.clear();

  if (toFlush.length === 0) return;

  const rows = toFlush.map((b) => ({
    market_id: b.market_id,
    outcome: b.outcome,
    minute_ts: b.minute_ts,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume_total: b.volume_total,
    buy_volume: b.buy_volume,
    sell_volume: b.sell_volume,
    trade_count: b.trade_count,
    vwap: b.volume_total > 0 ? b.vwapNumerator / b.volume_total : null,
    unique_price_levels: b.priceLevels.size,
    max_trade_size: b.max_trade_size,
    last_trade_ts: b.last_trade_ts,
  }));

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("trade_1m")
      .upsert(chunk, { onConflict: "market_id,outcome,minute_ts" });
    if (error) {
      console.error(`[trade_1m] shutdown flush failed:`, error.message);
    }
  }
}

// ── Start/stop the periodic flush timer ────────────────────────────────
export function startBucketFlush() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushBuckets().catch((err) =>
      console.error("[trade_1m] periodic flush error:", err?.message ?? err)
    );
  }, FLUSH_INTERVAL_MS);
  console.log(`[trade_1m] flush timer started (${FLUSH_INTERVAL_MS}ms)`);
}

export function stopBucketFlush() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
