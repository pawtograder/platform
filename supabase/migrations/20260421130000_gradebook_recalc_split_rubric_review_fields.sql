-- Gradebook columns for assignments depend on submission_reviews for enqueue of row
-- recalculation. The statement trigger only watched total_score and released.
--
-- Split-rubric (individual / assign-to-student) grading stores per-student lines in
-- individual_scores and per_student_grading_totals. The Edge Function score source
-- prefers per_student_grading_totals for assignment columns (see DependencySource.ts).
--
-- Those maps can change while total_score stays the same (e.g. cap_score_to_assignment_points
-- pins the rolled-up total at assignment max). Regrade resolution updates comment points,
-- recomputes those jsonb fields, but left the gradebook stale.
--
-- Fix: enqueue the same dependent rows when individual_scores or per_student_grading_totals
-- change.

CREATE OR REPLACE FUNCTION public.submission_review_recalculate_dependent_columns_statement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  r RECORD;
BEGIN
  SET LOCAL search_path TO public, pg_temp;
  -- Individual submissions with changed totals, released flag, or per-student score maps
  FOR r IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM new_table n
    LEFT JOIN old_table o ON n.id = o.id
    JOIN public.submissions s ON s.id = n.submission_id
    JOIN public.gradebook_columns gc ON gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
    JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gc.id AND gcs.student_id = s.profile_id
    WHERE s.profile_id IS NOT NULL
      AND (
        o.id IS NULL
        OR n.total_score IS DISTINCT FROM o.total_score
        OR n.released IS DISTINCT FROM o.released
        OR n.individual_scores IS DISTINCT FROM o.individual_scores
        OR n.per_student_grading_totals IS DISTINCT FROM o.per_student_grading_totals
      )
  ) LOOP
    PERFORM public.enqueue_gradebook_row_recalculation(
      r.class_id, r.gradebook_id, r.student_id, r.is_private, 'submission_review_change', NULL
    );
  END LOOP;

  -- Group submissions: same conditions; expand to each group member row
  FOR r IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM new_table n
    LEFT JOIN old_table o ON n.id = o.id
    JOIN public.submissions s ON s.id = n.submission_id
    JOIN public.assignment_groups_members agm ON agm.assignment_group_id = s.assignment_group_id
    JOIN public.gradebook_columns gc ON gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
    JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gc.id AND gcs.student_id = agm.profile_id
    WHERE s.assignment_group_id IS NOT NULL
      AND (
        o.id IS NULL
        OR n.total_score IS DISTINCT FROM o.total_score
        OR n.released IS DISTINCT FROM o.released
        OR n.individual_scores IS DISTINCT FROM o.individual_scores
        OR n.per_student_grading_totals IS DISTINCT FROM o.per_student_grading_totals
      )
  ) LOOP
    PERFORM public.enqueue_gradebook_row_recalculation(
      r.class_id, r.gradebook_id, r.student_id, r.is_private, 'submission_review_change', NULL
    );
  END LOOP;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.submission_review_recalculate_dependent_columns_statement() IS
  'After submission_reviews UPDATE: enqueue gradebook row recalc when total_score, released, individual_scores, or per_student_grading_totals change (covers split-rubric / capped totals).';

-- One-time backfill: enqueue gradebook row recalc for every gradebook cell tied to an active
-- submission on an assignment whose grading rubric has at least one is_individual_grading part.
-- Uses source=deps_update so rows already marked dirty still get a fresh queue message.

CREATE TEMP TABLE _mig_split_rubric_gb_backfill (
  class_id bigint NOT NULL,
  gradebook_id bigint NOT NULL,
  student_id uuid NOT NULL,
  is_private boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO _mig_split_rubric_gb_backfill (class_id, gradebook_id, student_id, is_private)
SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
FROM public.submissions s
JOIN public.assignments a ON a.id = s.assignment_id
JOIN public.rubric_parts rp ON rp.rubric_id = a.grading_rubric_id AND rp.is_individual_grading = true
JOIN public.gradebook_columns gc ON gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gc.id AND gcs.student_id = s.profile_id
WHERE s.is_active = true
  AND s.assignment_group_id IS NULL
  AND s.profile_id IS NOT NULL
  AND a.grading_rubric_id IS NOT NULL
  AND gcs.class_id = a.class_id

UNION

SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
FROM public.submissions s
JOIN public.assignments a ON a.id = s.assignment_id
JOIN public.rubric_parts rp ON rp.rubric_id = a.grading_rubric_id AND rp.is_individual_grading = true
JOIN public.assignment_groups_members agm ON agm.assignment_group_id = s.assignment_group_id AND agm.assignment_id = s.assignment_id
JOIN public.gradebook_columns gc ON gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gc.id AND gcs.student_id = agm.profile_id
WHERE s.is_active = true
  AND s.assignment_group_id IS NOT NULL
  AND a.grading_rubric_id IS NOT NULL
  AND gcs.class_id = a.class_id;

DO $backfill$
DECLARE
  v_batch jsonb[];
  v_chunk int := 400;
BEGIN
  LOOP
    WITH picked AS (
      SELECT ctid FROM _mig_split_rubric_gb_backfill LIMIT v_chunk
    ),
    del AS (
      DELETE FROM _mig_split_rubric_gb_backfill g
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

    EXIT WHEN v_batch IS NULL OR coalesce(array_length(v_batch, 1), 0) = 0;

    PERFORM public.enqueue_gradebook_row_recalculation_batch(v_batch);
  END LOOP;
END;
$backfill$;
