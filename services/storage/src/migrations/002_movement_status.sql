-- Two-stage movement pipeline: detect fast (OPEN), explain slow (FINAL)
ALTER TABLE market_movements
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'FINAL',
  ADD COLUMN IF NOT EXISTS finalize_at TIMESTAMPTZ;

-- Index for the finalize worker to find OPEN movements ready to process
CREATE INDEX IF NOT EXISTS market_movements_status_finalize_idx
  ON market_movements (status, finalize_at)
  WHERE status = 'OPEN';
