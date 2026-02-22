-- Make check_run_id nullable - we no longer create GitHub check runs,
-- but the repository_check_runs table still tracks push events internally.

-- Drop the old unique constraint (repository_id, check_run_id, sha) since
-- check_run_id will be null. With nullable check_run_id, that constraint
-- would allow duplicate (repo_id, null, sha) rows.
ALTER TABLE repository_check_runs
  DROP CONSTRAINT IF EXISTS repository_check_runs_repository_id_check_run_id_sha_key;

-- Add unique constraint on (repository_id, sha) for idempotency
ALTER TABLE repository_check_runs
  ADD CONSTRAINT repository_check_runs_repository_id_sha_key UNIQUE (repository_id, sha);

ALTER TABLE repository_check_runs
  ALTER COLUMN check_run_id DROP NOT NULL;

ALTER TABLE repository_check_runs
  ALTER COLUMN check_run_id SET DEFAULT NULL;
