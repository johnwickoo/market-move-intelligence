CREATE TABLE markets (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  resolution_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  price NUMERIC NOT NULL,
  size NUMERIC NOT NULL,
  side TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  raw JSONB NOT NULL
);

CREATE TABLE price_snapshots (
  id BIGSERIAL PRIMARY KEY,
  market_id TEXT NOT NULL,
  price NUMERIC NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  raw JSONB NOT NULL
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE signal_scores (
  id BIGSERIAL PRIMARY KEY,
  movement_id BIGINT NOT NULL,
  capital_score NUMERIC NOT NULL,
  info_score NUMERIC NOT NULL,
  time_score NUMERIC NOT NULL,
  classification TEXT NOT NULL,
  confidence NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE news_events (
  id BIGSERIAL PRIMARY KEY,
  movement_id BIGINT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  raw JSONB NOT NULL
);

CREATE TABLE evaluation_metrics (
  id BIGSERIAL PRIMARY KEY,
  market_id TEXT NOT NULL,
  movement_id BIGINT NOT NULL,
  classification TEXT NOT NULL,
  confidence NUMERIC NOT NULL,
  was_news_found BOOLEAN NOT NULL,
  capital_concentration NUMERIC NOT NULL,
  time_to_resolution_hours NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
