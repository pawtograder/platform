-- Retry creation and Fix Permissions on Repository Status assumed every repository is on GitHub.
--
-- Why:
--   1. retry_repository_creation cleared creation_error and called enqueue_create_repo_for_repository,
--      which returns null for a Forgejo row. The null branch then wrote "This assignment no longer
--      creates GitHub repositories..." on the row, which is wrong for Forgejo, while the page said the
--      creation was re-queued.
--   2. fix_assignment_repo_permissions raised "Course has no GitHub organization configured" for a
--      Forgejo course without a github_org. With a github_org, it called
--      enqueue_github_sync_repo_permissions for each Forgejo repo, which queues nothing for a Forgejo
--      name, and still counted the repo as enqueued.
--
-- What:
--   1. retry_repository_creation on a Forgejo row clears creation_error, kicks forgejo-reconciler and
--      returns null. The reconciler doesn't read creation_error or creation_attempts: every pass lists
--      each student who has no ready repository (forgejo_repos_needed) and tries again, so clearing the
--      error only removes a stale message. GitHub rows keep the body from
--      20261121160200_repository_status_by_capability.sql.
--   2. fix_assignment_repo_permissions refuses a Forgejo assignment with feature_not_supported before
--      it reads github_org. forgejo-reconciler manages Forgejo access. GitHub assignments keep the body
--      from 20261121160200_repository_status_by_capability.sql.
--
-- Not changed: cleanup_individual_repositories_for_assignment. On a Forgejo assignment it fails today
-- (no github_org, or repositories_validate_git_provider refuses to delete a Forgejo row and the whole
-- call rolls back), and the open Forgejo archive-and-delete PR (#1398) makes that delete archive the
-- Forgejo repo instead.
--
-- Signatures, grants and search_path are unchanged.

CREATE OR REPLACE FUNCTION public.retry_repository_creation(p_repository_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_class_id bigint;
  v_git_provider text;
  v_msg_id bigint;
begin
  select class_id, git_provider into v_class_id, v_git_provider from public.repositories where id = p_repository_id;
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

  if v_git_provider = 'forgejo' then
    -- forgejo-reconciler retries every not-ready Forgejo repo on each pass; the kick starts one now
    -- rather than at the next hourly run. Nothing is queued here, so there is no message id.
    perform public.kick_forgejo_reconciler();
    return null;
  end if;

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

    -- Before the github_org check, so a Forgejo course without one gets this reason instead.
    -- repositories_validate_git_provider keeps every repository on its assignment's host.
    IF EXISTS (
        SELECT 1 FROM public.assignments a
        WHERE a.id = p_assignment_id AND a.class_id = p_class_id AND a.git_provider = 'forgejo'
    ) THEN
        RAISE EXCEPTION 'Fix Permissions only works for GitHub repositories. forgejo-reconciler manages access to Forgejo repositories.'
            USING ERRCODE = 'feature_not_supported';
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

REVOKE ALL ON FUNCTION public.retry_repository_creation(p_repository_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retry_repository_creation(p_repository_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fix_assignment_repo_permissions(p_class_id bigint, p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fix_assignment_repo_permissions(p_class_id bigint, p_assignment_id bigint) TO authenticated, service_role;
