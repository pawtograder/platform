-- submissions_insert_hook_optimized: stop rewriting rows that are already inactive.
--
-- The BEFORE INSERT hook on public.submissions deactivates the prior active
-- submission for the student (or group) before making the new row active. Two of
-- its three UPDATE statements had no predicate on is_active:
--
--   UPDATE public.submissions SET is_active = false
--   WHERE assignment_id = NEW.assignment_id AND profile_id = NEW.profile_id;
--
-- so every insert rewrote EVERY prior row for that (assignment, profile) -- or
-- (assignment, group) -- including the rows already sitting at is_active = false.
-- The work is therefore O(submissions that student has ever made) per insert,
-- when the actual job is O(1): there is at most one active row to demote, which
-- the partial unique indexes from 20260424200000 already guarantee
-- (submissions_one_active_individual_per_student, submissions_one_active_group_per_group).
--
-- Measured in production before this change:
--   * 1,798 inserts produced 1,110,155 row UPDATEs on public.submissions.
--   * 288,483 of 362,964 rows (79%) were already is_active = false, i.e. rewritten
--     for no reason.
--   * The top-level `INSERT INTO public.submissions` through PostgREST ran
--     826 calls, mean 1320ms, max 7687ms, against the `authenticated` role's 8s
--     statement_timeout -- and 54 statement timeouts were logged during a
--     330-submission test wave, clustered toward the end of the wave as
--     per-student row counts grew.
--
-- Scale note, so nobody reads this as a production fire: in prod the fan-out is
-- still small -- mean 4.5 rows per (assignment, profile), p95 16, and only 39
-- groups above 100. The 1,483-rows-for-one-insert worst case is from a LOAD TEST
-- dataset with a few thousand submissions per student. This is a correctness and
-- efficiency fix whose value is in load testing and in the long tail, not an
-- outage being stopped.
--
-- Why this preserves behaviour: each statement's job is "deactivate everything
-- currently active in this scope". `AND is_active` skips only rows that are
-- ALREADY false, so the post-statement state is identical. That holds even if the
-- data has drifted to several active rows in one scope, because the predicate
-- still matches every active one. Setting is_active = false on a row where it is
-- already false is a no-op on the row itself.
--
-- BEHAVIOUR CHANGE, stated plainly rather than buried: fewer rows updated means
-- fewer rows written to public.audit. audit_submissions_update is an AFTER UPDATE
-- ... FOR EACH STATEMENT trigger with transition tables, and
-- audit_statement_trigger() inserts one audit row per row in NEW_TABLE, so the
-- audit volume tracks rows affected. The entries this removes recorded
-- is_active false -> false with nothing else changed: no-op updates. Removing
-- them removes audit NOISE, not audit history of real changes. Audit data is
-- compliance-adjacent, so this is called out here (and in the PR) for a reviewer
-- to accept knowingly. The same applies to broadcast_submission_change_trigger
-- (AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW), which no longer emits a
-- realtime broadcast for a row whose state did not change.
--
-- The third UPDATE in this function -- the one that demotes straggler individual
-- submissions via a FROM public.assignment_groups_members join -- ALREADY had
-- `AND s.is_active = true` and is unchanged here. It is reproduced verbatim
-- because CREATE OR REPLACE FUNCTION must restate the whole body.
--
-- Signature is unchanged (submissions_insert_hook_optimized() RETURNS trigger),
-- so submissions_insert_hook_trigger is deliberately NOT dropped and recreated;
-- CREATE OR REPLACE rebinds the existing trigger to the new body.

CREATE OR REPLACE FUNCTION public.submissions_insert_hook_optimized()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  assigned_ordinal integer;
  v_in_group boolean;
  r RECORD;
BEGIN
  CASE TG_OP
  WHEN 'INSERT' THEN
    IF NEW.assignment_group_id IS NOT NULL THEN
      INSERT INTO public.submission_ordinal_counters
        (assignment_id, assignment_group_id, profile_id, next_ordinal, updated_at)
      VALUES
        (NEW.assignment_id::bigint,
         NEW.assignment_group_id::bigint,
         '00000000-0000-0000-0000-000000000000'::uuid,
         2,
         now())
      ON CONFLICT (assignment_id, assignment_group_id, profile_id) DO UPDATE SET
        next_ordinal = public.submission_ordinal_counters.next_ordinal + 1,
        updated_at = now()
      RETURNING (public.submission_ordinal_counters.next_ordinal - 1) INTO assigned_ordinal;

      NEW.ordinal = assigned_ordinal;

      IF NOT NEW.is_not_graded THEN
        NEW.is_active = true;
        -- `AND is_active` added 20260828: without it this rewrote every prior
        -- submission for the group, already-inactive ones included.
        UPDATE public.submissions
        SET is_active = false
        WHERE assignment_id = NEW.assignment_id
          AND assignment_group_id = NEW.assignment_group_id
          AND is_active;

        FOR r IN (
          WITH demoted AS (
            UPDATE public.submissions s
            SET is_active = false
            FROM public.assignment_groups_members agm
            WHERE agm.assignment_id = NEW.assignment_id
              AND agm.assignment_group_id = NEW.assignment_group_id
              AND s.assignment_id = NEW.assignment_id
              AND s.profile_id = agm.profile_id
              AND s.assignment_group_id IS NULL
              AND s.is_active = true
            RETURNING s.profile_id
          )
          SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
          FROM demoted d
          JOIN public.gradebook_column_students gcs ON gcs.student_id = d.profile_id
          JOIN public.gradebook_columns gc
            ON gc.id = gcs.gradebook_column_id
           AND gc.dependencies->'assignments' @> to_jsonb(ARRAY[NEW.assignment_id]::bigint[])
        ) LOOP
          PERFORM public.enqueue_gradebook_row_recalculation(
            r.class_id, r.gradebook_id, r.student_id, r.is_private, 'group_submission_demote_individual', NULL
          );
        END LOOP;
      END IF;
    ELSE
      IF NEW.profile_id IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1
          FROM public.assignment_groups_members
          WHERE assignment_id = NEW.assignment_id
            AND profile_id = NEW.profile_id
        ) INTO v_in_group;
        IF v_in_group THEN
          RAISE EXCEPTION
            'Cannot create individual submission for profile % on assignment %: student is in an assignment group; submissions must go through the group repository.',
            NEW.profile_id, NEW.assignment_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;

      INSERT INTO public.submission_ordinal_counters
        (assignment_id, assignment_group_id, profile_id, next_ordinal, updated_at)
      VALUES
        (NEW.assignment_id::bigint, 0::bigint, NEW.profile_id::uuid, 2, now())
      ON CONFLICT (assignment_id, assignment_group_id, profile_id) DO UPDATE SET
        next_ordinal = public.submission_ordinal_counters.next_ordinal + 1,
        updated_at = now()
      RETURNING (public.submission_ordinal_counters.next_ordinal - 1) INTO assigned_ordinal;

      NEW.ordinal = assigned_ordinal;

      IF NOT NEW.is_not_graded THEN
        NEW.is_active = true;
        -- `AND is_active` added 20260828: this is the hot one. Without it every
        -- insert rewrote the student's entire submission history for the
        -- assignment (1,483 rows for a single insert at the worst measured).
        UPDATE public.submissions
        SET is_active = false
        WHERE assignment_id = NEW.assignment_id
          AND profile_id = NEW.profile_id
          AND is_active;
      END IF;
    END IF;

    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
  END CASE;
END;
$$;

COMMENT ON FUNCTION public.submissions_insert_hook_optimized() IS
  'Assigns ordinals, manages is_active, rejects individual INSERT when the student is in a group, demotes straggler individual rows on new group submission and enqueues gradebook row recalc for demoted students. Deactivation UPDATEs are predicated on is_active so an insert does not rewrite already-inactive history (20260828).';
