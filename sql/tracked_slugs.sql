-- Run this in the Supabase SQL editor to create the tracked_slugs table.
-- This table is the shared config between the frontend and ingestion service.

CREATE TABLE IF NOT EXISTS tracked_slugs (
  slug TEXT PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable Row Level Security but allow service-role full access
ALTER TABLE tracked_slugs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON tracked_slugs
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Seed with the currently configured slug (adjust as needed)
INSERT INTO tracked_slugs (slug)
VALUES ('another-us-government-shutdown-by-february-14')
ON CONFLICT (slug) DO NOTHING;
