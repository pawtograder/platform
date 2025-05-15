alter table "public"."assignments" add column "self_rubric_id" bigint;

alter table "public"."assignments" add constraint "assignments_self_rubric_id_fkey" FOREIGN KEY (self_rubric_id) REFERENCES rubrics(id) not valid;

alter table "public"."assignments" validate constraint "assignments_self_rubric_id_fkey";

-- auto create a  when assignment created

CREATE OR REPLACE FUNCTION public.assignments_grader_config_auto_populate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    declare 
    rubric_id int;
    s_rubric_id int;
    begin
  
  INSERT INTO autograder (id, class_id) VALUES (NEW.id, NEW.class_id);
  INSERT INTO autograder_regression_test (autograder_id,repository) VALUES (NEW.id, NEW.template_repo);
  INSERT INTO rubrics (name, class_id) VALUES ('Grading Rubric', NEW.class_id) RETURNING id into rubric_id;
    UPDATE assignments set grading_rubric_id=rubric_id WHERE id=NEW.id;
INSERT INTO rubrics (name, class_id) VALUES ('Self Rubric', NEW.class_id) RETURNING id into s_rubric_id;
  UPDATE assignments set self_rubric_id=s_rubric_id WHERE id=NEW.id;
  RETURN NULL;
end;$function$
;


-- add column to checks for submission comment regex

alter table "public"."rubric_checks" add column "comment_regex" text;

