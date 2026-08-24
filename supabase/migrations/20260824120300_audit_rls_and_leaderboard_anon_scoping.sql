-- Restore the audit log's instructor read, scope the leaderboard read to enrolled users, and drop
-- write grants that no client path uses.
--
-- 1. public.audit has RLS enabled and no policy at all. That combination is default-deny, and
--    default-deny on a SELECT returns zero rows and no error, so nothing anywhere reports a
--    failure. 20251228143943_partitioned_audit_system.sql opened with
--    `ALTER TABLE public.audit RENAME TO audit_legacy`; Postgres policies follow a table through a
--    rename, so the `instructors read` policy (added in 20250410173054_handgrading_rest.sql,
--    rewritten in 20250917002948_optimize-submission-rls.sql) went with audit_legacy and now sits
--    on a table holding zero rows. The replacement partitioned table got
--    ENABLE ROW LEVEL SECURITY and never got a CREATE POLICY. The instructor audit view
--    (app/course/[course_id]/manage/course/audit/page.tsx) has rendered "0 Rows" ever since.
--
-- 2. assignment_leaderboard's SELECT policy leads with `auth.uid() IS NULL`, added in
--    20251221230000_assignment_leaderboard.sql under the comment "Allow anonymous users to view
--    all leaderboard entries" and carried forward verbatim by
--    20260120140000_fix_leaderboard_max_score_zero.sql. The anon key is public in a browser app,
--    so that leg returns every class's leaderboard rows to any unauthenticated caller, with no
--    class scoping. Nothing consumes it: the only reader is the leaderboard component on
--    app/course/[course_id]/assignments/[assignment_id]/page.tsx, which is behind the /course auth
--    redirect and additionally requires a class profile.
--
-- 3. anon holds UPDATE and DELETE on live_poll_responses that no policy allows.
--
-- What this migration deliberately does NOT touch: live_polls_select_live
-- (`TO anon, authenticated USING (is_live = true)`). That anon read is load-bearing for the public
-- QR-join page app/poll/[course_id]/page.tsx, which utils/supabase/middleware.ts leaves
-- unauthenticated (only /course* is redirected) and tests/e2e/polls.test.tsx exercises anonymously.
-- 20260817120000_tighten_survey_and_poll_rls.sql already narrowed it from `USING (true)` and
-- recorded why the remainder stays: a live poll's question is readable by anyone who knows the
-- course id, which is inherent to joining by QR code with no token in the URL.


-- ============================================================================
-- 1. audit: restore the instructor read
-- ============================================================================

-- ON THE PARTITIONED PARENT ONLY. Do not replicate this policy per partition.
--
-- Postgres applies the parent's policies to rows read through the parent, and reading through the
-- parent is the only access path anything uses (PostgREST hits /rest/v1/audit). One policy here
-- therefore covers every partition, present and future, with no maintenance.
--
-- Per-partition copies would be actively harmful. audit_maintain_partitions() creates tomorrow's
-- partition on a nightly cron and drops partitions past the 90-day retention, so a per-partition
-- policy set would have to be re-created every night forever -- and the first night that was
-- missed, reads of the newest partition would silently return zero rows again, which is exactly
-- the failure this migration is fixing. If you are here because audit reads look broken, check
-- for a policy on public.audit, not on public.audit_YYYYMMDD.
--
-- The partitions keep their own RLS-enabled/no-policy state, and that is deliberate rather than an
-- oversight: PostgREST also exposes public.audit_YYYYMMDD directly, and no policy there
-- default-denies that path.
--
-- Predicate form is the IN-subquery rather than authorizeforclassinstructor(class_id). The two are
-- semantically identical, but 20250917002948_optimize-submission-rls.sql established the IN form
-- for large tables because the planner hoists it into a single hashed SubPlan, where the STABLE
-- helper is invoked per candidate row. audit grows by every audited write in every class.
DROP POLICY IF EXISTS "instructors read" ON public.audit;

CREATE POLICY "instructors read"
  ON public.audit
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    class_id IN (
      SELECT up.class_id
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.role = 'instructor'
    )
  );

COMMENT ON TABLE public.audit IS
  'Partitioned audit trail. Read policy lives on this parent table only -- see '
  '20260824120300_audit_rls_and_leaderboard_anon_scoping.sql before adding one to a partition.';

-- Client roles have no reason to write the audit trail. It is written exclusively by
-- audit_statement_trigger(), which is SECURITY DEFINER owned by postgres; postgres also owns
-- public.audit and relforcerowsecurity is false, so that trigger bypasses RLS and uses its own
-- privileges. Revoking here does not affect it.
--
-- TRUNCATE is the one that matters. RLS does not constrain TRUNCATE at all -- it is authorized by
-- grant alone -- so `authenticated` holding TRUNCATE on the audit trail means the no-policy
-- default-deny above was never protecting the rows from deletion, only from being read.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit FROM anon, authenticated;

-- Partitions carry their own grants: CREATE TABLE ... PARTITION OF does not inherit privileges
-- from the parent, and Supabase's default privileges hand each new table full rights on anon and
-- authenticated. Revoke on the ones that exist now.
--
-- This decays: partitions created later by audit_maintain_partitions() will again be granted
-- INSERT/UPDATE/DELETE/TRUNCATE. Their DML is still default-denied by RLS (no policy), so the
-- residual is TRUNCATE on partitions younger than this migration. Closing that durably means
-- adding the same REVOKE to audit_maintain_partitions(); that is a behaviour change to a
-- cron-driven SECURITY DEFINER function and is left as follow-up rather than bundled here.
DO $$
DECLARE
    partition_name text;
BEGIN
    FOR partition_name IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename ~ '^audit_[0-9]{8}$'
    LOOP
        EXECUTE format(
            'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM anon, authenticated',
            partition_name
        );
    END LOOP;
END $$;


-- ============================================================================
-- 2. assignment_leaderboard: drop the unauthenticated read
-- ============================================================================

-- authorizeforclass(class_id) is exactly the surviving leg's semantics -- any user_privileges row
-- for the class, i.e. any enrolled member regardless of role -- expressed with the repo's standard
-- helper. The policy is scoped TO authenticated because with the anon leg gone there is no
-- unauthenticated caller it should ever admit.
DROP POLICY IF EXISTS "Users can view leaderboard in their class" ON public.assignment_leaderboard;

CREATE POLICY "Users can view leaderboard in their class"
  ON public.assignment_leaderboard
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (public.authorizeforclass(class_id));

REVOKE SELECT ON public.assignment_leaderboard FROM anon;

-- No client role writes this table: the only policy on it is the SELECT above, and the rows are
-- maintained by the autograder through service_role. The write grants are therefore unreachable
-- for anon and authenticated -- except TRUNCATE, which RLS does not constrain at all, so `anon`
-- holding it means the whole leaderboard was droppable by grant alone.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.assignment_leaderboard FROM anon, authenticated;


-- ============================================================================
-- 3. live_poll_responses: drop grants no policy backs
-- ============================================================================

-- anon may only INSERT, and only through live_polls_responses_insert, whose WITH CHECK
-- (can_access_poll_response) enforces require_login and profile ownership. The UPDATE and DELETE
-- grants are unreachable today because no policy admits them; revoking them means a future
-- permissive policy cannot silently widen anon's reach to editing or deleting submitted responses.
REVOKE UPDATE, DELETE ON public.live_poll_responses FROM anon;

-- TRUNCATE again: not constrained by RLS, and nothing needs it. Staff delete individual responses
-- through live_polls_responses_all_staff, which is unaffected.
REVOKE TRUNCATE ON public.live_poll_responses FROM anon, authenticated;

-- live_polls itself: the SELECT grant stays, because live_polls_select_live and the public poll
-- page depend on it. Everything else anon holds here is unreachable -- the INSERT/UPDATE/DELETE
-- policies are all TO authenticated behind authorizeforclassgrader -- except TRUNCATE, which RLS
-- does not constrain, so anon could drop every poll in every class. Staff keep row-level DML
-- through their policies; nothing needs TRUNCATE.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.live_polls FROM anon;
REVOKE TRUNCATE ON public.live_polls FROM authenticated;

-- A column-grant trim on live_polls was considered and rejected. anon reads live_polls only to
-- render the public poll page, and needs nothing there beyond id/class_id/question/is_live/
-- require_login, so narrowing the grant away from created_by looked free. It is not: that page
-- issues .select("*") (app/poll/[course_id]/page.tsx), PostgREST passes `*` through rather than
-- expanding it to the readable columns, and Postgres rejects SELECT * outright when the role holds
-- only column-level grants. Verified against the running stack -- the trim turns the public poll
-- page into `42501 permission denied for table live_polls`. Trimming the grant requires first
-- replacing that .select("*") with an explicit column list.
