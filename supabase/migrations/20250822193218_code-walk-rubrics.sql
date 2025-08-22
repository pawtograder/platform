alter table "public"."rubrics" alter column "review_round" drop default;

alter type "public"."review_round" rename to "review_round__old_version_to_be_dropped";

create type "public"."review_round" as enum ('self-review', 'grading-review', 'meta-grading-review', 'code-walk');

alter table "public"."rubrics" alter column review_round type "public"."review_round" using review_round::text::"public"."review_round";

alter table "public"."rubrics" alter column "review_round" set default 'grading-review'::review_round;

drop type "public"."review_round__old_version_to_be_dropped";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.create_gradebook_column_for_code_walk_rubric()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  IF (TG_OP = 'INSERT' AND NEW.assignment_id IS NOT NULL AND NEW.review_round::text = 'code-walk') OR  
     (TG_OP = 'UPDATE'  
       AND NEW.assignment_id IS NOT NULL  
       AND NEW.review_round::text = 'code-walk'  
       AND (  
         (OLD.review_round IS DISTINCT FROM NEW.review_round)  
         OR (OLD.assignment_id IS DISTINCT FROM NEW.assignment_id)  
       )  
     ) THEN

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
$function$
;

-- Backfill submission reviews when a code-walk rubric is created
CREATE OR REPLACE FUNCTION public.create_submission_reviews_for_code_walk_rubric()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  submission_record RECORD;
  assignment_class_id bigint;
BEGIN
  -- Only process for code-walk rubrics with an assignment
  IF NEW.assignment_id IS NOT NULL AND NEW.review_round::text = 'code-walk' THEN
    
    -- Handle INSERT: always create submission reviews for all existing submissions
    -- Handle UPDATE: only if review_round changed TO code-walk or assignment_id changed
    IF TG_OP = 'INSERT' OR 
       (TG_OP = 'UPDATE' AND 
        ((OLD.review_round IS DISTINCT FROM NEW.review_round AND NEW.review_round::text = 'code-walk') OR
         (OLD.assignment_id IS DISTINCT FROM NEW.assignment_id))) THEN
      
      -- Get the class_id from the assignment
      SELECT a.class_id INTO assignment_class_id
      FROM public.assignments a
      WHERE a.id = NEW.assignment_id;
      
      -- Loop through all existing submissions for this assignment
      FOR submission_record IN
        SELECT s.id as submission_id, s.class_id
        FROM public.submissions s
        WHERE s.assignment_id = NEW.assignment_id
      LOOP
        -- Check if a submission review already exists for this rubric and submission
        -- This prevents duplicate reviews if the trigger runs multiple times
        IF NOT EXISTS (
          SELECT 1 
          FROM public.submission_reviews sr
          WHERE sr.submission_id = submission_record.submission_id 
            AND sr.rubric_id = NEW.id
        ) THEN
          -- Create the submission review for this code-walk rubric
          INSERT INTO public.submission_reviews (
            total_score, 
            tweak, 
            class_id, 
            submission_id, 
            name, 
            rubric_id, 
            total_autograde_score, 
            released
          ) VALUES (
            0, 
            0, 
            submission_record.class_id, 
            submission_record.submission_id, 
            COALESCE(NEW.name, 'Code Walk'), 
            NEW.id, 
            0, 
            false
          );
        END IF;
      END LOOP;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.submissions_after_insert_hook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  new_review_id bigint;
  the_grading_rubric_id bigint;
  the_meta_grading_rubric_id bigint;
  the_self_review_rubric_id bigint;
  cw_rubric RECORD;
BEGIN
  CASE TG_OP
  WHEN 'INSERT' THEN
    -- Existing behavior: load assignment rubric pointers
    SELECT grading_rubric_id, meta_grading_rubric_id, self_review_rubric_id
      INTO the_grading_rubric_id, the_meta_grading_rubric_id, the_self_review_rubric_id
      FROM public.assignments WHERE id = NEW.assignment_id;

    -- Grading Review
    IF the_grading_rubric_id IS NOT NULL THEN
      INSERT INTO public.submission_reviews (
        total_score, tweak, class_id, submission_id, name, rubric_id, total_autograde_score, released
      ) VALUES (
        0, 0, NEW.class_id, NEW.id, 'Grading', the_grading_rubric_id, 0, false
      ) RETURNING id INTO new_review_id;

      UPDATE public.submissions SET grading_review_id = new_review_id WHERE id = NEW.id;
    END IF;

    -- Meta-Grading Review
    IF the_meta_grading_rubric_id IS NOT NULL THEN
      INSERT INTO public.submission_reviews (
        total_score, tweak, class_id, submission_id, name, rubric_id, total_autograde_score, released
      ) VALUES (
        0, 0, NEW.class_id, NEW.id, 'Meta-Grading', the_meta_grading_rubric_id, 0, false
      );
    END IF;

    -- Self Review
    IF the_self_review_rubric_id IS NOT NULL THEN
      INSERT INTO public.submission_reviews (
        total_score, tweak, class_id, submission_id, name, rubric_id, total_autograde_score, released
      ) VALUES (
        0, 0, NEW.class_id, NEW.id, 'Self-Review', the_self_review_rubric_id, 0, false
      );
    END IF;

    -- Code Walk: find rubric(s) for this assignment with review_round = 'code-walk'
    FOR cw_rubric IN
      SELECT id, name FROM public.rubrics WHERE assignment_id = NEW.assignment_id AND review_round::text = 'code-walk'
    LOOP
      -- Create a submission review for each code-walk rubric if not already created in this INSERT (should not exist yet)
      INSERT INTO public.submission_reviews (
        total_score, tweak, class_id, submission_id, name, rubric_id, total_autograde_score, released
      ) VALUES (
        0, 0, NEW.class_id, NEW.id, COALESCE(cw_rubric.name, 'Code Walk'), cw_rubric.id, 0, false
      );
    END LOOP;

    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'Unexpected TG_OP: %', TG_OP;
  END CASE;
END
$function$
;

CREATE TRIGGER trigger_create_gradebook_column_for_code_walk_rubric_insert AFTER INSERT ON public.rubrics FOR EACH ROW EXECUTE FUNCTION create_gradebook_column_for_code_walk_rubric();

CREATE TRIGGER trigger_create_gradebook_column_for_code_walk_rubric_update AFTER UPDATE OF review_round, assignment_id ON public.rubrics FOR EACH ROW EXECUTE FUNCTION create_gradebook_column_for_code_walk_rubric();

-- Backfill submission reviews when a code-walk rubric is created
CREATE TRIGGER trigger_create_submission_reviews_for_code_walk_rubric AFTER INSERT OR UPDATE OF review_round, assignment_id ON public.rubrics FOR EACH ROW EXECUTE FUNCTION create_submission_reviews_for_code_walk_rubric();


