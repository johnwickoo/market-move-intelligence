import { supabase } from "../../storage/src/db";
import type { TradeInsert } from "../../storage/src/types";

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


};

function toNum(x: any): number {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) throw new Error(`Expected numeric value, got: ${x}`);
  return n;
}

// 24h window ending "now"
function windowBounds(nowMs = Date.now()) {
  const end = new Date(nowMs);
  const start = new Date(nowMs - 24 * 60 * 60 * 1000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

// idempotency bucket: 1 event per market+outcome per hour
function bucketIdHour(tsMs: number) {
  const hourMs = 60 * 60 * 1000;
  return Math.floor(tsMs / hourMs);
}

export async function detectMovement(trade: TradeInsert) {
console.log("[detect] running for", trade.market_id, (trade as any).outcome);
 
  const marketId = trade.market_id;
  const outcome = (trade as any).outcome ? String((trade as any).outcome) : null;

  const nowMs = Date.parse(trade.timestamp); // ISO -> ms
  const { startISO, endISO } = windowBounds(nowMs);

  // deterministic id: market + outcome + hourly bucket
  const bucket = bucketIdHour(nowMs);
  const movementId = `${marketId}:${outcome ?? "NA"}:${bucket}`;

  // 0) idempotency: if we already created this bucket, bail
  const { data: existing, error: existsErr } = await supabase
    .from("market_movements")
    .select("id")
    .eq("id", movementId)
    .maybeSingle();

  if (existsErr) throw existsErr;
  if (existing) return; // already emitted

  // 1) pull trades in last 24h for this market (and outcome if present)
  let q = supabase
    .from("trades")
    .select("price,size,timestamp,side,outcome")
    .eq("market_id", marketId)
    .gte("timestamp", startISO)
    .lte("timestamp", endISO)
    .order("timestamp", { ascending: true });

  // only filter by outcome if you store it
  if (outcome) q = q.eq("outcome", outcome);

  const { data: trades, error: tradesErr } = await q;
  if (tradesErr) throw tradesErr;
    console.log("[detect] trades in 24h =", trades?.length ?? 0);

  if (!trades || trades.length < 2) return; // not enough info to detect movement

  const startPrice = trades[0].price == null ? null : toNum(trades[0].price);
  const endPrice = trades[trades.length - 1].price == null ? null : toNum(trades[trades.length - 1].price);

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
    rangePct = (max24 - min24) / min24; // e.g. 0.15 = 15% range
  }

  let pctChange: number | null = null;
  if (startPrice != null && endPrice != null && startPrice !== 0) {
    pctChange = (endPrice - startPrice) / startPrice; // e.g. 0.15 = +15%
  }

  const volume24h = trades.reduce((sum, t) => sum + toNum(t.size ?? 0), 0);

  // 2) baseline daily volume from aggregates (rough): total_volume / 30
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
      const ageDays = Math.max(
        1,
        Math.ceil((nowMs - firstMs) / (24 * 60 * 60 * 1000))
      );
      observedDays = Math.min(30, ageDays);
  }

  const baselineDaily = totalVol == null ? null : totalVol / observedDays;
  const baselineHourly = baselineDaily == null ? null : baselineDaily / 24;

  // Build hourly buckets for last 24h and find max hour volume
const hourMs = 60 * 60 * 1000;
const startMs = Date.parse(startISO);
const hourlySums = new Map<number, number>();

for (const t of trades) {
  const ts = Date.parse(t.timestamp);
  if (!Number.isFinite(ts)) continue;

  const bucket = Math.floor((ts - startMs) / hourMs); // 0..23
  const prev = hourlySums.get(bucket) ?? 0;
  hourlySums.set(bucket, prev + toNum(t.size ?? 0));
}

let maxHourVol = 0;
for (const v of hourlySums.values()) {
  if (v > maxHourVol) maxHourVol = v;
}

const hourlyRatio =
  baselineHourly != null && baselineHourly > 0 ? maxHourVol / baselineHourly : null;


  // 24h max hourly volume
  const hourly_ratio = volume24h / (baselineHourly ?? 1);



  const volumeRatio =
    baselineDaily && baselineDaily > 0 ? volume24h / baselineDaily : null;

    console.log("[detect] start/end", startPrice, endPrice, "pct", pctChange);
console.log("[detect] vol24h", volume24h, "baselineDaily", baselineDaily, "ratio", volumeRatio);

  // 3) thresholds (thesis)
  const PRICE_THRESHOLD = 0.15;
  const VOLUME_THRESHOLD = 2.0;

  const driftHit = pctChange != null && Math.abs(pctChange) >= PRICE_THRESHOLD;
  const rangeHit = rangePct != null && rangePct >= PRICE_THRESHOLD;

  // PRICE triggers if either drift OR intra-window range is large
  const priceHit = driftHit || rangeHit;

  const hasEnoughHistoryForVolume = observedDays >= 3;
  const dailyVolHit =
    hasEnoughHistoryForVolume && volumeRatio != null && volumeRatio >= VOLUME_THRESHOLD;

  const hourlyVolHit =
    hasEnoughHistoryForVolume && hourlyRatio != null && hourlyRatio >= VOLUME_THRESHOLD;

  const volHit = dailyVolHit || hourlyVolHit;


  console.log("[detect] wouldInsert", { pctChange, volumeRatio, tradesCount: trades.length });
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


  };

  const { error: insErr } = await supabase
    .from("market_movements")
    .insert(row);

  // if a race inserts same id, ignore
  if (insErr) {
    const msg = insErr.message ?? "";
    if (msg.includes("duplicate key")) return;
    throw insErr;
  }

  console.log(
  `[movement] ${reason} market=${marketId} outcome=${outcome ?? "-"} ` +
  `drift=${pctChange?.toFixed(3) ?? "n/a"} range=${rangePct?.toFixed(3) ?? "n/a"} ` +
  `vol24h=${volume24h.toFixed(2)} ratio=${volumeRatio?.toFixed(2) ?? "n/a"}`
);

}
