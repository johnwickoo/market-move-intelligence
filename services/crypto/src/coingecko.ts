/**
 * CoinGecko API client with in-memory caching.
 *
 * Free tier: ~10-30 calls/min (no key required for /simple/price).
 * Optional COINGECKO_API_KEY for higher rate limits.
 *
 * Never throws — returns null on failure for graceful degradation.
 */

const COINGECKO_BASE = process.env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3";
const COINGECKO_KEY = process.env.COINGECKO_API_KEY ?? "";
const TIMEOUT_MS = Number(process.env.COINGECKO_TIMEOUT_MS ?? 10_000);
const COINGECKO_HOST = (() => {
  try {
    return new URL(COINGECKO_BASE).hostname.toLowerCase();
  } catch {
    return "";
  }
})();
const IS_OFFICIAL_COINGECKO =
  COINGECKO_HOST === "api.coingecko.com" || COINGECKO_HOST.endsWith(".coingecko.com");
let providerLogged = false;

function logProviderOnce() {
  if (providerLogged) return;
  providerLogged = true;
  if (IS_OFFICIAL_COINGECKO) {
    console.log(`[crypto] provider=coingecko base=${COINGECKO_BASE}`);
  } else {
    console.warn(
      `[crypto] provider mismatch: expected CoinGecko, using base=${COINGECKO_BASE}`
    );
  }
}

// Canonical entity name → CoinGecko coin ID
const COINGECKO_IDS: Record<string, string> = {
  Bitcoin: "bitcoin",
  Ethereum: "ethereum",
  Solana: "solana",
  XRP: "ripple",
  Dogecoin: "dogecoin",
  Cardano: "cardano",
  Avalanche: "avalanche-2",
  Chainlink: "chainlink",
  Polygon: "matic-network",
  Polkadot: "polkadot",
};

export function resolveCoingeckoId(canonicalEntity: string): string | null {
  return COINGECKO_IDS[canonicalEntity] ?? null;
}

// ── Current price cache (60s TTL) ────────────────────────────────────
const priceCache = new Map<string, { price: number; ts: number }>();
const PRICE_CACHE_TTL_MS = 60_000;

export async function fetchCurrentPrice(coinId: string): Promise<number | null> {
  logProviderOnce();
  const now = Date.now();
  const cached = priceCache.get(coinId);
  if (cached && now - cached.ts < PRICE_CACHE_TTL_MS) return cached.price;

  try {
    const params = new URLSearchParams({
      ids: coinId,
      vs_currencies: "usd",
    });
    if (COINGECKO_KEY) params.set("x_cg_demo_api_key", COINGECKO_KEY);

    const res = await fetch(`${COINGECKO_BASE}/simple/price?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[crypto] coingecko /simple/price ${res.status}`);
      return null;
    }

    const data = await res.json();
    const price = data?.[coinId]?.usd;
    if (typeof price !== "number" || !Number.isFinite(price)) return null;

    priceCache.set(coinId, { price, ts: now });
    return price;
  } catch (err: any) {
    console.warn("[crypto] fetchCurrentPrice failed:", err?.message ?? err);
    return null;
  }
}

// ── Historical price at a specific timestamp ─────────────────────────
// Uses /coins/{id}/market_chart/range to get price data for a time range,
// then picks the data point closest to the target timestamp.
const historyCache = new Map<string, { price: number; ts: number }>();
const HISTORY_CACHE_TTL_MS = 5 * 60_000; // 5 min — historical prices don't change

export async function fetchHistoricalPrice(
  coinId: string,
  targetMs: number,
): Promise<number | null> {
  logProviderOnce();
  const cacheKey = `${coinId}:${Math.floor(targetMs / 60_000)}`; // bucket to minute
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < HISTORY_CACHE_TTL_MS) return cached.price;

  try {
    // Fetch a 10-minute range around the target to find the closest point
    const fromSec = Math.floor((targetMs - 5 * 60_000) / 1000);
    const toSec = Math.floor((targetMs + 5 * 60_000) / 1000);

    const params = new URLSearchParams({
      vs_currency: "usd",
      from: String(fromSec),
      to: String(toSec),
    });
    if (COINGECKO_KEY) params.set("x_cg_demo_api_key", COINGECKO_KEY);

    const res = await fetch(
      `${COINGECKO_BASE}/coins/${coinId}/market_chart/range?${params}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) {
      console.warn(`[crypto] coingecko /market_chart/range ${res.status}`);
      return null;
    }

    const data = await res.json();
    const prices: [number, number][] = data?.prices;
    if (!Array.isArray(prices) || prices.length === 0) return null;

    // Find closest data point to targetMs
    let bestPrice = prices[0][1];
    let bestDist = Math.abs(prices[0][0] - targetMs);
    for (const [ts, price] of prices) {
      const dist = Math.abs(ts - targetMs);
      if (dist < bestDist) {
        bestDist = dist;
        bestPrice = price;
      }
    }

    if (!Number.isFinite(bestPrice)) return null;
    historyCache.set(cacheKey, { price: bestPrice, ts: Date.now() });
    return bestPrice;
  } catch (err: any) {
    console.warn("[crypto] fetchHistoricalPrice failed:", err?.message ?? err);
    return null;
  }
}
