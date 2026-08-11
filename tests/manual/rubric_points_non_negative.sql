-- Proof harness for 20260811130300_rubric_points_non_negative.sql.
--
-- Run from the repo root against local Supabase; everything happens in one transaction that ends in
-- ROLLBACK, so it leaves no fixtures behind and the shared dev DB is untouched:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f tests/manual/rubric_points_non_negative.sql
--
-- ON_ERROR_STOP is deliberately OFF and each scenario is wrapped in a SAVEPOINT: the point of most of
-- them is the error message, so the script has to survive them and keep going.
--
-- Scenarios:
--   0. count pre-existing violations, so the NOT VALID choice can be re-checked on any database
--   1. UPDATE rubric_checks.points negative                    -> 23514
--   2. UPDATE rubric_criteria.total_points negative            -> 23514
--   3. INSERT rubric_checks with negative points               -> 23514
--   4. zero points, fractional points, and a deduction-only criterion holding a POSITIVE deduction
--      -> all still accepted
--   5. update_rubric_full with a negative check points         -> error naming the check and criterion
--   6. update_rubric_full with a negative total_points         -> error naming the criterion and part
--   7. update_rubric_full on a valid deduction-only + zero-points rubric -> saves, points round-trip
--   8. the bare 23514 that scenarios 5-7 exist to avoid, for comparison
--
-- Scenarios 5-7 run as `authenticated` with an instructor's uid in request.jwt.claims, since
-- update_rubric_full gates on authorizeforclassinstructor. The uid/class/assignment ids below come
-- from `npm run seed` fixtures (Demo Class); adjust them for a differently-seeded database.
\set ON_ERROR_STOP off
\timing off
BEGIN;

\echo '=== 0. pre-existing violations in this database ==='
SELECT count(*) AS negative_rubric_checks_points FROM public.rubric_checks WHERE points < 0;
SELECT count(*) AS negative_rubric_criteria_total_points FROM public.rubric_criteria WHERE total_points < 0;

\echo '=== applying migration ==='
\i supabase/migrations/20260811130300_rubric_points_non_negative.sql

SELECT conname, convalidated, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conname IN ('chk_rubric_checks_points_non_negative', 'chk_rubric_criteria_total_points_non_negative')
ORDER BY conname;

\echo ''
\echo '=== 1. UPDATE rubric_checks.points to a negative value: expect 23514 ==='
SAVEPOINT s;
UPDATE public.rubric_checks SET points = -5 WHERE id = (SELECT min(id) FROM public.rubric_checks);
ROLLBACK TO SAVEPOINT s;

\echo ''
\echo '=== 2. UPDATE rubric_criteria.total_points to a negative value: expect 23514 ==='
SAVEPOINT s;
UPDATE public.rubric_criteria SET total_points = -20 WHERE id = (SELECT min(id) FROM public.rubric_criteria);
ROLLBACK TO SAVEPOINT s;

\echo ''
\echo '=== 3. INSERT a rubric_check with negative points: expect 23514 ==='
SAVEPOINT s;
INSERT INTO public.rubric_checks (rubric_criteria_id, name, ordinal, is_annotation, points, class_id, assignment_id, rubric_id)
SELECT c.id, 'negative check', 99, false, -1, c.class_id, c.assignment_id, c.rubric_id
FROM public.rubric_criteria c WHERE c.id = 2;
ROLLBACK TO SAVEPOINT s;

\echo ''
\echo '=== 4. zero, fractional, and deduction-only-with-positive-deductions are still accepted ==='
SAVEPOINT s;
UPDATE public.rubric_criteria
SET is_additive = false, is_deduction_only = true, total_points = 15
WHERE id = 2;
INSERT INTO public.rubric_checks (rubric_criteria_id, name, ordinal, is_annotation, points, class_id, assignment_id, rubric_id)
SELECT c.id, 'zero-point check', 98, false, 0, c.class_id, c.assignment_id, c.rubric_id
FROM public.rubric_criteria c WHERE c.id = 2
RETURNING id, name, points;
INSERT INTO public.rubric_checks (rubric_criteria_id, name, ordinal, is_annotation, points, class_id, assignment_id, rubric_id)
SELECT c.id, 'deduction of 2.5 stored positive', 97, false, 2.5, c.class_id, c.assignment_id, c.rubric_id
FROM public.rubric_criteria c WHERE c.id = 2
RETURNING id, name, points;
SELECT id, total_points, is_additive, is_deduction_only FROM public.rubric_criteria WHERE id = 2;
ROLLBACK TO SAVEPOINT s;

\echo ''
\echo '=== 5. update_rubric_full: negative check points => named error, not a bare 23514 ==='
SAVEPOINT s;
SET LOCAL role TO authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT public.update_rubric_full(
  jsonb_build_object(
    'id', 1,
    'class_id', 1,
    'assignment_id', 1,
    'review_round', 'grading-review',
    'name', 'Grading Rubric',
    'parts', jsonb_build_array(jsonb_build_object(
      'name', 'Part A',
      'criteria', jsonb_build_array(jsonb_build_object(
        'name', 'Style',
        'total_points', 20,
        'is_deduction_only', true,
        'checks', jsonb_build_array(jsonb_build_object('name', 'Bad naming', 'points', -3))
      ))
    ))
  )
);
ROLLBACK TO SAVEPOINT s;

\echo ''
\echo '=== 6. update_rubric_full: negative criterion total_points => named error ==='
SAVEPOINT s;
SET LOCAL role TO authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT public.update_rubric_full(
  jsonb_build_object(
    'id', 1,
    'class_id', 1,
    'assignment_id', 1,
    'review_round', 'grading-review',
    'name', 'Grading Rubric',
    'parts', jsonb_build_array(jsonb_build_object(
      'name', 'Part A',
      'criteria', jsonb_build_array(jsonb_build_object(
        'name', 'Style',
        'total_points', -20,
        'checks', jsonb_build_array(jsonb_build_object('name', 'Bad naming', 'points', 3))
      ))
    ))
  )
);
ROLLBACK TO SAVEPOINT s;

\echo ''
\echo '=== 7. update_rubric_full: valid deduction-only + zero-point rubric still saves ==='
SAVEPOINT s;
SET LOCAL role TO authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT public.update_rubric_full(
  jsonb_build_object(
    'id', 1,
    'class_id', 1,
    'assignment_id', 1,
    'review_round', 'grading-review',
    'name', 'Grading Rubric',
    'parts', jsonb_build_array(jsonb_build_object(
      'name', 'Part A',
      'criteria', jsonb_build_array(
        jsonb_build_object(
          'name', 'Style deductions',
          'total_points', 20,
          'is_deduction_only', true,
          'checks', jsonb_build_array(
            jsonb_build_object('name', 'Bad naming', 'points', 3),
            jsonb_build_object('name', 'Informational only', 'points', 0)
          )
        ),
        jsonb_build_object(
          'name', 'Zero-weight criterion',
          'total_points', 0,
          'checks', jsonb_build_array(jsonb_build_object('name', 'Note', 'points', 0))
        )
      )
    ))
  )
) AS summary;
SELECT c.name, c.total_points, c.is_deduction_only, ch.name AS check_name, ch.points
FROM public.rubric_criteria c JOIN public.rubric_checks ch ON ch.rubric_criteria_id = c.id
WHERE c.rubric_id = 1 ORDER BY c.name, ch.name;
ROLLBACK TO SAVEPOINT s;

\echo ''
\echo '=== 8. for comparison: the bare violation scenarios 5-7 exist to avoid ==='
SAVEPOINT s;
UPDATE public.rubric_checks SET points = -1 WHERE id = (SELECT min(id) FROM public.rubric_checks);
ROLLBACK TO SAVEPOINT s;

ROLLBACK;
\echo '=== rolled back ==='
