-- Add 'code-walk' to review_round enum if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'review_round' AND e.enumlabel = 'code-walk'
  ) THEN
    ALTER TYPE public.review_round ADD VALUE 'code-walk';
  END IF;
END$$;

-- Helper function: create gradebook column for a rubric with review_round = 'code-walk'
CREATE OR REPLACE FUNCTION public.create_gradebook_column_for_code_walk_rubric()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  assignment_slug text;
  assignment_title text;
  assignment_total_points numeric;
  assignment_class_id bigint;
  gradebook_id bigint;
  new_slug text;
BEGIN
  -- Only act when we have an assignment_id and the rubric is for code-walk
  IF (TG_OP = 'INSERT' AND NEW.assignment_id IS NOT NULL AND NEW.review_round = 'code-walk') OR
     (TG_OP = 'UPDATE' AND NEW.assignment_id IS NOT NULL AND NEW.review_round = 'code-walk' AND (OLD.review_round IS DISTINCT FROM NEW.review_round)) THEN

    SELECT a.slug, a.title, a.total_points, a.class_id
      INTO assignment_slug, assignment_title, assignment_total_points, assignment_class_id
      FROM public.assignments a
     WHERE a.id = NEW.assignment_id;

    IF assignment_slug IS NULL THEN
      RETURN NEW;
    END IF;

    -- Get the gradebook for the class
    SELECT g.id INTO gradebook_id FROM public.gradebooks g WHERE g.class_id = assignment_class_id;

    IF gradebook_id IS NULL THEN
      RETURN NEW;
    END IF;

    new_slug := 'assignment-' || assignment_slug || '-code-walk';

    -- Only create if a column with this slug doesn't already exist
    IF NOT EXISTS (
      SELECT 1 FROM public.gradebook_columns gc
      WHERE gc.class_id = assignment_class_id AND gc.slug = new_slug
    ) THEN
      INSERT INTO public.gradebook_columns (
        name,
        max_score,
        slug,
        class_id,
        gradebook_id,
        score_expression,
        released,
        dependencies
      ) VALUES (
        COALESCE('Code Walk: ' || assignment_title, 'Code Walk'),
        assignment_total_points,
        new_slug,
        assignment_class_id,
        gradebook_id,
        'assignments("' || assignment_slug || '", "code-walk")',
        false,
        jsonb_build_object('assignments', jsonb_build_array(NEW.assignment_id))
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Triggers for INSERT and UPDATE on rubrics
DROP TRIGGER IF EXISTS trigger_create_gradebook_column_for_code_walk_rubric_insert ON public.rubrics;
CREATE TRIGGER trigger_create_gradebook_column_for_code_walk_rubric_insert
AFTER INSERT ON public.rubrics
FOR EACH ROW
EXECUTE FUNCTION public.create_gradebook_column_for_code_walk_rubric();

DROP TRIGGER IF EXISTS trigger_create_gradebook_column_for_code_walk_rubric_update ON public.rubrics;
CREATE TRIGGER trigger_create_gradebook_column_for_code_walk_rubric_update
AFTER UPDATE OF review_round, assignment_id ON public.rubrics
FOR EACH ROW
EXECUTE FUNCTION public.create_gradebook_column_for_code_walk_rubric();

-- Backfill: create gradebook columns for any existing 'code-walk' rubrics without a column
WITH cw AS (
  SELECT r.id as rubric_id, r.assignment_id, a.slug, a.title, a.total_points, a.class_id, g.id as gradebook_id
  FROM public.rubrics r
  JOIN public.assignments a ON a.id = r.assignment_id
  JOIN public.gradebooks g ON g.class_id = a.class_id
  WHERE r.review_round = 'code-walk' AND r.assignment_id IS NOT NULL
),
missing AS (
  SELECT cw.*
  FROM cw
  LEFT JOIN public.gradebook_columns gc
    ON gc.class_id = cw.class_id AND gc.slug = 'assignment-' || cw.slug || '-code-walk'
  WHERE gc.id IS NULL
)
INSERT INTO public.gradebook_columns (
  name,
  max_score,
  slug,
  class_id,
  gradebook_id,
  score_expression,
  released,
  dependencies
)
SELECT
  'Code Walk: ' || m.title,
  m.total_points,
  'assignment-' || m.slug || '-code-walk',
  m.class_id,
  m.gradebook_id,
  'assignments("' || m.slug || '", "code-walk")',
  false,
  jsonb_build_object('assignments', jsonb_build_array(m.assignment_id))
FROM missing m;