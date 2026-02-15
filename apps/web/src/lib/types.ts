export type SeriesPoint = {
  t: string;
  price: number;
  volume: number;
};

export type VolumePoint = {
  t: string;
  buy: number;
  sell: number;
};

export type Annotation = {
  kind: "signal" | "movement";
  start_ts: string;
  end_ts: string;
  label: string;
  explanation: string;
  color: string;
};

export type OutcomeSeries = {
  outcome: string;
  color: string;
  series: SeriesPoint[];
  volumes: VolumePoint[];
  annotations: Annotation[];
  market_id?: string; // child market_id for multi-market events
};

export type MarketSnapshot = {
  market_id?: string;
  slug: string;
  title: string;
  outcomes: OutcomeSeries[];
  child_market_ids?: string[];
};

export type PinnedSelection = {
  marketId: string;
  assetId: string;
};
