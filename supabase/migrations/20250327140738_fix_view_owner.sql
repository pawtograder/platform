DROP view if exists "public"."autograder_regression_test_by_grader";
DROP view if exists "public"."submissions_agg";

create or replace view "public"."autograder_regression_test_by_grader" with (security_invoker) as  SELECT a.grader_repo,
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


create or replace view "public"."submissions_agg" with (security_invoker) as  SELECT c.submissioncount,
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
   FROM ((( SELECT count(submissions.id) AS submissioncount,
            max(submissions.id) AS latestsubmissionid
           FROM submissions
          GROUP BY submissions.assignment_id, submissions.profile_id) c
     JOIN submissions s ON ((s.id = c.latestsubmissionid)))
     LEFT JOIN grader_results g ON ((g.submission_id = s.id)));