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
type WindowDef = {
  type: WindowType;
  ms: number;
  priceThreshold: number;
  thinPriceThreshold: number;
  minAbsMove: number;
  volumeThreshold: number;
  minTicks: number;
  minTrades: number;
  bucketDivisorMs: number;
  cooldownMs: number;
};

// Ordered smallest → largest for compound graduation.
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
    bucketDivisorMs: 5 * 60_000,
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

const WINDOW_ORDER: WindowType[] = WINDOWS.map((w) => w.type);
function windowIndex(t: WindowType): number {
  return WINDOW_ORDER.indexOf(t);
}
function windowDef(t: WindowType): WindowDef | undefined {
  return WINDOWS.find((w) => w.type === t);
}

// ── Shared config ────────────────────────────────────────────────────
const MIN_PRICE_FOR_ALERT = Number(process.env.MOVEMENT_MIN_PRICE_FOR_ALERT ?? 0.05);
const CONFIRM_MINUTES = Number(process.env.MOVEMENT_CONFIRM_MINUTES ?? 5);
const CONFIRM_MIN_TICKS = Number(process.env.MOVEMENT_CONFIRM_MIN_TICKS ?? 3);
const THIN_TRADE_COUNT = 15;
const THIN_PRICE_LEVELS = 8;
const WIDE_SPREAD = 0.05;

const VELOCITY_THRESHOLD = Number(process.env.MOVEMENT_VELOCITY_THRESHOLD ?? 0.008);
const MIN_DRIFT_FOR_VOLUME = Number(process.env.MOVEMENT_MIN_DRIFT_FOR_VOLUME ?? 0.02);

// Pre-move anchor lookback: how far before the window start to find the
// "resting" price before the move began. Default 5 minutes.
const ANCHOR_LOOKBACK_MS = Number(process.env.MOVEMENT_ANCHOR_LOOKBACK_MS ?? 5 * 60_000);

// Minimum elapsed time for "event" window (since-last-signal anchoring).
const EVENT_MIN_ELAPSED_MS = Number(process.env.MOVEMENT_EVENT_MIN_ELAPSED_MS ?? 10 * 60_000);

// ── Compound movement tracker ────────────────────────────────────────
// Instead of 4 independent windows, track one active compound movement
// per market+outcome. The movement starts at the smallest triggered window
// and graduates upward as momentum continues.
type ActiveCompound = {
  windowType: WindowType;     // current graduated window
  anchorPrice: number;        // pre-move price (frozen)
  anchorTs: number;           // timestamp of anchor price
  dbId: string;               // movement row ID in DB
  firstDetectMs: number;      // when first threshold crossed
  lastUpdateMs: number;       // last time we extended/graduated
  marketId: string;           // for stale cleanup validation
};
const activeCompound = new Map<string, ActiveCompound>();

// Stale compound cleanup: evict entries that haven't been updated in 2× their window duration.
const STALE_CLEANUP_INTERVAL_MS = 60_000;
let lastStaleCleanupMs = 0;

function cleanupStaleCompounds(nowMs: number) {
  if (nowMs - lastStaleCleanupMs < STALE_CLEANUP_INTERVAL_MS) return;
  lastStaleCleanupMs = nowMs;

  for (const [key, compound] of activeCompound) {
    const wDef = windowDef(compound.windowType);
    const staleCutoff = wDef ? wDef.ms * 2 : 30 * 60_000;
    if (nowMs - compound.lastUpdateMs > staleCutoff) {
      activeCompound.delete(key);
    }
  }

  // Also clean stale entries from anti-spam maps (1 hour TTL)
  const mapTtl = 60 * 60_000;
  for (const [key, ts] of lastEmitMs) {
    if (nowMs - ts > mapTtl) lastEmitMs.delete(key);
  }
  for (const [key, ts] of lastCheckedMs) {
    if (nowMs - ts > mapTtl) lastCheckedMs.delete(key);
  }
}

/** Clear all in-memory state for a market (call when slug is untracked). */
export function clearMarketState(marketId: string) {
  for (const key of [...activeCompound.keys()]) {
    if (key.startsWith(marketId + ":")) activeCompound.delete(key);
  }
  for (const key of [...lastEmitMs.keys()]) {
    if (key.startsWith(marketId + ":")) lastEmitMs.delete(key);
  }
  for (const key of [...lastCheckedMs.keys()]) {
    if (key.startsWith(marketId + ":")) lastCheckedMs.delete(key);
  }
}

const lastEmitMs = new Map<string, number>();

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
function computeVelocity(absDrift: number, windowMinutes: number): number {
  if (windowMinutes <= 0) return 0;
  return absDrift / Math.sqrt(windowMinutes);
}

// ── Window evaluation result ─────────────────────────────────────────
type WindowEval = {
  w: WindowDef;
  ticks: any[];
  trades: any[];
  startMid: number | null;
  endMid: number | null;
  minMid: number | null;
  maxMid: number | null;
  avgSpreadPct: number | null;
  driftPct: number | null;
  rangePct: number | null;
  absMove: number | null;
  volume: number;
  tradesCount: number;
  uniquePriceLevels: number;
  avgTradeSize: number | null;
  maxHourVol: number;
  volumeRatio: number | null;
  hourlyRatio: number | null;
  thinLiquidity: boolean;
  velocity: number | null;
  priceHit: boolean;
  priceConfirmed: boolean;
  volHit: boolean;
  velocityHit: boolean;
  wStartMs: number;
};

/** Find the pre-move anchor price by looking back ANCHOR_LOOKBACK_MS before windowStart. */
function findPreMoveAnchor(
  allTicks: any[],
  windowStartMs: number,
  firstSeenMs: number | null,
): { price: number; ts: number } | null {
  const lookbackMs = windowStartMs - ANCHOR_LOOKBACK_MS;
  const floor = firstSeenMs != null ? Math.max(lookbackMs, firstSeenMs) : lookbackMs;

  // allTicks are descending (newest-first). Find ticks in [floor, windowStartMs].
  let bestTick: { mid: number; ts: number } | null = null;
  let bestDist = Infinity;

  for (const tk of allTicks) {
    if (tk.mid == null) continue;
    const ts = Date.parse(tk.ts);
    if (!Number.isFinite(ts)) continue;
    if (ts > windowStartMs || ts < floor) continue;

    // Find the tick closest to the lookback target (5 min before window start)
    const dist = Math.abs(ts - lookbackMs);
    if (dist < bestDist) {
      bestDist = dist;
      bestTick = { mid: safeNum(tk.mid), ts };
    }
  }

  if (bestTick && bestTick.mid >= MIN_PRICE_FOR_ALERT) {
    return { price: bestTick.mid, ts: bestTick.ts };
  }
  return null;
}

/** Evaluate a single window's metrics against its thresholds. */
function evaluateWindow(
  w: WindowDef,
  allTicks: any[],
  allTrades: any[],
  nowMs: number,
  baselineHourly: number | null,
): WindowEval | null {
  const wStartMs = nowMs - w.ms;
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

  if (ticks.length < w.minTicks && trades.length < w.minTrades) return null;
  const hasTicks = ticks.length >= 2;

  if (hasTicks) {
    const lastMid = safeNum(ticks[ticks.length - 1].mid);
    if (lastMid < MIN_PRICE_FOR_ALERT) return null;
  }

  // Price analysis
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

  // Trade stats
  const tradesCount = trades.length;
  const volume = trades.reduce((sum, t) => sum + safeNum(t.size ?? 0), 0);
  const avgTradeSize = tradesCount > 0 ? volume / tradesCount : null;
  const priceLevelsSet = new Set<number>();
  for (const t of trades) {
    if (t.price == null) continue;
    priceLevelsSet.add(Number(safeNum(t.price).toFixed(2)));
  }
  const uniquePriceLevels = priceLevelsSet.size;

  // Liquidity guard
  const thinBySpread = avgSpreadPct != null && avgSpreadPct >= WIDE_SPREAD;
  const thinByActivity = tradesCount < THIN_TRADE_COUNT || uniquePriceLevels < THIN_PRICE_LEVELS;
  const thinLiquidity = thinByActivity || (thinBySpread && tradesCount < THIN_TRADE_COUNT * 4);

  // Price metrics
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
  const priceHit = hasTicks && priceEligible && absHit && driftHit;

  // Volume metrics
  const windowHours = w.ms / (60 * 60_000);
  const scaledBaseline = baselineHourly != null ? baselineHourly * windowHours : null;
  const volumeRatio =
    scaledBaseline != null && scaledBaseline > 0 ? volume / scaledBaseline : null;

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

  // Velocity
  const windowMinutes = w.ms / 60_000;
  const velocity =
    driftPct != null ? computeVelocity(Math.abs(driftPct), windowMinutes) : null;
  const velocityHit = velocity != null && velocity >= VELOCITY_THRESHOLD;

  // Confirmation for short windows without volume
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

  return {
    w,
    ticks,
    trades,
    startMid,
    endMid,
    minMid,
    maxMid,
    avgSpreadPct,
    driftPct,
    rangePct,
    absMove,
    volume,
    tradesCount,
    uniquePriceLevels,
    avgTradeSize,
    maxHourVol,
    volumeRatio,
    hourlyRatio,
    thinLiquidity,
    velocity,
    priceHit,
    priceConfirmed,
    volHit,
    velocityHit,
    wStartMs,
  };
}

/** Check if a window evaluation passes the firing criteria. */
function windowFires(ev: WindowEval): boolean {
  if (!ev.priceConfirmed && !ev.volHit && !ev.velocityHit) return false;
  // Volume-only signals require meaningful price movement.
  if (ev.volHit && !ev.priceConfirmed && !ev.velocityHit) {
    const absDrift = ev.driftPct != null ? Math.abs(ev.driftPct) : 0;
    if (absDrift < MIN_DRIFT_FOR_VOLUME) return false;
  }
  return true;
}

function classifyReason(ev: WindowEval): MovementInsert["reason"] {
  return ev.velocityHit && ev.priceConfirmed
    ? "VELOCITY"
    : ev.priceConfirmed && ev.volHit
      ? "BOTH"
      : ev.priceConfirmed
        ? "PRICE"
        : "VOLUME";
}

// ── Main entry point ─────────────────────────────────────────────────
export async function detectMovement(trade: TradeInsert) {
  const marketId = trade.market_id;
  const outcome = (trade as any).outcome ? String((trade as any).outcome) : null;
  const nowMs = Date.parse(trade.timestamp);
  if (!Number.isFinite(nowMs)) return;

  // Periodic cleanup of stale compound entries and anti-spam maps
  cleanupStaleCompounds(nowMs);

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

  // Fetch data for the full 4h window + anchor lookback
  const maxWindowMs = Math.max(...WINDOWS.map((w) => w.ms));
  const outerStartMs = nowMs - maxWindowMs - ANCHOR_LOOKBACK_MS;
  let outerStartISO = new Date(outerStartMs).toISOString();
  if (firstSeenMs != null && firstSeenMs > outerStartMs) {
    outerStartISO = new Date(firstSeenMs).toISOString();
  }
  const endISO = new Date(nowMs).toISOString();

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

  // ── Compound detection ─────────────────────────────────────────
  const compoundKey = `${marketId}:${outcome ?? "NA"}`;
  const active = activeCompound.get(compoundKey);

  if (!active) {
    // No active compound — evaluate windows smallest-first, fire on first hit.
    for (const w of WINDOWS) {
      const computeKey = `${compoundKey}:${w.type}`;
      if (shouldSkipCompute(computeKey, nowMs, w.cooldownMs)) continue;

      const ev = evaluateWindow(w, allTicks ?? [], allTrades, nowMs, baselineHourly);
      if (!ev || !windowFires(ev)) continue;

      // Find pre-move anchor price (5min before window start)
      const preAnchor = findPreMoveAnchor(allTicks ?? [], ev.wStartMs, firstSeenMs);
      const anchorPrice = preAnchor?.price ?? ev.startMid;
      const anchorTs = preAnchor?.ts ?? ev.wStartMs;

      // Recompute drift from pre-move anchor to current end price
      const anchoredDrift =
        anchorPrice != null && anchorPrice > 0 && ev.endMid != null
          ? (ev.endMid - anchorPrice) / anchorPrice
          : ev.driftPct;

      const reason = classifyReason(ev);
      const bucketId = Math.floor(nowMs / w.bucketDivisorMs);
      const movementId = `${compoundKey}:${w.type}:${bucketId}`;
      const wStartISO = new Date(Math.max(anchorTs, firstSeenMs ?? 0)).toISOString();

      const row: MovementInsert = {
        id: movementId,
        market_id: marketId,
        outcome,
        window_type: w.type,
        window_start: wStartISO,
        window_end: endISO,
        start_price: anchorPrice,
        end_price: ev.endMid,
        pct_change: anchoredDrift,
        volume_24h: ev.volume,
        baseline_daily_volume: baselineDaily,
        volume_ratio: ev.volumeRatio,
        reason,
        min_price_24h: ev.minMid,
        max_price_24h: ev.maxMid,
        range_pct: ev.rangePct,
        max_hour_volume: ev.maxHourVol,
        hourly_volume_ratio: ev.hourlyRatio,
        trades_count_24h: ev.tradesCount,
        unique_price_levels_24h: ev.uniquePriceLevels,
        avg_trade_size_24h: ev.avgTradeSize,
        thin_liquidity: ev.thinLiquidity,
        velocity: ev.velocity,
      };

      const inserted = await insertMovement(row, marketId, outcome, ev.thinLiquidity);
      if (inserted) {
        lastEmitMs.set(compoundKey, nowMs);
        activeCompound.set(compoundKey, {
          windowType: w.type,
          anchorPrice: anchorPrice!,
          anchorTs,
          dbId: movementId,
          firstDetectMs: nowMs,
          lastUpdateMs: nowMs,
          marketId,
        });
      }
      break; // Only fire the smallest triggering window
    }
  } else {
    // Active compound exists — try to graduate or extend.
    const curIdx = windowIndex(active.windowType);
    const curDef = windowDef(active.windowType);
    if (!curDef) {
      activeCompound.delete(compoundKey);
      return;
    }

    // Check if movement has gone stale (no activity in 2× window duration)
    if (nowMs - active.lastUpdateMs > curDef.ms * 2) {
      activeCompound.delete(compoundKey);
      // Fall through — next call will start fresh
      return;
    }

    // Try graduation to the next window up
    let graduated = false;
    const nextIdx = curIdx + 1;
    if (nextIdx < WINDOWS.length) {
      const nextW = WINDOWS[nextIdx];
      const elapsedSinceFirst = nowMs - active.firstDetectMs;

      // Only graduate if enough time has elapsed for the next window
      if (elapsedSinceFirst >= nextW.ms * 0.5) {
        const ev = evaluateWindow(nextW, allTicks ?? [], allTrades, nowMs, baselineHourly);
        if (ev) {
          // Check threshold against the compound's frozen anchor price
          const anchoredDrift =
            active.anchorPrice > 0 && ev.endMid != null
              ? (ev.endMid - active.anchorPrice) / active.anchorPrice
              : ev.driftPct;
          const threshold = ev.thinLiquidity ? nextW.thinPriceThreshold : nextW.priceThreshold;
          const anchoredDriftHit = anchoredDrift != null && Math.abs(anchoredDrift) >= threshold;
          const anchoredAbsMove =
            ev.endMid != null ? Math.abs(ev.endMid - active.anchorPrice) : null;
          const anchoredAbsHit = anchoredAbsMove != null && anchoredAbsMove >= nextW.minAbsMove;

          if (anchoredDriftHit && anchoredAbsHit && ev.ticks.length >= nextW.minTicks) {
            // Graduate the movement
            const delayMs = FINALIZE_DELAY_MS[nextW.type] ?? 15 * 60_000;
            const finalizeAt = new Date(Date.now() + delayMs).toISOString();

            const newMin = ev.minMid != null ? Math.min(active.anchorPrice, ev.minMid) : active.anchorPrice;
            const newMax = ev.maxMid != null ? Math.max(active.anchorPrice, ev.maxMid) : active.anchorPrice;
            const newRangePct =
              Number.isFinite(newMin) && Number.isFinite(newMax) && newMin > 0
                ? (newMax - newMin) / newMin
                : ev.rangePct;

            const { error: gradErr } = await supabase
              .from("market_movements")
              .update({
                window_type: nextW.type,
                window_end: endISO,
                end_price: ev.endMid,
                pct_change: anchoredDrift,
                min_price_24h: Number.isFinite(newMin) ? newMin : null,
                max_price_24h: Number.isFinite(newMax) ? newMax : null,
                range_pct: newRangePct,
                volume_24h: ev.volume,
                trades_count_24h: ev.tradesCount,
                avg_trade_size_24h: ev.avgTradeSize,
                thin_liquidity: ev.thinLiquidity,
                finalize_at: finalizeAt,
              })
              .eq("id", active.dbId);

            if (!gradErr) {
              graduated = true;
              active.windowType = nextW.type;
              active.lastUpdateMs = nowMs;
              console.log(
                `[movement] GRADUATE ${WINDOW_ORDER[curIdx]}→${nextW.type} id=${active.dbId.slice(0, 24)} ` +
                `anchor=${active.anchorPrice.toFixed(4)} end=${ev.endMid?.toFixed(4) ?? "n/a"} ` +
                `drift=${anchoredDrift?.toFixed(3) ?? "n/a"}`
              );
            } else {
              console.error("[movement] graduate failed", active.dbId, gradErr.message);
            }
          }
        }
      }
    }

    // If not graduated, extend the current window (update end_price, push finalize)
    if (!graduated) {
      const ev = evaluateWindow(curDef, allTicks ?? [], allTrades, nowMs, baselineHourly);
      if (ev && ev.endMid != null) {
        const anchoredDrift =
          active.anchorPrice > 0
            ? (ev.endMid - active.anchorPrice) / active.anchorPrice
            : ev.driftPct;

        const delayMs = FINALIZE_DELAY_MS[active.windowType] ?? 15 * 60_000;
        const finalizeAt = new Date(Date.now() + delayMs).toISOString();

        const { error: extErr } = await supabase
          .from("market_movements")
          .update({
            window_end: endISO,
            end_price: ev.endMid,
            pct_change: anchoredDrift,
            min_price_24h: ev.minMid,
            max_price_24h: ev.maxMid,
            range_pct: ev.rangePct,
            volume_24h: ev.volume,
            trades_count_24h: ev.tradesCount,
            avg_trade_size_24h: ev.avgTradeSize,
            thin_liquidity: ev.thinLiquidity,
            finalize_at: finalizeAt,
          })
          .eq("id", active.dbId);

        if (!extErr) {
          active.lastUpdateMs = nowMs;
        }
      }
    }
  }

  // ── "event" window: since last signal (unchanged) ──────────────
  if (lastMoveEndPrice != null && lastMoveEndISO != null) {
    const eventComputeKey = `${compoundKey}:event`;
    if (!shouldSkipCompute(eventComputeKey, nowMs, 60_000)) {
      const eventStartMs = Date.parse(lastMoveEndISO);
      const eventElapsedMs = Number.isFinite(eventStartMs) ? nowMs - eventStartMs : 0;
      if (Number.isFinite(eventStartMs) && eventStartMs < nowMs && eventElapsedMs >= EVENT_MIN_ELAPSED_MS) {
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

          const eventThreshold = 0.06;
          const eventMinAbs = 0.03;
          const eDriftHit = eDriftPct != null && Math.abs(eDriftPct) >= eventThreshold;
          const eAbsHit = eAbsMove != null && eAbsMove >= eventMinAbs;
          const ePriceEligible = eMinMid != null && eMinMid >= MIN_PRICE_FOR_ALERT;

          const eventLastEmit = lastEmitMs.get(compoundKey) ?? 0;
          const eventCooldownOk = nowMs - eventLastEmit >= EVENT_MIN_ELAPSED_MS;

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

            const eventMinutes = Math.max(1, (nowMs - eventStartMs) / 60_000);
            const eVelocity = eDriftPct != null
              ? computeVelocity(Math.abs(eDriftPct), eventMinutes)
              : null;

            const bucketId = Math.floor(nowMs / (60 * 60_000));
            const row: MovementInsert = {
              id: `${compoundKey}:event:${bucketId}`,
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
            if (eventInserted) lastEmitMs.set(compoundKey, nowMs);
          }
        }
      }
    }
  }
}

// Finalize delays per window type
const FINALIZE_DELAY_MS: Record<string, number> = {
  "5m": 5 * 60_000,
  "15m": 10 * 60_000,
  "1h": 30 * 60_000,
  "4h": 2 * 3_600_000,
  "event": 5 * 60_000,
};

async function insertMovement(
  row: MovementInsert,
  marketId: string,
  outcome: string | null,
  thinLiquidity: boolean
): Promise<boolean> {
  const velocity = row.velocity;
  const { velocity: _v, ...dbRow } = row;

  const delayMs = FINALIZE_DELAY_MS[row.window_type] ?? 15 * 60_000;
  const finalizeAt = new Date(Date.now() + delayMs).toISOString();

  // ── Chain extension for compound movements ─────────────────────────
  // Look for an existing OPEN movement for this market+outcome (any window type)
  // to extend. With compound detection, there should be at most one active
  // movement per market+outcome.
  if (row.window_type !== "event") {
    const chainCutoff = new Date(Date.now() - Math.max(...Object.values(FINALIZE_DELAY_MS))).toISOString();

    const chainQ = supabase
      .from("market_movements")
      .select("id, start_price, window_type, min_price_24h, max_price_24h, volume_24h, trades_count_24h")
      .eq("market_id", row.market_id)
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
          finalize_at: finalizeAt,
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

  // ── No active chain — insert new OPEN movement ─────────────────────
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
