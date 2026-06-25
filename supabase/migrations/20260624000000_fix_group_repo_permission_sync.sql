-- Fix group-repo permission sync gaps that left students (even ones already
-- confirmed in the GitHub org) without write access to their group repos.
--
-- Three coupled changes:
--   1. New helper enqueue_sync_repo_permissions_for_repo(repo_id): re-derives the
--      intended collaborator list for a repo (group OR individual) from the DB and
--      enqueues a permission sync. Called by the github-async-worker after a repo
--      becomes GitHub-ready, so members added via an empty-collaborator create are
--      still granted access.
--   2. copy_groups_from_assignment: it only ever CREATED missing repos
--      (create_all_repos_for_assignment_internal) and never re-synced members on
--      repos that already existed. Add an explicit per-repo permission sync.
--   3. publish_assignment_group_changes: Phase 3 skipped not-GitHub-ready repos
--      ("if not is_github_ready then continue"), so newly-created group repos
--      (created with an empty collaborator list) never got a member sync. Remove
--      the skip — the async worker requeues sync_repo_permissions until the repo is
--      ready, then applies the real member list (matching the rationale documented
--      in 20260605120000).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Helper: re-derive a repo's intended collaborators and enqueue a sync.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.enqueue_sync_repo_permissions_for_repo(p_repo_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id    bigint;
  v_repository  text;
  v_group_id    bigint;
  v_profile_id  uuid;
  v_course_slug text;
  v_github_org  text;
  v_usernames   text[];
begin
  select r.class_id, r.repository, r.assignment_group_id, r.profile_id, c.slug, c.github_org
    into v_class_id, v_repository, v_group_id, v_profile_id, v_course_slug, v_github_org
  from public.repositories r
  join public.classes c on c.id = r.class_id
  where r.id = p_repo_id;

  if not found
     or v_repository is null
     or position('/' in v_repository) = 0
     or v_github_org is null then
    return;
  end if;

  if v_group_id is not null then
    -- Group repo: all confirmed student members of the group.
    select coalesce(array_remove(array_agg(u.github_username), null), '{}')
      into v_usernames
    from public.assignment_groups_members agm
    join public.user_roles ur on ur.private_profile_id = agm.profile_id
    join public.users u on u.user_id = ur.user_id
    where agm.assignment_group_id = v_group_id
      and ur.class_id = v_class_id
      and ur.role = 'student'
      and ur.github_org_confirmed = true
      and u.github_username is not null
      and u.github_username <> '';
  else
    -- Individual repo: the owning student, if confirmed.
    select coalesce(array_remove(array_agg(u.github_username), null), '{}')
      into v_usernames
    from public.user_roles ur
    join public.users u on u.user_id = ur.user_id
    where ur.private_profile_id = v_profile_id
      and ur.class_id = v_class_id
      and ur.github_org_confirmed = true
      and u.github_username is not null
      and u.github_username <> '';
  end if;

  if v_usernames is not null and array_length(v_usernames, 1) > 0 then
    perform public.enqueue_github_sync_repo_permissions(
      v_class_id,
      v_github_org,
      split_part(v_repository, '/', 2),
      v_course_slug,
      v_usernames,
      'post-create-resync-' || p_repo_id::text
    );
  end if;
end;
$$;

revoke all on function public.enqueue_sync_repo_permissions_for_repo(bigint) from public;
grant execute on function public.enqueue_sync_repo_permissions_for_repo(bigint) to postgres;
grant execute on function public.enqueue_sync_repo_permissions_for_repo(bigint) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. copy_groups_from_assignment: add an explicit per-repo permission sync.
--    (Body is the active 20260615130000 definition + the new Phase-final sync loop.)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.copy_groups_from_assignment(
  p_class_id bigint,
  p_source_assignment_id bigint,
  p_target_assignment_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_profile_id uuid;
  v_course_slug text;
  v_github_org text;
  v_template_repo text;
  v_group_config text;
  v_release_date timestamptz;
  v_groups_processed int := 0;
  v_members_copied int := 0;
  v_memberships_removed int := 0;
  v_submissions_deactivated int := 0;
  v_groups_deleted int := 0;
  v_groups_preserved int := 0;
  v_empty_gid bigint;
  v_repo_record record;
BEGIN
  set local statement_timeout to '3min';
  set local pawtograder.suppress_repo_sync = 'on';

  IF NOT authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'Permission denied'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT private_profile_id INTO v_caller_profile_id
  FROM user_roles
  WHERE user_id = auth.uid()
    AND class_id = p_class_id
    AND role = 'instructor'
    AND disabled = false
  LIMIT 1;

  IF v_caller_profile_id IS NULL THEN
    RAISE EXCEPTION 'Could not find instructor profile for caller'
      USING ERRCODE = 'data_exception';
  END IF;

  IF p_source_assignment_id = p_target_assignment_id THEN
    RAISE EXCEPTION 'Source and target assignments must be different'
      USING ERRCODE = 'data_exception';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM assignments
    WHERE id = p_source_assignment_id
      AND class_id = p_class_id
      AND group_config IN ('groups', 'both')
  ) THEN
    RAISE EXCEPTION 'Source assignment not found in this class or is not a group assignment'
      USING ERRCODE = 'data_exception';
  END IF;

  SELECT c.slug, c.github_org, a.template_repo, a.group_config, a.release_date
  INTO v_course_slug, v_github_org, v_template_repo, v_group_config, v_release_date
  FROM assignments a
  JOIN classes c ON c.id = a.class_id
  WHERE a.id = p_target_assignment_id
    AND a.class_id = p_class_id
    AND a.group_config IN ('groups', 'both');

  IF v_group_config IS NULL THEN
    RAISE EXCEPTION 'Target assignment not found in this class or is not a group assignment'
      USING ERRCODE = 'data_exception';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(format('copy_groups:%s:%s', p_class_id, p_target_assignment_id), 0));

  SELECT COUNT(*) INTO v_groups_processed
  FROM assignment_groups
  WHERE assignment_id = p_source_assignment_id
    AND class_id = p_class_id;

  IF v_groups_processed = 0 THEN
    RAISE EXCEPTION 'Source assignment has no groups'
      USING ERRCODE = 'data_exception';
  END IF;

  -- Copy the source group names and mentors onto the target. Existing target
  -- groups with the same name are reused so repository/history links survive.
  INSERT INTO assignment_groups (assignment_id, class_id, name, mentor_profile_id)
  SELECT p_target_assignment_id, class_id, name, mentor_profile_id
  FROM assignment_groups
  WHERE assignment_id = p_source_assignment_id
    AND class_id = p_class_id
  ON CONFLICT (assignment_id, name)
  DO UPDATE SET mentor_profile_id = EXCLUDED.mentor_profile_id;

  WITH deleted_memberships AS (
    DELETE FROM assignment_groups_members
    WHERE assignment_id = p_target_assignment_id
      AND class_id = p_class_id
    RETURNING id, profile_id
  ),
  deactivated_submissions AS (
    UPDATE submissions
    SET is_active = false
    WHERE assignment_id = p_target_assignment_id
      AND profile_id IN (SELECT profile_id FROM deleted_memberships)
    RETURNING id
  )
  SELECT
    (SELECT COUNT(*) FROM deleted_memberships),
    (SELECT COUNT(*) FROM deactivated_submissions)
  INTO v_memberships_removed, v_submissions_deactivated;

  WITH inserted_members AS (
    INSERT INTO assignment_groups_members (
      assignment_id,
      class_id,
      profile_id,
      assignment_group_id,
      added_by
    )
    SELECT
      p_target_assignment_id,
      p_class_id,
      sm.profile_id,
      tg.id,
      v_caller_profile_id
    FROM assignment_groups_members sm
    JOIN assignment_groups sg ON sg.id = sm.assignment_group_id
    JOIN assignment_groups tg ON tg.name = sg.name
      AND tg.assignment_id = p_target_assignment_id
      AND tg.class_id = p_class_id
    WHERE sm.assignment_id = p_source_assignment_id
      AND sm.class_id = p_class_id
    ON CONFLICT (assignment_id, profile_id)
    DO UPDATE SET
      assignment_group_id = EXCLUDED.assignment_group_id,
      added_by = EXCLUDED.added_by
    RETURNING id
  )
  SELECT COUNT(*) INTO v_members_copied FROM inserted_members;

  FOR v_empty_gid IN
    SELECT ag.id
    FROM assignment_groups ag
    WHERE ag.assignment_id = p_target_assignment_id
      AND ag.class_id = p_class_id
      AND NOT EXISTS (
        SELECT 1
        FROM assignment_groups_members agm
        WHERE agm.assignment_group_id = ag.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM assignment_groups source_group
        WHERE source_group.assignment_id = p_source_assignment_id
          AND source_group.class_id = p_class_id
          AND source_group.name = ag.name
      )
  LOOP
    IF EXISTS (
      SELECT 1 FROM submissions s
      WHERE s.assignment_group_id = v_empty_gid
    ) OR EXISTS (
      SELECT 1
      FROM submissions s
      JOIN repositories r ON r.id = s.repository_id
      WHERE r.assignment_group_id = v_empty_gid
    ) THEN
      v_groups_preserved := v_groups_preserved + 1;
      CONTINUE;
    END IF;

    DELETE FROM assignment_group_invitations
    WHERE assignment_group_id = v_empty_gid;
    DELETE FROM assignment_group_join_request
    WHERE assignment_group_id = v_empty_gid;

    FOR v_repo_record IN
      SELECT r.id, r.repository
      FROM repositories r
      WHERE r.assignment_group_id = v_empty_gid
        AND r.repository IS NOT NULL
        AND position('/' in r.repository) > 0
    LOOP
      IF v_github_org IS NOT NULL THEN
        PERFORM enqueue_github_archive_repo(
          p_class_id,
          v_github_org,
          split_part(v_repo_record.repository, '/', 2),
          'copy-groups-dissolve-' || v_empty_gid::text
        );
      END IF;
      DELETE FROM repository_check_runs WHERE repository_id = v_repo_record.id;
      DELETE FROM repositories WHERE id = v_repo_record.id;
    END LOOP;

    DELETE FROM assignment_groups WHERE id = v_empty_gid;
    v_groups_deleted := v_groups_deleted + 1;
  END LOOP;

  IF v_group_config IN ('groups', 'both')
     AND v_template_repo IS NOT NULL AND v_template_repo != ''
     AND v_release_date IS NOT NULL AND v_release_date <= now()
  THEN
    PERFORM create_all_repos_for_assignment_internal(p_class_id, p_target_assignment_id, false);
  END IF;

  -- Sync collaborator permissions for every target group that already has a repo.
  -- create_all_repos_for_assignment_internal only CREATES missing repos; it never
  -- re-syncs members on repos that already exist, so members copied into a
  -- pre-existing group repo would otherwise never be granted write access. The
  -- async worker requeues sync_repo_permissions until the repo is GitHub-ready.
  FOR v_repo_record IN
    SELECT r.repository, r.assignment_group_id
    FROM repositories r
    JOIN assignment_groups ag ON ag.id = r.assignment_group_id
    WHERE ag.assignment_id = p_target_assignment_id
      AND ag.class_id = p_class_id
      AND r.repository IS NOT NULL
      AND position('/' in r.repository) > 0
  LOOP
    DECLARE
      v_usernames text[];
    BEGIN
      SELECT coalesce(array_remove(array_agg(u.github_username), null), '{}')
        INTO v_usernames
      FROM assignment_groups_members agm
      JOIN user_roles ur ON ur.private_profile_id = agm.profile_id
      JOIN users u ON u.user_id = ur.user_id
      WHERE agm.assignment_group_id = v_repo_record.assignment_group_id
        AND ur.class_id = p_class_id
        AND ur.role = 'student'
        AND ur.github_org_confirmed = true
        AND u.github_username IS NOT NULL
        AND u.github_username <> '';

      IF v_github_org IS NOT NULL AND array_length(v_usernames, 1) > 0 THEN
        PERFORM enqueue_github_sync_repo_permissions(
          p_class_id,
          v_github_org,
          split_part(v_repo_record.repository, '/', 2),
          v_course_slug,
          v_usernames,
          'copy-groups-sync-' || v_repo_record.assignment_group_id::text
        );
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'groups_processed', v_groups_processed,
    'members_copied', v_members_copied,
    'memberships_removed', v_memberships_removed,
    'groups_deleted', v_groups_deleted,
    'groups_preserved', v_groups_preserved
  );
END;
$$;

REVOKE ALL ON FUNCTION public.copy_groups_from_assignment(bigint, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.copy_groups_from_assignment(bigint, bigint, bigint) TO authenticated;

COMMENT ON FUNCTION public.copy_groups_from_assignment IS
  'Overwrites a target assignment group membership set with groups and members from a source assignment. '
  'Only instructors can call. Uses auth.uid() for authorization and added_by. '
  'Enqueues a repo permission sync for every target group repo so copied members get write access.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. publish_assignment_group_changes: remove the not-GitHub-ready skip in Phase 3.
--    (Body is the active 20260615000000 definition with the skip removed.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.publish_assignment_group_changes(
    p_class_id       bigint,
    p_assignment_id  bigint,
    p_groups_to_create jsonb default '[]'::jsonb,
    p_moves_to_fulfill jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_caller_profile_id uuid;
    v_course_slug       text;
    v_github_org        text;
    v_template_repo     text;
    v_latest_sha        text;
    v_assignment_slug   text;

    v_repo_mode            public.assignment_repo_mode;
    v_source_assignment_id bigint;
    v_branch_protection    jsonb;
    v_creation_method      text;
    v_group_source_repo    text;

    v_group             jsonb;
    v_move              jsonb;
    v_group_name        text;
    v_new_group_id      bigint;
    v_member_id         uuid;
    v_member_ids        jsonb;

    v_old_gid           bigint;
    v_new_gid           bigint;
    v_profile_id        uuid;
    v_empty_gid         bigint;

    v_membership_id     bigint;
    v_repo_record       record;

    v_affected_groups   bigint[] := '{}';
    v_deleted_groups    bigint[] := '{}';
    -- empty groups we intentionally keep (they have submissions); excluded from
    -- the permission sync so their preserved repo's GitHub access is left as-is
    v_preserved_groups  bigint[] := '{}';

    v_groups_created    integer := 0;
    v_members_added     integer := 0;
    v_members_moved     integer := 0;
    v_groups_dissolved  integer := 0;
    v_syncs_enqueued    integer := 0;
    v_errors            jsonb[] := '{}';
begin
    -- auth
    if auth.uid() is null then
        raise exception 'Not authenticated';
    end if;
    if not exists (
        select 1 from public.user_privileges up
        where up.user_id = auth.uid()
          and (up.role = 'admin' or (up.class_id = p_class_id and up.role = 'instructor'))
    ) then
        raise exception 'Only instructors can publish group changes';
    end if;

    select private_profile_id into v_caller_profile_id
    from public.user_roles
    where user_id = auth.uid()
      and class_id = p_class_id
      and role = 'instructor'
    limit 1;

    -- class + assignment metadata (one query), incl. repo_mode config
    select c.slug, c.github_org, a.slug, a.template_repo, a.latest_template_sha,
           a.repo_mode, a.source_assignment_id,
           jsonb_build_object(
             'blockForcePush', coalesce(a.protect_block_force_push, true),
             'requirePullRequest', coalesce(a.protect_require_pull_request, false),
             'requiredReviewers', coalesce(a.protect_required_reviewers, 0)
           )
    into   v_course_slug, v_github_org, v_assignment_slug, v_template_repo, v_latest_sha,
           v_repo_mode, v_source_assignment_id, v_branch_protection
    from   public.assignments a
    join   public.classes c on c.id = a.class_id
    where  a.id = p_assignment_id and a.class_id = p_class_id;

    if v_course_slug is null then
        raise exception 'Assignment % not found in class %', p_assignment_id, p_class_id;
    end if;

    -- Phase 1: process moves on existing groups
    for v_move in select * from jsonb_array_elements(p_moves_to_fulfill)
    loop
        v_profile_id := (v_move->>'profile_id')::uuid;
        v_old_gid    := (v_move->>'old_group_id')::bigint;
        v_new_gid    := (v_move->>'new_group_id')::bigint;

        begin
            if v_old_gid is not null and not exists (
                select 1 from public.assignment_groups
                where id = v_old_gid
                  and assignment_id = p_assignment_id
                  and class_id = p_class_id
            ) then
                v_errors := array_append(v_errors, jsonb_build_object(
                    'profile_id', v_profile_id,
                    'error', format('Group %s does not belong to assignment %s', v_old_gid, p_assignment_id)
                ));
                continue;
            end if;
            if v_new_gid is not null and not exists (
                select 1 from public.assignment_groups
                where id = v_new_gid
                  and assignment_id = p_assignment_id
                  and class_id = p_class_id
            ) then
                v_errors := array_append(v_errors, jsonb_build_object(
                    'profile_id', v_profile_id,
                    'error', format('Group %s does not belong to assignment %s', v_new_gid, p_assignment_id)
                ));
                continue;
            end if;

            if v_old_gid is not null then
                select id into v_membership_id
                from public.assignment_groups_members
                where assignment_group_id = v_old_gid
                  and profile_id = v_profile_id
                  and class_id = p_class_id;

                if v_membership_id is null then
                    v_errors := array_append(v_errors, jsonb_build_object(
                        'profile_id', v_profile_id,
                        'error', format('Student not in group %s', v_old_gid)
                    ));
                    continue;
                end if;

                delete from public.assignment_groups_members where id = v_membership_id;
                v_affected_groups := array_append(v_affected_groups, v_old_gid);
            end if;

            if v_new_gid is not null then
                if v_old_gid is null then
                    update public.submissions
                    set is_active = false
                    where assignment_id = p_assignment_id
                      and profile_id = v_profile_id;
                end if;

                insert into public.assignment_groups_members
                    (assignment_group_id, profile_id, assignment_id, class_id, added_by)
                values
                    (v_new_gid, v_profile_id, p_assignment_id, p_class_id, v_caller_profile_id);

                v_affected_groups := array_append(v_affected_groups, v_new_gid);
            end if;

            v_members_moved := v_members_moved + 1;

        exception when others then
            v_errors := array_append(v_errors, jsonb_build_object(
                'profile_id', v_profile_id,
                'error', SQLERRM
            ));
        end;
    end loop;

    -- Phase 2: create new groups and add their initial members
    for v_group in select * from jsonb_array_elements(p_groups_to_create)
    loop
        v_group_name := trim(v_group->>'name');
        v_member_ids := v_group->'member_ids';

        begin
            if v_group_name = '' or v_group_name is null then
                raise exception 'Group name cannot be empty';
            end if;
            if length(v_group_name) > 36 then
                raise exception 'Group name too long (max 36 chars)';
            end if;
            if v_group_name !~ '^[a-zA-Z0-9_-]+$' then
                raise exception 'Group name must be alphanumeric, hyphens, or underscores';
            end if;

            if exists (
                select 1 from public.assignment_groups
                where assignment_id = p_assignment_id and lower(name) = lower(v_group_name)
            ) then
                raise exception 'Group "%" already exists', v_group_name;
            end if;

            -- Resolve the creation strategy from repo_mode BEFORE creating the
            -- group, so a fork-mode group with no source repo is reported as an
            -- error without leaving a half-created group behind.
            v_creation_method := null;
            v_group_source_repo := null;
            if v_repo_mode not in ('none', 'no_submission') then
                if v_repo_mode = 'fork_from_prior_assignment' then
                    select r.repository into v_group_source_repo
                      from public.repositories r
                      join public.assignment_groups ag on ag.id = r.assignment_group_id
                     where r.assignment_id = v_source_assignment_id
                       and ag.name = v_group_name
                     limit 1;
                    if v_group_source_repo is null then
                        raise exception 'No source repository for group "%" on source assignment %', v_group_name, v_source_assignment_id;
                    end if;
                    v_creation_method := 'fork';
                elsif v_repo_mode = 'template_with_student_forks' then
                    v_group_source_repo := v_template_repo;
                    v_creation_method := 'fork';
                else  -- template_only_staff
                    v_group_source_repo := v_template_repo;
                    v_creation_method := 'template';
                end if;
            end if;

            insert into public.assignment_groups (name, assignment_id, class_id)
            values (v_group_name, p_assignment_id, p_class_id)
            returning id into v_new_group_id;

            v_groups_created := v_groups_created + 1;

            -- enqueue repo creation per repo_mode (empty usernames; permission sync below)
            if v_creation_method is not null
               and v_github_org is not null
               and (v_repo_mode = 'fork_from_prior_assignment'
                    or (v_template_repo is not null and v_template_repo != '')) then
                perform public.enqueue_github_create_repo(
                    p_class_id,
                    v_github_org,
                    v_course_slug || '-' || v_assignment_slug || '-group-' || v_group_name,
                    coalesce(v_template_repo, v_group_source_repo),
                    v_course_slug,
                    '{}'::text[],
                    false,
                    'batch-group-create-' || v_new_group_id::text,
                    p_assignment_id,
                    null::uuid,
                    v_new_group_id,
                    v_latest_sha,
                    v_creation_method,
                    v_group_source_repo,
                    v_branch_protection,
                    null
                );
            end if;

            if v_member_ids is not null and jsonb_array_length(v_member_ids) > 0 then
                for v_member_id in
                    select (value#>>'{}')::uuid from jsonb_array_elements(v_member_ids) as value
                loop
                    update public.submissions
                    set is_active = false
                    where assignment_id = p_assignment_id
                      and profile_id = v_member_id;

                    insert into public.assignment_groups_members
                        (assignment_group_id, profile_id, assignment_id, class_id, added_by)
                    values
                        (v_new_group_id, v_member_id, p_assignment_id, p_class_id, v_caller_profile_id);

                    v_members_added := v_members_added + 1;
                end loop;
            end if;

            v_affected_groups := array_append(v_affected_groups, v_new_group_id);

        exception when others then
            v_errors := array_append(v_errors, jsonb_build_object(
                'group_name', v_group_name,
                'error', SQLERRM
            ));
        end;
    end loop;

    -- Phase 2b: dissolve empty groups (batch-final state after moves + creates)
    for v_empty_gid in
        select ag.id
        from public.assignment_groups ag
        where ag.assignment_id = p_assignment_id
          and ag.class_id = p_class_id
          and not exists (
              select 1 from public.assignment_groups_members agm
              where agm.assignment_group_id = ag.id
          )
    loop
        -- Preserve groups that still have submissions. Their repo holds
        -- graded/active work and is referenced by submissions (repository_id and
        -- repository_check_run_id), so deleting it would violate those FKs and
        -- destroy history. Keep the group, repo, check runs, and submissions
        -- intact; only fully dissolve groups whose repos have no submissions.
        if exists (
            select 1 from public.submissions s
            where s.assignment_group_id = v_empty_gid
        ) or exists (
            select 1
            from public.submissions s
            join public.repositories r on r.id = s.repository_id
            where r.assignment_group_id = v_empty_gid
        ) then
            v_preserved_groups := array_append(v_preserved_groups, v_empty_gid);
            continue;
        end if;

        delete from public.assignment_group_invitations
        where assignment_group_id = v_empty_gid;
        delete from public.assignment_group_join_request
        where assignment_group_id = v_empty_gid;

        for v_repo_record in
            select r.id, r.repository
            from public.repositories r
            where r.assignment_group_id = v_empty_gid
              and r.repository is not null
              and position('/' in r.repository) > 0
        loop
            if v_github_org is not null then
                perform public.enqueue_github_archive_repo(
                    p_class_id,
                    v_github_org,
                    split_part(v_repo_record.repository, '/', 2),
                    'batch-dissolve-' || v_empty_gid::text
                );
            end if;
            delete from public.repository_check_runs where repository_id = v_repo_record.id;
            delete from public.repositories where id = v_repo_record.id;
        end loop;

        delete from public.assignment_groups where id = v_empty_gid;
        v_deleted_groups := array_append(v_deleted_groups, v_empty_gid);
        v_groups_dissolved := v_groups_dissolved + 1;
    end loop;

    -- Phase 3: enqueue ONE permission sync per affected repo
    -- Deduplicate and exclude dissolved + preserved groups.
    -- Enqueue the sync even for repos that aren't GitHub-ready yet: newly-created
    -- group repos are created via enqueue_github_create_repo with an EMPTY
    -- collaborator list, so this sync is the only path that grants member access.
    -- The async worker requeues sync_repo_permissions until is_github_ready=true
    -- (so it can't race create_repo), then applies the real member list. Skipping
    -- not-ready repos here would strand those members without GitHub access.
    for v_repo_record in
        select distinct r.id           as repo_id,
               r.repository,
               r.assignment_group_id,
               r.is_github_ready
        from   unnest(v_affected_groups) as gid(g)
        join   public.repositories r on r.assignment_group_id = gid.g
        where  not (gid.g = any(v_deleted_groups))
          and  not (gid.g = any(v_preserved_groups))
    loop
        begin
            declare
                v_usernames text[];
            begin
                select coalesce(array_remove(array_agg(u.github_username), null), '{}')
                into v_usernames
                from public.assignment_groups_members agm
                join public.user_roles ur on ur.private_profile_id = agm.profile_id
                join public.users u on u.user_id = ur.user_id
                where agm.assignment_group_id = v_repo_record.assignment_group_id
                  and ur.class_id = p_class_id
                  and ur.role = 'student'
                  and ur.github_org_confirmed = true
                  and u.github_username is not null
                  and u.github_username != '';

                if v_repo_record.repository is not null and position('/' in v_repo_record.repository) > 0 then
                    perform public.enqueue_github_sync_repo_permissions(
                        p_class_id,
                        v_github_org,
                        split_part(v_repo_record.repository, '/', 2),
                        v_course_slug,
                        coalesce(v_usernames, '{}'),
                        'batch-publish-' || p_assignment_id::text || '-g' || v_repo_record.assignment_group_id::text
                    );
                    v_syncs_enqueued := v_syncs_enqueued + 1;
                end if;
            end;
        exception when others then
            v_errors := array_append(v_errors, jsonb_build_object(
                'repository_id', v_repo_record.repo_id,
                'error', SQLERRM
            ));
        end;
    end loop;

    return jsonb_build_object(
        'groups_created',   v_groups_created,
        'members_added',    v_members_added,
        'members_moved',    v_members_moved,
        'groups_dissolved', v_groups_dissolved,
        'syncs_enqueued',   v_syncs_enqueued,
        'errors',           to_jsonb(v_errors)
    );
end;
$$;

revoke all on function public.publish_assignment_group_changes(bigint, bigint, jsonb, jsonb) from public;
grant execute on function public.publish_assignment_group_changes(bigint, bigint, jsonb, jsonb) to authenticated;

comment on function public.publish_assignment_group_changes is
'Atomically publish all staged group changes (new groups + member moves) for an
assignment in a single database call. Validates inputs, creates groups, moves
members, dissolves empty groups, enqueues repo creation and ONE permission sync
per affected repo (including not-yet-ready repos, which the worker requeues until
GitHub-ready). Group-create enqueue is repo_mode-aware (template_only_staff
template-generates; template_with_student_forks and fork_from_prior_assignment
fork from the resolved source with branch protection). Empty groups whose
repositories still have submissions are preserved (repo + check runs +
submissions kept intact) rather than deleted, to avoid FK violations and history
loss.';
