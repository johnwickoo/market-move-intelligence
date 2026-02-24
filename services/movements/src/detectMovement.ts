import { supabase } from "../../storage/src/db";
import type { TradeInsert } from "../../storage/src/types";

// ── Window types ──────────────────────────────────────────────────────
// "5m" | "15m" | "1h" | "4h" are the active detection windows.
// "event" is still emitted for since-last-signal anchoring.
export type WindowType = "5m" | "15m" | "1h" | "4h" | "event";

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

  volume_24h: number; // volume in THIS window (column name kept for schema compat)
  baseline_daily_volume: number | null;
  volume_ratio: number | null;

  reason: "PRICE" | "VOLUME" | "BOTH" | "VELOCITY";

  min_price_24h: number | null; // min price in THIS window
  max_price_24h: number | null; // max price in THIS window
  range_pct: number | null;

  max_hour_volume: number | null;
  hourly_volume_ratio: number | null;

  trades_count_24h: number; // trade count in THIS window
  unique_price_levels_24h: number;
  avg_trade_size_24h: number | null;

  thin_liquidity: boolean;

  // New fields stored in the existing JSON-friendly columns via "reason" metadata
  velocity?: number | null;
};

// ── Window definitions ────────────────────────────────────────────────
// Each window has its own duration, price threshold, and idempotency bucket.
// Shorter windows use tighter thresholds — a 3% move in 5m is significant,
// while 4h needs 8%+ to filter daily noise.
type WindowDef = {
  type: WindowType;
  ms: number;
  priceThreshold: number;
  thinPriceThreshold: number;
  minAbsMove: number;
  volumeThreshold: number;
  minTicks: number;        // minimum mid ticks to evaluate
  minTrades: number;       // minimum trades to evaluate
  bucketDivisorMs: number; // idempotency bucket size
  cooldownMs: number;      // per-key anti-spam cooldown
};

const WINDOWS: WindowDef[] = [
  {
    type: "5m",
    ms: 5 * 60_000,
    priceThreshold: Number(process.env.MOVEMENT_5M_PRICE_THRESHOLD ?? 0.03),
    thinPriceThreshold: Number(process.env.MOVEMENT_5M_THIN_THRESHOLD ?? 0.05),
    minAbsMove: Number(process.env.MOVEMENT_5M_MIN_ABS ?? 0.02),
    volumeThreshold: Number(process.env.MOVEMENT_5M_VOLUME_THRESHOLD ?? 2.0),
    minTicks: 2,
    minTrades: 2,
    bucketDivisorMs: 5 * 60_000,   // 1 signal per 5min bucket
    cooldownMs: Number(process.env.MOVEMENT_5M_COOLDOWN_MS ?? 60_000),
  },
  {
    type: "15m",
    ms: 15 * 60_000,
    priceThreshold: Number(process.env.MOVEMENT_15M_PRICE_THRESHOLD ?? 0.04),
    thinPriceThreshold: Number(process.env.MOVEMENT_15M_THIN_THRESHOLD ?? 0.07),
    minAbsMove: Number(process.env.MOVEMENT_15M_MIN_ABS ?? 0.02),
    volumeThreshold: Number(process.env.MOVEMENT_15M_VOLUME_THRESHOLD ?? 2.0),
    minTicks: 3,
    minTrades: 3,
    bucketDivisorMs: 15 * 60_000,
    cooldownMs: Number(process.env.MOVEMENT_15M_COOLDOWN_MS ?? 120_000),
  },
  {
    type: "1h",
    ms: 60 * 60_000,
    priceThreshold: Number(process.env.MOVEMENT_1H_PRICE_THRESHOLD ?? 0.06),
    thinPriceThreshold: Number(process.env.MOVEMENT_1H_THIN_THRESHOLD ?? 0.10),
    minAbsMove: Number(process.env.MOVEMENT_1H_MIN_ABS ?? 0.03),
    volumeThreshold: Number(process.env.MOVEMENT_1H_VOLUME_THRESHOLD ?? 2.0),
    minTicks: 4,
    minTrades: 5,
    bucketDivisorMs: 30 * 60_000,
    cooldownMs: Number(process.env.MOVEMENT_1H_COOLDOWN_MS ?? 180_000),
  },
  {
    type: "4h",
    ms: 4 * 60 * 60_000,
    priceThreshold: Number(process.env.MOVEMENT_4H_PRICE_THRESHOLD ?? 0.08),
    thinPriceThreshold: Number(process.env.MOVEMENT_4H_THIN_THRESHOLD ?? 0.12),
    minAbsMove: Number(process.env.MOVEMENT_4H_MIN_ABS ?? 0.03),
    volumeThreshold: Number(process.env.MOVEMENT_4H_VOLUME_THRESHOLD ?? 2.0),
    minTicks: 5,
    minTrades: 8,
    bucketDivisorMs: 60 * 60_000,
    cooldownMs: Number(process.env.MOVEMENT_4H_COOLDOWN_MS ?? 300_000),
  },
];

// ── Shared config ────────────────────────────────────────────────────
const MIN_PRICE_FOR_ALERT = Number(process.env.MOVEMENT_MIN_PRICE_FOR_ALERT ?? 0.05);
const CONFIRM_MINUTES = Number(process.env.MOVEMENT_CONFIRM_MINUTES ?? 5);
const CONFIRM_MIN_TICKS = Number(process.env.MOVEMENT_CONFIRM_MIN_TICKS ?? 3);
const THIN_TRADE_COUNT = 15;
const THIN_PRICE_LEVELS = 8;
const WIDE_SPREAD = 0.05;

// Velocity significance: |price_delta| / sqrt(minutes)
// A 5% move in 5min = 0.05/sqrt(5) = 0.022
// An 8% move in 4h  = 0.08/sqrt(240) = 0.005
const VELOCITY_THRESHOLD = Number(process.env.MOVEMENT_VELOCITY_THRESHOLD ?? 0.008);

// Minimum drift required for volume-only signals. Prevents noise from
// high-volume events where price barely moves (e.g., 6x volume but 0.5% drift).
const MIN_DRIFT_FOR_VOLUME = Number(process.env.MOVEMENT_MIN_DRIFT_FOR_VOLUME ?? 0.02);

// Global per-market cooldown: max 1 signal per market+outcome across ALL
// window types. Prevents 5m+15m+1h+4h from all firing for the same move.
const GLOBAL_COOLDOWN_MS = Number(process.env.MOVEMENT_GLOBAL_COOLDOWN_MS ?? 180_000);
const lastEmitMs = new Map<string, number>();

// Minimum elapsed time for "event" window (since-last-signal anchoring).
const EVENT_MIN_ELAPSED_MS = Number(process.env.MOVEMENT_EVENT_MIN_ELAPSED_MS ?? 10 * 60_000);

function toNum(x: any): number {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) throw new Error(`Expected numeric value, got: ${x}`);
  return n;
}

function safeNum(x: any, fallback = 0): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// ── Anti-spam guards (per window type) ───────────────────────────────
const lastCheckedMs = new Map<string, number>();
function shouldSkipCompute(key: string, nowMs: number, cooldownMs: number): boolean {
  const prev = lastCheckedMs.get(key) ?? 0;
  if (nowMs - prev < cooldownMs) return true;
  lastCheckedMs.set(key, nowMs);
  return false;
}

// ── Velocity calculation ─────────────────────────────────────────────
// Normalizes price change by sqrt(time) — standard diffusion scaling.
// This makes a 3% move in 5 minutes score higher than an 8% move in 4 hours.
function computeVelocity(absDrift: number, windowMinutes: number): number {
  if (windowMinutes <= 0) return 0;
  return absDrift / Math.sqrt(windowMinutes);
}

// ── Main entry point ─────────────────────────────────────────────────
export async function detectMovement(trade: TradeInsert) {
  const marketId = trade.market_id;
  const outcome = (trade as any).outcome ? String((trade as any).outcome) : null;
  const nowMs = Date.parse(trade.timestamp);
  if (!Number.isFinite(nowMs)) return;

  // Fetch aggregate stats once (shared across windows)
  const { data: agg, error: aggErr } = await supabase
    .from("market_aggregates")
    .select("total_volume, first_seen_at")
    .eq("market_id", marketId)
    .maybeSingle();
  if (aggErr) throw aggErr;

  const totalVol = agg?.total_volume == null ? null : toNum(agg.total_volume);
  const firstSeenISO = (agg as any)?.first_seen_at as string | null;
  let firstSeenMs: number | null = null;
  if (firstSeenISO) {
    const ms = Date.parse(firstSeenISO);
    if (Number.isFinite(ms)) firstSeenMs = ms;
  }

  // Baseline volume (7-day minimum for reliability)
  let observedDays = 30;
  let baselineOk = true;
  if (firstSeenMs != null) {
    const ageDays = Math.max(1, Math.ceil((nowMs - firstSeenMs) / (24 * 60 * 60_000)));
    observedDays = Math.min(30, ageDays);
    if (ageDays < 7) baselineOk = false;
  }
  const baselineDaily = totalVol == null || !baselineOk ? null : totalVol / observedDays;
  const baselineHourly = baselineDaily == null ? null : baselineDaily / 24;

  // Find the longest window we need data for (4h)
  const maxWindowMs = Math.max(...WINDOWS.map((w) => w.ms));
  const outerStartMs = nowMs - maxWindowMs;
  let outerStartISO = new Date(outerStartMs).toISOString();
  if (firstSeenMs != null && firstSeenMs > outerStartMs) {
    outerStartISO = new Date(firstSeenMs).toISOString();
  }
  const endISO = new Date(nowMs).toISOString();

  // ── Fetch ticks + trades once for the full 4h window ────────────
  // Use DESCENDING order so the row-limit cap (PostgREST max_rows, typically
  // 1000) cuts the oldest, least-relevant records rather than the most recent
  // ones. Short-window analysis (5m, 15m) depends on recent data — with
  // ascending order a busy market would return 1000 rows from hours ago and
  // contain zero trades in the last 5 minutes.
  let tq = supabase
    .from("trades")
    .select("price,size,timestamp,outcome")
    .eq("market_id", marketId)
    .gte("timestamp", outerStartISO)
    .lte("timestamp", endISO)
    .order("timestamp", { ascending: false });
  if (outcome) tq = tq.eq("outcome", outcome);
  const { data: allTrades, error: tradesErr } = await tq.limit(10000);
  if (tradesErr) throw tradesErr;
  if (!allTrades || allTrades.length < 2) return;

  let mq = supabase
    .from("market_mid_ticks")
    .select("mid, ts, spread_pct, outcome")
    .eq("market_id", marketId)
    .gte("ts", outerStartISO)
    .lte("ts", endISO)
    .order("ts", { ascending: false });
  if (outcome) mq = mq.eq("outcome", outcome);
  const { data: allTicks, error: ticksErr } = await mq.limit(10000);
  if (ticksErr) throw ticksErr;

  // ── Last movement anchor for "event" window ────────────────────
  let lastMoveEndPrice: number | null = null;
  let lastMoveEndISO: string | null = null;
  {
    const { data: lastMove } = await supabase
      .from("market_movements")
      .select("end_price, window_end")
      .eq("market_id", marketId)
      .eq("outcome", outcome)
      .order("window_end", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ep = (lastMove as any)?.end_price;
    const we = (lastMove as any)?.window_end as string | undefined;
    const weMs = we ? Date.parse(we) : NaN;
    if (ep != null && Number.isFinite(weMs) && weMs > outerStartMs && weMs <= nowMs) {
      lastMoveEndPrice = toNum(ep);
      lastMoveEndISO = we as string;
    }
  }

  // ── Evaluate each window ───────────────────────────────────────
  for (const w of WINDOWS) {
    const computeKey = `${marketId}:${outcome ?? "NA"}:${w.type}`;
    if (shouldSkipCompute(computeKey, nowMs, w.cooldownMs)) continue;

    const wStartMs = nowMs - w.ms;
    const wStartISO = new Date(Math.max(wStartMs, firstSeenMs ?? 0)).toISOString();

    // Filter ticks/trades to this window.
    // allTicks/allTrades are in descending order (newest-first) from the DB
    // query; sort ticks ascending here so ticks[0]=oldest and ticks[last]=newest
    // for correct startMid/endMid price analysis. Trades are only used for
    // count/volume/levels so their order does not matter.
    const ticks = (allTicks
      ? allTicks.filter((t) => {
          const ts = Date.parse(t.ts);
          return Number.isFinite(ts) && ts >= wStartMs && ts <= nowMs;
        })
      : []).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const trades = allTrades.filter((t) => {
      const ts = Date.parse(t.timestamp);
      return Number.isFinite(ts) && ts >= wStartMs && ts <= nowMs;
    });

    if (ticks.length < w.minTicks && trades.length < w.minTrades) continue;
    const hasTicks = ticks.length >= 2;

    // Skip outcomes priced below the alert floor — prevents noise from
    // penny-priced child markets in multi-outcome events.
    if (hasTicks) {
      const lastMid = safeNum(ticks[ticks.length - 1].mid);
      if (lastMid < MIN_PRICE_FOR_ALERT) continue;
    }

    // ── Price analysis from mid ticks ──
    let startMid: number | null = null;
    let endMid: number | null = null;
    let minMid: number | null = null;
    let maxMid: number | null = null;
    let avgSpreadPct: number | null = null;

    if (hasTicks) {
      startMid = ticks[0].mid == null ? null : safeNum(ticks[0].mid);
      endMid = ticks[ticks.length - 1].mid == null ? null : safeNum(ticks[ticks.length - 1].mid);
      let spreadSum = 0;
      let spreadN = 0;
      for (const tk of ticks) {
        if (tk.mid == null) continue;
        const m = safeNum(tk.mid);
        minMid = minMid == null ? m : Math.min(minMid, m);
        maxMid = maxMid == null ? m : Math.max(maxMid, m);
        if (tk.spread_pct != null) {
          spreadSum += safeNum(tk.spread_pct);
          spreadN += 1;
        }
      }
      avgSpreadPct = spreadN > 0 ? spreadSum / spreadN : null;
    }

    // ── Trade stats ──
    const tradesCount = trades.length;
    const volume = trades.reduce((sum, t) => sum + safeNum(t.size ?? 0), 0);
    const avgTradeSize = tradesCount > 0 ? volume / tradesCount : null;
    const priceLevelsSet = new Set<number>();
    for (const t of trades) {
      if (t.price == null) continue;
      priceLevelsSet.add(Number(safeNum(t.price).toFixed(2)));
    }
    const uniquePriceLevels = priceLevelsSet.size;

    // ── Liquidity guard ──
    const thinBySpread = avgSpreadPct != null && avgSpreadPct >= WIDE_SPREAD;
    const thinByActivity = tradesCount < THIN_TRADE_COUNT || uniquePriceLevels < THIN_PRICE_LEVELS;
    // Wide spread alone does not indicate thin liquidity when there is substantial
    // trade activity. A large spread during a fast move reflects price discovery,
    // not lack of participation. Only use spread as a thin signal when trade count
    // is also low (< 4× the baseline thin threshold).
    const thinLiquidity = thinByActivity || (thinBySpread && tradesCount < THIN_TRADE_COUNT * 4);

    // ── Price metrics ──
    const driftPct =
      startMid != null && endMid != null && startMid > 0
        ? (endMid - startMid) / startMid
        : null;
    const rangePct =
      minMid != null && maxMid != null && minMid > 0
        ? (maxMid - minMid) / minMid
        : null;
    const absMove =
      minMid != null && maxMid != null ? Math.abs(maxMid - minMid) : null;

    const priceEligible = minMid != null && minMid >= MIN_PRICE_FOR_ALERT;
    const threshold = thinLiquidity ? w.thinPriceThreshold : w.priceThreshold;
    const driftHit = driftPct != null && Math.abs(driftPct) >= threshold;
    const absHit = absMove != null && absMove >= w.minAbsMove;
    // Require directional drift — range alone (oscillation without net move) is noise.
    const priceHit = hasTicks && priceEligible && absHit && driftHit;

    // ── Volume metrics ──
    // Scale hourly volume against baseline for this window's duration
    const windowHours = w.ms / (60 * 60_000);
    const scaledBaseline = baselineHourly != null ? baselineHourly * windowHours : null;
    const volumeRatio =
      scaledBaseline != null && scaledBaseline > 0 ? volume / scaledBaseline : null;

    // Hourly max within this window
    const hourMs = 60 * 60_000;
    const hourlySums = new Map<number, number>();
    for (const t of trades) {
      const ts = Date.parse(t.timestamp);
      if (!Number.isFinite(ts)) continue;
      const b = Math.floor((ts - wStartMs) / hourMs);
      hourlySums.set(b, (hourlySums.get(b) ?? 0) + safeNum(t.size ?? 0));
    }
    let maxHourVol = 0;
    for (const v of hourlySums.values()) maxHourVol = Math.max(maxHourVol, v);
    const hourlyRatio =
      baselineHourly != null && baselineHourly > 0 ? maxHourVol / baselineHourly : null;

    const volHit =
      (volumeRatio != null && volumeRatio >= w.volumeThreshold) ||
      (hourlyRatio != null && hourlyRatio >= w.volumeThreshold);

    // ── Velocity metric ──
    const windowMinutes = w.ms / 60_000;
    const velocity =
      driftPct != null ? computeVelocity(Math.abs(driftPct), windowMinutes) : null;
    const velocityHit = velocity != null && velocity >= VELOCITY_THRESHOLD;

    // ── Confirmation for short windows without volume ──
    let priceConfirmed = priceHit;
    if (priceHit && !volHit && !velocityHit && hasTicks && startMid != null && endMid != null) {
      const confirmMs = Math.max(1, CONFIRM_MINUTES) * 60_000;
      const confirmStartMs = nowMs - confirmMs;
      let wCount = 0;
      let wMin: number | null = null;
      let wMax: number | null = null;
      for (const tk of ticks) {
        const ts = Date.parse(tk.ts);
        if (!Number.isFinite(ts) || ts < confirmStartMs) continue;
        if (tk.mid == null) continue;
        const m = safeNum(tk.mid);
        wMin = wMin == null ? m : Math.min(wMin, m);
        wMax = wMax == null ? m : Math.max(wMax, m);
        wCount += 1;
      }
      const confirmThresh = threshold * 0.5;
      if (wCount >= CONFIRM_MIN_TICKS && wMin != null && wMax != null) {
        const upMove = endMid >= startMid;
        priceConfirmed = upMove
          ? wMin >= startMid * (1 + confirmThresh) || (wMin - startMid) >= w.minAbsMove
          : wMax <= startMid * (1 - confirmThresh) || (startMid - wMax) >= w.minAbsMove;
      } else {
        priceConfirmed = false;
      }
    }

    // ── Decision: emit? ──
    if (!priceConfirmed && !volHit && !velocityHit) continue;

    // Volume-only signals require meaningful price movement — suppress
    // "high volume, flat price" noise.
    if (volHit && !priceConfirmed && !velocityHit) {
      const absDrift = driftPct != null ? Math.abs(driftPct) : 0;
      if (absDrift < MIN_DRIFT_FOR_VOLUME) continue;
    }

    // Global per-market cooldown: only 1 signal per market+outcome every N ms
    // across all window types. Prevents burst of 5m+15m+1h+4h for one move.
    const globalKey = `${marketId}:${outcome ?? "NA"}`;
    const lastEmit = lastEmitMs.get(globalKey) ?? 0;
    if (nowMs - lastEmit < GLOBAL_COOLDOWN_MS) continue;

    const reason: MovementInsert["reason"] =
      velocityHit && priceConfirmed
        ? "VELOCITY"
        : priceConfirmed && volHit
          ? "BOTH"
          : priceConfirmed
            ? "PRICE"
            : "VOLUME";

    const bucketId = Math.floor(nowMs / w.bucketDivisorMs);
    const movementId = `${marketId}:${outcome ?? "NA"}:${w.type}:${bucketId}`;

    const row: MovementInsert = {
      id: movementId,
      market_id: marketId,
      outcome,
      window_type: w.type,
      window_start: wStartISO,
      window_end: endISO,
      start_price: startMid,
      end_price: endMid,
      pct_change: driftPct,
      volume_24h: volume,
      baseline_daily_volume: baselineDaily,
      volume_ratio: volumeRatio,
      reason,
      min_price_24h: minMid,
      max_price_24h: maxMid,
      range_pct: rangePct,
      max_hour_volume: maxHourVol,
      hourly_volume_ratio: hourlyRatio,
      trades_count_24h: tradesCount,
      unique_price_levels_24h: uniquePriceLevels,
      avg_trade_size_24h: avgTradeSize,
      thin_liquidity: thinLiquidity,
      velocity,
    };

    const inserted = await insertMovement(row, marketId, outcome, thinLiquidity);
    if (inserted) lastEmitMs.set(globalKey, nowMs);
  }

  // ── "event" window: since last signal ──────────────────────────
  if (lastMoveEndPrice != null && lastMoveEndISO != null) {
    const eventComputeKey = `${marketId}:${outcome ?? "NA"}:event`;
    if (!shouldSkipCompute(eventComputeKey, nowMs, 60_000)) {
      const eventStartMs = Date.parse(lastMoveEndISO);
      const eventElapsedMs = Number.isFinite(eventStartMs) ? nowMs - eventStartMs : 0;
      if (Number.isFinite(eventStartMs) && eventStartMs < nowMs && eventElapsedMs >= EVENT_MIN_ELAPSED_MS) {
        // Sort ascending so eventTicks[last] is the most recent tick (eLastMid).
        const eventTicks = (allTicks
          ? allTicks.filter((t) => {
              const ts = Date.parse(t.ts);
              return Number.isFinite(ts) && ts >= eventStartMs && ts <= nowMs;
            })
          : []).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
        const eventTrades = allTrades.filter((t) => {
          const ts = Date.parse(t.timestamp);
          return Number.isFinite(ts) && ts >= eventStartMs && ts <= nowMs;
        });

        const eLastMid = safeNum(eventTicks[eventTicks.length - 1]?.mid);
        if (eventTicks.length >= 2 && eventTrades.length >= 2 && eLastMid >= MIN_PRICE_FOR_ALERT) {
          const eEndMid = eLastMid;
          const eStartMid = lastMoveEndPrice;
          let eMinMid: number | null = null;
          let eMaxMid: number | null = null;
          for (const tk of eventTicks) {
            if (tk.mid == null) continue;
            const m = safeNum(tk.mid);
            eMinMid = eMinMid == null ? m : Math.min(eMinMid, m);
            eMaxMid = eMaxMid == null ? m : Math.max(eMaxMid, m);
          }

          const eDriftPct = eStartMid > 0 ? (eEndMid - eStartMid) / eStartMid : null;
          const eRangePct =
            eMinMid != null && eMaxMid != null && eMinMid > 0
              ? (eMaxMid - eMinMid) / eMinMid
              : null;
          const eAbsMove =
            eMinMid != null && eMaxMid != null ? Math.abs(eMaxMid - eMinMid) : null;

          // Use 1h thresholds for event window
          const eventThreshold = 0.06;
          const eventMinAbs = 0.03;
          const eDriftHit = eDriftPct != null && Math.abs(eDriftPct) >= eventThreshold;
          const eAbsHit = eAbsMove != null && eAbsMove >= eventMinAbs;
          const ePriceEligible = eMinMid != null && eMinMid >= MIN_PRICE_FOR_ALERT;

          // Global cooldown also applies to event window
          const eventGlobalKey = `${marketId}:${outcome ?? "NA"}`;
          const eventLastEmit = lastEmitMs.get(eventGlobalKey) ?? 0;
          const eventCooldownOk = nowMs - eventLastEmit >= GLOBAL_COOLDOWN_MS;

          if (ePriceEligible && eAbsHit && eDriftHit && eventCooldownOk) {
            const eVolume = eventTrades.reduce(
              (sum, t) => sum + safeNum(t.size ?? 0),
              0
            );
            const eLevels = new Set<number>();
            for (const t of eventTrades) {
              if (t.price == null) continue;
              eLevels.add(Number(safeNum(t.price).toFixed(2)));
            }

            // Compute velocity for the event window
            const eventMinutes = Math.max(1, (nowMs - eventStartMs) / 60_000);
            const eVelocity = eDriftPct != null
              ? computeVelocity(Math.abs(eDriftPct), eventMinutes)
              : null;

            const bucketId = Math.floor(nowMs / (60 * 60_000));
            const row: MovementInsert = {
              id: `${marketId}:${outcome ?? "NA"}:event:${bucketId}`,
              market_id: marketId,
              outcome,
              window_type: "event",
              window_start: lastMoveEndISO,
              window_end: endISO,
              start_price: eStartMid,
              end_price: eEndMid,
              pct_change: eDriftPct,
              volume_24h: eVolume,
              baseline_daily_volume: null,
              volume_ratio: null,
              reason: "PRICE",
              min_price_24h: eMinMid,
              max_price_24h: eMaxMid,
              range_pct: eRangePct,
              max_hour_volume: null,
              hourly_volume_ratio: null,
              trades_count_24h: eventTrades.length,
              unique_price_levels_24h: eLevels.size,
              avg_trade_size_24h:
                eventTrades.length > 0 ? eVolume / eventTrades.length : null,
              thin_liquidity: false,
              velocity: eVelocity,
            };

            const eventInserted = await insertMovement(row, marketId, outcome, false);
            if (eventInserted) lastEmitMs.set(eventGlobalKey, nowMs);
          }
        }
      }
    }
  }
}

// Finalize delays per window type — how long to wait for momentum to settle
// before running classification + explanation with stable data.
const FINALIZE_DELAY_MS: Record<string, number> = {
  "5m": 5 * 60_000,    // 5 min
  "15m": 10 * 60_000,  // 10 min
  "1h": 30 * 60_000,   // 30 min
  "4h": 2 * 3_600_000, // 2 hours
  "event": 5 * 60_000, // 5 min
};

async function insertMovement(
  row: MovementInsert,
  marketId: string,
  outcome: string | null,
  thinLiquidity: boolean
): Promise<boolean> {
  // Strip the velocity field before insert — it's not a DB column.
  const velocity = row.velocity;
  const { velocity: _v, ...dbRow } = row;

  const delayMs = FINALIZE_DELAY_MS[row.window_type] ?? 15 * 60_000;
  const finalizeAt = new Date(Date.now() + delayMs).toISOString();

  // ── Movement chain extension ─────────────────────────────────────────
  // For time-windowed detections (not "event" since-last-signal windows),
  // look for an existing OPEN movement of the same type that fired recently.
  // If one exists, EXTEND it instead of inserting a new row:
  //   - window_start + start_price stay frozen from the first detection (the anchor)
  //   - window_end + end_price advance to the current tick
  //   - pct_change reflects the total drift from anchor to now
  //   - volume/trades accumulate across detections
  //   - finalize_at is pushed out so the worker waits for full momentum
  //
  // This collapses "4 separate 5m bands on the chart" into one clean
  // start→end signal showing the true magnitude of the move.
  if (row.window_type !== "event") {
    const chainCutoff = new Date(Date.now() - delayMs).toISOString(); // delayMs ≈ 2 × window

    // Build outcome filter (null needs IS NULL, not = NULL)
    const chainQ = supabase
      .from("market_movements")
      .select("id, start_price, min_price_24h, max_price_24h, volume_24h, trades_count_24h")
      .eq("market_id", row.market_id)
      .eq("window_type", row.window_type)
      .eq("status", "OPEN")
      .gte("window_end", chainCutoff);
    const chainQFiltered = outcome !== null
      ? chainQ.eq("outcome", outcome)
      : chainQ.is("outcome", null);

    const { data: existing } = await chainQFiltered
      .order("window_start", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (existing) {
      const origStart = existing.start_price != null ? Number(existing.start_price) : null;
      const newEnd = dbRow.end_price;
      const newDrift =
        origStart != null && origStart > 0 && newEnd != null
          ? (newEnd - origStart) / origStart
          : dbRow.pct_change;

      const prevMin = existing.min_price_24h != null ? Number(existing.min_price_24h) : Infinity;
      const prevMax = existing.max_price_24h != null ? Number(existing.max_price_24h) : -Infinity;
      const newMin = Math.min(prevMin, dbRow.min_price_24h ?? Infinity);
      const newMax = Math.max(prevMax, dbRow.max_price_24h ?? -Infinity);
      const newRangePct =
        Number.isFinite(newMin) && Number.isFinite(newMax) && newMin > 0
          ? (newMax - newMin) / newMin
          : dbRow.range_pct;

      const newVol = Number(existing.volume_24h ?? 0) + (dbRow.volume_24h ?? 0);
      const newTrades = Number(existing.trades_count_24h ?? 0) + (dbRow.trades_count_24h ?? 0);

      // Re-evaluate thin_liquidity as trades accumulate: a movement that started
      // with sparse activity but grew to many trades should not stay "thin".
      // Only keep thin=true if accumulated trade count is still below the activity cap.
      const updatedThinLiquidity = thinLiquidity && newTrades < THIN_TRADE_COUNT * 4;

      const { error: updateErr } = await supabase
        .from("market_movements")
        .update({
          window_end: dbRow.window_end,
          end_price: newEnd,
          pct_change: newDrift,
          min_price_24h: Number.isFinite(newMin) ? newMin : null,
          max_price_24h: Number.isFinite(newMax) ? newMax : null,
          range_pct: newRangePct,
          volume_24h: newVol,
          trades_count_24h: newTrades,
          avg_trade_size_24h: newTrades > 0 ? newVol / newTrades : null,
          thin_liquidity: updatedThinLiquidity,
          finalize_at: finalizeAt, // push deadline out so worker waits for full move
        })
        .eq("id", existing.id);

      if (updateErr) {
        console.error("[movement] chain extend failed", existing.id, updateErr.message);
        return false;
      }

      console.log(
        `[movement] EXTEND ${row.window_type} id=${existing.id.slice(0, 24)} ` +
        `start=${origStart?.toFixed(4) ?? "n/a"} end=${newEnd?.toFixed(4) ?? "n/a"} ` +
        `drift=${newDrift?.toFixed(3) ?? "n/a"} vol=${newVol.toFixed(2)}`
      );
      return true;
    }
  }

  // ── No active chain — insert as a new OPEN movement ─────────────────
  const { error: insErr } = await supabase.from("market_movements").insert({
    ...dbRow,
    status: "OPEN",
    finalize_at: finalizeAt,
  });
  if (insErr) {
    const msg = insErr.message ?? "";
    if (msg.includes("duplicate key")) return false;
    console.error("[movement] insert failed", msg, "id", row.id);
    throw insErr;
  }

  console.log(
    `[movement] OPEN ${row.window_type}/${row.reason} market=${marketId} outcome=${outcome ?? "-"} ` +
      `drift=${row.pct_change?.toFixed(3) ?? "n/a"} range=${row.range_pct?.toFixed(3) ?? "n/a"} ` +
      `vol=${row.volume_24h.toFixed(2)} vr=${row.volume_ratio?.toFixed(2) ?? "n/a"} ` +
      `hr=${row.hourly_volume_ratio?.toFixed(2) ?? "n/a"} ` +
      `vel=${velocity?.toFixed(4) ?? "n/a"} thin=${thinLiquidity} ` +
      `finalize_at=${finalizeAt}`
  );
  return true;
}
