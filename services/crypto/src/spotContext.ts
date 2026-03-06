/**
 * Spot price context enrichment for prediction market movements.
 *
 * For crypto-related markets, fetches the underlying asset's spot price
 * at window_start and window_end to compute correlation between the
 * prediction market movement and the underlying price movement.
 */

import { supabase } from "../../storage/src/db";
import { resolveSlugAndTitle } from "../../news/src/newsapi.client";
import { deriveEntityContext } from "../../news/src/entity";
import {
  resolveCoingeckoId,
  fetchCurrentPrice,
  fetchHistoricalPrice,
} from "./coingecko";

export type SpotContext = {
  provider: "coingecko";
  coinId: string;
  coinName: string;
  spotPriceStart: number;
  spotPriceEnd: number;
  spotDriftPct: number; // (end - start) / start
  startSource: "historical";
  endSource: "historical" | "current";
};

// Cache entity lookups per market_id (doesn't change during a session)
const entityCache = new Map<string, { coinId: string | null; coinName: string; ts: number }>();
const ENTITY_CACHE_TTL_MS = 60 * 60_000; // 1 hour

async function resolveCryptoEntity(
  marketId: string,
): Promise<{ coinId: string; coinName: string } | null> {
  const now = Date.now();
  const cached = entityCache.get(marketId);
  if (cached && now - cached.ts < ENTITY_CACHE_TTL_MS) {
    return cached.coinId ? { coinId: cached.coinId, coinName: cached.coinName } : null;
  }

  try {
    // Try to resolve entity from trade raw data. The most recent trade may
    // be from CLOB (no slug/title), so also check older backfill trades
    // which include eventSlug in their raw JSON.
    let textForEntity: string | null = null;
    let slug: string | null = null;

    // 1. Try latest trade (fast path)
    const { slug: tradeSlug, title } = await resolveSlugAndTitle(marketId);
    if (title) {
      textForEntity = title;
      slug = tradeSlug;
    } else if (tradeSlug) {
      textForEntity = tradeSlug.replace(/-/g, " ");
      slug = tradeSlug;
    }

    // 2. If no slug from latest trade, scan older trades for one with a slug
    if (!textForEntity) {
      const { data: olderTrades } = await supabase
        .from("trades")
        .select("raw")
        .eq("market_id", marketId)
        .order("timestamp", { ascending: true })
        .limit(5);
      if (olderTrades) {
        for (const row of olderTrades) {
          const raw = row.raw as any;
          const p = raw?.payload ?? raw;
          const s = p?.eventSlug ?? p?.slug ?? p?.marketSlug ?? null;
          const t = p?.title ?? p?.market_title ?? null;
          if (t) { textForEntity = t; slug = s; break; }
          if (s) { textForEntity = String(s).replace(/-/g, " "); slug = s; break; }
        }
      }
    }

    if (!textForEntity) {
      entityCache.set(marketId, { coinId: null, coinName: "", ts: now });
      return null;
    }

    const entity = deriveEntityContext(textForEntity, slug);
    if (entity.category !== "crypto") {
      entityCache.set(marketId, { coinId: null, coinName: "", ts: now });
      return null;
    }

    const coinId = resolveCoingeckoId(entity.canonicalEntity);
    if (!coinId) {
      entityCache.set(marketId, { coinId: null, coinName: "", ts: now });
      return null;
    }

    entityCache.set(marketId, { coinId, coinName: entity.canonicalEntity, ts: now });
    return { coinId, coinName: entity.canonicalEntity };
  } catch {
    return null;
  }
}

/**
 * Fetch spot price context for a movement window.
 *
 * Returns null for non-crypto markets or if prices can't be fetched.
 * Never throws.
 */
export async function fetchSpotContext(
  marketId: string,
  windowStartISO: string,
  windowEndISO: string,
): Promise<SpotContext | null> {
  try {
    const crypto = await resolveCryptoEntity(marketId);
    if (!crypto) return null;

    const startMs = Date.parse(windowStartISO);
    const endMs = Date.parse(windowEndISO);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

    // Fetch historical price for window start, current/recent for window end
    const now = Date.now();
    const endIsRecent = now - endMs < 5 * 60_000; // within last 5 min

    const [spotStart, spotEnd] = await Promise.all([
      fetchHistoricalPrice(crypto.coinId, startMs),
      endIsRecent
        ? fetchCurrentPrice(crypto.coinId)
        : fetchHistoricalPrice(crypto.coinId, endMs),
    ]);

    if (spotStart == null || spotEnd == null) {
      console.warn(
        `[crypto] coingecko spot unavailable coin=${crypto.coinId} start=${
          spotStart == null ? "n/a" : spotStart.toFixed(2)
        } end=${spotEnd == null ? "n/a" : spotEnd.toFixed(2)}`
      );
      return null;
    }
    if (spotStart <= 0) return null;

    const spotDriftPct = (spotEnd - spotStart) / spotStart;

    console.log(
      `[crypto] coingecko ${crypto.coinName}(${crypto.coinId}) spot: ` +
      `$${spotStart.toFixed(2)} → $${spotEnd.toFixed(2)} ` +
      `(Δ ${(spotDriftPct * 100).toFixed(2)}%, endSource=${endIsRecent ? "current" : "historical"})`
    );

    return {
      provider: "coingecko",
      coinId: crypto.coinId,
      coinName: crypto.coinName,
      spotPriceStart: spotStart,
      spotPriceEnd: spotEnd,
      spotDriftPct,
      startSource: "historical",
      endSource: endIsRecent ? "current" : "historical",
    };
  } catch (err: any) {
    console.warn("[crypto] fetchSpotContext failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Compute correlation between prediction market drift and spot price drift.
 *
 * Returns 0..1 where:
 * - 1.0 = prediction market perfectly tracked spot price
 * - 0.0 = spot was flat, or markets moved in opposite directions
 */
export function computeCryptoCorrelation(
  marketDriftPct: number,
  spotDriftPct: number,
): number {
  // Spot was flat — prediction market move is independent of spot
  if (Math.abs(spotDriftPct) < 0.005) return 0;

  // Opposite directions — divergence
  if (Math.sign(marketDriftPct) !== Math.sign(spotDriftPct)) return 0;

  // Same direction — how closely do the magnitudes match?
  const diff = Math.abs(Math.abs(marketDriftPct) - Math.abs(spotDriftPct));
  const correlation = Math.max(0, 1 - diff / Math.abs(spotDriftPct));
  return Math.min(1, correlation);
}
