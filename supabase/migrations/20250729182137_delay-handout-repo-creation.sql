CREATE OR REPLACE FUNCTION public.assignments_grader_config_auto_populate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    declare 
    rubric_id int;
    self_rubric_id int;
    begin
  
  INSERT INTO autograder (id, class_id) VALUES (NEW.id, NEW.class_id);
  INSERT INTO rubrics (name, class_id, assignment_id, review_round) VALUES ('Grading Rubric', NEW.class_id, NEW.id, 'grading-review') RETURNING id into rubric_id;
  INSERT INTO rubrics (name, class_id, assignment_id, review_round) VALUES ('Self-Review Rubric', NEW.class_id, NEW.id, 'self-review') RETURNING id into self_rubric_id;
  UPDATE assignments set grading_rubric_id=rubric_id WHERE id=NEW.id;
  UPDATE assignments set self_review_rubric_id=self_rubric_id WHERE id=NEW.id;
  RETURN NULL;
end;$function$
;