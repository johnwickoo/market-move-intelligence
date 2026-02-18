/**
 * Time Window Alignment — maps detection windows to appropriate news lookback periods.
 *
 * Detection window → News lookback:
 *   5m  → 60 min
 *   15m → 4 hours
 *   1h  → 12 hours
 *   4h  → 48 hours
 *   event → 24 hours
 */

export type WindowType = "5m" | "15m" | "1h" | "4h" | "event";

type WindowConfig = {
  lookbackMs: number;
  bucketMs: number; // cache bucket granularity
};

const WINDOW_CONFIG: Record<string, WindowConfig> = {
  "5m":    { lookbackMs: 60 * 60_000,         bucketMs: 15 * 60_000 },   // 1h lookback, 15m cache buckets
  "15m":   { lookbackMs: 4 * 60 * 60_000,     bucketMs: 30 * 60_000 },   // 4h lookback, 30m cache buckets
  "1h":    { lookbackMs: 12 * 60 * 60_000,    bucketMs: 60 * 60_000 },   // 12h lookback, 1h cache buckets
  "4h":    { lookbackMs: 48 * 60 * 60_000,    bucketMs: 2 * 60 * 60_000 }, // 48h lookback, 2h cache buckets
  "event": { lookbackMs: 24 * 60 * 60_000,    bucketMs: 60 * 60_000 },   // 24h lookback, 1h cache buckets
};

const DEFAULT_CONFIG: WindowConfig = {
  lookbackMs: 24 * 60 * 60_000,
  bucketMs: 60 * 60_000,
};

export function getWindowConfig(windowType: string): WindowConfig {
  return WINDOW_CONFIG[windowType] ?? DEFAULT_CONFIG;
}

/**
 * Compute the news search time range for a movement.
 *
 * @param windowEnd  ISO timestamp of the movement's window_end
 * @param windowType Detection window type (5m, 15m, 1h, 4h, event)
 * @returns { fromDate: ISO string, toDate: ISO string, lookbackMs, bucketKey }
 */
export function computeNewsTimeRange(
  windowEnd: string,
  windowType: string
): {
  fromDate: string;
  toDate: string;
  lookbackMs: number;
  bucketKey: number;
} {
  const config = getWindowConfig(windowType);
  const endMs = Date.parse(windowEnd);
  const effectiveEnd = Number.isFinite(endMs) ? endMs : Date.now();

  const fromMs = effectiveEnd - config.lookbackMs;
  const bucketKey = Math.floor(effectiveEnd / config.bucketMs);

  return {
    fromDate: new Date(fromMs).toISOString().slice(0, 10),
    toDate: new Date(effectiveEnd).toISOString().slice(0, 10),
    lookbackMs: config.lookbackMs,
    bucketKey,
  };
}
