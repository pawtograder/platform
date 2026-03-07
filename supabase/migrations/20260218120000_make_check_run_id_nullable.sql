-- Make check_run_id nullable - we no longer create GitHub check runs,
-- but the repository_check_runs table still tracks push events internally.

-- Drop the old unique constraint (repository_id, check_run_id, sha) since
-- check_run_id will be null. With nullable check_run_id, that constraint
-- would allow duplicate (repo_id, null, sha) rows.
ALTER TABLE repository_check_runs
  DROP CONSTRAINT IF EXISTS repository_check_runs_repository_id_check_run_id_sha_key;

-- Dedupe: remove duplicate (repository_id, sha) rows before adding unique constraint.
-- Keep the row with smallest id (earliest) per (repository_id, sha).
-- First, update submissions that reference duplicate rows to point to the canonical row.
WITH dups AS (
  SELECT id,
    FIRST_VALUE(id) OVER (PARTITION BY repository_id, sha ORDER BY id ASC) AS canonical_id
  FROM public.repository_check_runs
)
UPDATE public.submissions s
SET repository_check_run_id = d.canonical_id
FROM dups d
WHERE s.repository_check_run_id = d.id
  AND d.id != d.canonical_id;

-- Delete duplicate rows, keeping only the canonical (smallest id) per (repository_id, sha).
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY repository_id, sha ORDER BY id ASC) AS rn
  FROM public.repository_check_runs
)
DELETE FROM public.repository_check_runs
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Add unique constraint on (repository_id, sha) for idempotency
ALTER TABLE repository_check_runs
  ADD CONSTRAINT repository_check_runs_repository_id_sha_key UNIQUE (repository_id, sha);

ALTER TABLE repository_check_runs
  ALTER COLUMN check_run_id DROP NOT NULL;

ALTER TABLE repository_check_runs
  ALTER COLUMN check_run_id SET DEFAULT NULL;
