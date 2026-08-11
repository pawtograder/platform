-- Proof harness for 20260811210000_discord_membership_reinvite.sql.
--
-- Run from the repo root against local Supabase; everything happens in one transaction that ends in
-- ROLLBACK, so it leaves no fixtures behind and the shared dev DB is untouched:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f tests/manual/discord_membership_reinvite.sql
--
-- ON_ERROR_STOP is deliberately OFF and the authorization scenarios are wrapped in DO blocks: the
-- point of those is the error, so the script has to survive them and keep going.
--
-- Scenarios:
--   1. anon cannot execute the SECURITY DEFINER function at all      -> permission denied
--   2. class has no discord_roles row                                -> queued 0, roles_repaired 1,
--      a create_role is enqueued, and the student is NOT throttled
--   3. role exists                                                   -> queued 1, add_member_role
--      enqueued with the right role_id
--   4. immediate repeat                                              -> queued 0 (throttled)
--   5. a student retrying themselves                                 -> allowed
--   6. a student retrying the whole class                            -> access denied
--   7. class with no discord_server_id                               -> queued 0, no error
--
-- Scenario 2 is the one worth keeping: enqueue_discord_role_sync() returns silently when the class
-- has no discord_roles row for the user's role type, so a version of this function that counted every
-- candidate would report "queued N" while enqueueing nothing at all -- permanently, for exactly the
-- classes whose role creation had failed. The ids below come from `npm run seed` fixtures (Demo
-- Class); adjust them for a differently-seeded database.

\set ON_ERROR_STOP off
\timing off

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
UPDATE public.classes SET discord_server_id = 'guild-test-1' WHERE id = 1;

SELECT ur.user_id AS instructor
FROM public.user_roles ur
WHERE ur.class_id = 1 AND ur.role = 'instructor' AND ur.disabled = false
LIMIT 1 \gset

SELECT ur.user_id AS student
FROM public.user_roles ur
WHERE ur.class_id = 1 AND ur.role = 'student' AND ur.disabled = false
LIMIT 1 \gset

UPDATE public.users SET discord_id = 'discord-test-student' WHERE user_id = :'student';

-- Stashed as a GUC so the DO block in scenario 6 can reach it; psql's :'student' does not
-- interpolate inside a dollar-quoted body.
SELECT set_config('test.student', :'student', true);

INSERT INTO public.discord_membership_status (class_id, user_id, guild_id, state, discord_error_code, detail)
VALUES (1, :'student', 'guild-test-1', 'cannot_invite', 50001, 'Missing Access');

\echo ''
\echo '=== 1. anon is denied (expect: permission denied) ==='
DO $$
BEGIN
  SET LOCAL ROLE anon;
  PERFORM public.request_discord_reinvite(1, NULL);
  RAISE NOTICE 'FAIL: anon executed the function';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: %', SQLERRM;
  WHEN OTHERS THEN RAISE NOTICE 'FAIL: unexpected % / %', SQLSTATE, SQLERRM;
END $$;
RESET ROLE;

\echo ''
\echo '=== 2. no discord_roles row (expect: queued 0, roles_repaired 1) ==='
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'instructor', 'role', 'authenticated')::text, true) \gset
SELECT * FROM public.request_discord_reinvite(1, NULL);
RESET ROLE;

\echo '-- a create_role was enqueued for the missing role type (expect: create_role / student) --'
SELECT message ->> 'method' AS method, message ->> 'role_type' AS role_type
FROM pgmq.q_discord_async_calls
ORDER BY msg_id DESC
LIMIT 1;

\echo '-- and the student was NOT stamped, so the next press is not throttled (expect: t) --'
SELECT last_retry_requested_at IS NULL AS not_throttled
FROM public.discord_membership_status
WHERE class_id = 1 AND user_id = :'student';

\echo ''
\echo '=== 3. role exists (expect: queued 1, roles_repaired 0) ==='
INSERT INTO public.discord_roles (class_id, role_type, discord_role_id)
VALUES (1, 'student', 'role-test-student');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'instructor', 'role', 'authenticated')::text, true) \gset
SELECT * FROM public.request_discord_reinvite(1, NULL);

\echo ''
\echo '=== 4. immediate repeat is throttled (expect: queued 0) ==='
SELECT * FROM public.request_discord_reinvite(1, NULL);
RESET ROLE;

\echo '-- the enqueued message names the class role (expect: add_member_role / role-test-student) --'
SELECT message ->> 'method' AS method, message -> 'args' ->> 'role_id' AS role_id
FROM pgmq.q_discord_async_calls
ORDER BY msg_id DESC
LIMIT 1;

\echo ''
\echo '=== 5. a student may retry themselves (expect: queued 1) ==='
UPDATE public.discord_membership_status SET last_retry_requested_at = NULL WHERE class_id = 1;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'student', 'role', 'authenticated')::text, true) \gset
SELECT * FROM public.request_discord_reinvite(1, :'student');
RESET ROLE;

\echo ''
\echo '=== 6. a student may not retry the whole class (expect: access denied) ==='
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', current_setting('test.student'), 'role', 'authenticated')::text, true);
  PERFORM public.request_discord_reinvite(1, NULL);
  RAISE NOTICE 'FAIL: a student ran a class-wide retry';
EXCEPTION
  WHEN OTHERS THEN RAISE NOTICE 'PASS: %', SQLERRM;
END $$;
RESET ROLE;

\echo ''
\echo '=== 7. class with no Discord server (expect: queued 0, no error) ==='
UPDATE public.classes SET discord_server_id = NULL WHERE id = 1;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'instructor', 'role', 'authenticated')::text, true) \gset
SELECT * FROM public.request_discord_reinvite(1, NULL);
RESET ROLE;

ROLLBACK;
