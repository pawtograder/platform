create or replace view "public"."autograder_regression_test_by_grader" with (security_invoker) as  

SELECT a.grader_repo,
    t.repository,
    s.sha,
    t.id,
    s.class_id
    FROM
autograder_regression_test t
     JOIN autograder a ON a.id = t.autograder_id
     JOIN (SELECT s.repository,max(s.id) as sid
   FROM submissions s
   JOIN autograder_regression_test t ON s.repository = t.repository
  GROUP BY s.repository) z on z.repository=t.repository
    JOIN submissions s on s.id=z.sid;

alter table classes
add column github_org text null;