-- rubric_checks.points cascade updates comment rows inside a trigger at depth 1;
-- comment INSERT/UPDATE triggers call submissionreviewrecompute() at depth 2, which
-- returns early (pg_trigger_depth guard) and never recomputes submission_reviews totals.
-- After cascading points, directly call _submission_review_recompute_scores for each
-- affected submission review (non-deleted comments only, matching score aggregation).

CREATE OR REPLACE FUNCTION public.handle_rubric_check_points_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_review_id bigint;
BEGIN
  IF NEW.points IS DISTINCT FROM OLD.points THEN
    UPDATE public.submission_comments
    SET points = NEW.points
    WHERE rubric_check_id = NEW.id;

    UPDATE public.submission_file_comments
    SET points = NEW.points
    WHERE rubric_check_id = NEW.id;

    UPDATE public.submission_artifact_comments
    SET points = NEW.points
    WHERE rubric_check_id = NEW.id;

    FOR v_review_id IN
      SELECT DISTINCT subq.submission_review_id
      FROM (
        SELECT submission_review_id FROM public.submission_comments
        WHERE rubric_check_id = NEW.id AND deleted_at IS NULL
        UNION
        SELECT submission_review_id FROM public.submission_file_comments
        WHERE rubric_check_id = NEW.id AND deleted_at IS NULL
        UNION
        SELECT submission_review_id FROM public.submission_artifact_comments
        WHERE rubric_check_id = NEW.id AND deleted_at IS NULL
      ) AS subq
      WHERE subq.submission_review_id IS NOT NULL
    LOOP
      PERFORM public._submission_review_recompute_scores(v_review_id);
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_rubric_check_points_update() IS
  'Cascade rubric_checks.points to comment rows; then recompute each affected submission_review via _submission_review_recompute_scores (avoids nested trigger depth skip).';
