// ── Jupiter Prediction API response types ───────────────────────────
// Based on https://dev.jup.ag/openapi-spec/prediction/prediction.yaml

export const JUP_PREFIX = "jup:";

// ── /trades response ────────────────────────────────────────────────

export type JupiterRawTrade = {
  id: number;
  ownerPubkey: string;
  marketId: string;
  message: string;
  timestamp: number; // Unix seconds
  action: "buy" | "sell";
  side: "yes" | "no";
  eventTitle: string;
  marketTitle: string;
  amountUsd: string; // micro USD string
  priceUsd: string; // micro USD string
  eventImageUrl: string;
  eventId: string;
};

// ── /orderbook/{marketId} response ──────────────────────────────────
// Real format: { yes: [[priceCents, size], ...], no: [[priceCents, size], ...],
//                yes_dollars: [["0.0100", size], ...], no_dollars: [...] }

export type JupiterOrderbook = {
  yes: [number, number][]; // [priceCents, size]
  no: [number, number][]; // [priceCents, size]
  yes_dollars?: [string, number][]; // ["priceDecimal", size]
  no_dollars?: [string, number][]; // ["priceDecimal", size]
  marketId?: string;
};

// ── /events response ────────────────────────────────────────────────

export type JupiterEventMetadata = {
  eventId: string;
  title: string;
  subtitle: string;
  imageUrl: string;
  isLive: boolean;
};

export type JupiterMarketMetadata = {
  marketId: string;
  title: string;
  imageUrl?: string;
};

export type JupiterMarketPricing = {
  buyYesPriceUsd: number | null;
  buyNoPriceUsd: number | null;
  sellYesPriceUsd: number | null;
  sellNoPriceUsd: number | null;
  volume: number;
  openInterest: number;
  volume24h: number;
  liquidityDollars: number;
  notionalValueDollars: number;
};

export type JupiterMarket = {
  marketId: string;
  event: string; // eventId
  status: "open" | "closed";
  result: null | "yes" | "no";
  openTime: number;
  closeTime: number;
  settlementTime: number;
  metadata: JupiterMarketMetadata;
  pricing: JupiterMarketPricing;
};

export type JupiterEvent = {
  eventId: string;
  series: string;
  winner: string;
  multipleWinners: boolean;
  isActive: boolean;
  isLive: boolean;
  isTrending: boolean;
  isRecommended: boolean;
  category: string;
  subcategory: string;
  metadata: JupiterEventMetadata;
  markets?: JupiterMarket[];
  tvlDollars: string;
  volumeUsd: string;
  closeCondition: string;
  beginAt: string | null;
  rulesPdf: string;
};

export type JupiterPagination = {
  start: number;
  end: number;
  total: number;
  hasNext: boolean;
};

export type JupiterListResponse<T> = {
  data: T[];
  pagination: JupiterPagination;
};

// ── Internal tracked market ─────────────────────────────────────────

export type TrackedJupiterMarket = {
  marketId: string;
  eventId: string;
  title: string;
  namespacedId: string; // "jup:marketId"
  status: string;
  volume24h: number; // for prioritizing orderbook polling
};
