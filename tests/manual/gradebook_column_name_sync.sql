-- Proof harness for 20261105120000_sync_gradebook_column_name_on_assignment_rename.sql (#891).
--
-- Needs the migration applied (`npx supabase migration up`) and `npm run seed` fixtures. Run from
-- the repo root against local Supabase; one transaction ending in ROLLBACK, so the dev DB is untouched:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f tests/manual/gradebook_column_name_sync.sql
--
-- Scenarios (each check raises on failure, so with ON_ERROR_STOP `psql -f` exits nonzero):
--   1. rename an assignment                      -> its assignments("<slug>") column follows
--   2. hand-renamed header, rename again         -> the header follows the title again
--   3. column whose expression no longer matches -> left alone
--   4. gradebook_column_id unset                 -> the matching column still follows
--   5. change total_points                       -> max_score still follows (the old trigger's job)
--   6. the superseded trigger and function are gone
\set ON_ERROR_STOP on
\timing off
BEGIN;

-- An empty set fails too: bool_and over no rows is NULL.
CREATE FUNCTION pg_temp.expect(label text, ok boolean, detail text DEFAULT '') RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL %: %', label, coalesce(detail, '');
  END IF;
  RETURN 'pass ' || label;
END $$;

CREATE TEMP TABLE fixture AS
SELECT a.id AS assignment_id, gc.id AS column_id, a.slug
FROM public.assignments a
JOIN public.gradebook_columns gc
  ON gc.id = a.gradebook_column_id AND gc.score_expression = 'assignments("' || a.slug || '")'
ORDER BY a.id LIMIT 1;

SELECT pg_temp.expect('fixture', count(*) = 1, 'no seeded assignment column; run npm run seed') FROM fixture;

\echo '=== 1. rename assignment -> column follows ==='
UPDATE public.assignments SET title = 'Renamed Once' WHERE id = (SELECT assignment_id FROM fixture);
SELECT pg_temp.expect('scenario_1', bool_and(name = 'Renamed Once'), string_agg(name, ', '))
FROM public.gradebook_columns WHERE id = (SELECT column_id FROM fixture);

\echo '=== 2. hand-renamed header follows the title again ==='
UPDATE public.gradebook_columns SET name = 'Custom Header' WHERE id = (SELECT column_id FROM fixture);
UPDATE public.assignments SET title = 'Renamed Twice' WHERE id = (SELECT assignment_id FROM fixture);
SELECT pg_temp.expect('scenario_2', bool_and(name = 'Renamed Twice'), string_agg(name, ', '))
FROM public.gradebook_columns WHERE id = (SELECT column_id FROM fixture);

\echo '=== 3. a column with another expression is left alone ==='
UPDATE public.gradebook_columns
SET score_expression = 'assignments("' || (SELECT slug FROM fixture) || '", "code-walk")'
WHERE id = (SELECT column_id FROM fixture);
UPDATE public.assignments SET title = 'Renamed Thrice' WHERE id = (SELECT assignment_id FROM fixture);
SELECT pg_temp.expect('scenario_3', bool_and(name = 'Renamed Twice'), string_agg(name, ', '))
FROM public.gradebook_columns WHERE id = (SELECT column_id FROM fixture);

\echo '=== 4. gradebook_column_id unset -> matching column still follows ==='
UPDATE public.gradebook_columns
SET score_expression = 'assignments("' || (SELECT slug FROM fixture) || '")'
WHERE id = (SELECT column_id FROM fixture);
UPDATE public.assignments SET gradebook_column_id = NULL WHERE id = (SELECT assignment_id FROM fixture);
UPDATE public.assignments SET title = 'Renamed Unlinked' WHERE id = (SELECT assignment_id FROM fixture);
SELECT pg_temp.expect('scenario_4', bool_and(name = 'Renamed Unlinked'), string_agg(name, ', '))
FROM public.gradebook_columns WHERE id = (SELECT column_id FROM fixture);

\echo '=== 5. total_points still syncs max_score ==='
UPDATE public.assignments SET gradebook_column_id = (SELECT column_id FROM fixture)
WHERE id = (SELECT assignment_id FROM fixture);
UPDATE public.assignments SET total_points = 12345 WHERE id = (SELECT assignment_id FROM fixture);
SELECT pg_temp.expect('scenario_5', bool_and(max_score = 12345), string_agg(max_score::text, ', '))
FROM public.gradebook_columns WHERE id = (SELECT column_id FROM fixture);

\echo '=== 6. old trigger/function removed ==='
SELECT pg_temp.expect('scenario_6', count(*) = 0)
FROM pg_trigger WHERE tgname = 'update_gradebook_column_max_score_trigger';
SELECT pg_temp.expect('scenario_6b', count(*) = 0)
FROM pg_proc WHERE proname = 'update_gradebook_column_max_score';

ROLLBACK;
