-- Proof harness for 20260909120000_sync_gradebook_column_name_on_assignment_rename.sql (#891).
--
-- Run from the repo root against local Supabase; one transaction ending in ROLLBACK, so the shared
-- dev DB is untouched:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f tests/manual/gradebook_column_name_sync.sql
--
-- Scenarios (each SELECT prints pass/fail):
--   1. rename an assignment              -> its gradebook column follows
--   2. rename again after the column was hand-renamed -> column keeps the hand-picked name
--   3. change total_points               -> max_score still follows (the old trigger's job)
--   4. the superseded trigger and function are gone
--
-- Uses the lowest-id assignment that has a gradebook column; needs `npm run seed` fixtures.
\set ON_ERROR_STOP on
\timing off
BEGIN;

\i supabase/migrations/20260909120000_sync_gradebook_column_name_on_assignment_rename.sql

CREATE TEMP TABLE fixture AS
SELECT a.id AS assignment_id, a.gradebook_column_id, a.title, a.total_points
FROM public.assignments a
WHERE a.gradebook_column_id IS NOT NULL
ORDER BY a.id LIMIT 1;

\echo '=== 1. rename assignment -> column follows ==='
UPDATE public.assignments SET title = 'Renamed Once' WHERE id = (SELECT assignment_id FROM fixture);
SELECT CASE WHEN name = 'Renamed Once' THEN 'pass' ELSE 'FAIL: ' || name END AS scenario_1
FROM public.gradebook_columns WHERE id = (SELECT gradebook_column_id FROM fixture);

\echo '=== 2. hand-renamed column is left alone ==='
UPDATE public.gradebook_columns SET name = 'Custom Header' WHERE id = (SELECT gradebook_column_id FROM fixture);
UPDATE public.assignments SET title = 'Renamed Twice' WHERE id = (SELECT assignment_id FROM fixture);
SELECT CASE WHEN name = 'Custom Header' THEN 'pass' ELSE 'FAIL: ' || name END AS scenario_2
FROM public.gradebook_columns WHERE id = (SELECT gradebook_column_id FROM fixture);

\echo '=== 3. total_points still syncs max_score ==='
UPDATE public.assignments SET total_points = 12345 WHERE id = (SELECT assignment_id FROM fixture);
SELECT CASE WHEN max_score = 12345 THEN 'pass' ELSE 'FAIL: ' || max_score END AS scenario_3
FROM public.gradebook_columns WHERE id = (SELECT gradebook_column_id FROM fixture);

\echo '=== 4. old trigger/function removed ==='
SELECT CASE WHEN count(*) = 0 THEN 'pass' ELSE 'FAIL' END AS scenario_4
FROM pg_trigger WHERE tgname = 'update_gradebook_column_max_score_trigger';
SELECT CASE WHEN count(*) = 0 THEN 'pass' ELSE 'FAIL' END AS scenario_4b
FROM pg_proc WHERE proname = 'update_gradebook_column_max_score';

ROLLBACK;
