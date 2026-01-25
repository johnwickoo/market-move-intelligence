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

export async function updateAggregate(trade: TradeInsert) {
  const marketId = trade.market_id;

  // normalize (DB may store as string depending on column types)
  const size = toNum(trade.size);
  const price = toNum(trade.price);
  const side = String(trade.side).toUpperCase();

  // 30d rolling window definition (simple for now; no subtraction yet)
  const windowStart = isoDaysAgo(30);
  const windowEnd = trade.timestamp;

  // 1) load existing row
  const { data: existing, error: selectErr } = await supabase
    .from("market_aggregates")
    .select("*")
    .eq("market_id", marketId)
    .maybeSingle();

  if (selectErr) throw selectErr;

  // 2) if none -> create fresh row
  if (!existing) {
    const tradeCount = 1;
    const totalVol = size;
    const buyVol = side === "BUY" ? size : 0;
    const sellVol = side === "SELL" ? size : 0;

    const row = {
      market_id: marketId,
      window_start: windowStart,
      window_end: windowEnd,

      trade_count: tradeCount,
      total_volume: totalVol,
      buy_volume: buyVol,
      sell_volume: sellVol,

      avg_trade_size: size,
      last_price: price,
      min_price: price,
      max_price: price,

      updated_at: windowEnd,
      first_seen_at: trade.timestamp,
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

  const newCount = oldCount + 1;
  const newTotal = oldTotal + size;
  const newBuy = oldBuy + (side === "BUY" ? size : 0);
  const newSell = oldSell + (side === "SELL" ? size : 0);

  // running average
  const newAvg = (oldAvg * oldCount + size) / newCount;

  const newMin = oldMin == null ? price : Math.min(oldMin, price);
  const newMax = oldMax == null ? price : Math.max(oldMax, price);
  const existingFirstSeen = (existing as any).first_seen_at as string | null;

  const patch = {
    window_start: windowStart,
    window_end: windowEnd,

    trade_count: newCount,
    total_volume: newTotal,
    buy_volume: newBuy,
    sell_volume: newSell,

    avg_trade_size: newAvg,
    last_price: price,
    min_price: newMin,
    max_price: newMax,

    updated_at: windowEnd,

     ...(existingFirstSeen ? {} : { first_seen_at: trade.timestamp }),
  };
  
  const { error: updateErr } = await supabase
    .from("market_aggregates")
    .update(patch)
    .eq("market_id", marketId);

  if (updateErr) throw updateErr;
}
