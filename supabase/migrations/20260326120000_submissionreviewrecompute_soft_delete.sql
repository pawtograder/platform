-- Soft-delete / restore on comment rows must still rerun _submission_review_recompute_scores
-- (pg_trigger_depth > 1 and NULL id short-circuits previously skipped those updates).
CREATE OR REPLACE FUNCTION public.submissionreviewrecompute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  existing_submission_review_id int8;
  v_comment_deleted_at_changed boolean;
BEGIN
  v_comment_deleted_at_changed := false;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN (
    'submission_comments',
    'submission_file_comments',
    'submission_artifact_comments'
  ) THEN
    v_comment_deleted_at_changed := OLD.deleted_at IS DISTINCT FROM NEW.deleted_at;
  END IF;

  IF NOT v_comment_deleted_at_changed AND pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF 'rubric_check_id' = ANY (SELECT jsonb_object_keys(to_jsonb(NEW))) THEN
    IF (
      CASE
        WHEN TG_OP = 'UPDATE' THEN COALESCE(NEW.rubric_check_id, OLD.rubric_check_id)
        ELSE NEW.rubric_check_id
      END
    ) IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'submission_reviews' THEN
    existing_submission_review_id := NEW.id;
  ELSIF 'submission_review_id' = ANY (SELECT jsonb_object_keys(to_jsonb(NEW))) THEN
    existing_submission_review_id :=
      CASE
        WHEN TG_OP = 'UPDATE' THEN COALESCE(NEW.submission_review_id, OLD.submission_review_id)
        ELSE NEW.submission_review_id
      END;
    IF existing_submission_review_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    SELECT grading_review_id INTO existing_submission_review_id
    FROM public.submissions
    WHERE id = NEW.submission_id;
  END IF;

  IF existing_submission_review_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public._submission_review_recompute_scores(existing_submission_review_id);

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.submissionreviewrecompute() IS
  'Recompute submission review scores; on comment soft-delete/restore (deleted_at change), runs even at nested trigger depth and uses COALESCE(NEW, OLD) for rubric_check_id / submission_review_id.';
