/**
 * Two-stage movement pipeline — Stage 2: Finalize worker
 *
 * Polls for OPEN movements whose finalize_at has passed, then:
 *   1. Re-fetches ticks/trades for the settled window
 *   2. Recomputes metrics (price drift, volume, spread) with stable data
 *   3. Updates the movement row with settled metrics
 *   4. Runs classification + news fetch + explanation (scoreSignals)
 *   5. Marks movement FINAL
 *
 * This runs as a loop inside the ingestion process.
 */
import { supabase } from "../../storage/src/db";
import { scoreSignals } from "../../signals/src/scoreSignals";

const POLL_INTERVAL_MS = Number(process.env.FINALIZE_POLL_MS ?? 30_000);
const BATCH_SIZE = 10;

type OpenMovement = {
  id: string;
  market_id: string;
  outcome: string | null;
  window_type: string;
  window_start: string;
  window_end: string;
  start_price: number | null;
  end_price: number | null;
  pct_change: number | null;
  volume_24h: number;
  baseline_daily_volume: number | null;
  volume_ratio: number | null;
  reason: string;
  min_price_24h: number | null;
  max_price_24h: number | null;
  range_pct: number | null;
  max_hour_volume: number | null;
  hourly_volume_ratio: number | null;
  trades_count_24h: number;
  unique_price_levels_24h: number | null;
  avg_trade_size_24h: number | null;
  thin_liquidity: boolean;
  finalize_at: string;
};

function safeNum(x: any, fallback = 0): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Re-fetch ticks and trades for the movement's window and recompute
 * settled metrics. Returns updated fields or null if data is insufficient.
 */
async function recomputeMetrics(mv: OpenMovement) {
  const windowStartMs = Date.parse(mv.window_start);
  const windowEndMs = Date.parse(mv.window_end);
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) return null;

  // Extend the window to now — captures any ticks that arrived after detection
  const settledEndMs = Date.now();
  const settledEndISO = new Date(settledEndMs).toISOString();

  // Fetch ticks for the full settled window
  const { data: ticks } = await supabase
    .from("market_mid_ticks")
    .select("mid,ts,best_bid,best_ask,spread_pct")
    .eq("market_id", mv.market_id)
    .gte("ts", mv.window_start)
    .lte("ts", settledEndISO)
    .order("ts", { ascending: true })
    .limit(5000);

  // Fetch trades
  const { data: trades } = await supabase
    .from("trades")
    .select("price,size,timestamp")
    .eq("market_id", mv.market_id)
    .gte("timestamp", mv.window_start)
    .lte("timestamp", settledEndISO)
    .order("timestamp", { ascending: true })
    .limit(5000);

  const validTicks = (ticks ?? []).filter((t: any) => t.mid != null);
  const validTrades = trades ?? [];

  if (validTicks.length < 2) return null;

  // Recompute price metrics
  const firstMid = safeNum(validTicks[0].mid);
  const lastMid = safeNum(validTicks[validTicks.length - 1].mid);
  let minMid = firstMid;
  let maxMid = firstMid;
  for (const tk of validTicks) {
    const m = safeNum(tk.mid);
    if (m < minMid) minMid = m;
    if (m > maxMid) maxMid = m;
  }

  const driftPct = firstMid > 0 ? (lastMid - firstMid) / firstMid : null;
  const rangePct = minMid > 0 ? (maxMid - minMid) / minMid : null;

  // Recompute volume
  let totalVolume = 0;
  for (const tr of validTrades) {
    totalVolume += safeNum((tr as any).size);
  }

  // Recompute unique price levels
  const priceLevels = new Set<number>();
  for (const tk of validTicks) {
    priceLevels.add(Math.round(safeNum(tk.mid) * 10000));
  }

  const avgTradeSize = validTrades.length > 0 ? totalVolume / validTrades.length : null;

  // Velocity (price change per sqrt of minutes)
  const elapsedMinutes = (settledEndMs - windowStartMs) / 60_000;
  const velocity = driftPct != null && elapsedMinutes > 0
    ? Math.abs(driftPct) / Math.sqrt(elapsedMinutes)
    : 0;

  return {
    end_price: lastMid,
    pct_change: driftPct,
    min_price_24h: minMid,
    max_price_24h: maxMid,
    range_pct: rangePct,
    volume_24h: totalVolume,
    trades_count_24h: validTrades.length,
    unique_price_levels_24h: priceLevels.size,
    avg_trade_size_24h: avgTradeSize,
    velocity,
  };
}

async function finalizeOne(mv: OpenMovement) {
  const settled = await recomputeMetrics(mv);

  // Build the row for scoreSignals — use settled metrics if available, else original
  const scoringRow = {
    ...mv,
    ...(settled ?? {}),
  };

  // Update the movement row with settled metrics + mark FINAL
  const updateFields: Record<string, any> = { status: "FINAL" };
  if (settled) {
    updateFields.end_price = settled.end_price;
    updateFields.pct_change = settled.pct_change;
    updateFields.min_price_24h = settled.min_price_24h;
    updateFields.max_price_24h = settled.max_price_24h;
    updateFields.range_pct = settled.range_pct;
    updateFields.volume_24h = settled.volume_24h;
    updateFields.trades_count_24h = settled.trades_count_24h;
    updateFields.unique_price_levels_24h = settled.unique_price_levels_24h;
    updateFields.avg_trade_size_24h = settled.avg_trade_size_24h;
  }

  const { error: updateErr } = await supabase
    .from("market_movements")
    .update(updateFields)
    .eq("id", mv.id);

  if (updateErr) {
    console.error("[finalize] update failed", mv.id, updateErr.message);
    return;
  }

  // Now run classification + explanation + attestation with settled data
  try {
    await scoreSignals(scoringRow);
    console.log(
      `[finalize] FINAL ${mv.window_type} market=${mv.market_id.slice(0, 16)} ` +
      `drift=${safeNum(scoringRow.pct_change).toFixed(3)} ` +
      `vol=${safeNum(scoringRow.volume_24h).toFixed(2)} ` +
      `trades=${scoringRow.trades_count_24h}`
    );
  } catch (err: any) {
    console.error("[finalize] scoreSignals failed", mv.id, err?.message);
    // Mark as FINAL anyway to avoid re-processing
  }
}

// Minimum time (ms) an OPEN movement must exist before early finalization
// is considered. Prevents finalizing during the initial burst.
const EARLY_MIN_AGE_MS: Record<string, number> = {
  "5m": 2 * 60_000,    // 2 min
  "15m": 5 * 60_000,   // 5 min
  "1h": 15 * 60_000,   // 15 min
  "4h": 60 * 60_000,   // 1 hour
  "event": 2 * 60_000, // 2 min
};

// How many recent minutes of ticks to check for stabilization
const STABLE_WINDOW_MS = 2 * 60_000; // 2 min
// Max price range (as fraction) in the stable window to consider settled
const STABLE_RANGE_THRESHOLD = 0.01; // 1%
// Min ticks required in the stable window to have enough data to judge
const STABLE_MIN_TICKS = 3;

/**
 * Check if a movement's price has stabilized: the last 2 minutes of
 * mid-ticks show < 1% range, meaning the move has settled.
 */
async function isStabilized(mv: OpenMovement): Promise<boolean> {
  const nowMs = Date.now();
  const windowStartMs = Date.parse(mv.window_start);
  if (!Number.isFinite(windowStartMs)) return false;

  const minAge = EARLY_MIN_AGE_MS[mv.window_type] ?? 5 * 60_000;
  if (nowMs - windowStartMs < minAge) return false;

  // Fetch recent ticks
  const stableFrom = new Date(nowMs - STABLE_WINDOW_MS).toISOString();
  const { data: recentTicks } = await supabase
    .from("market_mid_ticks")
    .select("mid,ts")
    .eq("market_id", mv.market_id)
    .gte("ts", stableFrom)
    .order("ts", { ascending: false })
    .limit(50);

  const valid = (recentTicks ?? []).filter((t: any) => t.mid != null);

  // No ticks at all in the last 2 minutes = market went quiet, move is done
  if (valid.length === 0) return true;

  if (valid.length < STABLE_MIN_TICKS) return false;

  let minMid = Infinity;
  let maxMid = -Infinity;
  for (const t of valid) {
    const m = safeNum(t.mid);
    if (m < minMid) minMid = m;
    if (m > maxMid) maxMid = m;
  }

  if (minMid <= 0 || !Number.isFinite(minMid)) return false;
  const range = (maxMid - minMid) / minMid;

  return range < STABLE_RANGE_THRESHOLD;
}

/**
 * Check OPEN movements that haven't hit finalize_at yet but may have
 * stabilized. Finalize them early to get faster explanations.
 */
async function checkEarlyFinalize() {
  const now = new Date().toISOString();

  const { data: pending, error } = await supabase
    .from("market_movements")
    .select("*")
    .eq("status", "OPEN")
    .gt("finalize_at", now) // not yet due
    .order("window_start", { ascending: true })
    .limit(BATCH_SIZE);

  if (error || !pending || pending.length === 0) return;

  for (const mv of pending as OpenMovement[]) {
    try {
      const stable = await isStabilized(mv);
      if (!stable) continue;

      console.log(
        `[finalize] early finalize: ${mv.window_type} market=${mv.market_id.slice(0, 16)} ` +
        `— price stabilized within ${STABLE_RANGE_THRESHOLD * 100}% over last ${STABLE_WINDOW_MS / 60_000}min`
      );
      await finalizeOne(mv);
    } catch (err: any) {
      console.error("[finalize] early finalize error", mv.id, err?.message);
    }
  }
}

async function pollOnce() {
  const now = new Date().toISOString();

  // 1. Process movements whose timer has expired
  const { data: open, error } = await supabase
    .from("market_movements")
    .select("*")
    .eq("status", "OPEN")
    .lte("finalize_at", now)
    .order("finalize_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("[finalize] query error", error.message);
    return;
  }

  if (open && open.length > 0) {
    console.log(`[finalize] processing ${open.length} movement(s)`);

    for (const mv of open as OpenMovement[]) {
      try {
        await finalizeOne(mv);
      } catch (err: any) {
        console.error("[finalize] error on", mv.id, err?.message);
        // Mark FINAL to prevent infinite retry
        try {
          await supabase
            .from("market_movements")
            .update({ status: "FINAL" })
            .eq("id", mv.id);
        } catch { /* ignore */ }
      }
    }
  }

  // 2. Check for early finalization of stabilized movements
  await checkEarlyFinalize();
}

let running = false;

/**
 * Start the finalize worker loop. Call once from ingestion startup.
 * Non-blocking — runs on a setInterval.
 */
export function startFinalizeWorker() {
  if (running) return;
  running = true;
  console.log(`[finalize] worker started (poll every ${POLL_INTERVAL_MS / 1000}s)`);

  // Initial poll after a short delay
  setTimeout(pollOnce, 5_000);
  setInterval(pollOnce, POLL_INTERVAL_MS);
}
