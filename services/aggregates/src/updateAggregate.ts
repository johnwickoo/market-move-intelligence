import { supabase } from "../../storage/src/db";
import type { TradeInsert } from "../../storage/src/types";

type MarketAggregateRow = {
  market_id: string;
  window_start: string;
  window_end: string;

  trade_count: number;
  total_volume: number;
  buy_volume: number;
  sell_volume: number;

  avg_trade_size: number;
  last_price: number | null;
  min_price: number | null;
  max_price: number | null;

  updated_at: string;
};

function isoNow() {
  return new Date().toISOString();
}

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function toNum(x: any): number {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) throw new Error(`Expected numeric value, got: ${x}`);
  return n;
}

type AggregateDelta = {
  count: number;
  total: number;
  buy: number;
  sell: number;
  sumTradeSize: number;
  minPrice: number;
  maxPrice: number;
  lastPrice: number;
  lastTimestamp: string;
  firstSeenAt: string;
};

async function applyAggregateDelta(marketId: string, delta: AggregateDelta) {
  // Window start should not predate first_seen_at; keep it aligned to observed data.
  const windowEnd = delta.lastTimestamp;

  // 1) load existing row
  const { data: existing, error: selectErr } = await supabase
    .from("market_aggregates")
    .select("*")
    .eq("market_id", marketId)
    .maybeSingle();

  if (selectErr) throw selectErr;

  // 2) if none -> create fresh row
  if (!existing) {
    const row = {
      market_id: marketId,
      window_start: delta.firstSeenAt,
      window_end: windowEnd,

      trade_count: delta.count,
      total_volume: delta.total,
      buy_volume: delta.buy,
      sell_volume: delta.sell,

      avg_trade_size: delta.sumTradeSize / delta.count,
      last_price: delta.lastPrice,
      min_price: delta.minPrice,
      max_price: delta.maxPrice,

      updated_at: windowEnd,
      first_seen_at: delta.firstSeenAt,
    };

    const { error: insertErr } = await supabase
      .from("market_aggregates")
      .insert(row);

    if (insertErr) throw insertErr;
    return;
  }

  // 3) update existing row
  const oldCount = toNum((existing as any).trade_count);
  const oldAvg = toNum((existing as any).avg_trade_size);
  const oldTotal = toNum((existing as any).total_volume);
  const oldBuy = toNum((existing as any).buy_volume);
  const oldSell = toNum((existing as any).sell_volume);

  const oldMin =
    (existing as any).min_price == null ? null : toNum((existing as any).min_price);
  const oldMax =
    (existing as any).max_price == null ? null : toNum((existing as any).max_price);

  const newCount = oldCount + delta.count;
  const newTotal = oldTotal + delta.total;
  const newBuy = oldBuy + delta.buy;
  const newSell = oldSell + delta.sell;

  // running average
  const newAvg = (oldAvg * oldCount + delta.sumTradeSize) / newCount;

  const newMin = oldMin == null ? delta.minPrice : Math.min(oldMin, delta.minPrice);
  const newMax = oldMax == null ? delta.maxPrice : Math.max(oldMax, delta.maxPrice);
  const existingFirstSeen = (existing as any).first_seen_at as string | null;
  const nextFirstSeen =
    existingFirstSeen && Date.parse(existingFirstSeen) <= Date.parse(delta.firstSeenAt)
      ? existingFirstSeen
      : delta.firstSeenAt;

  const patch = {
    window_start: nextFirstSeen,
    window_end: windowEnd,

    trade_count: newCount,
    total_volume: newTotal,
    buy_volume: newBuy,
    sell_volume: newSell,

    avg_trade_size: newAvg,
    last_price: delta.lastPrice,
    min_price: newMin,
    max_price: newMax,

    updated_at: windowEnd,

    first_seen_at: nextFirstSeen,
  };

  const { error: updateErr } = await supabase
    .from("market_aggregates")
    .update(patch)
    .eq("market_id", marketId);

  if (updateErr) throw updateErr;
}

export async function updateAggregate(trade: TradeInsert) {
  const marketId = trade.market_id;
  const size = toNum(trade.size);
  const price = toNum(trade.price);
  const side = String(trade.side).toUpperCase();

  const delta: AggregateDelta = {
    count: 1,
    total: size,
    buy: side === "BUY" ? size : 0,
    sell: side === "SELL" ? size : 0,
    sumTradeSize: size,
    minPrice: price,
    maxPrice: price,
    lastPrice: price,
    lastTimestamp: trade.timestamp,
    firstSeenAt: trade.timestamp,
  };

  await applyAggregateDelta(marketId, delta);
}

type AggregateBuffer = {
  delta: AggregateDelta;
  flushTimer: NodeJS.Timeout | null;
  flushing: boolean;
  recentCounts: number[];
  nextFlushMs: number;
};

const buffers = new Map<string, AggregateBuffer>();

function parseMs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : Date.now();
}

function getFlushMs() {
  const n = Number(process.env.AGGREGATE_FLUSH_MS ?? 5000);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

function getMaxTrades() {
  const n = Number(process.env.AGGREGATE_MAX_TRADES ?? 50);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

function getMinFlushMs() {
  const n = Number(process.env.AGGREGATE_MIN_FLUSH_MS ?? 1000);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

function getMaxFlushMs() {
  const n = Number(process.env.AGGREGATE_MAX_FLUSH_MS ?? 20000);
  return Number.isFinite(n) && n > 0 ? n : 20000;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function updateDynamicFlush(buf: AggregateBuffer, flushedCount: number) {
  const maxLen = 5;
  buf.recentCounts.push(flushedCount);
  if (buf.recentCounts.length > maxLen) buf.recentCounts.shift();

  const avg =
    buf.recentCounts.reduce((sum, v) => sum + v, 0) / buf.recentCounts.length;
  const minMs = getMinFlushMs();
  const maxMs = getMaxFlushMs();

  // Heuristic: >25 trades/flush => faster; <3 trades/flush => slower.
  let target = buf.nextFlushMs;
  if (avg >= 25) target = Math.max(minMs, Math.floor(buf.nextFlushMs * 0.6));
  else if (avg <= 3) target = Math.min(maxMs, Math.floor(buf.nextFlushMs * 1.5));

  buf.nextFlushMs = clamp(target, minMs, maxMs);
}

async function flushBuffer(marketId: string, reason: "timer" | "count") {
  const buf = buffers.get(marketId);
  if (!buf || buf.flushing) return;

  if (buf.flushTimer) {
    clearTimeout(buf.flushTimer);
    buf.flushTimer = null;
  }

  buf.flushing = true;
  const snapshot = buf.delta;
  buf.delta = {
    count: 0,
    total: 0,
    buy: 0,
    sell: 0,
    sumTradeSize: 0,
    minPrice: Number.POSITIVE_INFINITY,
    maxPrice: Number.NEGATIVE_INFINITY,
    lastPrice: 0,
    lastTimestamp: new Date(0).toISOString(),
    firstSeenAt: new Date(0).toISOString(),
  };

  try {
    if (snapshot.count > 0) {
      console.log(
        `[agg] flush market=${marketId.slice(0, 8)} count=${snapshot.count} reason=${reason}`
      );
      await applyAggregateDelta(marketId, snapshot);
      updateDynamicFlush(buf, snapshot.count);
    }
  } catch (err) {
    // Requeue snapshot on failure to avoid losing counts.
    const cur = buf.delta;
    const merged: AggregateDelta = {
      count: cur.count + snapshot.count,
      total: cur.total + snapshot.total,
      buy: cur.buy + snapshot.buy,
      sell: cur.sell + snapshot.sell,
      sumTradeSize: cur.sumTradeSize + snapshot.sumTradeSize,
      minPrice: Math.min(cur.minPrice, snapshot.minPrice),
      maxPrice: Math.max(cur.maxPrice, snapshot.maxPrice),
      lastPrice:
        parseMs(cur.lastTimestamp) >= parseMs(snapshot.lastTimestamp)
          ? cur.lastPrice
          : snapshot.lastPrice,
      lastTimestamp:
        parseMs(cur.lastTimestamp) >= parseMs(snapshot.lastTimestamp)
          ? cur.lastTimestamp
          : snapshot.lastTimestamp,
      firstSeenAt:
        parseMs(cur.firstSeenAt) <= parseMs(snapshot.firstSeenAt)
          ? cur.firstSeenAt
          : snapshot.firstSeenAt,
    };
    buf.delta = merged;
    setTimeout(() => {
      void flushBuffer(marketId, "timer");
    }, 5000);
    throw err;
  } finally {
    buf.flushing = false;
  }
}

export async function updateAggregateBuffered(trade: TradeInsert) {
  const marketId = trade.market_id;
  const size = toNum(trade.size);
  const price = toNum(trade.price);
  const side = String(trade.side).toUpperCase();

  const ts = trade.timestamp;
  const tsMs = parseMs(ts);

  const existing = buffers.get(marketId);
  if (!existing) {
    const delta: AggregateDelta = {
      count: 1,
      total: size,
      buy: side === "BUY" ? size : 0,
      sell: side === "SELL" ? size : 0,
      sumTradeSize: size,
      minPrice: price,
      maxPrice: price,
      lastPrice: price,
      lastTimestamp: ts,
      firstSeenAt: ts,
    };
    const flushMs = getFlushMs();
    const buf: AggregateBuffer = {
      delta,
      flushTimer: setTimeout(() => void flushBuffer(marketId, "timer"), flushMs),
      flushing: false,
      recentCounts: [],
      nextFlushMs: flushMs,
    };
    buffers.set(marketId, buf);
    return;
  }

  const d = existing.delta;
  const wasEmpty = d.count === 0;
  d.count += 1;
  d.total += size;
  d.buy += side === "BUY" ? size : 0;
  d.sell += side === "SELL" ? size : 0;
  d.sumTradeSize += size;
  if (wasEmpty) {
    d.minPrice = price;
    d.maxPrice = price;
    d.lastPrice = price;
    d.lastTimestamp = ts;
    d.firstSeenAt = ts;
  } else {
    d.minPrice = Math.min(d.minPrice, price);
    d.maxPrice = Math.max(d.maxPrice, price);
    if (tsMs >= parseMs(d.lastTimestamp)) {
      d.lastTimestamp = ts;
      d.lastPrice = price;
    }
    if (tsMs <= parseMs(d.firstSeenAt)) d.firstSeenAt = ts;
  }

  if (!existing.flushTimer) {
    existing.flushTimer = setTimeout(
      () => void flushBuffer(marketId, "timer"),
      existing.nextFlushMs
    );
  }

  if (d.count >= getMaxTrades()) {
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    existing.flushTimer = null;
    await flushBuffer(marketId, "count");
  }
}
