set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.submissions_after_insert_hook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  new_review_id int8;
  the_grading_rubric_id int8;
  the_meta_grading_rubric_id int8;
  the_self_review_rubric_id int8;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      -- Get all rubric IDs for this assignment
      SELECT 
        grading_rubric_id, 
        meta_grading_rubric_id, 
        self_review_rubric_id 
      INTO 
        the_grading_rubric_id, 
        the_meta_grading_rubric_id, 
        the_self_review_rubric_id 
      FROM assignments 
      WHERE id = NEW.assignment_id;

      -- Create grading review (this already exists, keeping it)
      IF the_grading_rubric_id IS NOT NULL THEN
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
          NEW.class_id, 
          NEW.id, 
          'Grading', 
          the_grading_rubric_id,
          0,
          false
        ) RETURNING id INTO new_review_id;

        -- Update the submissions table with grading_review_id
        UPDATE public.submissions 
        SET grading_review_id = new_review_id 
        WHERE id = NEW.id;
      END IF;

      -- Create meta-grading review if meta-grading rubric exists
      IF the_meta_grading_rubric_id IS NOT NULL THEN
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
          NEW.class_id, 
          NEW.id, 
          'Meta-Grading', 
          the_meta_grading_rubric_id,
          0,
          false
        );
      END IF;

      -- Create self-review if self-review rubric exists
      IF the_self_review_rubric_id IS NOT NULL THEN
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
          NEW.class_id, 
          NEW.id, 
          'Self-Review', 
          the_self_review_rubric_id,
          0,
          false
        );
      END IF;

      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$function$
;


