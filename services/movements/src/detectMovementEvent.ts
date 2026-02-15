import { supabase } from "../../storage/src/db";
import { scoreSignals } from "../../signals/src/scoreSignals";

type EventMovementInput = {
  eventSlug: string;
  childMarketIds: string[];
  nowMs: number;
};

type MovementInsert = {
  id: string;
  market_id: string;
  outcome: string | null;
  window_type: "24h" | "event";
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
  unique_price_levels_24h: number | null;
  avg_trade_size_24h: number | null;
  thin_liquidity: boolean;
};

const EVENT_MARKET_PREFIX = "event:";
const EVENT_MIN_CHILD_MARKETS = Number(process.env.EVENT_MIN_CHILD_MARKETS ?? 2);
const EVENT_MIN_TRADES_PER_BUCKET = Number(
  process.env.EVENT_MIN_TRADES_PER_BUCKET ?? 3
);
const EVENT_MIN_VOLUME_24H = Number(process.env.EVENT_MIN_VOLUME_24H ?? 1000);
const EVENT_STALE_TICK_MS = Number(
  process.env.EVENT_STALE_TICK_MS ?? 10 * 60_000
);

const PRICE_THRESHOLD = Number(process.env.MOVEMENT_PRICE_THRESHOLD ?? 0.08);
const THIN_PRICE_THRESHOLD = Number(
  process.env.MOVEMENT_THIN_PRICE_THRESHOLD ?? 0.12
);
const VOLUME_THRESHOLD = Number(process.env.MOVEMENT_VOLUME_THRESHOLD ?? 1.5);
const MIN_PRICE_FOR_ALERT = Number(
  process.env.MOVEMENT_MIN_PRICE_FOR_ALERT ?? 0.05
);
const MIN_ABS_MOVE = Number(process.env.MOVEMENT_MIN_ABS_MOVE ?? 0.03);

const lastCheckedMs = new Map<string, number>();

function toNum(x: any): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function windowBounds(nowMs: number) {
  const end = new Date(nowMs);
  const start = new Date(nowMs - 24 * 60 * 60 * 1000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function bucketIdHour(tsMs: number) {
  const hourMs = 60 * 60 * 1000;
  return Math.floor(tsMs / hourMs);
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

export async function detectEventMovement({
  eventSlug,
  childMarketIds,
  nowMs,
}: EventMovementInput) {
  if (!eventSlug || childMarketIds.length < EVENT_MIN_CHILD_MARKETS) return;
  if (!Number.isFinite(nowMs)) return;

  const computeKey = `${EVENT_MARKET_PREFIX}${eventSlug}`;
  if (shouldSkipCompute(computeKey, nowMs)) return;

  const { startISO, endISO } = windowBounds(nowMs);

  const { data: trades, error: tradesErr } = await supabase
    .from("trades")
    .select("market_id,price,size,timestamp")
    .in("market_id", childMarketIds)
    .gte("timestamp", startISO)
    .lte("timestamp", endISO)
    .order("timestamp", { ascending: true });

  if (tradesErr) throw tradesErr;
  if (!trades || trades.length < 2) return;

  const volumeByMarket = new Map<string, number>();
  let totalVolume = 0;
  const hourMs = 60 * 60 * 1000;
  const startMs = Date.parse(startISO);
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
    const bucket = Math.floor((ts - startMs) / hourMs);
    tradesByHour.set(bucket, (tradesByHour.get(bucket) ?? 0) + 1);
    volumeByHour.set(bucket, (volumeByHour.get(bucket) ?? 0) + size);
  }

  const tradesCount = trades.length;
  if (totalVolume < EVENT_MIN_VOLUME_24H) return;

  let maxTradesInHour = 0;
  for (const c of tradesByHour.values()) {
    if (c > maxTradesInHour) maxTradesInHour = c;
  }
  if (maxTradesInHour < EVENT_MIN_TRADES_PER_BUCKET) return;

  const { data: ticks, error: ticksErr } = await supabase
    .from("market_mid_ticks")
    .select("market_id,ts,mid")
    .in("market_id", childMarketIds)
    .eq("outcome", "Yes")
    .gte("ts", startISO)
    .lte("ts", endISO)
    .order("ts", { ascending: true });

  if (ticksErr) throw ticksErr;
  if (!ticks || ticks.length < 2) return;

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
        start: mid,
        end: mid,
        min: mid,
        max: mid,
        lastTs: ts,
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
      marketId,
      weight,
      start: stats.start,
      end: stats.end,
      min: stats.min,
      max: stats.max,
    });
  }

  if (entries.length < EVENT_MIN_CHILD_MARKETS) return;

  const startPrice = weightedAvg(
    entries.map((e) => ({ value: e.start, weight: e.weight }))
  );
  const endPrice = weightedAvg(
    entries.map((e) => ({ value: e.end, weight: e.weight }))
  );
  const minPrice = weightedAvg(
    entries.map((e) => ({ value: e.min, weight: e.weight }))
  );
  const maxPrice = weightedAvg(
    entries.map((e) => ({ value: e.max, weight: e.weight }))
  );

  if (startPrice == null || endPrice == null || minPrice == null || maxPrice == null) return;
  if (minPrice <= 0 || startPrice <= 0) return;

  const driftPct = (endPrice - startPrice) / startPrice;
  const rangePct = (maxPrice - minPrice) / minPrice;
  const absMove = Math.abs(maxPrice - minPrice);

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
      const ageDays = Math.max(1, Math.ceil((nowMs - firstMs) / (24 * 60 * 60 * 1000)));
      if (ageDays < 7) continue;
      const observedDays = Math.min(30, ageDays);
      sum += totalVol / observedDays;
      hasBaseline = true;
    }
    baselineDaily = hasBaseline ? sum : null;
  }

  let maxHourVol = 0;
  for (const v of volumeByHour.values()) maxHourVol = Math.max(maxHourVol, v);

  const volumeRatio =
    baselineDaily != null && baselineDaily > 0
      ? totalVolume / baselineDaily
      : null;
  const hourlyRatio =
    baselineDaily != null && baselineDaily > 0
      ? maxHourVol / (baselineDaily / 24)
      : null;

  const priceEligible = minPrice >= MIN_PRICE_FOR_ALERT;
  const driftHit = Math.abs(driftPct) >= PRICE_THRESHOLD;
  const rangeHit = rangePct >= PRICE_THRESHOLD;
  const absHit = absMove >= MIN_ABS_MOVE;
  const priceHit = priceEligible && absHit && (driftHit || rangeHit);

  const volHit =
    (volumeRatio != null && volumeRatio >= VOLUME_THRESHOLD) ||
    (hourlyRatio != null && hourlyRatio >= VOLUME_THRESHOLD);

  if (!priceHit && !volHit) return;

  const thinLiquidity = tradesCount < EVENT_MIN_TRADES_PER_BUCKET * 2;
  const threshold = thinLiquidity ? THIN_PRICE_THRESHOLD : PRICE_THRESHOLD;
  const driftOk = Math.abs(driftPct) >= threshold;
  const rangeOk = rangePct >= threshold;
  const priceOk = priceEligible && absHit && (driftOk || rangeOk);

  if (!priceOk && !volHit) return;

  const reason: MovementInsert["reason"] =
    priceOk && volHit ? "BOTH" : priceOk ? "PRICE" : "VOLUME";

  const bucket = bucketIdHour(nowMs);
  const marketId = `${EVENT_MARKET_PREFIX}${eventSlug}`;
  const movementId = `${marketId}:EVENT:24h:${bucket}`;

  const row: MovementInsert = {
    id: movementId,
    market_id: marketId,
    outcome: "EVENT",
    window_type: "24h",
    window_start: startISO,
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
    trades_count_24h: tradesCount,
    unique_price_levels_24h: null,
    avg_trade_size_24h: tradesCount > 0 ? totalVolume / tradesCount : null,
    thin_liquidity: thinLiquidity,
  };

  const { error } = await supabase.from("market_movements").insert(row);
  if (error) {
    const msg = error.message ?? "";
    if (!msg.includes("duplicate key")) throw error;
    return;
  }

  await scoreSignals(row);
  console.log(
    `[movement-event] ${reason} event=${eventSlug} price=${endPrice.toFixed(4)} ` +
      `drift=${driftPct.toFixed(3)} range=${rangePct.toFixed(3)} ` +
      `vol24h=${totalVolume.toFixed(2)} ratio=${volumeRatio?.toFixed(2) ?? "n/a"}`
  );
}
