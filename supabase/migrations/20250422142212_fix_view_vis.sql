drop view if exists "public"."autograder_regression_test_by_grader";

drop view if exists "public"."submissions_agg";

drop view if exists "public"."submissions_with_grades_for_assignment";

create or replace view "public"."autograder_regression_test_by_grader" WITH ("security_invoker"='true') as  SELECT a.grader_repo,
    t.repository,
    s.sha,
    t.id,
    s.class_id
   FROM (((autograder_regression_test t
     JOIN autograder a ON ((a.id = t.autograder_id)))
     JOIN submissions s ON ((s.repository = t.repository)))
     JOIN grader_results g ON ((g.submission_id = s.id)))
  GROUP BY s.sha, a.grader_repo, t.repository, s.created_at, t.id, s.class_id
 HAVING (s.created_at = max(s.created_at));


create or replace view "public"."submissions_agg" WITH ("security_invoker"='true') as  SELECT c.profile_id,
    p.name,
    p.sortable_name,
    p.avatar_url,
    groups.name AS groupname,
    c.submissioncount,
    c.latestsubmissionid,
    s.id,
    s.created_at,
    s.assignment_id,
    s.profile_id AS user_id,
    s.released,
    s.sha,
    s.repository,
    s.run_attempt,
    s.run_number,
    g.score,
    g.ret_code,
    g.execution_time
   FROM ((((( SELECT count(submissions.id) AS submissioncount,
            max(submissions.id) AS latestsubmissionid,
            r.private_profile_id AS profile_id
           FROM ((user_roles r
             LEFT JOIN assignment_groups_members m ON ((m.profile_id = r.private_profile_id)))
             LEFT JOIN submissions ON (((submissions.profile_id = r.private_profile_id) OR (submissions.assignment_group_id = m.assignment_group_id))))
          GROUP BY submissions.assignment_id, r.private_profile_id) c
     LEFT JOIN submissions s ON ((s.id = c.latestsubmissionid)))
     LEFT JOIN assignment_groups groups ON ((groups.id = s.assignment_group_id)))
     LEFT JOIN grader_results g ON ((g.submission_id = s.id)))
     JOIN profiles p ON ((p.id = c.profile_id)));


create or replace view "public"."submissions_with_grades_for_assignment" WITH ("security_invoker"='true') as  SELECT activesubmissionsbystudent.id,
    activesubmissionsbystudent.class_id,
    activesubmissionsbystudent.assignment_id,
    p.name,
    p.sortable_name,
    s.id AS activesubmissionid,
    s.created_at,
    s.released,
    s.repository,
    s.sha,
    ar.score AS autograder_score,
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
    (activesubmissionsbystudent.due_date + ('01:00:00'::interval * (activesubmissionsbystudent.hours)::double precision)) AS late_due_date
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