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
  -- already saved, and this clears what it saved.
  PERFORM 1 FROM public.assignment_groups g
  WHERE g.id IN (SELECT DISTINCT assignment_group_id FROM new_members)
  ORDER BY g.id FOR UPDATE;
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
  SELECT * INTO v_group FROM public.assignment_groups WHERE id = p_assignment_group_id FOR UPDATE;
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
