import { supabase } from "../../storage/src/db";
import type { TradeInsert } from "../../storage/src/types";
import { scoreSignals } from "../../signals/src/scoreSignals";

type MovementInsert = {
  id: string;
  market_id: string;
  outcome: string | null;
  window_start: string;
  window_end: string;
  start_price: number | null;
  end_price: number | null;
  pct_change: number | null;

  volume_24h: number;
  baseline_daily_volume: number | null;
  volume_ratio: number | null;

  reason: "PRICE" | "VOLUME" | "BOTH";

  min_price_24h: number | null;
  max_price_24h: number | null;
  range_pct: number | null;

  max_hour_volume: number | null;
  hourly_volume_ratio: number | null;
  trades_count_24h: number;
  unique_price_levels_24h: number;
  avg_trade_size_24h: number | null;
  thin_liquidity: boolean;
};

function toNum(x: any): number {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) throw new Error(`Expected numeric value, got: ${x}`);
  return n;
}

// 24h window ending "now"
function windowBounds(nowMs: number) {
  const end = new Date(nowMs);
  const start = new Date(nowMs - 24 * 60 * 60 * 1000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

// idempotency bucket: 1 event per market+outcome per hour
function bucketIdHour(tsMs: number) {
  const hourMs = 60 * 60 * 1000;
  return Math.floor(tsMs / hourMs);
}

/**
 * Tiny anti-spam guard:
 * only compute movement once per minute per market+outcome in this process.
 * (Prevents constant rereads/recomputes on high trade throughput.)
 */
const lastCheckedMs = new Map<string, number>();
function shouldSkipCompute(key: string, nowMs: number, cooldownMs = 60_000) {
  const prev = lastCheckedMs.get(key) ?? 0;
  if (nowMs - prev < cooldownMs) return true;
  lastCheckedMs.set(key, nowMs);
  return false;
}


export async function detectMovement(trade: TradeInsert) {
  const marketId = trade.market_id;
  const outcome = (trade as any).outcome ? String((trade as any).outcome) : null;

  const nowMs = Date.parse(trade.timestamp);
  if (!Number.isFinite(nowMs)) return;

  const computeKey = `${marketId}:${outcome ?? "NA"}`;
  if (shouldSkipCompute(computeKey, nowMs)) return;

  const { startISO, endISO } = windowBounds(nowMs);

  // deterministic id: market + outcome + hourly bucket
  const bucket = bucketIdHour(nowMs);
  const movementId = `${marketId}:${outcome ?? "NA"}:${bucket}`;

  // 1) pull trades in last 24h for this market (and outcome if present)
  let q = supabase
    .from("trades")
    .select("price,size,timestamp,outcome")
    .eq("market_id", marketId)
    .gte("timestamp", startISO)
    .lte("timestamp", endISO)
    .order("timestamp", { ascending: true });

  if (outcome) q = q.eq("outcome", outcome);

  const { data: trades, error: tradesErr } = await q;
  if (tradesErr) throw tradesErr;

  if (!trades || trades.length < 2) return;

  const startPrice = trades[0].price == null ? null : toNum(trades[0].price);
  const endPrice =
    trades[trades.length - 1].price == null ? null : toNum(trades[trades.length - 1].price);

  // 24h min/max (captures spikes/whipsaws inside the window)
  let min24: number | null = null;
  let max24: number | null = null;

  for (const t of trades) {
    if (t.price == null) continue;
    const px = toNum(t.price);
    min24 = min24 == null ? px : Math.min(min24, px);
    max24 = max24 == null ? px : Math.max(max24, px);
  }

  let rangePct: number | null = null;
  if (min24 != null && max24 != null && min24 > 0) {
    rangePct = (max24 - min24) / min24;
  }

  let pctChange: number | null = null;
  if (startPrice != null && endPrice != null && startPrice !== 0) {
    pctChange = (endPrice - startPrice) / startPrice;
  }

  const volume24h = trades.reduce((sum, t) => sum + toNum(t.size ?? 0), 0);

    // --- Liquidity guard inputs ---
  const tradesCount = trades.length;

  // unique "price levels" in the window
  // (round to avoid float noise creating fake uniqueness)
  const priceLevels = new Set<number>();
  for (const t of trades) {
    if (t.price == null) continue;
    const px = toNum(t.price);
    priceLevels.add(Number(px.toFixed(4)));
  }
  const uniquePriceLevels = priceLevels.size;

  const avgTradeSize24h =
    tradesCount > 0 ? volume24h / tradesCount : null;

  // Thin liquidity rule (simple + effective):
  // If very few trades OR very few price levels,
  // price jumps are likely orderbook effects.
  const THIN_TRADE_COUNT = 15;
  const THIN_PRICE_LEVELS = 8;

  const thinLiquidity =
    tradesCount < THIN_TRADE_COUNT || uniquePriceLevels < THIN_PRICE_LEVELS;


  // 2) baseline daily volume from aggregates (scaled by observed days)
  const { data: agg, error: aggErr } = await supabase
    .from("market_aggregates")
    .select("total_volume, first_seen_at")
    .eq("market_id", marketId)
    .maybeSingle();
  if (aggErr) throw aggErr;

  const totalVol = agg?.total_volume == null ? null : toNum(agg.total_volume);
  const firstSeenISO = (agg as any)?.first_seen_at as string | null;

  let observedDays = 30;
  if (firstSeenISO) {
    const firstMs = Date.parse(firstSeenISO);
    const ageDays = Math.max(1, Math.ceil((nowMs - firstMs) / (24 * 60 * 60 * 1000)));
    observedDays = Math.min(30, ageDays);
  }

  const baselineDaily = totalVol == null ? null : totalVol / observedDays;
  const baselineHourly = baselineDaily == null ? null : baselineDaily / 24;

  const volumeRatio =
    baselineDaily != null && baselineDaily > 0 ? volume24h / baselineDaily : null;

  // hourly spike: max 1-hour volume / baseline hourly
  const hourMs = 60 * 60 * 1000;
  const startMs = Date.parse(startISO);
  const hourlySums = new Map<number, number>();

  for (const t of trades) {
    const ts = Date.parse(t.timestamp);
    if (!Number.isFinite(ts)) continue;
    const b = Math.floor((ts - startMs) / hourMs); // 0..23
    hourlySums.set(b, (hourlySums.get(b) ?? 0) + toNum(t.size ?? 0));
  }

  let maxHourVol = 0;
  for (const v of hourlySums.values()) maxHourVol = Math.max(maxHourVol, v);

  const hourlyRatio =
    baselineHourly != null && baselineHourly > 0 ? maxHourVol / baselineHourly : null;

  // 3) thresholds
  const PRICE_THRESHOLD = 0.15;
  const VOLUME_THRESHOLD = 2.0;

  const driftHit = pctChange != null && Math.abs(pctChange) >= PRICE_THRESHOLD;
  const rangeHit = rangePct != null && rangePct >= PRICE_THRESHOLD;
  let priceHit = driftHit || rangeHit;

    const hasEnoughHistoryForVolume = observedDays >= 3;
    const dailyVolHit =
      hasEnoughHistoryForVolume && volumeRatio != null && volumeRatio >= VOLUME_THRESHOLD;
    const hourlyVolHit =
      hasEnoughHistoryForVolume && hourlyRatio != null && hourlyRatio >= VOLUME_THRESHOLD;

    const volHit = dailyVolHit || hourlyVolHit;

    // If market is thin, require a stronger price move to trigger PRICE.
  // (prevents false “price repricing” from one sweep)
  const THIN_PRICE_THRESHOLD = 0.25;

  if (thinLiquidity) {
    const thinDriftHit = pctChange != null && Math.abs(pctChange) >= THIN_PRICE_THRESHOLD;
    const thinRangeHit = rangePct != null && rangePct >= THIN_PRICE_THRESHOLD;

    // override priceHit under thin liquidity
    const guardedPriceHit = thinDriftHit || thinRangeHit;

    // replace priceHit with guarded version
    // (volume logic stays unchanged)
    // @ts-ignore
    priceHit = guardedPriceHit;
  }
  


  if (!priceHit && !volHit) return;

  const reason: MovementInsert["reason"] =
    priceHit && volHit ? "BOTH" : priceHit ? "PRICE" : "VOLUME";

  const row: MovementInsert = {
    id: movementId,
    market_id: marketId,
    outcome,
    window_start: startISO,
    window_end: endISO,
    start_price: startPrice,
    end_price: endPrice,
    pct_change: pctChange,

    volume_24h: volume24h,
    baseline_daily_volume: baselineDaily,
    volume_ratio: volumeRatio,

    reason,

    min_price_24h: min24,
    max_price_24h: max24,
    range_pct: rangePct,

    max_hour_volume: maxHourVol,
    hourly_volume_ratio: hourlyRatio,
    trades_count_24h: tradesCount,
    unique_price_levels_24h: uniquePriceLevels,
    avg_trade_size_24h: avgTradeSize24h,
    thin_liquidity: thinLiquidity,

    
  };

  // ✅ single-step idempotency: try insert, ignore duplicates
  const { error: insErr } = await supabase.from("market_movements").insert(row);

  if (insErr) {
    const msg = insErr.message ?? "";
    if (msg.includes("duplicate key")) return;
    console.error("[movement] insert failed", msg, "id", movementId);
    throw insErr;
  }

  await scoreSignals(row);

  console.log(
    `[movement] ${reason} market=${marketId} outcome=${outcome ?? "-"} ` +
      `drift=${pctChange?.toFixed(3) ?? "n/a"} range=${rangePct?.toFixed(3) ?? "n/a"} ` +
      `vol24h=${volume24h.toFixed(2)} vr=${volumeRatio?.toFixed(2) ?? "n/a"} ` +
      `hr=${hourlyRatio?.toFixed(2) ?? "n/a"}`
  );
}
