import { supabase } from "../../storage/src/db";
import type { TradeInsert } from "../../storage/src/types";
import { scoreSignals } from "../../signals/src/scoreSignals";

type MovementInsert = {
  id: string;
  market_id: string;
  outcome: string | null;
  window_type: "24h" | "event";
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

  let { startISO, endISO } = windowBounds(nowMs);

  // Clamp window start to first_seen_at so we don't report pre-tracking windows.
  const { data: agg, error: aggErr } = await supabase
    .from("market_aggregates")
    .select("total_volume, first_seen_at")
    .eq("market_id", marketId)
    .maybeSingle();
  if (aggErr) throw aggErr;
  const totalVol = agg?.total_volume == null ? null : toNum(agg.total_volume);
  const firstSeenISO = (agg as any)?.first_seen_at as string | null;
  if (firstSeenISO) {
    const firstMs = Date.parse(firstSeenISO);
    if (Number.isFinite(firstMs) && firstMs > Date.parse(startISO)) {
      startISO = new Date(firstMs).toISOString();
    }
  }

  // deterministic id: market + outcome + hourly bucket
  const bucket = bucketIdHour(nowMs);
  const movementId24h = `${marketId}:${outcome ?? "NA"}:24h:${bucket}`;
  const movementIdEvent = `${marketId}:${outcome ?? "NA"}:event:${bucket}`;

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

  const baseStartMid = startMid;
  const baseEndMid = endMid;
  const baseMinMid = minMid;
  const baseMaxMid = maxMid;
  const baseMidDriftPct = midDriftPct;
  const baseMidRangePct = midRangePct;
  const baseAvgSpreadPct = avgSpreadPct;

  // =========================================================
  // 2b) Anchor start_price to last movement end (if recent)
  // =========================================================
  let effectiveStartISO = startISO;
  if (hasTicks && endMid != null) {
    const { data: lastMove } = await supabase
      .from("market_movements")
      .select("end_price, window_end")
      .eq("market_id", marketId)
      .eq("outcome", outcome)
      .order("window_end", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastEndPrice = (lastMove as any)?.end_price;
    const lastEndISO = (lastMove as any)?.window_end as string | undefined;
    const lastEndMs = lastEndISO ? Date.parse(lastEndISO) : NaN;
    if (lastEndPrice != null && Number.isFinite(lastEndMs)) {
      if (lastEndMs > Date.parse(startISO) && lastEndMs <= nowMs) {
        startMid = toNum(lastEndPrice);
        effectiveStartISO = lastEndISO as string;
        if (startMid > 0) {
          midDriftPct = (endMid - startMid) / startMid;
        }
      }
    }
  }

  let eventMinMid = minMid;
  let eventMaxMid = maxMid;
  let eventMidRangePct = midRangePct;
  if (hasTicks && ticks && effectiveStartISO !== startISO) {
    const eventStartMs = Date.parse(effectiveStartISO);
    eventMinMid = null;
    eventMaxMid = null;
    for (const tk of ticks) {
      const ts = Date.parse(tk.ts);
      if (!Number.isFinite(ts) || ts < eventStartMs) continue;
      if (tk.mid == null) continue;
      const m = toNum(tk.mid);
      eventMinMid = eventMinMid == null ? m : Math.min(eventMinMid, m);
      eventMaxMid = eventMaxMid == null ? m : Math.max(eventMaxMid, m);
    }
    if (eventMinMid != null && eventMaxMid != null && eventMinMid > 0) {
      eventMidRangePct = (eventMaxMid - eventMinMid) / eventMinMid;
    }
  }

  // =========================================================
  // 3) baseline daily volume from aggregates (scaled by observed days)
  // =========================================================
  let observedDays = 30;
  let baselineOk = true;
  if (firstSeenISO) {
    const firstMs = Date.parse(firstSeenISO);
    const ageDays = Math.max(1, Math.ceil((nowMs - firstMs) / (24 * 60 * 60 * 1000)));
    observedDays = Math.min(30, ageDays);
    if (ageDays < 7) baselineOk = false;
  }

  const baselineDaily = totalVol == null || !baselineOk ? null : totalVol / observedDays;
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

  const eventStartMs = Date.parse(effectiveStartISO);
  const eventTrades = Number.isFinite(eventStartMs)
    ? trades.filter((t) => Date.parse(t.timestamp) >= eventStartMs)
    : trades;
  const eventTradesCount = eventTrades.length;
  const eventVolume = eventTrades.reduce((sum, t) => sum + toNum(t.size ?? 0), 0);
  const eventAvgTradeSize =
    eventTradesCount > 0 ? eventVolume / eventTradesCount : null;
  const eventPriceLevelsSet = new Set<number>();
  for (const t of eventTrades) {
    if (t.price == null) continue;
    eventPriceLevelsSet.add(Number(toNum(t.price).toFixed(2)));
  }
  const eventPriceLevels = eventPriceLevelsSet.size;

  // =========================================================
  // 5) LIQUIDITY GUARD (spread + trade sparsity)
  // =========================================================
  const THIN_TRADE_COUNT = 15;
  const THIN_PRICE_LEVELS = 8;
  const WIDE_SPREAD = 0.05; // 5%

  const thinBySpread = baseAvgSpreadPct != null && baseAvgSpreadPct >= WIDE_SPREAD;
  const thinLiquidity =
    thinBySpread ||
    tradesCount < THIN_TRADE_COUNT ||
    uniquePriceLevels < THIN_PRICE_LEVELS;

  // =========================================================
  // 6) THRESHOLDS
  // =========================================================
  const PRICE_THRESHOLD = Number(process.env.MOVEMENT_PRICE_THRESHOLD ?? 0.08);
  const THIN_PRICE_THRESHOLD = Number(process.env.MOVEMENT_THIN_PRICE_THRESHOLD ?? 0.12);
  const VOLUME_THRESHOLD = Number(process.env.MOVEMENT_VOLUME_THRESHOLD ?? 1.5);
  const MIN_PRICE_FOR_ALERT = Number(process.env.MOVEMENT_MIN_PRICE_FOR_ALERT ?? 0.05);
  const MIN_ABS_MOVE = Number(process.env.MOVEMENT_MIN_ABS_MOVE ?? 0.03);
  const CONFIRM_MINUTES = Number(process.env.MOVEMENT_CONFIRM_MINUTES ?? 10);
  const CONFIRM_MIN_TICKS = Number(process.env.MOVEMENT_CONFIRM_MIN_TICKS ?? 3);

  // PRICE uses MID ticks (not trade prints)
  const absMove24 =
    baseMinMid != null && baseMaxMid != null ? Math.abs(baseMaxMid - baseMinMid) : null;
  const priceEligible24 = baseMinMid != null && baseMinMid >= MIN_PRICE_FOR_ALERT;
  const driftHit24 =
    baseMidDriftPct != null &&
    Math.abs(baseMidDriftPct) >= (thinLiquidity ? THIN_PRICE_THRESHOLD : PRICE_THRESHOLD);
  const rangeHit24 =
    baseMidRangePct != null &&
    baseMidRangePct >= (thinLiquidity ? THIN_PRICE_THRESHOLD : PRICE_THRESHOLD);
  const absHit24 = absMove24 != null && absMove24 >= MIN_ABS_MOVE;
  const priceHit24 = hasTicks ? priceEligible24 && absHit24 && (driftHit24 || rangeHit24) : false;

  const absMoveEvent =
    eventMinMid != null && eventMaxMid != null ? Math.abs(eventMaxMid - eventMinMid) : null;
  const priceEligibleEvent = eventMinMid != null && eventMinMid >= MIN_PRICE_FOR_ALERT;
  const driftHitEvent =
    midDriftPct != null &&
    Math.abs(midDriftPct) >= (thinLiquidity ? THIN_PRICE_THRESHOLD : PRICE_THRESHOLD);
  const rangeHitEvent =
    eventMidRangePct != null &&
    eventMidRangePct >= (thinLiquidity ? THIN_PRICE_THRESHOLD : PRICE_THRESHOLD);
  const absHitEvent = absMoveEvent != null && absMoveEvent >= MIN_ABS_MOVE;
  const priceHitEvent =
    hasTicks ? priceEligibleEvent && absHitEvent && (driftHitEvent || rangeHitEvent) : false;

  // VOLUME uses trades vs baseline (daily + hourly spike)
  const hasEnoughHistoryForVolume = observedDays >= 3;

  const dailyVolHit =
    hasEnoughHistoryForVolume && volumeRatio != null && volumeRatio >= VOLUME_THRESHOLD;

  const hourlyVolHit =
    hasEnoughHistoryForVolume && hourlyRatio != null && hourlyRatio >= VOLUME_THRESHOLD;

  const volHit = dailyVolHit || hourlyVolHit;

  // PRICE confirmation: require persistence if volume hasn't confirmed
  let priceConfirmed = priceHitEvent;
  if (priceHitEvent && !volHit && hasTicks && ticks && startMid != null && endMid != null) {
    const confirmMs = Math.max(1, CONFIRM_MINUTES) * 60 * 1000;
    const confirmStartMs = nowMs - confirmMs;
    let wMin: number | null = null;
    let wMax: number | null = null;
    let wCount = 0;
    let wStartPrice: number | null = null;
    for (const tk of ticks) {
      const ts = Date.parse(tk.ts);
      if (!Number.isFinite(ts) || ts < confirmStartMs) continue;
      if (tk.mid == null) continue;
      const m = toNum(tk.mid);
      wMin = wMin == null ? m : Math.min(wMin, m);
      wMax = wMax == null ? m : Math.max(wMax, m);
      if (wStartPrice == null) wStartPrice = m;
      wCount += 1;
    }
    const thresh = thinLiquidity ? THIN_PRICE_THRESHOLD : PRICE_THRESHOLD;
    const confirmThresh = thresh * 0.5;
    if (wCount >= CONFIRM_MIN_TICKS && wMin != null && wMax != null) {
      const upMove = endMid >= startMid;
      if (upMove) {
        priceConfirmed =
          wMin >= startMid * (1 + confirmThresh) || (wMin - startMid) >= MIN_ABS_MOVE;
      } else {
        priceConfirmed =
          wMax <= startMid * (1 - confirmThresh) || (startMid - wMax) >= MIN_ABS_MOVE;
      }
    } else {
      priceConfirmed = false;
    }
    if (!priceConfirmed) {
      console.log("[movement] skip price not confirmed", {
        market_id: marketId,
        outcome: outcome ?? "-",
        confirm_minutes: CONFIRM_MINUTES,
        confirm_ticks: CONFIRM_MIN_TICKS,
        ticks_in_window: wCount,
        start_price: startMid,
        end_price: endMid,
        window_start_price: wStartPrice,
        window_min: wMin,
        window_max: wMax,
      });
    }
  }

  if (!priceHit24 && !volHit && !priceConfirmed) return;

  const reason24: MovementInsert["reason"] =
    priceHit24 && volHit ? "BOTH" : priceHit24 ? "PRICE" : "VOLUME";

  async function insertMovement(row: MovementInsert) {
    const { error: insErr } = await supabase.from("market_movements").insert(row);
    if (insErr) {
      const msg = insErr.message ?? "";
      if (msg.includes("duplicate key")) return false;
      console.error("[movement] insert failed", msg, "id", row.id);
      throw insErr;
    }
    await scoreSignals(row);
    console.log(
      `[movement] ${row.reason} market=${marketId} outcome=${outcome ?? "-"} ` +
        `mid_drift=${row.pct_change?.toFixed(3) ?? "n/a"} mid_range=${row.range_pct?.toFixed(3) ?? "n/a"} ` +
        `vol24h=${row.volume_24h.toFixed(2)} vr=${row.volume_ratio?.toFixed(2) ?? "n/a"} ` +
        `hr=${row.hourly_volume_ratio?.toFixed(2) ?? "n/a"} thin=${thinLiquidity} window=${row.window_start}`
    );
    return true;
  }

  if (priceHit24 || volHit) {
    const row24: MovementInsert = {
      id: movementId24h,
      market_id: marketId,
      outcome,
      window_type: "24h",
      window_start: startISO,
      window_end: endISO,
      start_price: baseStartMid,
      end_price: baseEndMid,
      pct_change: baseMidDriftPct,
      volume_24h: volume24h,
      baseline_daily_volume: baselineDaily,
      volume_ratio: volumeRatio,
      reason: reason24,
      min_price_24h: baseMinMid,
      max_price_24h: baseMaxMid,
      range_pct: baseMidRangePct,
      max_hour_volume: maxHourVol,
      hourly_volume_ratio: hourlyRatio,
      trades_count_24h: tradesCount,
      unique_price_levels_24h: uniquePriceLevels,
      avg_trade_size_24h: avgTradeSize24h,
      thin_liquidity: thinLiquidity,
    };
    await insertMovement(row24);
  }

  if (priceConfirmed && effectiveStartISO !== startISO) {
    const rowEvent: MovementInsert = {
      id: movementIdEvent,
      market_id: marketId,
      outcome,
      window_type: "event",
      window_start: effectiveStartISO,
      window_end: endISO,
      start_price: startMid,
      end_price: endMid,
      pct_change: midDriftPct,
      volume_24h: eventVolume,
      baseline_daily_volume: null,
      volume_ratio: null,
      reason: "PRICE",
      min_price_24h: eventMinMid,
      max_price_24h: eventMaxMid,
      range_pct: eventMidRangePct,
      max_hour_volume: null,
      hourly_volume_ratio: null,
      trades_count_24h: eventTradesCount,
      unique_price_levels_24h: eventPriceLevels,
      avg_trade_size_24h: eventAvgTradeSize,
      thin_liquidity: thinLiquidity,
    };
    await insertMovement(rowEvent);
  }
}
