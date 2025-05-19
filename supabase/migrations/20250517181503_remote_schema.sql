set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.submissionreviewreleasecascade()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
is_grading_review boolean;
begin

if NEW.released != OLD.released then
  UPDATE public.submission_file_comments set released=NEW.released WHERE submission_review_id=NEW.id;
  UPDATE public.submission_comments set released=NEW.released WHERE submission_review_id=NEW.id;
  UPDATE public.submission_artifact_comments set released=NEW.released WHERE submission_review_id=NEW.id;
  UPDATE public.grader_result_tests set is_released=NEW.released FROM grader_results where
    grader_results.id=grader_result_tests.grader_result_id AND grader_results.submission_id=NEW.submission_id AND NEW.released = true;
  -- If this is the "Grading" review, then set the released flag on the submission, to_regrole
  select COUNT(*)>0 into is_grading_review from submissions where grading_review_id = NEW.id and id=NEW.submission_id;
  if is_grading_review then
    if NEW.released then
      update submissions set released=NOW() WHERE id=NEW.submission_id;
    else
      update submissions set released=null WHERE id=NEW.submission_id;
    end if;
  end if;
end if;
return NEW;
end;
$function$
;


