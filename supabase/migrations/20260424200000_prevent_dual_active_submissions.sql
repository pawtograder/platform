-- Prevent dual-active submissions: an active individual submission
-- (assignment_group_id IS NULL) while the student is in assignment_groups_members
-- for that assignment, plus at-most-one active row per (assignment, profile) and per (assignment, group).

-- 1) Pre-flight: fail fast if already violated
DO $pre$
DECLARE
  v_count int;
BEGIN
  SELECT count(*)::int INTO v_count
  FROM public.submissions s
  WHERE s.is_active = true
    AND s.assignment_group_id IS NULL
    AND s.profile_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.assignment_groups_members agm
      WHERE agm.assignment_id = s.assignment_id AND agm.profile_id = s.profile_id
    );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Dual-active submissions exist (% rows). Resolve before applying migration.', v_count;
  END IF;

  SELECT count(*)::int INTO v_count
  FROM (
    SELECT 1
    FROM public.submissions
    WHERE is_active = true AND assignment_group_id IS NULL AND profile_id IS NOT NULL
    GROUP BY assignment_id, profile_id
    HAVING count(*) > 1
  ) x;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Multiple active individual submissions per (assignment, profile) exist. Resolve first.';
  END IF;

  SELECT count(*)::int INTO v_count
  FROM (
    SELECT 1
    FROM public.submissions
    WHERE is_active = true AND assignment_group_id IS NOT NULL
    GROUP BY assignment_id, assignment_group_id
    HAVING count(*) > 1
  ) x;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Multiple active group submissions per (assignment, group) exist. Resolve first.';
  END IF;
END;
$pre$;

-- 2) Partial unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS submissions_one_active_individual_per_student
  ON public.submissions (assignment_id, profile_id)
  WHERE is_active = true AND assignment_group_id IS NULL AND profile_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS submissions_one_active_group_per_group
  ON public.submissions (assignment_id, assignment_group_id)
  WHERE is_active = true AND assignment_group_id IS NOT NULL;

-- 3) After joining a group: demote this student's active individual submission + enqueue gradebook recalc
CREATE OR REPLACE FUNCTION public.deactivate_individual_submissions_on_group_join()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_demoted_count int;
  r RECORD;
BEGIN
  WITH demoted AS (
    UPDATE public.submissions s
    SET is_active = false
    WHERE s.assignment_id = NEW.assignment_id
      AND s.profile_id = NEW.profile_id
      AND s.assignment_group_id IS NULL
      AND s.is_active = true
    RETURNING s.id
  )
  SELECT count(*)::int INTO v_demoted_count FROM demoted;

  IF v_demoted_count > 0 THEN
    FOR r IN (
      SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
      FROM public.gradebook_column_students gcs
      JOIN public.gradebook_columns gc
        ON gc.id = gcs.gradebook_column_id
       AND gc.dependencies->'assignments' @> to_jsonb(ARRAY[NEW.assignment_id]::bigint[])
      WHERE gcs.student_id = NEW.profile_id
    ) LOOP
      PERFORM public.enqueue_gradebook_row_recalculation(
        r.class_id, r.gradebook_id, r.student_id, r.is_private, 'group_join_demote_individual', NULL
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.deactivate_individual_submissions_on_group_join() IS
  'On assignment_groups_members insert: set is_active=false on this student''s individual submissions for the assignment, then enqueue gradebook row recalc.';

DROP TRIGGER IF EXISTS trg_deactivate_individual_on_group_join ON public.assignment_groups_members;
CREATE TRIGGER trg_deactivate_individual_on_group_join
  AFTER INSERT ON public.assignment_groups_members
  FOR EACH ROW
  EXECUTE FUNCTION public.deactivate_individual_submissions_on_group_join();

-- 4) submissions_insert_hook: reject new individual when in a group; demote stragglers on new group submission
CREATE OR REPLACE FUNCTION public.submissions_insert_hook_optimized()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  assigned_ordinal integer;
  v_in_group boolean;
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
        UPDATE public.submissions
        SET is_active = false
        WHERE assignment_id = NEW.assignment_id
          AND assignment_group_id = NEW.assignment_group_id;

        UPDATE public.submissions s
        SET is_active = false
        FROM public.assignment_groups_members agm
        WHERE agm.assignment_id = NEW.assignment_id
          AND agm.assignment_group_id = NEW.assignment_group_id
          AND s.assignment_id = NEW.assignment_id
          AND s.profile_id = agm.profile_id
          AND s.assignment_group_id IS NULL
          AND s.is_active = true;
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
        UPDATE public.submissions
        SET is_active = false
        WHERE assignment_id = NEW.assignment_id
          AND profile_id = NEW.profile_id;
      END IF;
    END IF;

    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
  END CASE;
END;
$$;

COMMENT ON FUNCTION public.submissions_insert_hook_optimized() IS
  'Assigns ordinals, manages is_active, rejects individual INSERT when the student is in a group, demotes straggler individual rows on new group submission.';

-- 5) Guard: cannot re-activate an individual submission while the student is in a group
CREATE OR REPLACE FUNCTION public.guard_individual_submission_active_when_in_group()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.is_active = true
     AND (OLD.is_active IS DISTINCT FROM true)
     AND NEW.assignment_group_id IS NULL
     AND NEW.profile_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.assignment_groups_members agm
       WHERE agm.assignment_id = NEW.assignment_id
         AND agm.profile_id = NEW.profile_id
     )
  THEN
    RAISE EXCEPTION
      'Cannot activate individual submission % for profile % on assignment %: student is in an assignment group',
      NEW.id, NEW.profile_id, NEW.assignment_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_individual_submission_active_when_in_group() IS
  'Before UPDATE: block setting is_active=true on individual rows when the student is in a group.';

DROP TRIGGER IF EXISTS trg_guard_individual_active_when_in_group ON public.submissions;
CREATE TRIGGER trg_guard_individual_active_when_in_group
  BEFORE UPDATE OF is_active ON public.submissions
  FOR EACH ROW
  WHEN (NEW.is_active = true)
  EXECUTE FUNCTION public.guard_individual_submission_active_when_in_group();

-- E2E / deployment: returns 1 when this migration’s guards are installed
CREATE OR REPLACE FUNCTION public.dual_active_invariants_version()
RETURNS integer
LANGUAGE sql
STABLE
AS $$ SELECT 1; $$;
COMMENT ON FUNCTION public.dual_active_invariants_version() IS
  'Returns 1 when prevent_dual_active_submissions (20260424) migration is applied. Used by e2e to skip or assert.';

REVOKE ALL ON FUNCTION public.dual_active_invariants_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dual_active_invariants_version() TO service_role;
