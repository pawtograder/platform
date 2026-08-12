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
--   2. class has no discord_roles row                                -> queued 0, roles_repaired 2
--      (one per enrolled role type), create_role enqueued, student NOT throttled
--   3. role exists                                                   -> queued 1, add_member_role
--      enqueued with the right role_id
--   4. immediate repeat                                              -> queued 0 (throttled)
--   5. a student retrying themselves                                 -> allowed
--   6. a student retrying the whole class                            -> access denied
--   7. class with no discord_server_id                               -> queued 0, no error
--   8. three presses while class roles are missing                   -> one create_role each, not three
--   9. a user who unlinks Discord                                    -> drops out of the instructor read
--  10. everyone in_guild but a class role missing            -> repair still runs
--  11. an `admin` enrollment                                 -> never enqueued as a Discord role
--  12. a caller naming their own id for a class they are not in -> access denied, nothing enqueued
--  13. a linked user with no status row at all              -> included in a class-wide retry
--  14. relinking a different Discord account                -> the stale observation is cleared
--  15. an in-flight write from the superseded account       -> discarded, current account still accepted
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

-- Setting discord_server_id above fires the class-connect trigger, which enqueues create_role for
-- all three role types plus two create_channel messages. Cleared so that scenario 2 measures what
-- request_discord_reinvite() enqueues rather than what connecting the server already did -- the
-- function now declines to duplicate an outstanding create_role, which is scenario 8.
DELETE FROM pgmq.q_discord_async_calls WHERE (message ->> 'class_id')::bigint = 1;

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
\echo '=== 2. no discord_roles row (expect: queued 0, roles_repaired 2) ==='
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'instructor', 'role', 'authenticated')::text, true) \gset
SELECT * FROM public.request_discord_reinvite(1, NULL);
RESET ROLE;

\echo '-- create_role enqueued per enrolled role type (expect: instructor, student) --'
SELECT DISTINCT message ->> 'role_type' AS role_type
FROM pgmq.q_discord_async_calls
WHERE message ->> 'method' = 'create_role'
ORDER BY 1;

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

-- ---------------------------------------------------------------------------
-- 8. Repeated presses must not queue duplicate role creations.
--
-- Users are deliberately left un-stamped on the missing-role path, so nothing throttles a second
-- press while the worker is still working. create_role is not idempotent at the Discord end -- it
-- creates the role and only then inserts the row, and discord_roles allows one row per
-- (class_id, role_type) -- so a duplicate leaves an untracked role in the guild forever.
--
-- The queue is cleared first because connecting a Discord server to a class already enqueues
-- create_role for all three role types plus two create_channel messages. Without clearing, the
-- function's correct decision to defer to those is indistinguishable from it doing nothing.
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 8. repeated presses do not duplicate create_role ==='
UPDATE public.classes SET discord_server_id = 'guild-test-1' WHERE id = 1;
DELETE FROM public.discord_roles WHERE class_id = 1;
DELETE FROM pgmq.q_discord_async_calls WHERE (message ->> 'class_id')::bigint = 1;
UPDATE public.discord_membership_status SET last_retry_requested_at = NULL WHERE class_id = 1;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'instructor', 'role', 'authenticated')::text, true) \gset
\echo '-- press 1 (expect: roles_repaired 2) --'
SELECT * FROM public.request_discord_reinvite(1, NULL);
\echo '-- presses 2 and 3 (expect: roles_repaired 0) --'
SELECT * FROM public.request_discord_reinvite(1, NULL);
SELECT * FROM public.request_discord_reinvite(1, NULL);
RESET ROLE;

\echo '-- create_role messages on the queue (expect: 2, one per role type) --'
SELECT count(*) AS create_role_msgs
FROM pgmq.q_discord_async_calls
WHERE message ->> 'method' = 'create_role' AND (message ->> 'class_id')::bigint = 1;

-- ---------------------------------------------------------------------------
-- 9. A user who unlinks Discord drops out of the instructor read.
--
-- get_discord_role_sync_candidates() requires discord_id IS NOT NULL, so an unlinked user's last
-- recorded state can never be refreshed or cleared, and nothing deletes the row. Without the same
-- filter on the read, the alerts kept naming them as having an invite waiting on the same page where
-- the roster column read "Not linked" from users.discord_id.
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 9. unlinking Discord removes the row from the instructor read ==='
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'instructor', 'role', 'authenticated')::text, true) \gset
\echo '-- while linked (expect: 1) --'
SELECT count(*) AS rows_while_linked FROM public.get_discord_membership_status_for_class(1);
RESET ROLE;

UPDATE public.users SET discord_id = NULL WHERE user_id = :'student';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'instructor', 'role', 'authenticated')::text, true) \gset
\echo '-- after unlinking (expect: 0) --'
SELECT count(*) AS rows_after_unlink FROM public.get_discord_membership_status_for_class(1);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- 10. Role repair runs even when nobody needs a membership retry.
--
-- The repair used to be derived from the membership-retry loop, so a class whose role creation
-- failed but whose students had all since joined produced no candidates, no repair, and no way to
-- ever create the role. The batch worker records in_guild even when enqueue_discord_role_sync
-- silently finds no role, so nothing anywhere reported it.
--
-- 11. `admin` is never enqueued as a Discord role type.
--
-- app_role has four values but discord_roles_role_type_check accepts three. Enqueueing admin would
-- have Discord create a role the insert then refuses to track: an orphan in the guild, re-created
-- on every retry.
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 10 + 11. repair with everyone in_guild, and admin excluded ==='
UPDATE public.classes SET discord_server_id = 'guild-test-1' WHERE id = 1;
UPDATE public.users SET discord_id = 'discord-test-student' WHERE user_id = :'student';
DELETE FROM public.discord_roles WHERE class_id = 1;
DELETE FROM pgmq.q_discord_async_calls WHERE (message ->> 'class_id')::bigint = 1;
UPDATE public.discord_membership_status SET state = 'in_guild', last_retry_requested_at = NULL WHERE class_id = 1;

-- Promote one student enrollment to admin so the class carries an unsupported role type.
UPDATE public.user_roles
SET role = 'admin'
WHERE id = (SELECT id FROM public.user_roles WHERE class_id = 1 AND role = 'student' AND disabled = false LIMIT 1);

\echo '-- role types enrolled in the class --'
SELECT DISTINCT role FROM public.user_roles WHERE class_id = 1 AND disabled = false ORDER BY 1;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'instructor', 'role', 'authenticated')::text, true) \gset
\echo '-- expect: queued 0 (nobody is stuck), roles_repaired 2 (not 3 -- admin excluded) --'
SELECT * FROM public.request_discord_reinvite(1, NULL);
RESET ROLE;

\echo '-- create_role role types enqueued (expect: instructor, student; never admin) --'
SELECT DISTINCT message ->> 'role_type' AS role_type
FROM pgmq.q_discord_async_calls
WHERE message ->> 'method' = 'create_role' AND (message ->> 'class_id')::bigint = 1
ORDER BY 1;

-- ---------------------------------------------------------------------------
-- 13. A linked user the sync has never reached is included in a class-wide retry.
--
-- The predicate used to require a discord_membership_status row, which excluded exactly the students
-- nothing had checked yet. For a class outside the active-class window that is permanent -- the
-- hourly batch will never create the row -- so the settings page reported nothing to queue for the
-- users most in need of it.
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 13. a linked user with no status row is retried ==='
UPDATE public.classes SET discord_server_id = 'guild-test-1' WHERE id = 1;
DELETE FROM public.discord_membership_status WHERE class_id = 1;
DELETE FROM public.discord_roles WHERE class_id = 1;
INSERT INTO public.discord_roles (class_id, role_type, discord_role_id) VALUES (1, 'student', 'role-test-student');
UPDATE public.users SET discord_id = 'discord-test-student' WHERE user_id = :'student';
-- Scenario 11 promoted this enrollment to admin to prove admin is excluded from repair. Put it
-- back, or the retry below skips the user for having no Discord role rather than for the reason
-- under test.
UPDATE public.user_roles SET role = 'student' WHERE class_id = 1 AND user_id = :'student';

\echo '-- status rows for the class (expect: 0) --'
SELECT count(*) AS status_rows FROM public.discord_membership_status WHERE class_id = 1;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'instructor', 'role', 'authenticated')::text, true) \gset
\echo '-- expect: queued 1, for a user with no recorded state at all --'
SELECT * FROM public.request_discord_reinvite(1, NULL);
RESET ROLE;

\echo '-- and a row now exists so the throttle applies to them too (expect: t) --'
SELECT last_retry_requested_at IS NOT NULL AS stamped
FROM public.discord_membership_status
WHERE class_id = 1 AND user_id = :'student';

-- ---------------------------------------------------------------------------
-- 14. Relinking a different Discord account forgets what was observed for the old one.
--
-- The status row records the Pawtograder user and the guild, not which Discord account was checked,
-- and the instructor read only hides rows while discord_id is null. So unlinking an account recorded
-- as in_guild and linking a different one brought the old row back, and a class-wide retry then
-- skipped that user as already in the server -- permanently, for a class outside the active window.
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 14. relinking a different account clears the stale observation ==='
UPDATE public.classes SET discord_server_id = 'guild-test-1' WHERE id = 1;
DELETE FROM public.discord_membership_status WHERE class_id = 1;
UPDATE public.users SET discord_id = 'acct-A' WHERE user_id = :'student';
INSERT INTO public.discord_membership_status (class_id, user_id, guild_id, state)
VALUES (1, :'student', 'guild-test-1', 'in_guild');

\echo '-- recorded in_guild for the first account (expect: 1) --'
SELECT count(*) AS rows_for_first_account FROM public.discord_membership_status WHERE user_id = :'student';

UPDATE public.users SET discord_id = NULL WHERE user_id = :'student';
UPDATE public.users SET discord_id = 'acct-B' WHERE user_id = :'student';

\echo '-- after unlink and relink of a different account (expect: 0) --'
SELECT count(*) AS rows_after_relink FROM public.discord_membership_status WHERE user_id = :'student';

-- 15. And the ordering window the trigger alone does not close: a worker that read the old account
-- before the relink, and records its result afterwards, would recreate a row describing an account
-- nobody uses -- an in_guild there excludes the new account from class-wide retries indefinitely.
\echo '-- an in-flight write from the superseded account is discarded (expect: 0) --'
SELECT public.record_discord_membership_status(1, :'student', 'guild-test-1', 'in_guild', 'acct-A');
SELECT count(*) AS rows_after_stale_write FROM public.discord_membership_status WHERE user_id = :'student';

\echo '-- while a write observed against the current account is accepted (expect: 1, acct-B) --'
SELECT public.record_discord_membership_status(1, :'student', 'guild-test-1', 'not_joined', 'acct-B');
SELECT count(*) AS rows_after_current_write, max(observed_discord_id) AS observed
FROM public.discord_membership_status WHERE user_id = :'student';

-- ---------------------------------------------------------------------------
-- 12. Naming your own id does not give you a claim on someone else's class.
--
-- The staff check is `authorizeforclassgrader(p_class_id)`, and a non-staff caller is allowed
-- through when p_user_id is their own id. That alone said nothing about the class: the membership
-- loop found no enrollment and returned queued 0, but the role-repair phase scans the class
-- independently of that loop, so any authenticated user who knew a class id could enqueue
-- create_role against a Discord server they had nothing to do with. Two boundaries now: an active
-- enrollment is required, and repair is staff-only.
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 12. an outsider cannot reach another class (expect: access denied, 0 messages) ==='
INSERT INTO public.classes (name, slug, discord_server_id, time_zone)
VALUES ('Reinvite harness target', 'reinvite-harness-target', 'guild-harness-victim', 'America/New_York')
RETURNING id AS victimclass \gset

INSERT INTO public.profiles (name, class_id, is_private_profile) VALUES ('harness-priv', :victimclass, true) RETURNING id AS vpriv \gset
INSERT INTO public.profiles (name, class_id, is_private_profile) VALUES ('harness-pub', :victimclass, false) RETURNING id AS vpub \gset
INSERT INTO public.user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
VALUES (:'student', :victimclass, 'student', :'vpriv', :'vpub');

DELETE FROM pgmq.q_discord_async_calls WHERE (message ->> 'class_id')::bigint = :victimclass;
SELECT set_config('test.victim_class', :victimclass::text, true);

-- The instructor of class 1, who holds no role at all in the class created just above.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'instructor', 'role', 'authenticated')::text, true) \gset
DO $$
BEGIN
  PERFORM public.request_discord_reinvite(current_setting('test.victim_class')::bigint, auth.uid());
  RAISE NOTICE 'FAIL: an unenrolled caller reached another class';
EXCEPTION
  WHEN OTHERS THEN RAISE NOTICE 'PASS: %', SQLERRM;
END $$;
RESET ROLE;

\echo '-- create_role enqueued against the other class (expect: 0) --'
SELECT count(*) AS create_role_msgs
FROM pgmq.q_discord_async_calls
WHERE message ->> 'method' = 'create_role' AND (message ->> 'class_id')::bigint = current_setting('test.victim_class')::bigint;

ROLLBACK;
