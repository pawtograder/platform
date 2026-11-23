-- Review fixes for #1398's Forgejo archives (20261122160000_forgejo_repo_archives.sql).
--
-- 1. cleanup_individual_repositories_for_assignment keeps the Forgejo repos of students who are in no
--    group. Before #1398 the repositories DELETE guard refused this RPC on Forgejo. Now it deletes
--    the rows, and the delete trigger archives the repos, but forgejo_repos_needed lists every 'both'
--    student who is in no group: the next pass would make them a blank repo under the same name, and
--    their submissions would already be gone. The RPC is for students who got an individual repo and a
--    group repo by mistake, so on Forgejo only students in a group of this assignment are cleaned up.
--    GitHub rows are unchanged: nothing recreates them there, and existing callers rely on it.
--    A Forgejo row is no longer sent to enqueue_github_archive_repo (it was skipped as an org mismatch,
--    or by the by-name guard); the trigger queues it, and the summary counts it.
--    Body otherwise from 20261121160200_repository_status_by_capability.sql, the live definition.
-- 2. prepare_forgejo_repo_archive, which forgejo-reconciler calls before archiving a repo for the first
--    time. A group repo is queued when its last member leaves, and its row stays. If the group has
--    members again by the time the pass gets to it, the archive is skipped (the caller marks the entry
--    done with no new name). Otherwise the row is marked not ready, so forgejo_group_repos_needed lists
--    the group again once it has members, and the reconciler makes a new repo under that name.

CREATE OR REPLACE FUNCTION public.cleanup_individual_repositories_for_assignment(p_class_id bigint, p_assignment_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_github_org text;
    v_repo record;
    v_org_name text;
    v_repo_name text;
    v_individual_repo_ids bigint[];
    v_submission_ids bigint[];
    v_enqueued integer := 0;
    v_deleted_repos integer := 0;
    v_repositories_skipped_unparseable integer := 0;
    v_skipped_org_mismatch integer := 0;
    v_skipped_org_mismatch_details jsonb := '[]'::jsonb;
    v_forgejo_queued integer := 0;
    v_skipped_not_in_group integer := 0;
    v_kept_message text;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    -- #1010: manage_student_repositories in p_class_id. The assignment check and every query below stay
    -- inside that class.
    IF p_class_id IS NULL OR p_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_student_repositories')) THEN
        RAISE EXCEPTION 'Not authorized to clean up individual repositories in this class'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT github_org INTO v_github_org
    FROM public.classes
    WHERE id = p_class_id;

    IF v_github_org IS NULL OR v_github_org = '' THEN
        RAISE EXCEPTION 'Course has no GitHub organization configured';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.assignments a
        WHERE a.id = p_assignment_id AND a.class_id = p_class_id
    ) THEN
        RAISE EXCEPTION 'Assignment not found for this course';
    END IF;

    -- Lock the membership that makes each Forgejo repo eligible. A concurrent leave either
    -- happens first, preserving the repo, or waits until cleanup has finished.
    SELECT coalesce(array_agg(r.id) FILTER (
               WHERE r.git_provider <> 'forgejo' OR membership.found
           ), '{}'),
           count(*) FILTER (WHERE r.git_provider = 'forgejo' AND membership.found IS NULL)::integer
    INTO v_individual_repo_ids, v_skipped_not_in_group
    FROM public.repositories r
    LEFT JOIN LATERAL (
        SELECT true AS found
        FROM public.assignment_groups_members m
        WHERE r.git_provider = 'forgejo'
          AND m.assignment_id = r.assignment_id AND m.profile_id = r.profile_id
        LIMIT 1
        FOR UPDATE OF m
    ) membership ON true
    WHERE r.class_id = p_class_id
      AND r.assignment_id = p_assignment_id
      AND r.assignment_group_id IS NULL
      AND r.profile_id IS NOT NULL;

    IF v_skipped_not_in_group > 0 THEN
        v_kept_message := format(
            'Kept %s Forgejo %s for students who are not in a group.',
            v_skipped_not_in_group,
            CASE WHEN v_skipped_not_in_group = 1 THEN 'repository' ELSE 'repositories' END
        );
    END IF;

    IF cardinality(v_individual_repo_ids) = 0 THEN
        RETURN jsonb_build_object(
            'message', coalesce(v_kept_message, 'No individual repositories found for this assignment.'),
            'summary', jsonb_build_object(
                'repositories_enqueued_for_archive', 0,
                'repositories_deleted', 0,
                'submissions_deleted', 0,
                'repositories_skipped_unparseable', 0,
                'skipped_org_mismatch', 0,
                'skipped_org_mismatch_details', '[]'::jsonb,
                'forgejo_repositories_queued_for_archive', 0,
                'skipped_not_in_group', v_skipped_not_in_group
            )
        );
    END IF;

    SELECT coalesce(array_agg(s.id), '{}')
    INTO v_submission_ids
    FROM public.submissions s
    WHERE s.repository_id = ANY (v_individual_repo_ids);

    -- Enqueue GitHub archive for each individual repo that exists on GitHub
    FOR v_repo IN
        SELECT r.id, r.repository, r.is_github_ready, r.git_provider
        FROM public.repositories r
        WHERE r.id = ANY (v_individual_repo_ids)
    LOOP
        -- A Forgejo repo is queued in forgejo_repo_archives by the repositories delete trigger below.
        IF v_repo.git_provider = 'forgejo' THEN
            IF v_repo.repository LIKE '%_/_%' THEN
                v_forgejo_queued := v_forgejo_queued + 1;
            END IF;
            CONTINUE;
        END IF;

        IF v_repo.repository IS NULL
           OR v_repo.repository = ''
           OR position('/' IN v_repo.repository) = 0
        THEN
            v_repositories_skipped_unparseable := v_repositories_skipped_unparseable + 1;
            CONTINUE;
        END IF;

        v_org_name := split_part(v_repo.repository, '/', 1);
        v_repo_name := split_part(v_repo.repository, '/', 2);

        IF v_org_name IS NULL OR v_org_name = '' OR v_repo_name IS NULL OR v_repo_name = '' THEN
            v_repositories_skipped_unparseable := v_repositories_skipped_unparseable + 1;
            CONTINUE;
        END IF;

        IF v_org_name != v_github_org THEN
            v_skipped_org_mismatch := v_skipped_org_mismatch + 1;
            v_skipped_org_mismatch_details := v_skipped_org_mismatch_details || jsonb_build_array(
                jsonb_build_object(
                    'repository', v_repo.repository,
                    'org_name', v_org_name
                )
            );
            CONTINUE;
        END IF;

        IF coalesce(v_repo.is_github_ready, false) THEN
            PERFORM public.enqueue_github_archive_repo(
                p_class_id,
                v_org_name,
                v_repo_name,
                'cleanup-individual-repos-' || v_repo.id::text,
                'github'
            );
            v_enqueued := v_enqueued + 1;
        END IF;
    END LOOP;

    -- Delete submission graph for affected submissions (subset of delete_assignment_with_all_data)
    IF v_submission_ids IS NOT NULL AND cardinality(v_submission_ids) > 0 THEN
        UPDATE public.repository_check_runs rcr
        SET target_submission_id = NULL
        WHERE rcr.target_submission_id = ANY (v_submission_ids);

        UPDATE public.grader_results gr
        SET rerun_for_submission_id = NULL
        WHERE gr.rerun_for_submission_id = ANY (v_submission_ids);

        UPDATE public.assignment_leaderboard al
        SET submission_id = NULL
        WHERE al.submission_id = ANY (v_submission_ids);

        DELETE FROM public.submission_regrade_request_comments srrc
        USING public.submission_regrade_requests srr
        WHERE srrc.submission_regrade_request_id = srr.id
          AND srr.submission_id = ANY (v_submission_ids);

        UPDATE public.submission_comments sc
        SET regrade_request_id = NULL
        WHERE sc.regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests
            WHERE submission_id = ANY (v_submission_ids)
        );

        UPDATE public.submission_file_comments sfc
        SET regrade_request_id = NULL
        WHERE sfc.regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests
            WHERE submission_id = ANY (v_submission_ids)
        );

        UPDATE public.submission_artifact_comments sac
        SET regrade_request_id = NULL
        WHERE sac.regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests
            WHERE submission_id = ANY (v_submission_ids)
        );

        DELETE FROM public.submission_regrade_requests
        WHERE submission_id = ANY (v_submission_ids);

        DELETE FROM public.submission_artifact_comments sac
        USING public.submission_artifacts sa
        JOIN public.submissions s ON sa.submission_id = s.id
        WHERE sac.submission_artifact_id = sa.id
          AND s.id = ANY (v_submission_ids);

        DELETE FROM public.submission_artifacts sa
        USING public.submissions s
        WHERE sa.submission_id = s.id
          AND s.id = ANY (v_submission_ids);

        DELETE FROM public.submission_file_comments sfc
        USING public.submission_files sf
        JOIN public.submissions s ON sf.submission_id = s.id
        WHERE sfc.submission_file_id = sf.id
          AND s.id = ANY (v_submission_ids);

        DELETE FROM public.submission_files sf
        USING public.submissions s
        WHERE sf.submission_id = s.id
          AND s.id = ANY (v_submission_ids);

        DELETE FROM public.submission_comments sc
        USING public.submissions s
        WHERE sc.submission_id = s.id
          AND s.id = ANY (v_submission_ids)
          AND sc.regrade_request_id IS NULL;

        DELETE FROM public.grader_result_test_output grto
        USING public.grader_result_tests grt
        JOIN public.grader_results gr ON grt.grader_result_id = gr.id
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE grto.grader_result_test_id = grt.id
          AND s.id = ANY (v_submission_ids);

        DELETE FROM public.grader_result_tests grt
        USING public.grader_results gr
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE grt.grader_result_id = gr.id
          AND s.id = ANY (v_submission_ids);

        DELETE FROM public.grader_result_output gro
        USING public.grader_results gr
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE gro.grader_result_id = gr.id
          AND s.id = ANY (v_submission_ids);

        DELETE FROM public.grader_results gr
        USING public.submissions s
        WHERE gr.submission_id = s.id
          AND s.id = ANY (v_submission_ids);

        UPDATE public.submissions s
        SET grading_review_id = NULL
        WHERE s.id = ANY (v_submission_ids)
          AND s.grading_review_id IS NOT NULL;

        DELETE FROM public.review_assignments ra
        WHERE ra.submission_id = ANY (v_submission_ids);

        DELETE FROM public.submission_reviews sr
        USING public.submissions s
        WHERE sr.submission_id = s.id
          AND s.id = ANY (v_submission_ids);

        DELETE FROM public.submissions s
        WHERE s.id = ANY (v_submission_ids);
    END IF;

    v_deleted_repos := public.delete_repository_rows(v_individual_repo_ids);

    RETURN jsonb_build_object(
        'message', format(
            'Queued %s individual repositories for archival on GitHub and %s on Forgejo, and removed %s repository row(s) locally.',
            v_enqueued,
            v_forgejo_queued,
            v_deleted_repos
        ) || coalesce(' ' || v_kept_message, ''),
        'summary', jsonb_build_object(
            'repositories_enqueued_for_archive', v_enqueued,
            'repositories_deleted', v_deleted_repos,
            'submissions_deleted', coalesce(cardinality(v_submission_ids), 0)::integer,
            'repositories_skipped_unparseable', v_repositories_skipped_unparseable,
            'skipped_org_mismatch', v_skipped_org_mismatch,
            'skipped_org_mismatch_details', v_skipped_org_mismatch_details,
            'forgejo_repositories_queued_for_archive', v_forgejo_queued,
            'skipped_not_in_group', v_skipped_not_in_group
        )
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_individual_repositories_for_assignment(p_class_id bigint, p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_individual_repositories_for_assignment(p_class_id bigint, p_assignment_id bigint) TO authenticated, service_role;

-- False when the repo's row belongs to a group that has members again: the archive should not happen.
-- Otherwise marks the row (if one is left) not ready and returns true. p_repository is the entry's name,
-- lowercased like every Forgejo name Pawtograder stores, so it is compared as is.
CREATE OR REPLACE FUNCTION public.prepare_forgejo_repo_archive(p_repository text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.repositories r
    JOIN public.assignment_groups_members m ON m.assignment_group_id = r.assignment_group_id
    WHERE r.git_provider = 'forgejo' AND r.repository = p_repository
  ) THEN
    RETURN false;
  END IF;
  UPDATE public.repositories r SET is_github_ready = false
  WHERE r.git_provider = 'forgejo' AND r.repository = p_repository AND r.is_github_ready;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_forgejo_repo_archive(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_forgejo_repo_archive(text) TO service_role;

COMMENT ON COLUMN public.forgejo_repo_archives.archived_as IS
  'Where the repo was renamed to. Null once archived_at is set means nothing was renamed: the repo was deleted, was already gone, or was kept because its group had members again.';

-- The student handler calls this after checking the course enrollment and formation deadline.
-- Serialize departures before removing any member so one caller always observes the empty group.
CREATE OR REPLACE FUNCTION public.leave_forgejo_assignment_group(p_membership_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_assignment_id bigint;
  v_group_id bigint;
  v_repo record;
BEGIN
  SELECT m.assignment_id, m.assignment_group_id INTO v_assignment_id, v_group_id
  FROM public.assignment_groups_members m WHERE m.id = p_membership_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Take the assignment lock first, in the same order as assignment deletion.
  PERFORM 1 FROM public.assignments a
  WHERE a.id = v_assignment_id AND a.git_provider = 'forgejo' FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- This also orders the last-member check against inserts that reference the group.
  PERFORM 1 FROM public.assignment_groups g
  WHERE g.id = v_group_id AND g.assignment_id = v_assignment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- The existing membership DELETE trigger also records the departing student's access revocation.
  DELETE FROM public.assignment_groups_members m
  WHERE m.id = p_membership_id AND m.assignment_group_id = v_group_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.assignment_groups_members m WHERE m.assignment_group_id = v_group_id
  ) THEN
    FOR v_repo IN
      UPDATE public.repositories r SET is_github_ready = false
      WHERE r.assignment_group_id = v_group_id AND r.git_provider = 'forgejo'
      RETURNING r.class_id, r.repository
    LOOP
      PERFORM public.queue_forgejo_repo_archives(ARRAY[v_repo.class_id], ARRAY[v_repo.repository]);
    END LOOP;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.leave_forgejo_assignment_group(bigint) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_forgejo_assignment_group(bigint) TO service_role;
