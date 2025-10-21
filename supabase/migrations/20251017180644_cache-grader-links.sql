-- Create table to cache grader signed URLs
CREATE TABLE IF NOT EXISTS grader_links_cache (
  id BIGSERIAL PRIMARY KEY,
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  signed_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
  UNIQUE(repo, sha)
);

-- Index for efficient lookup
CREATE INDEX IF NOT EXISTS idx_grader_links_cache_repo_sha ON grader_links_cache(repo, sha);

-- Index for efficient cleanup of expired links
CREATE INDEX IF NOT EXISTS idx_grader_links_cache_expires_at ON grader_links_cache(expires_at);

-- Enable RLS (optional, but good practice)
ALTER TABLE grader_links_cache ENABLE ROW LEVEL SECURITY;

-- Policy to allow service role full access
CREATE POLICY "Service role can manage grader links cache" ON grader_links_cache
  FOR ALL
  USING (auth.role() = 'service_role');

-- pg_cron job to cleanup expired links (runs every 15 minutes)
SELECT cron.schedule(
  'cleanup-expired-grader-links',
  '*/15 * * * *',
  $$
  DELETE FROM grader_links_cache 
  WHERE expires_at < NOW();
  $$
);

