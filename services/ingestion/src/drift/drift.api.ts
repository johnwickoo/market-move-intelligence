import type { DriftMarketInfo, DriftRawTrade } from "./drift.types";
import { BET_SUFFIX } from "./drift.types";

const BASE_URL =
  process.env.DRIFT_DATA_API_URL ?? "https://data.api.drift.trade";

const FETCH_TIMEOUT_MS = Number(process.env.DRIFT_FETCH_TIMEOUT_MS ?? 10_000);

async function fetchJson<T>(
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Drift API ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List all active Drift BET prediction markets.
 * Hits GET /stats/markets and filters for symbols ending in "-BET".
 */
export async function fetchDriftBetMarkets(): Promise<DriftMarketInfo[]> {
  try {
    const raw = await fetchJson<any>("/stats/markets");

    // The response may be an object with a `result` array or a direct array
    const list: any[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.result)
        ? raw.result
        : [];

    const betMarkets: DriftMarketInfo[] = [];
    for (const m of list) {
      const symbol = String(m?.symbol ?? m?.marketName ?? "");
      if (!symbol.endsWith(BET_SUFFIX)) continue;

      const status = String(m?.status ?? "active").toLowerCase();
      if (status === "delisted") continue;

      betMarkets.push({
        symbol,
        marketIndex: Number(m?.marketIndex ?? 0),
        marketType: String(m?.marketType ?? "perp"),
        baseAsset: m?.baseAsset,
        quoteAsset: m?.quoteAsset,
        status,
        markPrice: m?.markPrice != null ? Number(m.markPrice) : undefined,
        volume24h: m?.volume24h != null ? Number(m.volume24h) : undefined,
        oraclePrice: m?.oraclePrice != null ? Number(m.oraclePrice) : undefined,
      });
    }

    console.log(
      `[drift-api] found ${betMarkets.length} BET markets out of ${list.length} total`
    );
    return betMarkets;
  } catch (err: any) {
    console.error("[drift-api] fetchDriftBetMarkets failed:", err?.message);
    return [];
  }
}

/**
 * Fetch recent trades for a specific Drift market (for backfill).
 * Hits GET /market/{symbol}/trades
 */
export async function fetchDriftTrades(
  symbol: string,
  opts?: { limit?: number }
): Promise<DriftRawTrade[]> {
  try {
    const params: Record<string, string> = {};
    if (opts?.limit) params.limit = String(opts.limit);

    const raw = await fetchJson<any>(`/market/${symbol}/trades`, params);
    const list: any[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.result)
        ? raw.result
        : Array.isArray(raw?.trades)
          ? raw.trades
          : [];

    // Ensure each entry has the marketName set
    return list.map((t) => ({
      ...t,
      marketName: t.marketName ?? symbol,
    })) as DriftRawTrade[];
  } catch (err: any) {
    console.error(
      `[drift-api] fetchDriftTrades(${symbol}) failed:`,
      err?.message
    );
    return [];
  }
}
