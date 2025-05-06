CREATE OR REPLACE FUNCTION public.handle_rubric_check_points_update()
RETURNS TRIGGER AS $$
BEGIN
  -- This condition ensures the updates only run if the 'points' value actually changed.
  -- It correctly handles NULLs as well, should 'points' ever be nullable
  -- (though it typically seems to be a non-null number for rubric_checks).
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
  END IF;

  RETURN NEW; -- For AFTER triggers, the return value is ignored, but it's good practice.
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop the trigger first if it already exists to avoid errors during re-creation
DROP TRIGGER IF EXISTS on_rubric_check_points_updated ON public.rubric_checks;

CREATE TRIGGER on_rubric_check_points_updated
AFTER UPDATE OF points ON public.rubric_checks
FOR EACH ROW
EXECUTE FUNCTION public.handle_rubric_check_points_update();
