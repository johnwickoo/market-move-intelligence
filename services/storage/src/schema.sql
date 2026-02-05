CREATE TABLE market_aggregates (
  market_id TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  trade_count INTEGER NOT NULL,
  total_volume NUMERIC NOT NULL,
  buy_volume NUMERIC NOT NULL,
  sell_volume NUMERIC NOT NULL,
  avg_trade_size NUMERIC NOT NULL,
  last_price NUMERIC,
  min_price NUMERIC,
  max_price NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_seen_at TIMESTAMPTZ
);

CREATE TABLE market_mid_latest (
  market_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  outcome TEXT,
  ts TIMESTAMPTZ NOT NULL,
  best_bid NUMERIC,
  best_ask NUMERIC,
  mid NUMERIC,
  spread NUMERIC,
  spread_pct NUMERIC,
  PRIMARY KEY (market_id, asset_id)
);

CREATE TABLE market_dominant_outcomes (
  market_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE market_mid_ticks (
  id BIGSERIAL PRIMARY KEY,
  market_id TEXT NOT NULL,
  outcome TEXT,
  asset_id TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  best_bid NUMERIC,
  best_ask NUMERIC,
  mid NUMERIC,
  spread NUMERIC,
  spread_pct NUMERIC,
  raw JSONB
);

CREATE TABLE market_movements (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  outcome TEXT,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  start_price NUMERIC,
  end_price NUMERIC,
  pct_change NUMERIC,
  volume_24h NUMERIC NOT NULL,
  baseline_daily_volume NUMERIC,
  volume_ratio NUMERIC,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  min_price_24h NUMERIC,
  max_price_24h NUMERIC,
  range_pct NUMERIC,
  max_hour_volume NUMERIC,
  hourly_volume_ratio NUMERIC,
  trades_count_24h NUMERIC,
  unique_price_levels_24h INTEGER,
  avg_trade_size_24h NUMERIC,
  thin_liquidity BOOLEAN,
  window_type TEXT
);

CREATE TABLE movement_events (
  id BIGSERIAL PRIMARY KEY,
  market_id TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  price_start NUMERIC NOT NULL,
  price_end NUMERIC NOT NULL,
  volume NUMERIC NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  asset_id TEXT NOT NULL,
  outcome TEXT
);

CREATE TABLE movement_explanations (
  movement_id TEXT PRIMARY KEY,
  text TEXT NOT NULL
);

CREATE TABLE signal_scores (
  id BIGSERIAL PRIMARY KEY,
  movement_id TEXT NOT NULL,
  capital_score NUMERIC NOT NULL,
  info_score NUMERIC NOT NULL,
  time_score NUMERIC NOT NULL,
  classification TEXT NOT NULL,
  confidence NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  price NUMERIC NOT NULL,
  size NUMERIC NOT NULL,
  side TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  raw JSONB NOT NULL,
  outcome TEXT,
  outcome_index SMALLINT
);

CREATE UNIQUE INDEX market_mid_ticks_asset_id_ts_key
  ON public.market_mid_ticks USING btree (asset_id, ts);

CREATE INDEX market_mid_ticks_asset_ts_idx
  ON public.market_mid_ticks USING btree (asset_id, ts DESC);

CREATE INDEX market_mid_ticks_market_ts_idx
  ON public.market_mid_ticks USING btree (market_id, ts DESC);

CREATE INDEX market_mid_ticks_market_outcome_ts_idx
  ON public.market_mid_ticks USING btree (market_id, outcome, ts DESC);

CREATE INDEX market_movements_market_time_idx
  ON public.market_movements USING btree (market_id, window_end DESC);

CREATE UNIQUE INDEX signal_scores_movement_id_uniq
  ON public.signal_scores USING btree (movement_id);

CREATE INDEX trades_market_id_idx
  ON public.trades USING btree (market_id);

CREATE INDEX trades_timestamp_idx
  ON public.trades USING btree ("timestamp");

CREATE INDEX trades_market_outcome_timestamp_idx
  ON public.trades USING btree (market_id, outcome, "timestamp");
