DROP VIEW IF EXISTS public.submissions_with_grades_for_assignment;

create or replace view "public"."submissions_with_grades_for_assignment" 
WITH ("security_invoker"='true') 
as  SELECT activesubmissionsbystudent.id,
    activesubmissionsbystudent.class_id,
    activesubmissionsbystudent.assignment_id,
    p.id as student_private_profile_id,
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