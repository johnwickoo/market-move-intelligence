import type {
  JupiterRawTrade,
  JupiterOrderbook,
  JupiterEvent,
  JupiterMarket,
  JupiterListResponse,
} from "./jupiter.types";

// Trailing slash is required for new URL() to resolve relative paths correctly.
// new URL("events", "https://api.jup.ag/prediction/v1/") → .../prediction/v1/events  ✓
// new URL("/events", "https://api.jup.ag/prediction/v1")  → .../events               ✗
const BASE_URL_RAW =
  process.env.JUP_PREDICTION_API_URL ??
  "https://api.jup.ag/prediction/v1";
const BASE_URL = BASE_URL_RAW.endsWith("/") ? BASE_URL_RAW : BASE_URL_RAW + "/";

const FETCH_TIMEOUT_MS = Number(process.env.JUP_FETCH_TIMEOUT_MS ?? 10_000);

// ── Helpers ─────────────────────────────────────────────────────────

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
  };
  // Read lazily so dotenv has time to load
  const key = process.env.JUP_API_KEY ?? "";
  if (key) h["x-api-key"] = key;
  return h;
}

async function fetchJson<T>(
  rawPath: string,
  params?: Record<string, string>
): Promise<T> {
  // Strip leading slash so new URL() resolves relative to BASE_URL path
  const path = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      headers: headers(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jupiter API ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Fetch the global trade feed (order_filled events).
 * Newest first. Use `start`/`end` for pagination.
 */
export async function fetchTrades(opts?: {
  start?: number;
  end?: number;
}): Promise<JupiterRawTrade[]> {
  try {
    const params: Record<string, string> = {};
    if (opts?.start != null) params.start = String(opts.start);
    if (opts?.end != null) params.end = String(opts.end);

    const res = await fetchJson<JupiterListResponse<JupiterRawTrade>>(
      "/trades",
      params
    );
    return res?.data ?? [];
  } catch (err: any) {
    console.error("[jup-api] fetchTrades failed:", err?.message);
    return [];
  }
}

/**
 * Fetch the orderbook for a specific market.
 */
export async function fetchOrderbook(
  marketId: string
): Promise<JupiterOrderbook | null> {
  try {
    const raw = await fetchJson<any>(`/orderbook/${encodeURIComponent(marketId)}`);
    if (raw && typeof raw === "object") raw.marketId = marketId;
    return raw as JupiterOrderbook;
  } catch (err: any) {
    console.error(
      `[jup-api] fetchOrderbook(${marketId}) failed:`,
      err?.message
    );
    return null;
  }
}

/**
 * List events with optional filters.
 */
export async function fetchEvents(opts?: {
  provider?: "polymarket" | "kalshi";
  category?: string;
  filter?: "new" | "live" | "trending";
  includeMarkets?: boolean;
  start?: number;
  end?: number;
  sortBy?: "volume" | "beginAt";
  sortDirection?: "asc" | "desc";
}): Promise<JupiterEvent[]> {
  try {
    const params: Record<string, string> = {};
    if (opts?.provider) params.provider = opts.provider;
    if (opts?.category) params.category = opts.category;
    if (opts?.filter) params.filter = opts.filter;
    if (opts?.includeMarkets) params.includeMarkets = "true";
    if (opts?.start != null) params.start = String(opts.start);
    if (opts?.end != null) params.end = String(opts.end);
    if (opts?.sortBy) params.sortBy = opts.sortBy;
    if (opts?.sortDirection) params.sortDirection = opts.sortDirection;

    const res = await fetchJson<JupiterListResponse<JupiterEvent>>(
      "/events",
      params
    );
    return res?.data ?? [];
  } catch (err: any) {
    console.error("[jup-api] fetchEvents failed:", err?.message);
    return [];
  }
}

/**
 * Fetch markets for a specific event.
 */
export async function fetchEventMarkets(
  eventId: string
): Promise<JupiterMarket[]> {
  try {
    const res = await fetchJson<JupiterListResponse<JupiterMarket>>(
      `/events/${encodeURIComponent(eventId)}/markets`
    );
    return res?.data ?? [];
  } catch (err: any) {
    console.error(
      `[jup-api] fetchEventMarkets(${eventId}) failed:`,
      err?.message
    );
    return [];
  }
}

/**
 * Fetch a single market by ID.
 */
export async function fetchMarket(
  marketId: string
): Promise<JupiterMarket | null> {
  try {
    return await fetchJson<JupiterMarket>(
      `/markets/${encodeURIComponent(marketId)}`
    );
  } catch (err: any) {
    console.error(
      `[jup-api] fetchMarket(${marketId}) failed:`,
      err?.message
    );
    return null;
  }
}
