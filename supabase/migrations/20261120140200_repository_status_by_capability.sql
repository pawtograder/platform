-- #1010: the Repository Status actions follow the manage_student_repositories capability.
--
-- Why: Retry creation, Fix Permissions and Cleanup individual repositories on Repository Status were
-- decided by "is this user an instructor in the class". An instructor who wants a Head TA to keep
-- student repositories working had no way to allow it. Now one capability decides, in the database
-- and on the screen.
--
-- What:
--   1. New capability manage_student_repositories, on the default instructor role of every class.
--      It isn't on the default grader role or on custom roles (graders can't use these buttons
--      today), so a Head TA gets it only when an instructor turns it on. Cleanup deletes the
--      submissions of the assignment's individual repositories and archives the repositories, so the
--      description says so.
--   2. retry_repository_creation, fix_assignment_repo_permissions and
--      cleanup_individual_repositories_for_assignment check manage_student_repositories instead of
--      authorizeforclassinstructor. Each is the latest body with only that check changed, and a
--      refusal now raises 42501 (insufficient_privilege). Each still acts on one class only:
--      retry_repository_creation reads the class from the repository row, and the other two only read
--      and change rows of p_class_id. Signatures, grants and search_path are unchanged.
--
-- Who gains or loses: instructors hold every capability, so nothing changes for them. Default
-- graders, students and admins hold no manage_student_repositories, so they still can't run these.
-- Only a grader on a custom role with manage_student_repositories turned on gains them. The service
-- role was refused by all three before (no signed-in user) and still is.
--
-- Not changed: queue_repository_syncs (the Sync buttons; it follows manage_assignments because Edit
-- Assignment uses it), Resend invitation, Rerun Autograder and its functions, the functions that
-- create submissions, and the SELECT policies on repositories (who can see the table).
--
-- Safe to run again: the inserts skip rows that exist, and CREATE OR REPLACE gives the same functions.

-- ---------------------------------------------------------------------------
-- 1. The capability, on every default instructor role
-- ---------------------------------------------------------------------------

INSERT INTO public.capabilities (name, description)
VALUES (
  'manage_student_repositories',
  'Retry repository creation, fix repository permissions, and clean up individual repositories (deletes their submissions and archives the repos)'
)
ON CONFLICT (name) DO NOTHING;

-- New classes get it from seed_default_class_roles(), which gives the instructor role every
-- capability. Existing classes need it added here.
INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'manage_student_repositories'
FROM public.class_roles cr
WHERE cr.default_for = 'instructor'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2a. retry_repository_creation
-- ---------------------------------------------------------------------------

-- The body from 20260816120000_bound_repo_creation_retries.sql, with only the access check changed.
CREATE OR REPLACE FUNCTION public.retry_repository_creation(p_repository_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_class_id bigint;
  v_msg_id bigint;
begin
  select class_id into v_class_id from public.repositories where id = p_repository_id;
  if not found then
    raise exception 'Repository % not found', p_repository_id;
  end if;
  -- #1010: manage_student_repositories in the repository's own class (loaded above, not passed in).
  if v_class_id not in (select public.user_class_ids_with_capability('manage_student_repositories')) then
    raise exception 'Not authorized to retry repository creation for this class'
      using errcode = 'insufficient_privilege';
  end if;

  update public.repositories
     set creation_error = null
   where id = p_repository_id;

  v_msg_id := public.enqueue_create_repo_for_repository(p_repository_id);

  if v_msg_id is null then
    -- Nothing was queued, so clearing the error above would strand the row: it would sit
    -- at is_github_ready = false with no error, which the UI reads as "creation pending"
    -- and which hides the Retry button, while the reconciler skips it too. That is the
    -- same dead end this migration keeps closing, reached through the Retry button.
    --
    -- enqueue_create_repo_for_repository returns null in two cases. For repo_mode 'none'
    -- and 'no_submission' it queues nothing because those assignments never get a
    -- repository -- most likely a leftover row from before the mode was changed, which an
    -- instructor should be told about rather than left to click Retry forever. For an
    -- unresolvable fork source it has already written its own, more specific error, so
    -- coalesce keeps that rather than overwriting it with this generic one.
    update public.repositories
       set creation_error = coalesce(
             creation_error,
             'This assignment no longer creates GitHub repositories, so this leftover repository row cannot be created. It can be removed.')
     where id = p_repository_id;
    return null;
  end if;

  -- Zero the counter AFTER the enqueue, not before: enqueue_create_repo_for_repository
  -- increments it, so resetting first would leave the instructor with seven automatic
  -- retries rather than the full budget. A deliberate manual retry states that the
  -- underlying problem is fixed, so it does not spend an automatic attempt. The
  -- updated_at bump from the enqueue survives (this write refreshes it again), so the
  -- reconciler's stale window still keeps a second job from racing this one.
  update public.repositories
     set creation_attempts = 0
   where id = p_repository_id;

  return v_msg_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2b. fix_assignment_repo_permissions
-- ---------------------------------------------------------------------------

-- The body from 20260310000000_fix_assignment_repo_permissions_rpc.sql, with only the access check
-- changed.
CREATE OR REPLACE FUNCTION public.fix_assignment_repo_permissions(p_class_id bigint, p_assignment_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_course_slug text;
    v_github_org  text;
    v_repo        record;
    v_org_name    text;
    v_repo_name   text;
    v_usernames   text[];

    v_total            integer := 0;
    v_enqueued         integer := 0;
    v_skipped_no_users integer := 0;
    v_skipped_not_ready integer := 0;
    v_errors           integer := 0;
    v_details          jsonb[] := '{}';
BEGIN
    -- Auth check
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    -- #1010: manage_student_repositories in p_class_id. The loop below only reads repositories of
    -- that class.
    IF p_class_id IS NULL OR p_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_student_repositories')) THEN
        RAISE EXCEPTION 'Not authorized to fix repository permissions in this class'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Fetch class metadata once
    SELECT slug, github_org INTO v_course_slug, v_github_org
    FROM public.classes
    WHERE id = p_class_id;

    IF v_course_slug IS NULL THEN
        RAISE EXCEPTION 'Course not found';
    END IF;
    IF v_github_org IS NULL OR v_github_org = '' THEN
        RAISE EXCEPTION 'Course has no GitHub organization configured';
    END IF;

    -- Iterate every repository for this assignment
    FOR v_repo IN
        SELECT
            r.id,
            r.repository,
            r.profile_id,
            r.assignment_group_id,
            r.is_github_ready
        FROM public.repositories r
        WHERE r.assignment_id = p_assignment_id
          AND r.class_id = p_class_id
          AND r.repository IS NOT NULL
          AND r.repository != ''
          AND position('/' in r.repository) > 0
    LOOP
        v_total := v_total + 1;

        BEGIN
            -- Skip repos that haven't been created on GitHub yet
            IF NOT v_repo.is_github_ready THEN
                v_skipped_not_ready := v_skipped_not_ready + 1;
                v_details := array_append(v_details, jsonb_build_object(
                    'repository_id', v_repo.id,
                    'repository', v_repo.repository,
                    'action', 'skipped_not_ready'
                ));
                CONTINUE;
            END IF;

            v_usernames := NULL;

            IF v_repo.assignment_group_id IS NOT NULL THEN
                -- Group repo: collect every group member's GitHub username
                SELECT array_remove(array_agg(u.github_username), NULL)
                INTO v_usernames
                FROM public.assignment_groups_members agm
                JOIN public.user_roles ur ON ur.private_profile_id = agm.profile_id
                JOIN public.users u ON u.user_id = ur.user_id
                WHERE agm.assignment_group_id = v_repo.assignment_group_id
                  AND ur.class_id = p_class_id
                  AND ur.role = 'student'
                  AND ur.github_org_confirmed = true
                  AND u.github_username IS NOT NULL
                  AND u.github_username != '';

            ELSIF v_repo.profile_id IS NOT NULL THEN
                -- Individual repo: single student
                SELECT array_remove(array_agg(u.github_username), NULL)
                INTO v_usernames
                FROM public.user_roles ur
                JOIN public.users u ON u.user_id = ur.user_id
                WHERE ur.private_profile_id = v_repo.profile_id
                  AND ur.class_id = p_class_id
                  AND ur.role = 'student'
                  AND ur.github_org_confirmed = true
                  AND u.github_username IS NOT NULL
                  AND u.github_username != '';
            END IF;

            IF v_usernames IS NULL OR array_length(v_usernames, 1) IS NULL THEN
                v_skipped_no_users := v_skipped_no_users + 1;
                v_details := array_append(v_details, jsonb_build_object(
                    'repository_id', v_repo.id,
                    'repository', v_repo.repository,
                    'action', 'skipped_no_usernames'
                ));
                CONTINUE;
            END IF;

            v_org_name  := split_part(v_repo.repository, '/', 1);
            v_repo_name := split_part(v_repo.repository, '/', 2);

            IF v_org_name != v_github_org THEN
                RAISE EXCEPTION 'Repository % org (%) does not match class github_org (%)', v_repo.repository, v_org_name, v_github_org;
            END IF;

            PERFORM public.enqueue_github_sync_repo_permissions(
                p_class_id,
                v_org_name,
                v_repo_name,
                v_course_slug,
                v_usernames,
                'fix-repo-permissions-' || p_assignment_id::text || '-' || v_repo.id::text
            );

            v_enqueued := v_enqueued + 1;
            v_details := array_append(v_details, jsonb_build_object(
                'repository_id', v_repo.id,
                'repository', v_repo.repository,
                'action', 'enqueued_sync',
                'expected_usernames', to_jsonb(v_usernames)
            ));

        EXCEPTION WHEN OTHERS THEN
            v_errors := v_errors + 1;
            v_details := array_append(v_details, jsonb_build_object(
                'repository_id', v_repo.id,
                'repository', v_repo.repository,
                'action', 'error',
                'error_message', SQLERRM
            ));
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'message', format(
            'Audited %s repositories: %s syncs enqueued, %s skipped (no usernames), %s skipped (not ready), %s errors',
            v_total, v_enqueued, v_skipped_no_users, v_skipped_not_ready, v_errors
        ),
        'summary', jsonb_build_object(
            'total', v_total,
            'enqueued_sync', v_enqueued,
            'skipped_no_usernames', v_skipped_no_users,
            'skipped_not_ready', v_skipped_not_ready,
            'errors', v_errors
        ),
        'results', to_jsonb(v_details)
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2c. cleanup_individual_repositories_for_assignment
-- ---------------------------------------------------------------------------

-- The body from 20260417140000_cleanup_individual_assignment_repositories.sql, with only the access
-- check changed.
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
                'submissions_deleted', 0,
                'repositories_skipped_unparseable', 0,
                'skipped_org_mismatch', 0,
                'skipped_org_mismatch_details', '[]'::jsonb
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
            'submissions_deleted', coalesce(cardinality(v_submission_ids), 0)::integer,
            'repositories_skipped_unparseable', v_repositories_skipped_unparseable,
            'skipped_org_mismatch', v_skipped_org_mismatch,
            'skipped_org_mismatch_details', v_skipped_org_mismatch_details
        )
    );
END;
$function$;

-- Grants as set by 20261015120000_lock_down_security_definer_functions.sql. CREATE OR REPLACE keeps
-- them; they are repeated so this file states who can call each function.
REVOKE ALL ON FUNCTION public.retry_repository_creation(p_repository_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retry_repository_creation(p_repository_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fix_assignment_repo_permissions(p_class_id bigint, p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fix_assignment_repo_permissions(p_class_id bigint, p_assignment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.cleanup_individual_repositories_for_assignment(p_class_id bigint, p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_individual_repositories_for_assignment(p_class_id bigint, p_assignment_id bigint) TO authenticated, service_role;
