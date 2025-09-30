-- Migration to add unique constraint on submissions (repository, sha, run_number, run_attempt)
-- This migration will fix any duplicate submissions before adding the constraint
-- by incrementing run_attempt to 100 + run_attempt for older duplicates

-- Step 1: Create a temporary table to store duplicate submissions (excluding the most recent)
-- Include the row_num to ensure each duplicate gets a unique run_attempt
CREATE TEMP TABLE duplicate_submissions AS
WITH ranked_submissions AS (
  SELECT 
    id,
    repository,
    sha,
    run_number,
    run_attempt,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY repository, sha, run_number, run_attempt 
      ORDER BY created_at DESC
    ) AS row_num
  FROM public.submissions
)
SELECT 
  id,
  repository,
  sha,
  run_number,
  run_attempt,
  created_at,
  row_num
FROM ranked_submissions
WHERE row_num > 1;

-- Step 2: Update the duplicate submissions to have run_attempt = (row_num - 1) * 100 + run_attempt
-- This makes them unique since nobody has 100+ run attempts
-- For example: 
--   - 2nd occurrence (row_num=2): run_attempt = 100 + original
--   - 3rd occurrence (row_num=3): run_attempt = 200 + original
UPDATE public.submissions s
SET run_attempt = (ds.row_num - 1) * 100 + ds.run_attempt
FROM duplicate_submissions ds
WHERE s.id = ds.id;

-- Step 3: Add the unique constraint
ALTER TABLE public.submissions
ADD CONSTRAINT submissions_repository_sha_run_unique 
UNIQUE (repository, sha, run_number, run_attempt);
