-- Assignment gradebook columns read from the currently active submission.
-- Recalculate dependent gradebook rows whenever a submission activation changes.

CREATE OR REPLACE FUNCTION public.submission_active_recalculate_dependent_columns_statement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch jsonb[];
BEGIN
  WITH changed_submissions AS (
    SELECT
      n.id,
      n.class_id,
      n.assignment_id,
      n.profile_id,
      n.assignment_group_id
    FROM new_table n
    JOIN old_table o ON o.id = n.id
    WHERE n.is_active IS DISTINCT FROM o.is_active
  ),
  affected_rows AS (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM changed_submissions s
    JOIN public.gradebook_columns gc
      ON gc.class_id = s.class_id
     AND gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
    JOIN public.gradebook_column_students gcs
      ON gcs.gradebook_column_id = gc.id
     AND gcs.student_id = s.profile_id
    WHERE s.assignment_group_id IS NULL
      AND s.profile_id IS NOT NULL

    UNION

    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM changed_submissions s
    JOIN public.assignment_groups_members agm
      ON agm.assignment_id = s.assignment_id
     AND agm.assignment_group_id = s.assignment_group_id
    JOIN public.gradebook_columns gc
      ON gc.class_id = s.class_id
     AND gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
    JOIN public.gradebook_column_students gcs
      ON gcs.gradebook_column_id = gc.id
     AND gcs.student_id = agm.profile_id
    WHERE s.assignment_group_id IS NOT NULL
  )
  SELECT coalesce(
    array_agg(
      jsonb_build_object(
        'class_id', class_id,
        'gradebook_id', gradebook_id,
        'student_id', student_id,
        'is_private', is_private,
        'source', 'deps_update'
      )
    ),
    ARRAY[]::jsonb[]
  )
  INTO v_batch
  FROM affected_rows;

  IF coalesce(array_length(v_batch, 1), 0) > 0 THEN
    PERFORM public.enqueue_gradebook_row_recalculation_batch(v_batch);
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.submission_active_recalculate_dependent_columns_statement() IS
  'After submissions UPDATE: enqueue gradebook row recalculation when is_active changes for assignment-dependent columns.';

DROP TRIGGER IF EXISTS trigger_recalculate_dependent_columns_on_submission_active_change ON public.submissions;
CREATE TRIGGER trigger_recalculate_dependent_columns_on_submission_active_change
  AFTER UPDATE ON public.submissions
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.submission_active_recalculate_dependent_columns_statement();

-- Backfill existing rows so deployments with stale active-submission gradebook cells repair themselves.
CREATE TEMP TABLE _mig_active_submission_gb_backfill (
  class_id bigint NOT NULL,
  gradebook_id bigint NOT NULL,
  student_id uuid NOT NULL,
  is_private boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO _mig_active_submission_gb_backfill (class_id, gradebook_id, student_id, is_private)
SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
FROM public.submissions s
JOIN public.gradebook_columns gc
  ON gc.class_id = s.class_id
 AND gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
JOIN public.gradebook_column_students gcs
  ON gcs.gradebook_column_id = gc.id
 AND gcs.student_id = s.profile_id
WHERE s.assignment_group_id IS NULL
  AND s.profile_id IS NOT NULL

UNION

SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
FROM public.submissions s
JOIN public.assignment_groups_members agm
  ON agm.assignment_id = s.assignment_id
 AND agm.assignment_group_id = s.assignment_group_id
JOIN public.gradebook_columns gc
  ON gc.class_id = s.class_id
 AND gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
JOIN public.gradebook_column_students gcs
  ON gcs.gradebook_column_id = gc.id
 AND gcs.student_id = agm.profile_id
WHERE s.assignment_group_id IS NOT NULL;

DO $backfill$
DECLARE
  v_batch jsonb[];
  v_chunk int := 400;
BEGIN
  LOOP
    WITH picked AS (
      SELECT ctid FROM _mig_active_submission_gb_backfill LIMIT v_chunk
    ),
    del AS (
      DELETE FROM _mig_active_submission_gb_backfill g
      USING picked p
      WHERE g.ctid = p.ctid
      RETURNING g.class_id, g.gradebook_id, g.student_id, g.is_private
    )
    SELECT coalesce(
      array_agg(
        jsonb_build_object(
          'class_id', del.class_id,
          'gradebook_id', del.gradebook_id,
          'student_id', del.student_id,
          'is_private', del.is_private,
          'source', 'deps_update'
        )
      ),
      ARRAY[]::jsonb[]
    )
    INTO v_batch
    FROM del;

    EXIT WHEN coalesce(array_length(v_batch, 1), 0) = 0;

    PERFORM public.enqueue_gradebook_row_recalculation_batch(v_batch);
  END LOOP;
END;
$backfill$;
