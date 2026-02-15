-- Run this in the Supabase SQL editor to add news scoring support.

-- Add news_score column to signal_scores
ALTER TABLE signal_scores ADD COLUMN IF NOT EXISTS news_score NUMERIC DEFAULT 0;

-- Cache table for NewsAPI responses (keyed by slug + hour)
CREATE TABLE IF NOT EXISTS news_cache (
  slug TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  articles JSONB NOT NULL,
  article_count INTEGER NOT NULL,
  query TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, hour_bucket)
);

ALTER TABLE news_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON news_cache;

CREATE POLICY "service_role_all" ON news_cache
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Market resolution metadata (for time-based scoring)
CREATE TABLE IF NOT EXISTS market_resolution (
  market_id TEXT PRIMARY KEY,
  slug TEXT,
  end_time TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved BOOLEAN,
  status TEXT,
  resolved_source TEXT,
  end_source TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE market_resolution ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON market_resolution;

CREATE POLICY "service_role_all" ON market_resolution
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS market_resolution_slug_idx
  ON market_resolution USING btree (slug);
