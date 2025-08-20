-- Auto-create code-walk submission reviews on new submissions; RPC for getting/creating reviews; and backfill

-- Update submissions_after_insert_hook to also create a code-walk submission review
CREATE OR REPLACE FUNCTION public.submissions_after_insert_hook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
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
$function$;

DROP FUNCTION IF EXISTS public.get_or_create_submission_review(bigint, bigint);

-- Backfill code-walk submission reviews for existing submissions
INSERT INTO public.submission_reviews (submission_id, rubric_id, class_id, total_score, total_autograde_score, tweak, released, name)
SELECT s.id, r.id, s.class_id, 0, 0, 0, false, COALESCE(r.name, 'Code Walk')
FROM public.submissions s
JOIN public.rubrics r ON r.assignment_id = s.assignment_id AND r.review_round::text = 'code-walk'
LEFT JOIN public.submission_reviews sr ON sr.submission_id = s.id AND sr.rubric_id = r.id
WHERE sr.id IS NULL;