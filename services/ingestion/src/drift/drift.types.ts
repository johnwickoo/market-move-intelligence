// ── Raw Drift DLOB WebSocket messages ────────────────────────────────

/** Trade fill from the DLOB "trades" channel */
export type DriftRawTrade = {
  ts: number;
  marketIndex: number;
  marketName: string;
  marketType: string;
  filler?: string;
  taker?: string;
  maker?: string;
  takerOrderId?: number;
  makerOrderId?: number;
  takerOrderDirection: string; // "long" | "short"
  makerOrderDirection?: string;
  takerFee?: number;
  makerFee?: number;
  quoteAssetAmountSurplus?: number;
  baseAssetAmountFilled: number;
  quoteAssetAmountFilled: number;
  oraclePrice?: number;
  txSig: string;
  slot: number;
  action?: string;
  actionExplanation?: string;
};

/** Orderbook snapshot from the DLOB "orderbook" channel */
export type DriftRawOrderbook = {
  marketIndex: number;
  marketName: string;
  marketType: string;
  ts: number;
  slot: number;
  oracle?: number;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
};

// ── REST Data API types ─────────────────────────────────────────────

/** Market info from GET /stats/markets */
export type DriftMarketInfo = {
  symbol: string;
  marketIndex: number;
  marketType: string;
  baseAsset?: string;
  quoteAsset?: string;
  status?: string;
  markPrice?: number;
  volume24h?: number;
  oraclePrice?: number;
};

/** Internal tracked market state */
export type TrackedDriftMarket = {
  marketName: string;
  marketIndex: number;
  namespacedId: string; // "drift:MARKET-NAME"
  status: string;
};

// ── Constants ───────────────────────────────────────────────────────

export const DRIFT_PREFIX = "drift:";
export const BET_SUFFIX = "-BET";
