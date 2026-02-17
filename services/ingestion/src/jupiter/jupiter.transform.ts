import type { TradeInsert } from "../../../storage/src/types";
import type { MidTickInsert } from "../../../storage/src/insertMidTick";
import type { JupiterRawTrade, JupiterOrderbook } from "./jupiter.types";
import { JUP_PREFIX } from "./jupiter.types";

// Jupiter prices are in micro USD (1 USD = 1_000_000 micro USD)
const MICRO_USD = 1_000_000;

function clampPrice(p: number): number {
  return Math.max(0, Math.min(1, p));
}

/**
 * Parse a micro-USD string into a 0-1 decimal price.
 * Jupiter prices come as string micro-USD for prediction markets
 * (e.g. "500000" = $0.50).
 */
function parseMicroUsd(raw: string | number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  // If already in 0-1 range, it's already a decimal
  if (n >= 0 && n <= 1) return n;
  // If in dollars (0-100 range), divide by 100
  if (n > 1 && n <= 100) return n / 100;
  // Otherwise assume micro USD
  return n / MICRO_USD;
}

/**
 * Convert a Jupiter trade (from /trades endpoint) into a TradeInsert.
 */
export function jupiterTradeToInsert(raw: JupiterRawTrade): TradeInsert | null {
  if (!raw.marketId || raw.id == null) return null;

  const marketId = `${JUP_PREFIX}${raw.marketId}`;
  const id = `${JUP_PREFIX}${raw.id}`;

  const price = parseMicroUsd(raw.priceUsd);
  if (price <= 0) return null;

  const amount = parseMicroUsd(raw.amountUsd);
  // size in USD terms
  const size = amount > 0 ? amount : price;

  const side = raw.action === "buy" ? "BUY" : "SELL";

  // Jupiter uses "yes" / "no" directly
  const outcome = raw.side === "yes" ? "Yes" : "No";

  // Timestamp — Jupiter uses Unix seconds
  const tsMs =
    raw.timestamp < 10_000_000_000
      ? raw.timestamp * 1000
      : raw.timestamp;

  return {
    id,
    market_id: marketId,
    price: clampPrice(price),
    size,
    side,
    timestamp: new Date(tsMs).toISOString(),
    raw,
    outcome,
    outcome_index: outcome === "Yes" ? 0 : 1,
  };
}

/**
 * Convert a Jupiter orderbook snapshot into a MidTickInsert.
 *
 * Jupiter format: { yes: [[priceCents, size], ...], no: [[priceCents, size], ...] }
 * Price is in cents (1-99).
 *
 * For the "Yes" outcome:
 *   best bid = highest price in `yes` array (someone willing to buy Yes at that price)
 *   best ask = 1 - highest price in `no` array (buying No at X ≡ selling Yes at 1-X)
 */
export function jupiterOrderbookToMidTick(
  marketId: string,
  raw: JupiterOrderbook
): MidTickInsert | null {
  if (!raw.yes?.length && !raw.no?.length) return null;

  // Find highest price level on each side (cents → decimal)
  let bestYes: number | null = null;
  for (const [cents] of raw.yes ?? []) {
    const p = cents / 100;
    if (p > 0 && p < 1 && (bestYes === null || p > bestYes)) bestYes = p;
  }

  let bestNo: number | null = null;
  for (const [cents] of raw.no ?? []) {
    const p = cents / 100;
    if (p > 0 && p < 1 && (bestNo === null || p > bestNo)) bestNo = p;
  }

  // best bid for Yes = highest yes price
  // best ask for Yes = 1 - highest no price (buying No at X = selling Yes at 1-X)
  const bestBid = bestYes;
  const bestAsk = bestNo !== null ? clampPrice(1 - bestNo) : null;

  if (bestBid === null && bestAsk === null) return null;

  // Ensure bid < ask (crossed book = skip)
  if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) return null;

  const mid =
    bestBid !== null && bestAsk !== null
      ? (bestBid + bestAsk) / 2
      : bestBid ?? bestAsk;

  const spread =
    bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  const spreadPct =
    spread !== null && mid !== null && mid > 0 ? spread / mid : null;

  // Skip if spread is too wide (>30%)
  if (spreadPct !== null && spreadPct > 0.3) return null;

  const nsId = `${JUP_PREFIX}${marketId}`;

  return {
    market_id: nsId,
    outcome: "Yes",
    asset_id: nsId,
    ts: new Date().toISOString(),
    best_bid: bestBid,
    best_ask: bestAsk,
    mid,
    spread,
    spread_pct: spreadPct,
    raw: {
      source: "jupiter_orderbook",
      yes_top3: (raw.yes ?? []).slice(-3).reverse(),
      no_top3: (raw.no ?? []).slice(-3).reverse(),
    },
  };
}
