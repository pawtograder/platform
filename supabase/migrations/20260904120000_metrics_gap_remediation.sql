-- Metrics gap remediation (PR #952).
--
-- Consolidated: this lands as ONE migration because none of its parts were ever
-- applied to a real environment. Order below is load-bearing and must not be
-- resequenced:
--   1. workflow_runs indexes      -- the leader's RPCs seq-scan without them
--   2. errors-by-category RPC     -- bounded replacement for the free-text label
--   3. grading action counters    -- columns + trigger maintenance
--   4. privilege hardening        -- depends on (3)'s functions existing, and
--                                    must run AFTER they are SECURITY DEFINER
--
-- LOCKING: migrate.sh applies each file under `psql --single-transaction`, so
-- the whole of this file is one transaction. The CREATE INDEX statements below
-- take ACCESS EXCLUSIVE on public.workflow_runs and that lock is now held for
-- the file's duration rather than just the index build. Everything after step 1
-- is catalog work and small UPDATEs, so the widening is on the order of
-- seconds -- but it is a widening, and writes to workflow_runs block for it.
-- Deploy in the low-traffic window the runbook already calls for.


-- ============================================================================
-- from: 20260904120000_workflow_runs_metrics_indexes.sql
-- ============================================================================

-- Partial indexes backing the metrics_workflow_* RPCs
-- (20260529190000_workflow_metrics_rpcs.sql).
--
-- All three of those RPCs filter public.workflow_runs on completed_at or
-- in_progress_at against NOW() - INTERVAL, and neither column is indexed today,
-- so each one seq-scans the whole table on every refresh. That is the same
-- pathology as the metrics edge function before 76ca0bb8 (77.7% of all database
-- execution time), just at 1/32 the call rate — and the dedicated metrics leader
-- shipping in chart 0.3.18 is what starts calling them for real.
--
-- Partial (WHERE ... IS NOT NULL) because a workflow_runs row spends its whole
-- queued/running life with these columns NULL, and every query filters on a
-- non-NULL value. The partial index is smaller and skips the rows that can never
-- match.
--
-- ---------------------------------------------------------------------------
-- WHY NOT CREATE INDEX CONCURRENTLY
-- ---------------------------------------------------------------------------
-- charts/pawtograder/images/migrations/migrate.sh applies every migration under
-- `psql --single-transaction`. CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block: it errors, aborts the migration Job, and fails
-- `helm upgrade --wait-for-jobs` — taking the whole deploy down rather than just
-- this statement. So this is a PLAIN CREATE INDEX, which takes an ACCESS
-- EXCLUSIVE lock on public.workflow_runs (a hot autograder path) for the
-- duration of the build. Deploy accordingly: off-peak, not near a deadline.
--
-- IF NOT EXISTS is load-bearing, not decoration. If the build time is long
-- enough to matter, the operator should create these BY HAND with CREATE INDEX
-- CONCURRENTLY before deploying; this migration then finds them already present,
-- becomes a no-op, and still records itself in the migration ledger so the
-- schema does not read as drifted.

CREATE INDEX IF NOT EXISTS idx_workflow_runs_completed_at   ON public.workflow_runs (completed_at DESC)   WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_in_progress_at ON public.workflow_runs (in_progress_at DESC) WHERE in_progress_at IS NOT NULL;

-- ============================================================================
-- from: 20260904130000_workflow_error_category_metrics.sql
-- ============================================================================

-- Bounded replacement for metrics_workflow_errors_by_name.
--
-- WHY: web_workflow_errors_recent carried workflow_run_error.name as a
-- Prometheus label. That column is FREE TEXT — it is the student-visible
-- sentence, capped only at 500 characters by workflow_run_error_name_length
-- (20250801174131), and several producers embed a commit sha in it
-- (supabase/functions/_shared/tooLargeErrorName.ts,
--  github-repo-webhook/index.ts recordRejectedPush). Every oversized or
-- late push therefore mints a brand-new label value.
--
-- The old LIMIT 200 did NOT bound that. It caps the rows returned by ONE call,
-- not the label domain over time: refreshWorkflowMetrics() resets the gauge and
-- may pick a different top-200 on every pass, while Prometheus retains every
-- series it has ever seen. An error storm with distinct messages churned
-- hundreds of new series per refresh interval — worst exactly when monitoring
-- is under load. The cap was also a global top-N, so one noisy class could
-- push every other class out of the gauge.
--
-- WHAT: group by a CLOSED category instead. Every branch of the CASE below
-- yields a string literal from a fixed list, so the label domain is bounded by
-- the FUNCTION, not by the data or by a row limit. New producers land in
-- 'other' until someone deliberately adds them here, which is a reviewed edit
-- rather than a label that quietly appears in production.
--
-- The categories come from workflow_run_error.data, not from the message:
--   * data->>'error_type' — written by github-repo-webhook for the rejection
--     paths. REJECTION_ERROR_TYPES in that file is the same closed set plus
--     'missing_grader_result'.
--   * data->>'type' = 'grader' — written by autograder-submit-feedback for
--     errors reported by the grading container itself.
--   * anything else (including a NULL data column, and the pass-through data
--     from autograder-create-submission, which is caller-supplied and therefore
--     must NOT be trusted as a label) → 'other'.
--
-- Cardinality: classes x 7 categories, with no top-N, so no class can be
-- crowded out of the gauge by a noisy neighbour. At 100 classes that is 700
-- series, replacing a 200-series cap that leaked without limit over time.
--
-- metrics_workflow_errors_by_name is left in place (unused by the app after
-- this migration) rather than dropped: dropping it would break a rollback to
-- the previous web image mid-deploy, and it costs nothing to keep.

CREATE OR REPLACE FUNCTION public.metrics_workflow_errors_by_category(window_hours numeric DEFAULT 1)
RETURNS TABLE (class_id text, category text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT class_id::text,
         category,
         COUNT(*)::bigint AS count
  FROM (
    SELECT class_id,
           CASE
             WHEN data->>'error_type' IN (
                    'file_too_large',
                    'submission_too_large',
                    'empty_submission',
                    'after_due_date',
                    'missing_grader_result'
                  )
               THEN data->>'error_type'
             WHEN data->>'type' = 'grader' THEN 'grader'
             ELSE 'other'
           END AS category
    FROM public.workflow_run_error
    WHERE created_at > NOW() - make_interval(hours => window_hours::int)
  ) c
  GROUP BY class_id, category
$$;

COMMENT ON FUNCTION public.metrics_workflow_errors_by_category(numeric) IS
  'workflow_run_error rows in the last N hours, grouped by class and a CLOSED error category derived from data->>''error_type'' / data->>''type''. Replaces metrics_workflow_errors_by_name, whose `name` label was free text and unbounded over time. Driver for web_workflow_errors_recent.';

-- Privileges. GRANT alone is NOT sufficient here.
--
-- 20250330003141_remote_schema.sql:3593-3596 sets
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT ALL ON FUNCTIONS TO anon, authenticated;
-- so a function created in this schema is granted EXECUTE to anon and
-- authenticated the moment it exists, on top of PostgreSQL's own implicit
-- EXECUTE for PUBLIC. Because these metrics functions are SECURITY DEFINER they
-- run as the owner and see every class, bypassing RLS -- so without an explicit
-- REVOKE any signed-in user, and via the anon grant any unauthenticated caller
-- with the anon key, could read cross-class workflow aggregates. The repo
-- already uses this REVOKE-then-GRANT pattern for privileged helpers; see
-- 20250803015833_github-assignment-repo-triggers.sql:33-34.
REVOKE ALL ON FUNCTION public.metrics_workflow_errors_by_category(numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.metrics_workflow_errors_by_category(numeric) TO service_role;

-- Same defect, same feature: the four RPCs added in
-- 20260529190000_workflow_metrics_rpcs.sql granted service_role without ever
-- revoking the default anon/authenticated grants. They are already applied in
-- production and are only actually called once this release enables the metrics
-- leader, so they are closed here rather than left for a follow-up.
REVOKE ALL ON FUNCTION public.metrics_workflow_runs_by_conclusion(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.metrics_workflow_queue_percentiles(numeric)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.metrics_workflow_run_percentiles(numeric)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.metrics_workflow_errors_by_name(numeric)     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.metrics_workflow_runs_by_conclusion(numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.metrics_workflow_queue_percentiles(numeric)  TO service_role;
GRANT EXECUTE ON FUNCTION public.metrics_workflow_run_percentiles(numeric)    TO service_role;
GRANT EXECUTE ON FUNCTION public.metrics_workflow_errors_by_name(numeric)     TO service_role;

COMMENT ON FUNCTION public.metrics_workflow_errors_by_name(numeric) IS
  'SUPERSEDED by metrics_workflow_errors_by_category. The `name` column is free text (500-char cap only) and several producers embed a commit sha in it, so using it as a Prometheus label is unbounded cardinality; the LIMIT 200 here caps one call, not the label domain over time. Kept only so a rollback to an older web image still works. Do not add new callers.';

-- ============================================================================
-- from: 20260904140000_grading_action_counters.sql
-- ============================================================================

-- Monotonic per-class counters behind pawtograder_grading_actions_total.
--
-- ---------------------------------------------------------------------------
-- WHY: the exporter query this replaces was NOT a counter
-- ---------------------------------------------------------------------------
-- charts/pawtograder/templates/monitoring.yaml computed pawtograder_grading_actions
-- as a live COUNT(*) over submission_comments / submission_file_comments /
-- submission_artifact_comments / submission_reviews. That value can go DOWN in
-- two ways, and Prometheus reads any decrease of a COUNTER as a reset, which
-- rate()/increase() render as a phantom burst the size of the whole remaining
-- total:
--
--   1. HARD DELETES. public.delete_assignment_with_all_data()
--      (20260109094216_fix-delete-assignment-jsonb-bug.sql) hard-deletes all
--      three comment tables and submission_reviews for the assignment. The
--      "soft deletes are included so the counter stays monotonic" reasoning in
--      monitoring.yaml was correct about deleted_at and simply did not cover
--      this path.
--   2. BULK UNRELEASE. submission_reviews.released is a mutable boolean and
--      unrelease_all_grading_reviews_for_assignment() flips it back to false
--      for a whole assignment from the instructor UI. This was previously
--      documented as an accepted wart, but the damage is wider than the note
--      admitted: the "Grading actions (1h)" stat and the "Top classes by recent
--      activity" table sum ACROSS kinds, so a bulk unrelease corrupts those
--      panels too, not just the by-kind series.
--
-- Documenting either one is not enough for a dashboard that gets read during a
-- grading crunch: the panel does not read "stale", it reads "huge spike".
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS CHEAP, contrary to the earlier cost analysis
-- ---------------------------------------------------------------------------
-- The WS-APP wave rejected a trigger-maintained counter as "a new trigger on
-- the comment insert hot path to save 0.12% of one core". That trigger already
-- exists. class_metrics_submission_comments_counter()
-- (20250928001347_class_metrics_performance.sql) has fired AFTER INSERT on all
-- four comment tables since September 2025; this migration only adds columns to
-- the UPDATE it already issues. No new trigger, no new per-row invocation, no
-- extra statement — the same single-row UPDATE now touches one more column.
--
-- submission_reviews is the one genuinely new trigger, and it is scoped:
-- AFTER UPDATE OF released with a WHEN clause, so it is not entered at all for
-- the ordinary score/completed_at updates that dominate that table's write
-- volume. It fires once per review that actually transitions to released.
--
-- Dropping the scan also removes the exporter's cache_seconds: 300, which was
-- itself a problem — a 300s-cached counter makes rate(...[1m]) alternate
-- between zero and a five-minutes-in-one-scrape spike. The counters below are a
-- one-row-per-class read, so the exporter can serve them at every scrape.
--
-- ---------------------------------------------------------------------------
-- SEMANTICS
-- ---------------------------------------------------------------------------
-- These count grading ACTIONS (events), not surviving rows. A retracted
-- comment, a deleted assignment and an unreleased review all still happened.
-- The absolute value can therefore drift above the live row count; that is
-- correct and, in any case, invisible, because every panel reads these through
-- increase()/rate() where a constant offset cancels.
--
-- submission_regrade_request_comments is deliberately EXCLUDED from the two
-- comment counters (it keeps feeding submission_comments_total as before):
-- students write those, so they are not grading actions, and the scan being
-- replaced did not count them either. Keeping the metric's meaning identical
-- across the switch is what makes the counter continuous rather than stepping.

ALTER TABLE public.class_metrics_totals
  ADD COLUMN IF NOT EXISTS grading_actions_comment_total bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grading_actions_rubric_check_total bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grading_actions_release_total bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.class_metrics_totals.grading_actions_comment_total IS
  'Monotonic count of free-text grading comments ever inserted in this class (submission_comments + submission_file_comments + submission_artifact_comments with rubric_check_id IS NULL). Insert-only; never decremented. Backs pawtograder_grading_actions_total{kind="comment"}.';
COMMENT ON COLUMN public.class_metrics_totals.grading_actions_rubric_check_total IS
  'Monotonic count of rubric-check grading comments ever inserted in this class (same three tables, rubric_check_id IS NOT NULL). Backs pawtograder_grading_actions_total{kind="rubric_check"}.';
COMMENT ON COLUMN public.class_metrics_totals.grading_actions_release_total IS
  'Monotonic count of submission_reviews release EVENTS in this class (insert with released, or an update flipping released false -> true). Unlike COUNT(*) WHERE released, a bulk unrelease does not decrease it. Backs pawtograder_grading_actions_total{kind="release"}.';

-- ---------------------------------------------------------------------------
-- Comment counters: extend the trigger function that already runs.
-- ---------------------------------------------------------------------------
-- Fired by class_metrics_submission_comments_trg,
-- class_metrics_submission_artifact_comments_trg,
-- class_metrics_submission_file_comments_trg and
-- class_metrics_submission_regrade_request_comments_trg. Only the first three
-- carry rubric_check_id, which is why the regrade-comment table is branched out
-- FIRST: plpgsql resolves NEW.<field> when the expression is evaluated, so a
-- reference to a column that table does not have must not be reachable for it.
CREATE OR REPLACE FUNCTION public.class_metrics_submission_comments_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'submission_regrade_request_comments' THEN
    UPDATE public.class_metrics_totals
    SET submission_comments_total = submission_comments_total + 1,
        updated_at = now()
    WHERE class_id = NEW.class_id;
  ELSIF NEW.rubric_check_id IS NOT NULL THEN
    UPDATE public.class_metrics_totals
    SET submission_comments_total = submission_comments_total + 1,
        grading_actions_rubric_check_total = grading_actions_rubric_check_total + 1,
        updated_at = now()
    WHERE class_id = NEW.class_id;
  ELSE
    UPDATE public.class_metrics_totals
    SET submission_comments_total = submission_comments_total + 1,
        grading_actions_comment_total = grading_actions_comment_total + 1,
        updated_at = now()
    WHERE class_id = NEW.class_id;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Release counter: the one new trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.class_metrics_grading_releases_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET grading_actions_release_total = grading_actions_release_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

-- UPDATE OF released + a WHEN clause: the trigger is not entered for the score,
-- completed_at and rubric-assignment updates that make up nearly all of this
-- table's write traffic. A bulk release of one assignment fires it once per
-- review, each a single-row UPDATE of one class_metrics_totals row inside the
-- same transaction — the same shape as a bulk comment insert.
DROP TRIGGER IF EXISTS class_metrics_grading_releases_update_trg ON public.submission_reviews;
CREATE TRIGGER class_metrics_grading_releases_update_trg
AFTER UPDATE OF released ON public.submission_reviews
FOR EACH ROW
WHEN (NEW.released AND NOT OLD.released)
EXECUTE FUNCTION public.class_metrics_grading_releases_counter();

DROP TRIGGER IF EXISTS class_metrics_grading_releases_insert_trg ON public.submission_reviews;
CREATE TRIGGER class_metrics_grading_releases_insert_trg
AFTER INSERT ON public.submission_reviews
FOR EACH ROW
WHEN (NEW.released)
EXECUTE FUNCTION public.class_metrics_grading_releases_counter();

-- ---------------------------------------------------------------------------
-- Backfill.
-- ---------------------------------------------------------------------------
-- One pass over the comment tables and submission_reviews. This is the same
-- ~350ms full scan the exporter used to run every 5 minutes forever; here it
-- runs exactly once, inside the migration transaction.
--
-- The backfill counts SURVIVING rows, so it starts below the true historical
-- number of actions (anything already hard-deleted is gone, and releases that
-- have since been retracted read as zero). That is fine and is the reason these
-- are only ever read through increase()/rate(): the deficit is a constant
-- offset from the first scrape onwards, and only the deltas after that are
-- plotted.
WITH totals AS (
  SELECT c.id AS class_id,
         COALESCE(cm.n_comment, 0)      AS n_comment,
         COALESCE(cm.n_rubric_check, 0) AS n_rubric_check,
         COALESCE(rel.n_release, 0)     AS n_release
  FROM public.classes c
  LEFT JOIN (
    SELECT class_id,
           COUNT(*) FILTER (WHERE rubric_check_id IS NULL)     AS n_comment,
           COUNT(*) FILTER (WHERE rubric_check_id IS NOT NULL) AS n_rubric_check
    FROM (
      SELECT class_id, rubric_check_id FROM public.submission_comments
      UNION ALL
      SELECT class_id, rubric_check_id FROM public.submission_file_comments
      UNION ALL
      SELECT class_id, rubric_check_id FROM public.submission_artifact_comments
    ) x
    GROUP BY class_id
  ) cm ON cm.class_id = c.id
  LEFT JOIN (
    SELECT class_id, COUNT(*) AS n_release
    FROM public.submission_reviews
    WHERE released
    GROUP BY class_id
  ) rel ON rel.class_id = c.id
)
UPDATE public.class_metrics_totals mt
SET grading_actions_comment_total      = totals.n_comment,
    grading_actions_rubric_check_total = totals.n_rubric_check,
    grading_actions_release_total      = totals.n_release,
    updated_at = now()
FROM totals
WHERE mt.class_id = totals.class_id;

-- ============================================================================
-- from: 20260904150000_restrict_class_metrics_totals.sql
-- ============================================================================

-- Restrict public.class_metrics_totals to the roles that actually need it.
--
-- WHY NOW: this table is a bookkeeping detail of the class-metrics trigger
-- mechanism (20250928001347). Nothing in the application reads or writes it
-- directly — verified by repo grep: outside supabase/migrations it appears only
-- in the generated SupabaseTypes.d.ts, in no view, and in no function outside
-- the counter set below. This PR makes it authoritative for two exported
-- Prometheus counters (pawtograder_submissions_created_total and
-- pawtograder_grading_actions_total, see
-- charts/pawtograder/templates/monitoring.yaml), so its privileges should match
-- its actual consumers rather than the schema-wide default.
--
-- The schema-wide default is permissive:
-- 20250330003141_remote_schema.sql:3593-3596 sets
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT ALL ON TABLES TO anon, authenticated;
-- so every table created in `public` since then starts with ALL granted to both
-- roles unless a migration says otherwise. This one never did. Same root cause
-- as the workflow-metrics RPC grants tightened earlier in this branch — worth
-- knowing about when adding any new internal table here.
--
-- ---------------------------------------------------------------------------
-- ORDER IS LOAD-BEARING. Steps 2 and 3 are unsafe without step 1.
-- ---------------------------------------------------------------------------
-- All 20 class_metrics_* counter trigger functions are SECURITY INVOKER, so
-- they run as whoever issued the INSERT — normally `authenticated`, because
-- these counters are maintained off ordinary student and staff writes through
-- PostgREST (a comment, a submission, a help request). That means:
--
--   * revoking UPDATE from `authenticated` while the functions are INVOKER
--     makes the trigger fail, and the trigger failing aborts the user's INSERT.
--     Every student comment and submission would error.
--   * enabling RLS with no policies while the functions are INVOKER is worse:
--     the trigger's UPDATE matches zero rows and returns successfully, so the
--     counters silently stop advancing and both exported metrics flatline with
--     no error anywhere.
--
-- So the functions become SECURITY DEFINER first. They are owned by `postgres`,
-- which also owns the table, and the table is not FORCE ROW LEVEL SECURITY, so
-- a definer function keeps writing after RLS is enabled (table owners are
-- exempt from their own RLS unless FORCE is set). Do not add FORCE to this
-- table without re-testing every trigger below.
--
-- search_path is pinned to '' at the same time, which is the reason this is
-- done with ALTER FUNCTION rather than by rewriting the bodies: no body text
-- changes, so there is no chance of a transcription error across 20 functions,
-- and the change is verifiable as a one-line diff in pg_proc. Every table
-- reference in every one of these bodies is already schema-qualified
-- (`public.class_metrics_totals`); the only non-qualified calls are pg_catalog
-- builtins (now(), COALESCE, btrim), which resolve regardless.
--
-- MAINTENANCE NOTE: CREATE OR REPLACE FUNCTION resets both attributes. Any
-- later migration that redefines one of these must restate SECURITY DEFINER and
-- SET search_path = '' in the definition, or the function silently reverts to
-- INVOKER and its trigger starts failing against the restricted table.

-- ---------------------------------------------------------------------------
-- 1. The counter trigger functions run as their owner, with a pinned path.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.class_metrics_assignment_due_date_exceptions_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_assignment_due_date_exceptions_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_assignments_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_assignments_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_classes_insert() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_classes_insert() SET search_path = '';
ALTER FUNCTION public.class_metrics_discussion_threads_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_discussion_threads_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_gradebook_columns_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_gradebook_columns_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_grading_releases_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_grading_releases_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_help_request_messages_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_help_request_messages_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_help_requests_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_help_requests_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_hint_feedback_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_hint_feedback_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_llm_inference_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_llm_inference_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_notifications_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_notifications_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_regrade_requests_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_regrade_requests_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_submission_comments_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_submission_comments_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_submission_reviews_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_submission_reviews_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_submissions_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_submissions_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_user_roles_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_user_roles_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_video_meeting_participants_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_video_meeting_participants_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_video_meeting_sessions_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_video_meeting_sessions_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_workflow_errors_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_workflow_errors_counter() SET search_path = '';
ALTER FUNCTION public.class_metrics_workflow_events_counter() SECURITY DEFINER;
ALTER FUNCTION public.class_metrics_workflow_events_counter() SET search_path = '';

-- ---------------------------------------------------------------------------
-- 2. Direct DML belongs to the trigger mechanism, not to API roles.
-- ---------------------------------------------------------------------------
-- service_role keeps full access: it is the admin path, and the postgres_exporter
-- sidecar (which connects as supabase_admin) reads this table for
-- pawtograder_submissions_created_total / pawtograder_grading_actions_total.
--
-- SELECT is revoked along with the rest. Nothing reads the table through an API
-- role: get_all_class_metrics() is the only reader and it is SECURITY DEFINER
-- owned by postgres, so it is unaffected. Keeping SELECT would publish a
-- per-class activity profile (submission, comment, help-request and LLM-usage
-- totals for every class) to any API caller, which is not something this table
-- was ever meant to expose.
REVOKE ALL ON TABLE public.class_metrics_totals FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. RLS with no policies: deny by default, including for future grants.
-- ---------------------------------------------------------------------------
-- Belt and braces over step 2. If the schema-wide ALTER DEFAULT PRIVILEGES ever
-- re-grants this table (a re-created table, a restore, a migration that recreates
-- it), RLS with zero policies still denies every non-owner, non-BYPASSRLS role.
-- service_role and supabase_admin both carry rolbypassrls, so neither is
-- affected; `postgres` owns the table and is exempt because FORCE is not set.
ALTER TABLE public.class_metrics_totals ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.class_metrics_totals IS
  'Internal per-class counter table maintained by the class_metrics_* AFTER-INSERT/UPDATE triggers. Not part of the API surface: no policies, no grants to anon/authenticated. Read by service_role and by the postgres_exporter custom queries that back pawtograder_submissions_created_total and pawtograder_grading_actions_total. The trigger functions are SECURITY DEFINER so they can still write it.';

-- ---------------------------------------------------------------------------
-- 4. The one reader RPC follows the table.
-- ---------------------------------------------------------------------------
-- get_all_class_metrics() returns this table's contents for every class in one
-- jsonb blob. It is SECURITY DEFINER, so revoking table SELECT above does not
-- affect it — which would have left the data reachable through the RPC after
-- restricting the table, an inconsistency rather than a boundary. It has no
-- callers: a repo-wide grep finds it only in the generated SupabaseTypes.d.ts.
-- service_role keeps EXECUTE.
--
-- FROM PUBLIC as well as the two roles, and that is not belt and braces — it is
-- the part that does the work. PostgreSQL grants EXECUTE on a new function to
-- PUBLIC by default, so this function's ACL carries `=X/postgres` on top of the
-- explicit anon/authenticated entries the schema default added. Revoking only
-- the named roles leaves the PUBLIC grant, and has_function_privilege() still
-- answers true for both of them. Same REVOKE-then-keep-service_role shape as
-- 20260904130000 used for the metrics_workflow_* RPCs.
REVOKE ALL ON FUNCTION public.get_all_class_metrics() FROM PUBLIC, anon, authenticated;

-- The 20 counter functions above are deliberately NOT revoked. They all return
-- `trigger`, and PostgreSQL refuses to invoke a trigger-returning function
-- directly ("trigger functions can only be called as triggers", ERRCODE 0A000),
-- so their EXECUTE grant confers nothing even though they are now definer.
-- Trigger firing does not consult EXECUTE on the function either — that is
-- checked once, at CREATE TRIGGER time — so revoking would be inert in both
-- directions. Left alone rather than adding 20 no-op statements.
