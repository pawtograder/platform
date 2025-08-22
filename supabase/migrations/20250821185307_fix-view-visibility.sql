create or replace view "public"."submissions_agg" WITH ("security_invoker"='true') as SELECT c.profile_id,
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
