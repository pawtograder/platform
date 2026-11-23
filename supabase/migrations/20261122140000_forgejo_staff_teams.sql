-- CW-P2 (#1375): course staff get write access to a class's Forgejo repos, as the `{slug}-staff` team
-- does on GitHub (syncRepoPermissions grants it maintain on every student, group and handout repo).
--
-- forgejo-reconciler keeps a `{slug}-staff` team in each class's Forgejo org. forgejo_staff_teams() lists,
-- for each class with a Forgejo repo, the team's org and name, the Forgejo logins its members should be
-- (non-disabled instructors, graders and admins, the roles GitHub's staff team holds), and the repos it
-- should reach: ready student and group repos, and handouts. Only repos in the class's own org are
-- listed: the team lives there, and two classes can share a forgejo_org.
--
-- A role change, disable or delete of a staff role kicks the reconciler, so a TA who is removed loses
-- access in minutes rather than at the next hourly run. Enrolment already kicks it
-- (forgejo_reconciler_on_enrollment).

CREATE OR REPLACE FUNCTION public.forgejo_staff_teams(p_instance_url text, p_limit integer)
RETURNS TABLE (
  class_id bigint,
  org text,
  team text,
  logins text[],
  repositories text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH forgejo_classes AS (
    -- Lowercase, like every Forgejo name Pawtograder stores (forgejo_repos_needed).
    SELECT c.id, lower(c.slug) AS slug, lower(coalesce(nullif(c.forgejo_org, ''), c.slug)) AS org
    FROM public.classes c
    WHERE EXISTS (
        SELECT 1 FROM public.repositories r
        WHERE r.class_id = c.id AND r.git_provider = 'forgejo' AND r.is_github_ready
      )
      OR EXISTS (
        SELECT 1 FROM public.assignments a
        WHERE a.class_id = c.id AND a.git_provider = 'forgejo' AND coalesce(a.template_repo, '') <> ''
      )
  )
  SELECT k.id,
         k.org,
         k.slug || '-staff',
         coalesce((
           SELECT array_agg(DISTINCT ga.login ORDER BY ga.login)
           FROM public.user_roles ur
           JOIN public.git_accounts ga ON ga.user_id = ur.user_id AND ga.provider = 'forgejo'
             AND ga.instance_url = p_instance_url AND ga.remote_user_id IS NOT NULL AND ga.login IS NOT NULL
           WHERE ur.class_id = k.id
             AND ur.role IN ('instructor', 'grader', 'admin')
             AND NOT ur.disabled
         ), '{}'),
         coalesce((
           SELECT array_agg(DISTINCT x.repository ORDER BY x.repository)
           FROM (
             SELECT lower(r.repository) AS repository
             FROM public.repositories r
             WHERE r.class_id = k.id AND r.git_provider = 'forgejo' AND r.is_github_ready
             UNION
             SELECT lower(a.template_repo)
             FROM public.assignments a
             WHERE a.class_id = k.id AND a.git_provider = 'forgejo' AND coalesce(a.template_repo, '') <> ''
           ) x
           WHERE split_part(x.repository, '/', 1) = k.org
         ), '{}')
  FROM forgejo_classes k
  -- Random, as in the other backlogs: a class that keeps failing can't hold a place every pass.
  ORDER BY random()
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.forgejo_staff_teams(text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forgejo_staff_teams(text, integer) TO service_role;

-- Statement-level, so a bulk role edit kicks once. Only staff rows in a cloud-workspaces class, the only
-- classes whose users have Forgejo accounts.
CREATE OR REPLACE FUNCTION public.kick_forgejo_reconciler_on_staff_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (
      SELECT 1
      FROM new_roles n
      JOIN old_roles o ON o.id = n.id
      JOIN public.classes c ON c.id = n.class_id
      WHERE (n.role IS DISTINCT FROM o.role OR n.disabled IS DISTINCT FROM o.disabled)
        AND (n.role IN ('instructor', 'grader', 'admin') OR o.role IN ('instructor', 'grader', 'admin'))
        AND public.cloud_workspaces_enabled(c.features)
    ) THEN
      PERFORM public.kick_forgejo_reconciler();
    END IF;
  ELSIF EXISTS (
    SELECT 1
    FROM old_roles o
    JOIN public.classes c ON c.id = o.class_id
    WHERE o.role IN ('instructor', 'grader', 'admin')
      AND NOT o.disabled
      AND public.cloud_workspaces_enabled(c.features)
  ) THEN
    PERFORM public.kick_forgejo_reconciler();
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.kick_forgejo_reconciler_on_staff_change() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS forgejo_reconciler_on_staff_update ON public.user_roles;
CREATE TRIGGER forgejo_reconciler_on_staff_update
  AFTER UPDATE ON public.user_roles
  REFERENCING OLD TABLE AS old_roles NEW TABLE AS new_roles
  FOR EACH STATEMENT EXECUTE FUNCTION public.kick_forgejo_reconciler_on_staff_change();

DROP TRIGGER IF EXISTS forgejo_reconciler_on_staff_delete ON public.user_roles;
CREATE TRIGGER forgejo_reconciler_on_staff_delete
  AFTER DELETE ON public.user_roles
  REFERENCING OLD TABLE AS old_roles
  FOR EACH STATEMENT EXECUTE FUNCTION public.kick_forgejo_reconciler_on_staff_change();
