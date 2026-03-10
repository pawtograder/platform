-- RPC to audit and fix repository permissions for all repos in an assignment.
-- Replaces the edge function with a single database call to avoid N+2 round trips.

CREATE OR REPLACE FUNCTION public.fix_assignment_repo_permissions(
    p_class_id bigint,
    p_assignment_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    IF NOT public.authorizeforclassinstructor(p_class_id) THEN
        RAISE EXCEPTION 'Only instructors can fix repository permissions';
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
$$;

REVOKE ALL ON FUNCTION public.fix_assignment_repo_permissions(bigint, bigint) FROM public;
GRANT EXECUTE ON FUNCTION public.fix_assignment_repo_permissions(bigint, bigint) TO authenticated;

COMMENT ON FUNCTION public.fix_assignment_repo_permissions IS
'Audit and fix GitHub repository permissions for every repo in an assignment.
Computes the correct collaborator list from the database for each repository
(individual or group) and enqueues sync_repo_permissions for each.
Only instructors can call this function.';
