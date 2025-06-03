CREATE OR REPLACE FUNCTION public.assignments_grader_config_auto_populate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    declare 
    rubric_id int;
    self_rubric_id int;
    begin
  
  INSERT INTO autograder (id, class_id) VALUES (NEW.id, NEW.class_id);
  INSERT INTO autograder_regression_test (autograder_id,repository) VALUES (NEW.id, NEW.template_repo);
  INSERT INTO rubrics (name, class_id, assignment_id, review_round) VALUES ('Grading Rubric', NEW.class_id, NEW.id, 'grading-review') RETURNING id into rubric_id;
  INSERT INTO rubrics (name, class_id, assignment_id, review_round) VALUES ('Self-Review Rubric', NEW.class_id, NEW.id, 'self-review') RETURNING id into self_rubric_id;
  UPDATE assignments set grading_rubric_id=rubric_id WHERE id=NEW.id;
UPDATE assignments set self_review_rubric_id=self_rubric_id WHERE id=NEW.id;
  RETURN NULL;
end;$function$
;

drop policy "insert for self" on "public"."submission_artifact_comments";

drop policy "students view own, instructors and graders view all" on "public"."submission_artifact_comments";

drop policy "insert for self" on "public"."submission_comments";

drop policy "students view own, instructors and graders view all" on "public"."submission_comments";

drop policy "can only insert comments as self, for own files (instructors an" on "public"."submission_file_comments";

drop policy "students view own, instructors and graders view all" on "public"."submission_file_comments";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.authorize_for_submission_review(submission_review_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
    -- Only view submission reviews if the review is released or there is a review assignment for the user
    return (
        select exists (
            select 1
            from submission_reviews sr
            left join review_assignments ra
                on ra.submission_review_id = sr.id
            left join user_roles ur on ur.private_profile_id = ra.assignee_profile_id and ur.class_id=sr.class_id
            where sr.id=authorize_for_submission_review.submission_review_id and ((sr.released and authorize_for_submission(sr.submission_id)) or ur.user_id = auth.uid())
        )
    );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.assignments_grader_config_auto_populate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    declare 
    rubric_id int;
    self_rubric_id int;
    begin
  
  INSERT INTO autograder (id, class_id) VALUES (NEW.id, NEW.class_id);
  INSERT INTO autograder_regression_test (autograder_id,repository) VALUES (NEW.id, NEW.template_repo);
  INSERT INTO rubrics (name, class_id, assignment_id, review_round) VALUES ('Grading Rubric', NEW.class_id, NEW.id, 'grading-review') RETURNING id into rubric_id;
  INSERT INTO rubrics (name, class_id, assignment_id, review_round) VALUES ('Self-Review Rubric', NEW.class_id, NEW.id, 'self-review') RETURNING id into self_rubric_id;
  UPDATE assignments set grading_rubric_id=rubric_id WHERE id=NEW.id;
UPDATE assignments set self_review_rubric_id=self_rubric_id WHERE id=NEW.id;
  RETURN NULL;
end;$function$
;

DROP policy "students read only their own if released, instructors and grade" on "public"."submission_reviews";
create policy "students read only their own if released, instructors and grade"
on "public"."submission_reviews"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) OR authorize_for_submission_review(id)));

CREATE OR REPLACE FUNCTION public.auto_assign_self_reviews(this_assignment_id bigint, this_profile_id uuid) 
RETURNS void 
LANGUAGE plpgsql 
SECURITY DEFINER
AS $$ 
DECLARE     
    this_assignment public.assignments;     
    this_group_id bigint; 
    this_self_review_setting public.self_review_settings;     
    this_net_deadline_change_hours integer := 0;     
    this_net_deadline_change_minutes integer := 0;     
    this_active_submission_id bigint;
    existing_submission_review_id bigint;
    utc_now TIMESTAMP := date_trunc('minute', now() + interval '59 second'); -- round up to nearest minute
BEGIN    
    -- Get the assignment first     
    SELECT * INTO this_assignment FROM public.assignments WHERE id = this_assignment_id;          
    
    -- Check if assignment exists     
    IF this_assignment.id IS NULL THEN 
        RETURN;          
    END IF;      
    
    -- Confirm this is a private profile for a student in this class, else abort     
    IF NOT EXISTS (         
        SELECT 1 FROM user_roles          
        WHERE private_profile_id = this_profile_id          
        AND role = 'student'
        AND class_id = this_assignment.class_id     
    ) THEN  
        RETURN;
    END IF;      
    
    -- Get the group of the student for this assignment     
    SELECT assignment_group_id INTO this_group_id      
    FROM public.assignment_groups_members      
    WHERE profile_id = this_profile_id      
    AND class_id = this_assignment.class_id      
    AND assignment_id = this_assignment.id      
    LIMIT 1;      
    
    -- Get the self review setting     
    SELECT * INTO this_self_review_setting      
    FROM public.self_review_settings      
    WHERE id = this_assignment.self_review_setting_id;
    
    -- If self reviews are not enabled for this assignment, abort     
    IF this_self_review_setting.enabled IS NOT TRUE THEN       
        RETURN;       
    END IF;          
    
    -- If there is an existing review assignment for this student for this assignment, abort     
    IF EXISTS (         
        SELECT 1 FROM review_assignments          
        WHERE assignment_id = this_assignment.id          
        AND assignee_profile_id = this_profile_id     
    ) THEN 
       RETURN;       
    END IF;      
    
    SELECT COALESCE(SUM("hours"), 0) INTO this_net_deadline_change_hours      
    FROM public.assignment_due_date_exceptions      
    WHERE assignment_id = this_assignment.id      
    AND (student_id = this_profile_id OR assignment_group_id = this_group_id);     

    SELECT COALESCE(SUM("minutes"), 0) INTO this_net_deadline_change_minutes 
    FROM public.assignment_due_date_exceptions      
    WHERE assignment_id = this_assignment.id      
    AND (student_id = this_profile_id OR assignment_group_id = this_group_id);     

    
    -- If deadline has not passed, abort     
    IF NOT (this_assignment.due_date AT TIME ZONE 'UTC' + INTERVAL '1 hour' * this_net_deadline_change_hours  + 
    INTERVAL '1 minute' * this_net_deadline_change_minutes <= utc_now) THEN         
       RETURN;       
    END IF;      
    
    -- Get the active submission id for this profile     
    SELECT id INTO this_active_submission_id      
    FROM public.submissions      
    WHERE ((profile_id IS NOT NULL AND profile_id = this_profile_id) OR (assignment_group_id IS NOT NULL AND assignment_group_id = this_group_id)) 
    AND assignment_id = this_assignment_id
    AND is_active = true     
    LIMIT 1;      
    
    -- If active submission does not exist, abort     
    IF this_active_submission_id IS NULL THEN  
        RETURN;       
    END IF;          

    SELECT id INTO existing_submission_review_id
    FROM public.submission_reviews
    WHERE submission_id = this_active_submission_id
    AND class_id = this_assignment.class_id
    AND rubric_id = this_assignment.self_review_rubric_id
    LIMIT 1;

    IF existing_submission_review_id IS NULL THEN
        INSERT INTO submission_reviews (total_score, released,tweak,class_id,submission_id,name,rubric_id)
        VALUES (0, false, 0, this_assignment.class_id, this_active_submission_id, 'Self Review', this_assignment.self_review_rubric_id)
        RETURNING id INTO existing_submission_review_id;
    END IF;

    INSERT INTO review_assignments (   
        due_date,         
        assignee_profile_id,         
        submission_id,         
        submission_review_id,
        assignment_id,         
        rubric_id,         
        class_id   
    )     
    VALUES (        
        this_assignment.due_date AT TIME ZONE 'UTC' + (INTERVAL '1 hour' * this_net_deadline_change_hours) + (INTERVAL '1 minute' * this_net_deadline_change_minutes) + (INTERVAL '1 hour' * this_self_review_setting.deadline_offset),
        this_profile_id,         
        this_active_submission_id,         
        existing_submission_review_id,
        this_assignment.id,         
        this_assignment.self_review_rubric_id,         
        this_assignment.class_id
    );
END; 
$$;
create policy "insert for self"
on "public"."submission_artifact_comments"
as permissive
for insert
to public
with check ((authorizeforprofile(author) AND (authorizeforclassgrader(class_id) OR ((submission_review_id IS NULL) AND authorize_for_submission(submission_id)) OR authorize_for_submission_review(submission_review_id))));


create policy "students view own, instructors and graders view all"
on "public"."submission_artifact_comments"
as permissive
for select
to public
using ((authorizeforprofile(author) AND (authorizeforclassgrader(class_id) OR ((submission_review_id IS NULL) AND authorize_for_submission(submission_id)) OR authorize_for_submission_review(submission_review_id))));


create policy "insert for self"
on "public"."submission_comments"
as permissive
for insert
to public
with check ((authorizeforprofile(author) AND (authorizeforclassgrader(class_id) OR ((submission_review_id IS NULL) AND authorize_for_submission(submission_id)) OR authorize_for_submission_review(submission_review_id))));


create policy "students view own, instructors and graders view all"
on "public"."submission_comments"
as permissive
for select
to public
using ((authorizeforprofile(author) AND (authorizeforclassgrader(class_id) OR ((submission_review_id IS NULL) AND authorize_for_submission(submission_id)) OR authorize_for_submission_review(submission_review_id))));


create policy "can only insert comments as self, for own files (instructors an"
on "public"."submission_file_comments"
as permissive
for insert
to public
with check (true);


create policy "students view own, instructors and graders view all"
on "public"."submission_file_comments"
as permissive
for select
to public
using ((authorizeforprofile(author) AND (authorizeforclassgrader(class_id) OR ((submission_review_id IS NULL) AND authorize_for_submission(submission_id)) OR authorize_for_submission_review(submission_review_id))));


alter table "public"."review_assignments" add column "submission_review_id" bigint not null;

alter table "public"."review_assignments" add constraint "review_assignments_submission_review_id_fkey" FOREIGN KEY (submission_review_id) REFERENCES submission_reviews(id) not valid;

alter table "public"."review_assignments" validate constraint "review_assignments_submission_review_id_fkey";