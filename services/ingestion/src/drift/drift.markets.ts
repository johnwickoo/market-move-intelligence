import { supabase } from "../../../storage/src/db";
import { fetchDriftBetMarkets } from "./drift.api";
import type { TrackedDriftMarket, DriftMarketInfo } from "./drift.types";
import { DRIFT_PREFIX } from "./drift.types";

const DISCOVER_INTERVAL_MS = Number(
  process.env.DRIFT_DISCOVER_INTERVAL_MS ?? 5 * 60_000
);

let lastDiscoverAt = 0;
let cachedMarkets: TrackedDriftMarket[] = [];

/**
 * Discover all active BET prediction markets from the Drift Data API.
 * Results are cached for DRIFT_DISCOVER_INTERVAL_MS.
 */
export async function discoverActiveBetMarkets(): Promise<
  TrackedDriftMarket[]
> {
  const now = Date.now();
  if (cachedMarkets.length > 0 && now - lastDiscoverAt < DISCOVER_INTERVAL_MS) {
    return cachedMarkets;
  }

  const raw = await fetchDriftBetMarkets();
  cachedMarkets = raw.map(toTracked);
  lastDiscoverAt = now;

  console.log(
    `[drift-markets] discovered ${cachedMarkets.length} active BET markets`
  );
  return cachedMarkets;
}

function toTracked(m: DriftMarketInfo): TrackedDriftMarket {
  return {
    marketName: m.symbol,
    marketIndex: m.marketIndex,
    namespacedId: `${DRIFT_PREFIX}${m.symbol}`,
    status: m.status ?? "active",
  };
}

/**
 * Read drift-prefixed slugs from the tracked_slugs table.
 * Returns market names (without the drift: prefix) that are active.
 *
 * Slug format in DB: "drift:MARKET-NAME-BET"
 */
export async function syncDriftTrackedSlugs(): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("tracked_slugs")
      .select("slug")
      .eq("active", true)
      .like("slug", `${DRIFT_PREFIX}%`);

    if (error) {
      console.error("[drift-markets] tracked_slugs query failed:", error.message);
      return [];
    }

    if (!data || data.length === 0) return [];

    const names = data
      .map((row) => String(row.slug).replace(DRIFT_PREFIX, ""))
      .filter((n) => n.length > 0);

    console.log(
      `[drift-markets] ${names.length} tracked slug(s): ${names.join(", ")}`
    );
    return names;
  } catch (err: any) {
    console.error(
      "[drift-markets] syncDriftTrackedSlugs error:",
      err?.message
    );
    return [];
  }
}

/**
 * Reconcile discovered markets with tracked slugs.
 * Returns the final set of market names to subscribe to.
 *
 * If DRIFT_AUTO_DISCOVER=1, all active BET markets are included.
 * Otherwise only tracked_slugs entries are used.
 */
export async function resolveMarketsToTrack(): Promise<string[]> {
  const autoDiscover = process.env.DRIFT_AUTO_DISCOVER !== "0";
  const fromSlugs = await syncDriftTrackedSlugs();

  if (autoDiscover) {
    const discovered = await discoverActiveBetMarkets();
    const names = new Set(discovered.map((m) => m.marketName));
    // Merge slug-specified markets too (in case API misses some)
    for (const s of fromSlugs) names.add(s);
    return Array.from(names);
  }

  return fromSlugs;
}
