import { supabase } from "../../../storage/src/db";
import { fetchEvents } from "./jupiter.api";
import type { TrackedJupiterMarket } from "./jupiter.types";
import { JUP_PREFIX } from "./jupiter.types";

const DISCOVER_INTERVAL_MS = Number(
  process.env.JUP_DISCOVER_INTERVAL_MS ?? 5 * 60_000
);

let lastDiscoverAt = 0;
let cachedMarkets: TrackedJupiterMarket[] = [];

/**
 * Discover active prediction markets from Jupiter.
 * Fetches trending + live events with their markets.
 * Results are cached for DISCOVER_INTERVAL_MS.
 */
export async function discoverActiveMarkets(): Promise<
  TrackedJupiterMarket[]
> {
  const now = Date.now();
  if (cachedMarkets.length > 0 && now - lastDiscoverAt < DISCOVER_INTERVAL_MS) {
    return cachedMarkets;
  }

  const tracked: TrackedJupiterMarket[] = [];

  // Fetch live and trending events with their markets
  const [liveEvents, trendingEvents] = await Promise.all([
    fetchEvents({ filter: "live", includeMarkets: true, end: 50 }),
    fetchEvents({ filter: "trending", includeMarkets: true, end: 50 }),
  ]);

  const seen = new Set<string>();
  const allEvents = [...liveEvents, ...trendingEvents];

  for (const event of allEvents) {
    if (!event.markets) continue;

    for (const market of event.markets) {
      if (seen.has(market.marketId)) continue;
      if (market.status !== "open") continue;

      seen.add(market.marketId);
      tracked.push({
        marketId: market.marketId,
        eventId: event.eventId,
        title: market.metadata?.title ?? event.metadata?.title ?? market.marketId,
        namespacedId: `${JUP_PREFIX}${market.marketId}`,
        status: market.status,
        volume24h: market.pricing?.volume24h ?? 0,
      });
    }
  }

  cachedMarkets = tracked;
  lastDiscoverAt = now;

  console.log(
    `[jup-markets] discovered ${tracked.length} open markets across ${allEvents.length} events`
  );
  return tracked;
}

/**
 * Read jup:-prefixed slugs from tracked_slugs table.
 * Returns market IDs (without prefix) that are actively tracked.
 *
 * Slug format: "jup:MARKET_ID"
 */
export async function syncJupiterTrackedSlugs(): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("tracked_slugs")
      .select("slug")
      .eq("active", true)
      .like("slug", `${JUP_PREFIX}%`);

    if (error) {
      console.error(
        "[jup-markets] tracked_slugs query failed:",
        error.message
      );
      return [];
    }

    if (!data || data.length === 0) return [];

    const ids = data
      .map((row) => String(row.slug).replace(JUP_PREFIX, ""))
      .filter((n) => n.length > 0);

    console.log(
      `[jup-markets] ${ids.length} tracked slug(s): ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? "..." : ""}`
    );
    return ids;
  } catch (err: any) {
    console.error("[jup-markets] syncJupiterTrackedSlugs error:", err?.message);
    return [];
  }
}

/**
 * Resolve the final set of market IDs to track.
 *
 * If JUP_AUTO_DISCOVER=1, includes all live/trending markets.
 * Always merges with tracked_slugs entries.
 */
export async function resolveMarketsToTrack(): Promise<TrackedJupiterMarket[]> {
  const autoDiscover = process.env.JUP_AUTO_DISCOVER !== "0";
  const fromSlugs = await syncJupiterTrackedSlugs();

  const byId = new Map<string, TrackedJupiterMarket>();

  if (autoDiscover) {
    const discovered = await discoverActiveMarkets();
    for (const m of discovered) byId.set(m.marketId, m);
  }

  // Merge slug-specified markets (may not be in discovery if not trending)
  for (const id of fromSlugs) {
    if (!byId.has(id)) {
      byId.set(id, {
        marketId: id,
        eventId: "",
        title: id,
        namespacedId: `${JUP_PREFIX}${id}`,
        status: "open",
        volume24h: 0,
      });
    }
  }

  return Array.from(byId.values());
}
