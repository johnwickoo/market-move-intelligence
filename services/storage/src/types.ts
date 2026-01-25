export type StorageConfig = {
  // TODO: define storage config
};
export type TradeInsert = {
  id: string;
  market_id: string;
  price: number;
  size: number;
  side: string;
  timestamp: string;
  raw: unknown;
  outcome: String;
  outcome_index:number
};
