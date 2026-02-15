import { supabase } from "../../storage/src/db";
import { scoreSignals } from "../../signals/src/scoreSignals";
import type { WindowType } from "./detectMovement";

type EventMovementInput = {
  eventSlug: string;
  childMarketIds: string[];
  nowMs: number;
};

type MovementInsert = {
  id: string;
  market_id: string;
  outcome: string | null;
  window_type: WindowType;
  window_start: string;
  window_end: string;
  start_price: number | null;
  end_price: number | null;
  pct_change: number | null;
  volume_24h: number;
  baseline_daily_volume: number | null;
  volume_ratio: number | null;
  reason: "PRICE" | "VOLUME" | "BOTH" | "VELOCITY";
  min_price_24h: number | null;
  max_price_24h: number | null;
  range_pct: number | null;
  max_hour_volume: number | null;
  hourly_volume_ratio: number | null;
  trades_count_24h: number;
  unique_price_levels_24h: number | null;
  avg_trade_size_24h: number | null;
  thin_liquidity: boolean;
};

const EVENT_MARKET_PREFIX = "event:";
const EVENT_MIN_CHILD_MARKETS = Number(process.env.EVENT_MIN_CHILD_MARKETS ?? 2);
const EVENT_MIN_TRADES_PER_BUCKET = Number(
  process.env.EVENT_MIN_TRADES_PER_BUCKET ?? 3
);
const EVENT_MIN_VOLUME = Number(process.env.EVENT_MIN_VOLUME ?? 500);
const EVENT_STALE_TICK_MS = Number(
  process.env.EVENT_STALE_TICK_MS ?? 10 * 60_000
);

// Window definitions for event-level detection (1h and 4h only —
// shorter windows don't make sense for cross-market aggregation)
type EventWindowDef = {
  type: WindowType;
  ms: number;
  priceThreshold: number;
  thinPriceThreshold: number;
  minAbsMove: number;
  volumeThreshold: number;
  bucketDivisorMs: number;
};

const EVENT_WINDOWS: EventWindowDef[] = [
  {
    type: "1h",
    ms: 60 * 60_000,
    priceThreshold: Number(process.env.MOVEMENT_1H_PRICE_THRESHOLD ?? 0.06),
    thinPriceThreshold: Number(process.env.MOVEMENT_1H_THIN_THRESHOLD ?? 0.10),
    minAbsMove: Number(process.env.MOVEMENT_1H_MIN_ABS ?? 0.03),
    volumeThreshold: Number(process.env.MOVEMENT_1H_VOLUME_THRESHOLD ?? 1.5),
    bucketDivisorMs: 30 * 60_000,
  },
  {
    type: "4h",
    ms: 4 * 60 * 60_000,
    priceThreshold: Number(process.env.MOVEMENT_4H_PRICE_THRESHOLD ?? 0.08),
    thinPriceThreshold: Number(process.env.MOVEMENT_4H_THIN_THRESHOLD ?? 0.12),
    minAbsMove: Number(process.env.MOVEMENT_4H_MIN_ABS ?? 0.03),
    volumeThreshold: Number(process.env.MOVEMENT_4H_VOLUME_THRESHOLD ?? 1.5),
    bucketDivisorMs: 60 * 60_000,
  },
];

const MIN_PRICE_FOR_ALERT = Number(
  process.env.MOVEMENT_MIN_PRICE_FOR_ALERT ?? 0.05
);

const VELOCITY_THRESHOLD = Number(process.env.MOVEMENT_VELOCITY_THRESHOLD ?? 0.008);

const lastCheckedMs = new Map<string, number>();

function toNum(x: any): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function shouldSkipCompute(key: string, nowMs: number, cooldownMs = 60_000) {
  const prev = lastCheckedMs.get(key) ?? 0;
  if (nowMs - prev < cooldownMs) return true;
  lastCheckedMs.set(key, nowMs);
  return false;
}

function weightedAvg(
  entries: Array<{ value: number; weight: number }>
): number | null {
  let sum = 0;
  let wsum = 0;
  for (const e of entries) {
    if (!Number.isFinite(e.value) || !Number.isFinite(e.weight)) continue;
    if (e.weight <= 0) continue;
    sum += e.value * e.weight;
    wsum += e.weight;
  }
  if (wsum <= 0) return null;
  return sum / wsum;
}

function computeVelocity(absDrift: number, windowMinutes: number): number {
  if (windowMinutes <= 0) return 0;
  return absDrift / Math.sqrt(windowMinutes);
}

export async function detectEventMovement({
  eventSlug,
  childMarketIds,
  nowMs,
}: EventMovementInput) {
  if (!eventSlug || childMarketIds.length < EVENT_MIN_CHILD_MARKETS) return;
  if (!Number.isFinite(nowMs)) return;

  // Use the longest event window for data fetch
  const maxWindowMs = Math.max(...EVENT_WINDOWS.map((w) => w.ms));
  const outerStartMs = nowMs - maxWindowMs;
  const outerStartISO = new Date(outerStartMs).toISOString();
  const endISO = new Date(nowMs).toISOString();

  // Fetch all trades and ticks once
  const { data: allTrades, error: tradesErr } = await supabase
    .from("trades")
    .select("market_id,price,size,timestamp")
    .in("market_id", childMarketIds)
    .gte("timestamp", outerStartISO)
    .lte("timestamp", endISO)
    .order("timestamp", { ascending: true });
  if (tradesErr) throw tradesErr;
  if (!allTrades || allTrades.length < 2) return;

  const { data: allTicks, error: ticksErr } = await supabase
    .from("market_mid_ticks")
    .select("market_id,ts,mid")
    .in("market_id", childMarketIds)
    .eq("outcome", "Yes")
    .gte("ts", outerStartISO)
    .lte("ts", endISO)
    .order("ts", { ascending: true });
  if (ticksErr) throw ticksErr;
  if (!allTicks || allTicks.length < 2) return;

  // Fetch baseline volumes
  const { data: aggregates } = await supabase
    .from("market_aggregates")
    .select("market_id,total_volume,first_seen_at")
    .in("market_id", childMarketIds);

  let baselineDaily: number | null = null;
  if (aggregates && aggregates.length > 0) {
    let sum = 0;
    let hasBaseline = false;
    for (const row of aggregates as any[]) {
      const totalVol = row?.total_volume == null ? null : toNum(row.total_volume);
      const firstSeen = row?.first_seen_at ? String(row.first_seen_at) : null;
      if (totalVol == null || !firstSeen) continue;
      const firstMs = Date.parse(firstSeen);
      if (!Number.isFinite(firstMs)) continue;
      const ageDays = Math.max(1, Math.ceil((nowMs - firstMs) / (24 * 60 * 60_000)));
      if (ageDays < 7) continue;
      const observedDays = Math.min(30, ageDays);
      sum += totalVol / observedDays;
      hasBaseline = true;
    }
    baselineDaily = hasBaseline ? sum : null;
  }

  // Evaluate each window
  for (const w of EVENT_WINDOWS) {
    const computeKey = `${EVENT_MARKET_PREFIX}${eventSlug}:${w.type}`;
    if (shouldSkipCompute(computeKey, nowMs)) continue;

    const wStartMs = nowMs - w.ms;
    const wStartISO = new Date(wStartMs).toISOString();

    // Filter data to this window
    const trades = allTrades.filter((t) => {
      const ts = Date.parse(t.timestamp);
      return Number.isFinite(ts) && ts >= wStartMs && ts <= nowMs;
    });
    const ticks = allTicks.filter((t) => {
      const ts = Date.parse(t.ts);
      return Number.isFinite(ts) && ts >= wStartMs && ts <= nowMs;
    });

    if (trades.length < 2 || ticks.length < 2) continue;

    // Aggregate volume
    const volumeByMarket = new Map<string, number>();
    let totalVolume = 0;
    const hourMs = 60 * 60_000;
    const tradesByHour = new Map<number, number>();
    const volumeByHour = new Map<number, number>();

    for (const t of trades) {
      const size = toNum(t.size ?? 0);
      totalVolume += size;
      volumeByMarket.set(
        t.market_id,
        (volumeByMarket.get(t.market_id) ?? 0) + size
      );
      const ts = Date.parse(t.timestamp);
      if (!Number.isFinite(ts)) continue;
      const bucket = Math.floor((ts - wStartMs) / hourMs);
      tradesByHour.set(bucket, (tradesByHour.get(bucket) ?? 0) + 1);
      volumeByHour.set(bucket, (volumeByHour.get(bucket) ?? 0) + size);
    }

    if (totalVolume < EVENT_MIN_VOLUME) continue;

    let maxTradesInHour = 0;
    for (const c of tradesByHour.values()) {
      if (c > maxTradesInHour) maxTradesInHour = c;
    }
    if (maxTradesInHour < EVENT_MIN_TRADES_PER_BUCKET) continue;

    // Aggregate price per child market
    const perMarket = new Map<
      string,
      { start: number; end: number; min: number; max: number; lastTs: number }
    >();
    for (const tk of ticks) {
      if (tk.mid == null) continue;
      const mid = toNum(tk.mid);
      const ts = Date.parse(tk.ts);
      if (!Number.isFinite(mid) || !Number.isFinite(ts)) continue;
      const prev = perMarket.get(tk.market_id);
      if (!prev) {
        perMarket.set(tk.market_id, {
          start: mid, end: mid, min: mid, max: mid, lastTs: ts,
        });
        continue;
      }
      prev.end = mid;
      prev.min = Math.min(prev.min, mid);
      prev.max = Math.max(prev.max, mid);
      if (ts > prev.lastTs) prev.lastTs = ts;
    }

    const nowCutoff = nowMs - EVENT_STALE_TICK_MS;
    const entries: Array<{
      marketId: string;
      weight: number;
      start: number;
      end: number;
      min: number;
      max: number;
    }> = [];

    for (const [marketId, stats] of perMarket.entries()) {
      if (stats.lastTs < nowCutoff) continue;
      const weight = volumeByMarket.get(marketId) ?? 0;
      if (weight <= 0) continue;
      entries.push({
        marketId, weight,
        start: stats.start, end: stats.end, min: stats.min, max: stats.max,
      });
    }

    if (entries.length < EVENT_MIN_CHILD_MARKETS) continue;

    const startPrice = weightedAvg(entries.map((e) => ({ value: e.start, weight: e.weight })));
    const endPrice = weightedAvg(entries.map((e) => ({ value: e.end, weight: e.weight })));
    const minPrice = weightedAvg(entries.map((e) => ({ value: e.min, weight: e.weight })));
    const maxPrice = weightedAvg(entries.map((e) => ({ value: e.max, weight: e.weight })));

    if (startPrice == null || endPrice == null || minPrice == null || maxPrice == null) continue;
    if (minPrice <= 0 || startPrice <= 0) continue;

    const driftPct = (endPrice - startPrice) / startPrice;
    const rangePct = (maxPrice - minPrice) / minPrice;
    const absMove = Math.abs(maxPrice - minPrice);

    // Volume ratio scaled to this window
    const windowHours = w.ms / hourMs;
    const baselineHourly = baselineDaily != null ? baselineDaily / 24 : null;
    const scaledBaseline = baselineHourly != null ? baselineHourly * windowHours : null;
    const volumeRatio =
      scaledBaseline != null && scaledBaseline > 0 ? totalVolume / scaledBaseline : null;

    let maxHourVol = 0;
    for (const v of volumeByHour.values()) maxHourVol = Math.max(maxHourVol, v);
    const hourlyRatio =
      baselineHourly != null && baselineHourly > 0 ? maxHourVol / baselineHourly : null;

    const thinLiquidity = trades.length < EVENT_MIN_TRADES_PER_BUCKET * 2;
    const threshold = thinLiquidity ? w.thinPriceThreshold : w.priceThreshold;

    const priceEligible = minPrice >= MIN_PRICE_FOR_ALERT;
    const driftHit = Math.abs(driftPct) >= threshold;
    const rangeHit = rangePct >= threshold;
    const absHit = absMove >= w.minAbsMove;
    const priceHit = priceEligible && absHit && (driftHit || rangeHit);

    const volHit =
      (volumeRatio != null && volumeRatio >= w.volumeThreshold) ||
      (hourlyRatio != null && hourlyRatio >= w.volumeThreshold);

    const windowMinutes = w.ms / 60_000;
    const velocity = computeVelocity(Math.abs(driftPct), windowMinutes);
    const velocityHit = velocity >= VELOCITY_THRESHOLD;

    if (!priceHit && !volHit && !velocityHit) continue;

    const reason: MovementInsert["reason"] =
      velocityHit && priceHit
        ? "VELOCITY"
        : priceHit && volHit
          ? "BOTH"
          : priceHit
            ? "PRICE"
            : "VOLUME";

    const bucket = Math.floor(nowMs / w.bucketDivisorMs);
    const marketId = `${EVENT_MARKET_PREFIX}${eventSlug}`;
    const movementId = `${marketId}:EVENT:${w.type}:${bucket}`;

    const row: MovementInsert = {
      id: movementId,
      market_id: marketId,
      outcome: "EVENT",
      window_type: w.type,
      window_start: wStartISO,
      window_end: endISO,
      start_price: startPrice,
      end_price: endPrice,
      pct_change: driftPct,
      volume_24h: totalVolume,
      baseline_daily_volume: baselineDaily,
      volume_ratio: volumeRatio,
      reason,
      min_price_24h: minPrice,
      max_price_24h: maxPrice,
      range_pct: rangePct,
      max_hour_volume: maxHourVol,
      hourly_volume_ratio: hourlyRatio,
      trades_count_24h: trades.length,
      unique_price_levels_24h: null,
      avg_trade_size_24h: trades.length > 0 ? totalVolume / trades.length : null,
      thin_liquidity: thinLiquidity,
    };

    const { error } = await supabase.from("market_movements").insert(row);
    if (error) {
      const msg = error.message ?? "";
      if (!msg.includes("duplicate key")) throw error;
      continue;
    }

    await scoreSignals({ ...row, velocity });
    console.log(
      `[movement-event] ${w.type}/${reason} event=${eventSlug} price=${endPrice.toFixed(4)} ` +
        `drift=${driftPct.toFixed(3)} range=${rangePct.toFixed(3)} ` +
        `vel=${velocity.toFixed(4)} vol=${totalVolume.toFixed(2)} ratio=${volumeRatio?.toFixed(2) ?? "n/a"}`
    );
  }
}
