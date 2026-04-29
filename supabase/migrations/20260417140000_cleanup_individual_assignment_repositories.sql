-- Remove mistaken individual student repos when an assignment should be group-only.
-- Archives repos via the async GitHub worker, then deletes local rows and submission data.

CREATE OR REPLACE FUNCTION public.cleanup_individual_repositories_for_assignment(
    p_class_id bigint,
    p_assignment_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_github_org text;
    v_repo record;
    v_org_name text;
    v_repo_name text;
    v_individual_repo_ids bigint[];
    v_submission_ids bigint[];
    v_enqueued integer := 0;
    v_deleted_repos integer := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT public.authorizeforclassinstructor(p_class_id) THEN
        RAISE EXCEPTION 'Only instructors can clean up individual repositories';
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

    SELECT coalesce(array_agg(r.id), '{}')
    INTO v_individual_repo_ids
    FROM public.repositories r
    WHERE r.class_id = p_class_id
      AND r.assignment_id = p_assignment_id
      AND r.assignment_group_id IS NULL
      AND r.profile_id IS NOT NULL;

    IF v_individual_repo_ids IS NULL OR cardinality(v_individual_repo_ids) = 0 THEN
        RETURN jsonb_build_object(
            'message', 'No individual repositories found for this assignment.',
            'summary', jsonb_build_object(
                'repositories_enqueued_for_archive', 0,
                'repositories_deleted', 0,
                'submissions_deleted', 0
            )
        );
    END IF;

    SELECT coalesce(array_agg(s.id), '{}')
    INTO v_submission_ids
    FROM public.submissions s
    WHERE s.repository_id = ANY (v_individual_repo_ids);

    -- Enqueue GitHub archive for each individual repo that exists on GitHub
    FOR v_repo IN
        SELECT r.id, r.repository, r.is_github_ready
        FROM public.repositories r
        WHERE r.id = ANY (v_individual_repo_ids)
    LOOP
        IF v_repo.repository IS NULL
           OR v_repo.repository = ''
           OR position('/' IN v_repo.repository) = 0
        THEN
            CONTINUE;
        END IF;

        v_org_name := split_part(v_repo.repository, '/', 1);
        v_repo_name := split_part(v_repo.repository, '/', 2);

        IF v_org_name IS NULL OR v_org_name = '' OR v_repo_name IS NULL OR v_repo_name = '' THEN
            CONTINUE;
        END IF;

        IF v_org_name != v_github_org THEN
            RAISE EXCEPTION 'Repository % org (%) does not match class github_org (%)',
                v_repo.repository, v_org_name, v_github_org;
        END IF;

        IF coalesce(v_repo.is_github_ready, false) THEN
            PERFORM public.enqueue_github_archive_repo(
                p_class_id,
                v_org_name,
                v_repo_name,
                'cleanup-individual-repos-' || v_repo.id::text
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

    DELETE FROM public.repository_check_runs rcr
    WHERE rcr.repository_id = ANY (v_individual_repo_ids);

    DELETE FROM public.workflow_events we
    WHERE we.repository_id = ANY (v_individual_repo_ids);

    DELETE FROM public.workflow_run_error wre
    WHERE wre.repository_id = ANY (v_individual_repo_ids);

    DELETE FROM public.repositories r
    WHERE r.id = ANY (v_individual_repo_ids);

    GET DIAGNOSTICS v_deleted_repos = ROW_COUNT;

    RETURN jsonb_build_object(
        'message', format(
            'Queued %s individual repositories for archival on GitHub and removed %s repository row(s) locally.',
            v_enqueued,
            v_deleted_repos
        ),
        'summary', jsonb_build_object(
            'repositories_enqueued_for_archive', v_enqueued,
            'repositories_deleted', v_deleted_repos,
            'submissions_deleted', coalesce(cardinality(v_submission_ids), 0)::integer
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_individual_repositories_for_assignment(bigint, bigint) FROM public;
GRANT EXECUTE ON FUNCTION public.cleanup_individual_repositories_for_assignment(bigint, bigint) TO authenticated;

COMMENT ON FUNCTION public.cleanup_individual_repositories_for_assignment IS
'Instructors only: for an assignment, enqueue async GitHub archive for each individual (non-group) student repository, delete related submissions and workflow rows, then remove repository records.';
