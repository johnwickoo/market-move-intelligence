import { supabase } from "../../storage/src/db";

export const USE_TRADE_BUCKETS = process.env.USE_TRADE_BUCKETS === "true";

// ── Bucket row shape from trade_1m table ───────────────────────────────
export type BucketRow = {
  market_id: string;
  outcome: string;
  minute_ts: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume_total: number;
  buy_volume: number;
  sell_volume: number;
  trade_count: number;
  vwap: number | null;
  unique_price_levels: number;
  max_trade_size: number | null;
  last_trade_ts: string | null;
};

// ── Aggregated stats matching what evaluateWindow/finalize need ─────────
export type TradeStats = {
  volume: number;
  tradesCount: number;
  uniquePriceLevels: number;
  avgTradeSize: number | null;
  maxHourVol: number;
  hourlySums: Map<number, number>;
};

// PGRST_MAX_ROWS silently caps .limit() — paginate to get all rows.
const PAGE_SIZE = 1000;

// ── Fetch bucket rows for a market+outcome within a time range ─────────
export async function fetchBuckets(
  marketId: string,
  outcome: string | null,
  startISO: string,
  endISO: string,
  limit = 5000,
): Promise<BucketRow[]> {
  const outcomeVal = outcome ?? "";
  const all: BucketRow[] = [];
  let cursor = endISO; // walk backwards from end

  while (all.length < limit) {
    const pageLimit = Math.min(PAGE_SIZE, limit - all.length);
    const { data, error } = await supabase
      .from("trade_1m")
      .select("*")
      .eq("market_id", marketId)
      .eq("outcome", outcomeVal)
      .gte("minute_ts", startISO)
      .lte("minute_ts", cursor)
      .order("minute_ts", { ascending: false })
      .limit(pageLimit);

    if (error) throw error;
    if (!data || data.length === 0) break;

    all.push(...(data as BucketRow[]));

    // If we got fewer than a full page, we've got everything
    if (data.length < pageLimit) break;

    // Move cursor to just before the oldest row in this page
    const oldest = data[data.length - 1] as BucketRow;
    const oldestMs = Date.parse(oldest.minute_ts) - 1;
    cursor = new Date(oldestMs).toISOString();
  }

  return all;
}

// ── Fetch bucket rows for multiple markets (event detection) ───────────
export async function fetchBucketsMultiMarket(
  marketIds: string[],
  startISO: string,
  endISO: string,
): Promise<BucketRow[]> {
  const all: BucketRow[] = [];
  let cursor = startISO; // walk forwards from start

  while (true) {
    const { data, error } = await supabase
      .from("trade_1m")
      .select("*")
      .in("market_id", marketIds)
      .gte("minute_ts", cursor)
      .lte("minute_ts", endISO)
      .order("minute_ts", { ascending: true })
      .limit(PAGE_SIZE);

    if (error) throw error;
    if (!data || data.length === 0) break;

    all.push(...(data as BucketRow[]));

    if (data.length < PAGE_SIZE) break;

    const newest = data[data.length - 1] as BucketRow;
    const newestMs = Date.parse(newest.minute_ts) + 1;
    cursor = new Date(newestMs).toISOString();
  }

  return all;
}

// ── Compute trade stats from bucket rows within a time window ──────────
export function computeStatsFromBuckets(
  buckets: BucketRow[],
  wStartMs: number,
  nowMs: number,
): TradeStats {
  let volume = 0;
  let tradesCount = 0;
  let uniquePriceLevels = 0;
  const hourMs = 60 * 60_000;
  const hourlySums = new Map<number, number>();

  for (const b of buckets) {
    const ts = Date.parse(b.minute_ts);
    if (!Number.isFinite(ts) || ts < wStartMs || ts > nowMs) continue;

    volume += Number(b.volume_total) || 0;
    tradesCount += Number(b.trade_count) || 0;
    uniquePriceLevels += Number(b.unique_price_levels) || 0;

    // Hourly volume bucketing
    const hourBucket = Math.floor((ts - wStartMs) / hourMs);
    hourlySums.set(hourBucket, (hourlySums.get(hourBucket) ?? 0) + (Number(b.volume_total) || 0));
  }

  let maxHourVol = 0;
  for (const v of hourlySums.values()) {
    if (v > maxHourVol) maxHourVol = v;
  }

  const avgTradeSize = tradesCount > 0 ? volume / tradesCount : null;

  return { volume, tradesCount, uniquePriceLevels, avgTradeSize, maxHourVol, hourlySums };
}
