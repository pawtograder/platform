-- ============================================================================
-- PR base-tree cache (immutable, content-addressed base snapshot for PR diffs)
-- ============================================================================
-- For pr-mode submissions the Files view renders a base->head diff. `head` is
-- the snapshot already in `submission_files`; `base` is the upstream repo at the
-- submission's snapshotted `base_sha`. Fetching that base tree from GitHub on
-- every diff view would hammer the shared GitHub rate-limiter, especially since
-- a whole class submitting against the same upstream PR shares the SAME
-- (upstream_repo, base_sha) commit.
--
-- The base tree at a given (upstream_repo, base_sha) is a specific immutable git
-- commit. So this cache is CONTENT-ADDRESSED and WRITE-ONCE: a row is fetched
-- exactly once per (upstream_repo, base_sha) ever, then served from Postgres.
-- It is never invalidated (the keyed commit can't change) and never updated
-- (the get-pr-base-files edge function upserts ON CONFLICT DO NOTHING).
--
-- `files` holds only TEXT files ({ "stripped/path": "contents", ... }); binaries
-- are skipped because the diff is text-only (matching the head snapshot side).
-- ============================================================================

CREATE TABLE public.pr_base_tree_cache (
  upstream_repo text NOT NULL,
  base_sha text NOT NULL,
  files jsonb NOT NULL,          -- { "path": "contents", ... } for text files only
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upstream_repo, base_sha)
);

COMMENT ON TABLE public.pr_base_tree_cache IS
  'Immutable, content-addressed cache of the upstream base tree (text files) at a given (upstream_repo, base_sha), used to render PR base->head diffs without re-cloning. Write-once, never invalidated. Service-role only.';
COMMENT ON COLUMN public.pr_base_tree_cache.files IS
  'Text files at the base commit as { "stripped/path": "contents" }. Binaries are omitted (diff is text-only).';

-- Service-role only: the get-pr-base-files edge function reads/writes this table
-- server-side after authorizing the caller. There is intentionally NO client
-- policy, so anon/authenticated clients can't read another class's upstream
-- source by guessing (upstream_repo, base_sha). REVOKE the Supabase blanket
-- grants as defense in depth on top of "RLS enabled + no policy".
ALTER TABLE public.pr_base_tree_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.pr_base_tree_cache FROM anon, authenticated;
GRANT ALL ON TABLE public.pr_base_tree_cache TO service_role;
