import { supabase } from "../../storage/src/db";
import type { TradeInsert } from "../../storage/src/types";
import { scoreSignals } from "../../signals/src/scoreSignals";

type MovementInsert = {
  id: string;
  market_id: string;
  outcome: string | null;
  window_start: string;
  window_end: string;

  //these represent MID-price, not trade price
  start_price: number | null;
  end_price: number | null;
  pct_change: number | null;

  volume_24h: number;
  baseline_daily_volume: number | null;
  volume_ratio: number | null;

  reason: "PRICE" | "VOLUME" | "BOTH";

  // hese represent MID min/max/range
  min_price_24h: number | null;
  max_price_24h: number | null;
  range_pct: number | null;

  max_hour_volume: number | null;
  hourly_volume_ratio: number | null;

  trades_count_24h: number;
  unique_price_levels_24h: number;
  avg_trade_size_24h: number | null;

  // liquidity guard
  thin_liquidity: boolean;
};

function toNum(x: any): number {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) throw new Error(`Expected numeric value, got: ${x}`);
  return n;
}

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

  // =========================================================
  // 1) TRADES in last 24h → VOLUME + trade-based liquidity hints
  // =========================================================
  let tq = supabase
    .from("trades")
    .select("price,size,timestamp,outcome")
    .eq("market_id", marketId)
    .gte("timestamp", startISO)
    .lte("timestamp", endISO)
    .order("timestamp", { ascending: true });

  if (outcome) tq = tq.eq("outcome", outcome);

  const { data: trades, error: tradesErr } = await tq;
  if (tradesErr) throw tradesErr;
  if (!trades || trades.length < 2) return;

  const tradesCount = trades.length;

  const volume24h = trades.reduce((sum, t) => sum + toNum(t.size ?? 0), 0);
  const avgTradeSize24h = tradesCount > 0 ? volume24h / tradesCount : null;

  // unique trade price levels (rounded to avoid float noise)
  const priceLevels = new Set<number>();
  for (const t of trades) {
    if (t.price == null) continue;
    priceLevels.add(Number(toNum(t.price).toFixed(2)));
  }
  const uniquePriceLevels = priceLevels.size;

  // =========================================================
  // 2) MID TICKS in last 24h → PRICE movement + spread liquidity
  // =========================================================
  let mq = supabase
    .from("market_mid_ticks")
    .select("mid, ts, spread_pct, outcome")
    .eq("market_id", marketId)
    .gte("ts", startISO)
    .lte("ts", endISO)
    .order("ts", { ascending: true });

  // if you store outcome on ticks, filter it too
  if (outcome) mq = mq.eq("outcome", outcome);

  const { data: ticks, error: ticksErr } = await mq;
  if (ticksErr) throw ticksErr;

  // If we don’t have mid ticks yet, we can’t do price detection.
  // (We can still do volume detection below.)
  const hasTicks = !!ticks && ticks.length >= 2;

  let startMid: number | null = null;
  let endMid: number | null = null;
  let minMid: number | null = null;
  let maxMid: number | null = null;
  let midDriftPct: number | null = null;
  let midRangePct: number | null = null;

  let avgSpreadPct: number | null = null;

  if (hasTicks && ticks) {
    startMid = ticks[0].mid == null ? null : toNum(ticks[0].mid);
    endMid = ticks[ticks.length - 1].mid == null ? null : toNum(ticks[ticks.length - 1].mid);

    for (const tk of ticks) {
      if (tk.mid == null) continue;
      const m = toNum(tk.mid);
      minMid = minMid == null ? m : Math.min(minMid, m);
      maxMid = maxMid == null ? m : Math.max(maxMid, m);
    }

    if (minMid != null && maxMid != null && minMid > 0) {
      midRangePct = (maxMid - minMid) / minMid;
    }
    if (startMid != null && endMid != null && startMid > 0) {
      midDriftPct = (endMid - startMid) / startMid;
    }

    // avg spread % in window (ignore nulls)
    let spreadSum = 0;
    let spreadN = 0;
    for (const tk of ticks) {
      if (tk.spread_pct == null) continue;
      spreadSum += toNum(tk.spread_pct);
      spreadN += 1;
    }
    avgSpreadPct = spreadN > 0 ? spreadSum / spreadN : null;
  }

  // =========================================================
  // 3) baseline daily volume from aggregates (scaled by observed days)
  // =========================================================
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

  // =========================================================
  // 4) hourly max volume ratio (trade-based)
  // =========================================================
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

  // =========================================================
  // 5) LIQUIDITY GUARD (spread + trade sparsity)
  // =========================================================
  const THIN_TRADE_COUNT = 15;
  const THIN_PRICE_LEVELS = 8;
  const WIDE_SPREAD = 0.05; // 5%

  const thinBySpread = avgSpreadPct != null && avgSpreadPct >= WIDE_SPREAD;
  const thinLiquidity =
    thinBySpread ||
    tradesCount < THIN_TRADE_COUNT ||
    uniquePriceLevels < THIN_PRICE_LEVELS;

  // =========================================================
  // 6) THRESHOLDS
  // =========================================================
  const PRICE_THRESHOLD = 0.15;
  const THIN_PRICE_THRESHOLD = 0.25;
  const VOLUME_THRESHOLD = 2.0;

  // PRICE uses MID ticks (not trade prints)
  const driftHit = midDriftPct != null && Math.abs(midDriftPct) >= (thinLiquidity ? THIN_PRICE_THRESHOLD : PRICE_THRESHOLD);
  const rangeHit = midRangePct != null && midRangePct >= (thinLiquidity ? THIN_PRICE_THRESHOLD : PRICE_THRESHOLD);
  const priceHit = hasTicks ? (driftHit || rangeHit) : false;

  // VOLUME uses trades vs baseline (daily + hourly spike)
  const hasEnoughHistoryForVolume = observedDays >= 3;

  const dailyVolHit =
    hasEnoughHistoryForVolume && volumeRatio != null && volumeRatio >= VOLUME_THRESHOLD;

  const hourlyVolHit =
    hasEnoughHistoryForVolume && hourlyRatio != null && hourlyRatio >= VOLUME_THRESHOLD;

  const volHit = dailyVolHit || hourlyVolHit;

  if (!priceHit && !volHit) return;

  const reason: MovementInsert["reason"] =
    priceHit && volHit ? "BOTH" : priceHit ? "PRICE" : "VOLUME";

  const row: MovementInsert = {
    id: movementId,
    market_id: marketId,
    outcome,
    window_start: startISO,
    window_end: endISO,

    // ✅ store MID-based numbers here for now
    start_price: startMid,
    end_price: endMid,
    pct_change: midDriftPct,

    volume_24h: volume24h,
    baseline_daily_volume: baselineDaily,
    volume_ratio: volumeRatio,

    reason,

    min_price_24h: minMid,
    max_price_24h: maxMid,
    range_pct: midRangePct,

    max_hour_volume: maxHourVol,
    hourly_volume_ratio: hourlyRatio,

    trades_count_24h: tradesCount,
    unique_price_levels_24h: uniquePriceLevels,
    avg_trade_size_24h: avgTradeSize24h,
    thin_liquidity: thinLiquidity,
  };

  // ✅ idempotency: insert once per hour bucket
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
      `mid_drift=${midDriftPct?.toFixed(3) ?? "n/a"} mid_range=${midRangePct?.toFixed(3) ?? "n/a"} ` +
      `vol24h=${volume24h.toFixed(2)} vr=${volumeRatio?.toFixed(2) ?? "n/a"} ` +
      `hr=${hourlyRatio?.toFixed(2) ?? "n/a"} thin=${thinLiquidity}`
  );
}
