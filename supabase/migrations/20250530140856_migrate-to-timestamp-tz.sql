DROP VIEW IF EXISTS public.submissions_with_grades_for_assignment_and_regression_test;
DROP VIEW IF EXISTS public.submissions_with_grades_for_assignment;

drop policy if exists "read assignments in own class if released or grader or instruct" on "public"."assignments";

ALTER TABLE public.assignments ALTER COLUMN release_date SET DATA TYPE timestamptz USING release_date::timestamptz;
ALTER TABLE public.assignments ALTER COLUMN due_date SET DATA TYPE timestamptz USING due_date::timestamptz;
ALTER TABLE public.assignments ALTER COLUMN group_formation_deadline SET DATA TYPE timestamptz USING group_formation_deadline::timestamptz;

UPDATE public.assignments a
SET release_date = (a.release_date AT TIME ZONE 'UTC'  AT TIME ZONE c.time_zone)
FROM public.classes c
WHERE a.class_id = c.id AND a.release_date IS NOT NULL;

UPDATE public.assignments a
SET due_date = (a.due_date AT TIME ZONE 'UTC'  AT TIME ZONE c.time_zone)
FROM public.classes c
WHERE a.class_id = c.id AND a.due_date IS NOT NULL;

UPDATE public.assignments a
SET group_formation_deadline = (a.group_formation_deadline  AT TIME ZONE 'UTC' AT TIME ZONE c.time_zone)
FROM public.classes c
WHERE a.class_id = c.id AND a.group_formation_deadline IS NOT NULL;

create policy "read assignments in own class if released or grader or instruct"
on "public"."assignments"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) OR (authorizeforclass(class_id) AND (release_date < now()) AND (archived_at IS NULL))));

create or replace view "public"."submissions_with_grades_for_assignment_and_regression_test" 
WITH ("security_invoker"='true') 
as  SELECT activesubmissionsbystudent.id,
    activesubmissionsbystudent.class_id,
    activesubmissionsbystudent.assignment_id,
    p.name,
    p.sortable_name,
    s.id AS activesubmissionid,
    s.created_at,
    s.released,
    s.repository,
    s.sha,
    rev.total_autograde_score AS autograder_score,
    ag.name AS groupname,
    ar.grader_sha,
    ar.grader_action_sha,
    ar_rt.score AS rt_autograder_score,
    ar_rt.grader_sha AS rt_grader_sha,
    ar_rt.grader_action_sha AS rt_grader_action_sha
   FROM ((((((((( SELECT r.id,
                CASE
                    WHEN (isub.id IS NULL) THEN gsub.id
                    ELSE isub.id
                END AS sub_id,
            r.private_profile_id,
            r.class_id,
            a.id AS assignment_id,
            agm.assignment_group_id AS assignmentgroupid,
            a.due_date
           FROM ((((user_roles r
             JOIN assignments a ON ((a.class_id = r.class_id)))
             LEFT JOIN submissions isub ON (((isub.profile_id = r.private_profile_id) AND (isub.is_active = true) AND (isub.assignment_id = a.id))))
             LEFT JOIN assignment_groups_members agm ON (((agm.profile_id = r.private_profile_id) AND (agm.assignment_id = a.id))))
             LEFT JOIN submissions gsub ON (((gsub.assignment_group_id = agm.id) AND (gsub.is_active = true) AND (gsub.assignment_id = a.id))))
          WHERE (r.role = 'student'::app_role)) activesubmissionsbystudent
     JOIN profiles p ON ((p.id = activesubmissionsbystudent.private_profile_id)))
     LEFT JOIN submissions s ON ((s.id = activesubmissionsbystudent.sub_id)))
     LEFT JOIN submission_reviews rev ON ((rev.id = s.grading_review_id)))
     LEFT JOIN grader_results ar ON ((ar.submission_id = s.id)))
     LEFT JOIN autograder_regression_test rt ON ((rt.repository = s.repository)))
     LEFT JOIN ( SELECT max(grader_results.id) AS id,
            grader_results.autograder_regression_test
           FROM grader_results
          GROUP BY grader_results.autograder_regression_test, grader_results.grader_sha) current_rt ON ((current_rt.autograder_regression_test = rt.id)))
     LEFT JOIN grader_results ar_rt ON ((ar_rt.id = current_rt.id)))
     LEFT JOIN assignment_groups ag ON ((ag.id = activesubmissionsbystudent.assignmentgroupid)));


create or replace view "public"."submissions_with_grades_for_assignment" 
WITH ("security_invoker"='true') 
as  SELECT activesubmissionsbystudent.id,
    activesubmissionsbystudent.class_id,
    activesubmissionsbystudent.assignment_id,
    p.name,
    p.sortable_name,
    s.id AS activesubmissionid,
    s.created_at,
    s.released,
    s.repository,
    s.sha,
    rev.total_autograde_score AS autograder_score,
    rev.grader,
    rev.meta_grader,
    rev.total_score,
    rev.tweak,
    rev.completed_by,
    rev.completed_at,
    rev.checked_at,
    rev.checked_by,
    graderprofile.name AS assignedgradername,
    metagraderprofile.name AS assignedmetagradername,
    completerprofile.name AS gradername,
    checkgraderprofile.name AS checkername,
    ag.name AS groupname,
    activesubmissionsbystudent.tokens_consumed,
    activesubmissionsbystudent.hours,
    activesubmissionsbystudent.due_date,
    (activesubmissionsbystudent.due_date + ('01:00:00'::interval * (activesubmissionsbystudent.hours)::double precision)) AS late_due_date,
    ar.grader_sha,
    ar.grader_action_sha
   FROM (((((((((( SELECT r.id,
                CASE
                    WHEN (isub.id IS NULL) THEN gsub.id
                    ELSE isub.id
                END AS sub_id,
            r.private_profile_id,
            r.class_id,
            a.id AS assignment_id,
            agm.assignment_group_id AS assignmentgroupid,
            lt.tokens_consumed,
            lt.hours,
            a.due_date
           FROM (((((user_roles r
             JOIN assignments a ON ((a.class_id = r.class_id)))
             LEFT JOIN submissions isub ON (((isub.profile_id = r.private_profile_id) AND (isub.is_active = true) AND (isub.assignment_id = a.id))))
             LEFT JOIN assignment_groups_members agm ON (((agm.profile_id = r.private_profile_id) AND (agm.assignment_id = a.id))))
             LEFT JOIN ( SELECT sum(assignment_due_date_exceptions.tokens_consumed) AS tokens_consumed,
                    sum(assignment_due_date_exceptions.hours) AS hours,
                    assignment_due_date_exceptions.student_id,
                    assignment_due_date_exceptions.assignment_group_id
                   FROM assignment_due_date_exceptions
                  GROUP BY assignment_due_date_exceptions.student_id, assignment_due_date_exceptions.assignment_group_id) lt ON ((((agm.assignment_group_id IS NULL) AND (lt.student_id = r.private_profile_id)) OR ((agm.assignment_group_id IS NOT NULL) AND (lt.assignment_group_id = agm.assignment_group_id)))))
             LEFT JOIN submissions gsub ON (((gsub.assignment_group_id = agm.id) AND (gsub.is_active = true) AND (gsub.assignment_id = a.id))))
          WHERE (r.role = 'student'::app_role)) activesubmissionsbystudent
     JOIN profiles p ON ((p.id = activesubmissionsbystudent.private_profile_id)))
     LEFT JOIN submissions s ON ((s.id = activesubmissionsbystudent.sub_id)))
     LEFT JOIN submission_reviews rev ON ((rev.id = s.grading_review_id)))
     LEFT JOIN grader_results ar ON ((ar.submission_id = s.id)))
     LEFT JOIN assignment_groups ag ON ((ag.id = activesubmissionsbystudent.assignmentgroupid)))
     LEFT JOIN profiles completerprofile ON ((completerprofile.id = rev.completed_by)))
     LEFT JOIN profiles graderprofile ON ((graderprofile.id = rev.grader)))
     LEFT JOIN profiles metagraderprofile ON ((metagraderprofile.id = rev.meta_grader)))
     LEFT JOIN profiles checkgraderprofile ON ((checkgraderprofile.id = rev.checked_by)));