-- Proof harness for 20260811130200_gradebook_batch_returns_version.sql.
--
-- Run from the repo root against local Supabase; everything happens in one transaction that ends in
-- ROLLBACK, so it leaves no fixtures behind:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/gradebook_batch_version_guard.sql
--
-- It proves three things:
--   1. update_gradebook_rows_batch now returns expected_version and current_version per row.
--   2. The version-scoped clear releases a claim nobody else took (positive control).
--   3. The version-scoped clear does NOT release a claim a second worker took in the meantime --
--      which the old primary-key-only clear did, shown as a contrast at the end.
\set ON_ERROR_STOP on
\timing off

BEGIN;

\echo '=== applying migration ==='
\i supabase/migrations/20260811130200_gradebook_batch_returns_version.sql

\echo ''
\echo '=== DLQ queue exists ==='
SELECT to_regclass('pgmq.q_gradebook_row_recalculate_dlq') AS dlq_table,
       has_table_privilege('service_role', 'pgmq.q_gradebook_row_recalculate_dlq', 'INSERT') AS service_role_can_insert;

\echo ''
\echo '=== function posture preserved (should be jsonb / plpgsql / definer / search_path+timeout / service_role only) ==='
SELECT p.prorettype::regtype AS returns,
       l.lanname AS language,
       p.prosecdef AS security_definer,
       p.provolatile AS volatility,
       p.proconfig,
       pg_catalog.array_to_string(p.proacl, E'\n') AS acl
FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
WHERE p.oid = 'public.update_gradebook_rows_batch(jsonb[])'::regprocedure;

-- Minimal fixture: a class + gradebook + one recalc-state row per "student".
-- gradebook_row_recalc_state has no FKs enforced against profiles for these ids in a way that
-- blocks synthetic uuids, so the two-worker proof only needs this one table.
CREATE TEMP TABLE t_ids (student_id uuid);
INSERT INTO t_ids VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

INSERT INTO public.gradebook_row_recalc_state
  (class_id, gradebook_id, student_id, is_private, dirty, is_recalculating, version)
SELECT -991, -992, student_id, true, true, true, 7 FROM t_ids;

\echo ''
\echo '=== RPC returns expected_version + current_version (student 1 matches at v7, student 2 is stale at v5) ==='
SELECT jsonb_pretty(
  jsonb_agg(r ORDER BY r->>'student_id')
) AS results
FROM jsonb_array_elements(
  (public.update_gradebook_rows_batch(ARRAY[
    jsonb_build_object(
      'class_id', -991, 'gradebook_id', -992,
      'student_id', '11111111-1111-1111-1111-111111111111',
      'is_private', true, 'expected_version', 7,
      'message_ids', '[]'::jsonb, 'updates', '[]'::jsonb
    ),
    jsonb_build_object(
      'class_id', -991, 'gradebook_id', -992,
      'student_id', '22222222-2222-2222-2222-222222222222',
      'is_private', true, 'expected_version', 5,
      'message_ids', '[]'::jsonb, 'updates', '[]'::jsonb
    )
  ]))->'results'
) AS r;

\echo ''
\echo '=== state after the RPC (student 1 cleared, student 2 untouched and still claimed) ==='
SELECT student_id, dirty, is_recalculating, version FROM public.gradebook_row_recalc_state
WHERE class_id = -991 ORDER BY student_id;

\echo ''
\echo '======================================================================'
\echo '=== POSITIVE CONTROL: nobody re-claims, so the guarded clear DOES release'
\echo '======================================================================'
-- Student 2 lost the version race; the RPC handed worker A current_version = 7.
\echo '--- worker A guarded clear at the current_version the RPC returned (7) ---'
WITH guarded AS (
  UPDATE public.gradebook_row_recalc_state
  SET is_recalculating = false
  WHERE class_id = -991 AND gradebook_id = -992
    AND student_id = '22222222-2222-2222-2222-222222222222' AND is_private = true
    AND version = 7
  RETURNING 1
)
SELECT count(*) AS rows_released FROM guarded;

SELECT student_id, dirty, is_recalculating, version FROM public.gradebook_row_recalc_state
WHERE class_id = -991 AND student_id = '22222222-2222-2222-2222-222222222222';

-- Put the claim back so the negative test starts from the same place.
UPDATE public.gradebook_row_recalc_state SET is_recalculating = true
WHERE class_id = -991 AND student_id = '22222222-2222-2222-2222-222222222222';

\echo ''
\echo '======================================================================'
\echo '=== TWO-WORKER PROOF: A observed v7, B re-claims to v8, A must NOT release B'
\echo '======================================================================'

\echo '--- before: student 2 at version 7, worker A holds the claim ---'
SELECT student_id, dirty, is_recalculating, version FROM public.gradebook_row_recalc_state
WHERE class_id = -991 AND student_id = '22222222-2222-2222-2222-222222222222';

-- Worker B re-claims the row: bumps the version and takes the is_recalculating claim, exactly as
-- enqueue_gradebook_row_recalculation's idle branch does.
UPDATE public.gradebook_row_recalc_state
SET version = version + 1, dirty = true, is_recalculating = true
WHERE class_id = -991 AND gradebook_id = -992
  AND student_id = '22222222-2222-2222-2222-222222222222' AND is_private = true;

\echo '--- worker B re-claimed it, version is now 8 ---'
SELECT student_id, dirty, is_recalculating, version FROM public.gradebook_row_recalc_state
WHERE class_id = -991 AND student_id = '22222222-2222-2222-2222-222222222222';

-- Worker A now issues its clear, scoped to the current_version = 7 the RPC gave it.
\echo '--- worker A guarded clear (version = 7): expect ZERO rows released ---'
WITH guarded AS (
  UPDATE public.gradebook_row_recalc_state
  SET is_recalculating = false
  WHERE class_id = -991 AND gradebook_id = -992
    AND student_id = '22222222-2222-2222-2222-222222222222' AND is_private = true
    AND version = 7
  RETURNING 1
)
SELECT count(*) AS rows_released_by_guarded_clear FROM guarded;

\echo '--- after guarded clear: B still holds the claim (is_recalculating must be t at version 8) ---'
SELECT student_id, dirty, is_recalculating, version FROM public.gradebook_row_recalc_state
WHERE class_id = -991 AND student_id = '22222222-2222-2222-2222-222222222222';

-- Contrast: the OLD unguarded clear (primary key only) stomps B.
\echo '--- contrast: the OLD unguarded clear releases B''s claim (this is the bug) ---'
WITH unguarded AS (
  UPDATE public.gradebook_row_recalc_state
  SET is_recalculating = false
  WHERE class_id = -991 AND gradebook_id = -992
    AND student_id = '22222222-2222-2222-2222-222222222222' AND is_private = true
  RETURNING 1
)
SELECT count(*) AS rows_released_by_unguarded_clear FROM unguarded;

SELECT student_id, dirty, is_recalculating, version FROM public.gradebook_row_recalc_state
WHERE class_id = -991 AND student_id = '22222222-2222-2222-2222-222222222222';

\echo ''
\echo '=== DLQ round trip: a given-up row is a durable, inspectable message ==='
SELECT pgmq.send('gradebook_row_recalculate_dlq', jsonb_build_object(
  'class_id', -991, 'gradebook_id', -992,
  'student_id', '22222222-2222-2222-2222-222222222222', 'is_private', true,
  'version_mismatch_attempt', 8, 'expected_version', 5, 'current_version', 7,
  'reason', 'version_mismatch_retry_ceiling'
)) AS dlq_msg_id;

SELECT message->>'student_id' AS student_id,
       message->>'version_mismatch_attempt' AS attempt,
       message->>'reason' AS reason
FROM pgmq.q_gradebook_row_recalculate_dlq;

ROLLBACK;

\echo ''
\echo '=== ROLLED BACK: no rows and no function change persisted ==='
SELECT count(*) AS leftover_state_rows FROM public.gradebook_row_recalc_state WHERE class_id = -991;
SELECT to_regclass('pgmq.q_gradebook_row_recalculate_dlq') AS dlq_table_after_rollback;
