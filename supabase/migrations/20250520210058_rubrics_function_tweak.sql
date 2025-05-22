set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.assignments_grader_config_auto_populate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    declare 
    rubric_id int;
    begin
  
  INSERT INTO autograder (id, class_id) VALUES (NEW.id, NEW.class_id);
  INSERT INTO autograder_regression_test (autograder_id,repository) VALUES (NEW.id, NEW.template_repo);
  INSERT INTO rubrics (name, class_id, assignment_id) VALUES ('Grading Rubric', NEW.class_id, NEW.id) RETURNING id into rubric_id;
  UPDATE assignments set grading_rubric_id=rubric_id WHERE id=NEW.id;
  RETURN NULL;
end;$function$
;


