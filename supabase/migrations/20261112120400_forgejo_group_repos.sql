-- CW-13b (#1236): forgejo-reconciler creates one repo per group for released Forgejo group
-- assignments. forgejo_group_repos_needed() lists groups with no ready repo, with every member's
-- Forgejo login. A repo is ready only once every member has a login and Forgejo reports write
-- access for all of them, so a member still waiting for an account keeps the group listed.
--
-- A member who joins later marks the group's repo not ready again (trigger below), and the next pass
-- grants everyone again. Removing a member who leaves is out of scope.
--
-- group_config 'both': students in a group get the group repo; the rest keep an individual repo, so
-- forgejo_repos_needed() now also lists 'both' students who are in no group.

CREATE OR REPLACE FUNCTION public.forgejo_group_repos_needed(p_instance_url text, p_limit integer)
RETURNS TABLE (
  assignment_id bigint,
  class_id bigint,
  assignment_group_id bigint,
  owner text,
  name text,
  template_repo text,
  logins text[],
  all_members_have_logins boolean
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.id, a.class_id, g.id,
         coalesce(nullif(c.forgejo_org, ''), c.slug),
         a.slug || '-group-' || public.sanitize_repo_name_component(g.name),
         a.template_repo,
         coalesce(array_agg(ga.login ORDER BY ga.login) FILTER (WHERE ga.login IS NOT NULL), '{}'),
         bool_and(ga.login IS NOT NULL)
  FROM public.assignments a
  JOIN public.classes c ON c.id = a.class_id
  JOIN public.assignment_groups g ON g.assignment_id = a.id
  JOIN public.assignment_groups_members m ON m.assignment_group_id = g.id
  JOIN public.user_roles ur ON ur.class_id = a.class_id AND ur.private_profile_id = m.profile_id AND NOT ur.disabled
  LEFT JOIN public.git_accounts ga ON ga.user_id = ur.user_id AND ga.provider = 'forgejo'
    AND ga.instance_url = p_instance_url AND ga.login IS NOT NULL
  WHERE a.git_provider = 'forgejo'
    AND a.repo_mode = 'template_only_staff'
    AND a.group_config IN ('groups', 'both')
    AND coalesce(a.template_repo, '') <> ''
    AND a.release_date <= now()
    AND public.cloud_workspaces_enabled(c.features)
    AND NOT EXISTS (
      SELECT 1 FROM public.repositories r
      WHERE r.assignment_id = a.id AND r.assignment_group_id = g.id AND r.is_github_ready
    )
  GROUP BY a.id, a.class_id, g.id, c.forgejo_org, c.slug, a.slug, g.name, a.template_repo
  -- Random, not by id: a row that keeps failing stays listed, and a fixed order would let 50 of them
  -- fill every pass. Each pass samples the backlog, so everything is reached eventually.
  ORDER BY random()
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.forgejo_group_repos_needed(text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forgejo_group_repos_needed(text, integer) TO service_role;

-- From 20261112120200_forgejo_repos.sql, now also listing 'both' students who are in no group.
CREATE OR REPLACE FUNCTION public.forgejo_repos_needed(p_instance_url text, p_limit integer)
RETURNS TABLE (
  assignment_id bigint,
  class_id bigint,
  profile_id uuid,
  login text,
  owner text,
  name text,
  template_repo text
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.id, a.class_id, ur.private_profile_id, ga.login,
         coalesce(nullif(c.forgejo_org, ''), c.slug), a.slug || '-' || ga.login, a.template_repo
  FROM public.assignments a
  JOIN public.classes c ON c.id = a.class_id
  JOIN public.user_roles ur ON ur.class_id = a.class_id AND ur.role = 'student' AND NOT ur.disabled
  JOIN public.git_accounts ga ON ga.user_id = ur.user_id AND ga.provider = 'forgejo'
    AND ga.instance_url = p_instance_url AND ga.login IS NOT NULL
  WHERE a.git_provider = 'forgejo'
    AND a.repo_mode = 'template_only_staff'
    AND (a.group_config = 'individual' OR (a.group_config = 'both' AND NOT EXISTS (
      SELECT 1 FROM public.assignment_groups_members m
      WHERE m.assignment_id = a.id AND m.profile_id = ur.private_profile_id
    )))
    AND coalesce(a.template_repo, '') <> ''
    AND a.release_date <= now()
    AND public.cloud_workspaces_enabled(c.features)
    AND NOT EXISTS (
      SELECT 1 FROM public.repositories r
      WHERE r.assignment_id = a.id AND r.profile_id = ur.private_profile_id AND r.is_github_ready
    )
  -- Random, not by id: a row that keeps failing stays listed, and a fixed order would let 50 of them
  -- fill every pass. Each pass samples the backlog, so everything is reached eventually.
  ORDER BY random()
  LIMIT p_limit;
$$;

-- Statement-level, so adding a whole roster to groups kicks once. Only Forgejo repos are touched; a
-- GitHub group's access is synced by the existing GitHub triggers.
CREATE OR REPLACE FUNCTION public.forgejo_group_member_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- save_forgejo_group_repo takes the same lock, so a pass either counts the new members or has
  -- already saved, and this clears what it saved. NO KEY UPDATE, not UPDATE: each insert already
  -- holds the foreign key's KEY SHARE on its group, and two inserts upgrading to UPDATE would deadlock.
  PERFORM 1 FROM public.assignment_groups g
  JOIN public.assignments a ON a.id = g.assignment_id AND a.git_provider = 'forgejo'
  WHERE g.id IN (SELECT DISTINCT assignment_group_id FROM new_members)
  ORDER BY g.id FOR NO KEY UPDATE OF g;
  UPDATE public.repositories r SET is_github_ready = false
  WHERE r.git_provider = 'forgejo' AND r.is_github_ready
    AND r.assignment_group_id IN (SELECT DISTINCT assignment_group_id FROM new_members);
  -- Also when the group has no repo yet: a group formed after release gets its repo now, not at
  -- the next hourly run.
  IF EXISTS (
    SELECT 1 FROM new_members nm JOIN public.assignments a ON a.id = nm.assignment_id
    WHERE a.git_provider = 'forgejo' AND a.release_date <= now()
  ) THEN
    PERFORM public.kick_forgejo_reconciler();
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.forgejo_group_member_added() FROM public, anon, authenticated;

-- Records a group's Forgejo repo once `p_granted` have write access. It is ready only if every current
-- member has a login on this instance and was granted: a member added after the pass read the roster
-- makes it not ready, so the next pass grants them. The group row lock orders this against
-- forgejo_group_member_added.
CREATE OR REPLACE FUNCTION public.save_forgejo_group_repo(
  p_assignment_group_id bigint,
  p_repository text,
  p_instance_url text,
  p_granted text[]
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_group public.assignment_groups%ROWTYPE;
  v_ready boolean;
BEGIN
  SELECT * INTO v_group FROM public.assignment_groups WHERE id = p_assignment_group_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assignment group % not found', p_assignment_group_id;
  END IF;
  SELECT coalesce(bool_and(ga.login IS NOT NULL AND ga.login = ANY (p_granted)), false) INTO v_ready
  FROM public.assignment_groups_members m
  JOIN public.user_roles ur ON ur.class_id = v_group.class_id AND ur.private_profile_id = m.profile_id
    AND NOT ur.disabled
  LEFT JOIN public.git_accounts ga ON ga.user_id = ur.user_id AND ga.provider = 'forgejo'
    AND ga.instance_url = p_instance_url AND ga.login IS NOT NULL
  WHERE m.assignment_group_id = p_assignment_group_id;
  UPDATE public.repositories SET is_github_ready = v_ready
  WHERE git_provider = 'forgejo' AND repository = p_repository AND assignment_group_id = p_assignment_group_id;
  IF NOT FOUND THEN
    INSERT INTO public.repositories
      (assignment_id, class_id, profile_id, assignment_group_id, repository, git_provider, is_github_ready)
    VALUES (v_group.assignment_id, v_group.class_id, NULL, p_assignment_group_id, p_repository, 'forgejo', v_ready);
  END IF;
  RETURN v_ready;
END;
$$;

REVOKE ALL ON FUNCTION public.save_forgejo_group_repo(bigint, text, text, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_forgejo_group_repo(bigint, text, text, text[]) TO service_role;

CREATE TRIGGER forgejo_group_member_added
  AFTER INSERT ON public.assignment_groups_members
  REFERENCING NEW TABLE AS new_members
  FOR EACH STATEMENT EXECUTE FUNCTION public.forgejo_group_member_added();

-- sync_repos_after_assignment_group_change(): latest body from 20260605120000_fix_group_publish_timeout.sql,
-- returning early for a Forgejo assignment.
CREATE OR REPLACE FUNCTION public.sync_repos_after_assignment_group_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_assignment_id bigint;
  v_class_id bigint;
  v_group_config public.assignment_group_mode;
  v_release timestamptz;
  v_template text;
  v_provider text;
BEGIN
  -- Determine the affected assignment + class up front: needed both for the
  -- suppression authorization check below and the reconciliation logic.
  IF TG_TABLE_NAME = 'assignment_groups' THEN
    IF TG_OP = 'DELETE' THEN
      v_assignment_id := OLD.assignment_id;
      v_class_id := OLD.class_id;
    ELSE
      v_assignment_id := NEW.assignment_id;
      v_class_id := NEW.class_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'assignment_groups_members' THEN
    IF TG_OP = 'DELETE' THEN
      v_assignment_id := OLD.assignment_id;
      v_class_id := OLD.class_id;
    ELSE
      v_assignment_id := NEW.assignment_id;
      v_class_id := NEW.class_id;
    END IF;
  ELSE
    RAISE WARNING 'sync_repos_after_assignment_group_change: unexpected table %', TG_TABLE_NAME;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- Batch callers (publish_assignment_group_changes) suppress the per-row
  -- reconciliation and run it once at the end instead. Only honor the flag for
  -- instructor-authorized callers: students can mutate assignment_groups_members
  -- via RLS, so without this check a student could set the GUC to disable repo
  -- reconciliation / permission sync (e.g. retaining GitHub access after leaving
  -- a group). Non-instructor callers fall through to normal reconciliation. The
  -- authorize check is short-circuited so it only runs when the flag is set.
  IF current_setting('pawtograder.suppress_repo_sync', true) = 'on'
     AND public.authorizeforclassinstructor(v_class_id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT a.group_config, a.release_date, a.template_repo, a.git_provider
  INTO v_group_config, v_release, v_template, v_provider
  FROM public.assignments a
  WHERE a.id = v_assignment_id AND a.class_id = v_class_id;

  IF v_group_config IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- Forgejo groups are forgejo-reconciler's (forgejo_group_member_added above). The GitHub path
  -- raised "Invalid class/assignment" for a class with no github_org, failing the group change.
  IF v_group_config NOT IN ('groups', 'both') OR v_provider = 'forgejo' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_template IS NULL OR v_template = '' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_release IS NULL OR v_release > now() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE NOTICE 'sync_repos_after_assignment_group_change: enqueue repos for assignment_id=%, class_id=% (source=% %)',
    v_assignment_id, v_class_id, TG_TABLE_NAME, TG_OP;

  PERFORM public.create_all_repos_for_assignment_internal(v_class_id, v_assignment_id, false);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- publish_assignment_group_changes() and copy_groups_from_assignment(): latest bodies from
-- 20261031120000_fail_safe_group_repo_deletes.sql. Their archive and permission-sync calls now skip
-- non-GitHub rows. They name the repo by the class's GitHub org and the name after the row's owner,
-- so a Forgejo group repo could otherwise archive or re-permission a GitHub repo of the same name.
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
    v_release_date      timestamptz;

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

    v_groups_created    integer := 0;
    v_members_added     integer := 0;
    v_members_moved     integer := 0;
    v_groups_dissolved  integer := 0;
    v_syncs_enqueued    integer := 0;
    v_repos_deferred    integer := 0;
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
           a.repo_mode, a.source_assignment_id, a.release_date,
           jsonb_build_object(
             'blockForcePush', coalesce(a.protect_block_force_push, true),
             'requirePullRequest', coalesce(a.protect_require_pull_request, false),
             'requiredReviewers', coalesce(a.protect_required_reviewers, 0)
           )
    into   v_course_slug, v_github_org, v_assignment_slug, v_template_repo, v_latest_sha,
           v_repo_mode, v_source_assignment_id, v_release_date, v_branch_protection
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

            -- Before release, leave the repo to the release fan-out so it starts on the
            -- latest template commit and students get no access early (#1174). Fork
            -- mode is excluded: the release cron filters on template_repo and never
            -- reaches it.
            if v_creation_method is not null
               and v_release_date is not null
               and v_release_date > now()
               and v_repo_mode <> 'fork_from_prior_assignment' then
                v_repos_deferred := v_repos_deferred + 1;
            -- enqueue repo creation per repo_mode (empty usernames; permission sync below)
            elsif v_creation_method is not null
               and v_github_org is not null
               and (v_repo_mode = 'fork_from_prior_assignment'
                    or (v_template_repo is not null and v_template_repo != '')) then
                perform public.enqueue_github_create_repo(
                    p_class_id,
                    v_github_org,
                    v_course_slug || '-' || v_assignment_slug || '-group-' || public.sanitize_repo_name_component(v_group_name),
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
            -- Kept, but still in v_affected_groups: Phase 3 syncs its repo to the
            -- now-empty member list, which revokes the students who left.
            continue;
        end if;

        delete from public.assignment_group_invitations
        where assignment_group_id = v_empty_gid;
        delete from public.assignment_group_join_request
        where assignment_group_id = v_empty_gid;

        for v_repo_record in
            select r.id, r.repository, r.git_provider
            from public.repositories r
            where r.assignment_group_id = v_empty_gid
              and r.repository is not null
              and position('/' in r.repository) > 0
        loop
            if v_github_org is not null and v_repo_record.git_provider = 'github' then
                perform public.enqueue_github_archive_repo(
                    p_class_id,
                    v_github_org,
                    -- everything after the FIRST slash: the org is one segment, the repo
                    -- name that follows can itself contain a slash
                    substring(v_repo_record.repository from position('/' in v_repo_record.repository) + 1),
                    'batch-dissolve-' || v_empty_gid::text
                );
            end if;
            perform public.delete_repository_rows(array[v_repo_record.id]);
        end loop;

        delete from public.assignment_groups where id = v_empty_gid;
        v_deleted_groups := array_append(v_deleted_groups, v_empty_gid);
        v_groups_dissolved := v_groups_dissolved + 1;
    end loop;

    -- Phase 3: enqueue ONE permission sync per affected repo
    -- Deduplicate and exclude dissolved groups. Preserved (empty, with submissions)
    -- groups are included on purpose: their sync has no usernames, so the worker
    -- removes every student collaborator. Students who leave a group lose access
    -- to its repo even when the repo is kept for its submissions.
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
          -- Forgejo grants come from forgejo-reconciler, which the member insert trigger kicks
          and  r.git_provider = 'github'
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
                        -- everything after the FIRST slash; see the archive call above
                        substring(v_repo_record.repository from position('/' in v_repo_record.repository) + 1),
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
        'repos_deferred',   v_repos_deferred,
        'errors',           to_jsonb(v_errors)
    );
end;
$$;

revoke all on function public.publish_assignment_group_changes(bigint, bigint, jsonb, jsonb) from public, anon;
grant execute on function public.publish_assignment_group_changes(bigint, bigint, jsonb, jsonb) to authenticated, service_role;

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
      SELECT r.id, r.repository, r.git_provider
      FROM repositories r
      WHERE r.assignment_group_id = v_empty_gid
        AND r.repository IS NOT NULL
        AND position('/' in r.repository) > 0
    LOOP
      IF v_github_org IS NOT NULL AND v_repo_record.git_provider = 'github' THEN
        PERFORM enqueue_github_archive_repo(
          p_class_id,
          v_github_org,
          -- everything after the FIRST slash: the repo name can itself contain one
          substring(v_repo_record.repository from position('/' in v_repo_record.repository) + 1),
          'copy-groups-dissolve-' || v_empty_gid::text
        );
      END IF;
      PERFORM public.delete_repository_rows(ARRAY[v_repo_record.id]);
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
      AND r.git_provider = 'github'
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

      -- Enqueue even when v_usernames is empty so the worker reconciles (revokes) stale access on
      -- repos whose membership changed; v_usernames is coalesced to '{}' above, never null.
      IF v_github_org IS NOT NULL THEN
        PERFORM enqueue_github_sync_repo_permissions(
          p_class_id,
          v_github_org,
          substring(v_repo_record.repository from position('/' in v_repo_record.repository) + 1),
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

REVOKE ALL ON FUNCTION public.copy_groups_from_assignment(bigint, bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.copy_groups_from_assignment(bigint, bigint, bigint) TO authenticated, service_role;
