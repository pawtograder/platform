-- Proof harness for 20260910010000_park_dead_lettered_repo_creations.sql.
--
-- Run from the repo root against local Supabase; everything happens in one transaction that ends in
-- ROLLBACK, so it leaves no fixtures behind:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/park_dead_lettered_repo_creations.sql
--
-- It proves the two halves of the new park, which pull in opposite directions:
--   1. A repository whose most recently queued create_repo was DEAD-LETTERED is parked with a
--      creation_error, instead of being re-enqueued for the rest of its eight-attempt ladder.
--      This is the CS 4535 case of 2026-09-09: three repos re-enqueued six times over 8.5 hours
--      against a handout that could never be forked.
--   2. A repository whose dead-letter entry PREDATES its last queued attempt is NOT parked --
--      i.e. an instructor has since clicked Retry. Nothing drains the DLQ, so without this the
--      stale entry would park the fresh job before it ever ran, and the repo could never recover.
\set ON_ERROR_STOP on
\timing off

BEGIN;

\echo '=== applying migration ==='
\i supabase/migrations/20260910010000_park_dead_lettered_repo_creations.sql

\echo ''
\echo '=== fixture: an assignment whose repo_mode actually provisions repositories ==='
CREATE TEMP TABLE fx AS
  SELECT a.id AS assignment_id, a.class_id
    FROM public.assignments a
   WHERE a.repo_mode NOT IN ('none', 'no_submission')
   LIMIT 1;
SELECT assignment_id, class_id FROM fx;

-- Case A: the job we last queued is the one that died.
INSERT INTO public.repositories (assignment_id, class_id, repository, is_github_ready,
                                 creation_attempts, last_creation_attempt_at, updated_at)
SELECT assignment_id, class_id, 'test-org/dlq-park-case-a', false, 1,
       now() - interval '60 minutes', now() - interval '60 minutes' FROM fx;

-- Case B: the dead-letter entry is older than the last thing we queued.
INSERT INTO public.repositories (assignment_id, class_id, repository, is_github_ready,
                                 creation_attempts, last_creation_attempt_at, updated_at)
SELECT assignment_id, class_id, 'test-org/dlq-park-case-b', false, 1,
       now() - interval '5 minutes', now() - interval '5 minutes' FROM fx;

\echo ''
\echo '=== fixture: dead-letter entries ==='
SELECT pgmq.send('async_calls_dlq',
  jsonb_build_object('method', 'create_repo', 'repo_id',
    (SELECT id::text FROM public.repositories WHERE repository = 'test-org/dlq-park-case-a')));
SELECT pgmq.send('async_calls_dlq',
  jsonb_build_object('method', 'create_repo', 'repo_id',
    (SELECT id::text FROM public.repositories WHERE repository = 'test-org/dlq-park-case-b')));

-- Backdate B's dead-letter to before its last_creation_attempt_at: the "instructor already
-- retried" shape. pgmq.send always stamps now(), so this is the only way to build it.
UPDATE pgmq.q_async_calls_dlq SET enqueued_at = now() - interval '60 minutes'
 WHERE message->>'repo_id' = (SELECT id::text FROM public.repositories
                               WHERE repository = 'test-org/dlq-park-case-b');

\echo ''
\echo '=== the probe sees both, with the most recent dead-letter time ==='
SELECT rp.repository, d.dead_lettered_at <= now() AS dead_lettered
  FROM public.repo_ids_with_dead_lettered_create() d
  JOIN public.repositories rp ON rp.id::text = d.repo_id
 ORDER BY rp.repository;

\echo ''
\echo '=== run the reconciler ==='
SELECT public.reconcile_stuck_repo_creations(15) AS enqueued;

\echo ''
\echo '=== EXPECT: case-a parked = t, case-b parked = f ==='
SELECT repository,
       (creation_error IS NOT NULL) AS parked,
       left(creation_error, 60) AS reason
  FROM public.repositories
 WHERE repository IN ('test-org/dlq-park-case-a', 'test-org/dlq-park-case-b')
 ORDER BY repository;

-- Assert it, rather than leaving the result to be eyeballed. A harness whose output has to be
-- read by a human passes silently when it regresses, which defeats the point of committing it.
DO $$
DECLARE
  v_total   integer;
  v_parked_a boolean;
  v_parked_b boolean;
BEGIN
  SELECT count(*) INTO v_total
    FROM public.repositories
   WHERE repository IN ('test-org/dlq-park-case-a', 'test-org/dlq-park-case-b');
  IF v_total <> 2 THEN
    RAISE EXCEPTION 'fixture broken: expected 2 test rows, found %', v_total;
  END IF;

  SELECT creation_error IS NOT NULL INTO v_parked_a
    FROM public.repositories WHERE repository = 'test-org/dlq-park-case-a';
  SELECT creation_error IS NOT NULL INTO v_parked_b
    FROM public.repositories WHERE repository = 'test-org/dlq-park-case-b';

  IF NOT v_parked_a THEN
    RAISE EXCEPTION 'case-a NOT parked: a repository whose most recent create_repo was dead-lettered must be parked, not re-enqueued';
  END IF;
  IF v_parked_b THEN
    RAISE EXCEPTION 'case-b WAS parked: a dead-letter predating last_creation_attempt_at means the instructor already retried, and the fresh job must be left alone';
  END IF;

  RAISE NOTICE 'OK: case-a parked, case-b untouched';
END $$;

ROLLBACK;
