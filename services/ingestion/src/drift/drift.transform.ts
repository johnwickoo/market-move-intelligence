import type { TradeInsert } from "../../../storage/src/types";
import type { MidTickInsert } from "../../../storage/src/insertMidTick";
import type { DriftRawTrade, DriftRawOrderbook } from "./drift.types";
import { DRIFT_PREFIX } from "./drift.types";

// Drift uses 10^6 precision for USDC amounts
const USDC_DECIMALS = 1_000_000;

function clampPrice(p: number): number {
  return Math.max(0, Math.min(1, p));
}

function toMs(ts: number): number {
  // Drift timestamps may be seconds or milliseconds
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}

/**
 * Convert a raw Drift fill event into the shared TradeInsert format.
 * Returns null if the message is malformed or missing required fields.
 */
export function driftTradeToInsert(raw: DriftRawTrade): TradeInsert | null {
  if (!raw.txSig || !raw.marketName) return null;
  if (!Number.isFinite(raw.baseAssetAmountFilled)) return null;
  if (raw.baseAssetAmountFilled <= 0) return null;

  const marketId = `${DRIFT_PREFIX}${raw.marketName}`;
  const id = `${DRIFT_PREFIX}${raw.txSig}:${raw.slot}`;

  // Fill price: quote / base, scaled from USDC decimals
  let price: number;
  if (
    Number.isFinite(raw.quoteAssetAmountFilled) &&
    raw.quoteAssetAmountFilled > 0 &&
    raw.baseAssetAmountFilled > 0
  ) {
    price = raw.quoteAssetAmountFilled / raw.baseAssetAmountFilled;
    // If values appear to be in raw integer form, scale down
    if (price > 10) price = price / USDC_DECIMALS;
  } else if (raw.oraclePrice != null && Number.isFinite(raw.oraclePrice)) {
    price = raw.oraclePrice;
    if (price > 10) price = price / USDC_DECIMALS;
  } else {
    return null;
  }

  price = clampPrice(price);

  const side =
    raw.takerOrderDirection === "long" ? "BUY" : "SELL";

  // In Drift BET: long = Yes, short = No
  const outcome = side === "BUY" ? "Yes" : "No";

  // Size in USDC terms
  let size = raw.quoteAssetAmountFilled;
  if (size > 1_000_000_000) size = size / USDC_DECIMALS;

  const tsMs = toMs(raw.ts);

  return {
    id,
    market_id: marketId,
    price,
    size,
    side,
    timestamp: new Date(tsMs).toISOString(),
    raw,
    outcome,
    outcome_index: outcome === "Yes" ? 0 : 1,
  };
}

/**
 * Convert a raw Drift orderbook snapshot into a MidTickInsert.
 * Returns null if the orderbook is empty or malformed.
 */
export function driftOrderbookToMidTick(
  raw: DriftRawOrderbook
): MidTickInsert | null {
  if (!raw.marketName) return null;
  if (!raw.bids?.length && !raw.asks?.length) return null;

  let bestBid: number | null = null;
  let bestAsk: number | null = null;

  // Bids are sorted descending (highest first)
  for (const b of raw.bids) {
    const p = Number(b.price);
    if (!Number.isFinite(p)) continue;
    const scaled = p > 10 ? p / USDC_DECIMALS : p;
    if (bestBid === null || scaled > bestBid) bestBid = scaled;
  }

  // Asks are sorted ascending (lowest first)
  for (const a of raw.asks) {
    const p = Number(a.price);
    if (!Number.isFinite(p)) continue;
    const scaled = p > 10 ? p / USDC_DECIMALS : p;
    if (bestAsk === null || scaled < bestAsk) bestAsk = scaled;
  }

  if (bestBid === null && bestAsk === null) return null;

  // Clamp to 0-1 range for prediction markets
  if (bestBid !== null) bestBid = clampPrice(bestBid);
  if (bestAsk !== null) bestAsk = clampPrice(bestAsk);

  const mid =
    bestBid !== null && bestAsk !== null
      ? (bestBid + bestAsk) / 2
      : bestBid ?? bestAsk;
  const spread =
    bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const spreadPct =
    spread !== null && mid !== null && mid > 0 ? spread / mid : null;

  // Skip if spread is too wide (>30%) — likely stale or illiquid
  if (spreadPct !== null && spreadPct > 0.3) return null;

  const marketId = `${DRIFT_PREFIX}${raw.marketName}`;
  const assetId = `${DRIFT_PREFIX}${raw.marketName}`;
  const tsMs = toMs(raw.ts);

  return {
    market_id: marketId,
    outcome: "Yes",
    asset_id: assetId,
    ts: new Date(tsMs).toISOString(),
    best_bid: bestBid,
    best_ask: bestAsk,
    mid,
    spread,
    spread_pct: spreadPct,
    raw: {
      source: "drift_orderbook",
      slot: raw.slot,
      bids: raw.bids.slice(0, 3),
      asks: raw.asks.slice(0, 3),
    },
  };
}
