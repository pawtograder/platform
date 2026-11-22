-- Review follow-up on #1397 (CW-P2, #1375): keep removing dropped staff from a class whose Forgejo repos
-- are all gone.
--
-- forgejo_staff_teams() listed a class only while it still had a ready Forgejo repository or an assignment
-- with a handout. The team itself outlives both: #1398 archives a deleted assignment's repos, which removes
-- their `repositories` rows but leaves the Forgejo team and the repo grants it holds. So a class whose last
-- Forgejo assignment was deleted dropped out of the backlog, syncTeamMembers stopped running for it, and a
-- TA dropped after that kept team access indefinitely — on repos that are archived but still readable.
--
-- The fix is to remember that the team exists, rather than inferring it from live repo rows.
-- reconcileForgejoStaffTeams records the class as soon as ensureStaffTeam returns, and the backlog returns
-- a recorded class forever after. With no live repos it reports `repositories = '{}'`, so grantTeamRepos is
-- a no-op while syncTeamMembers still removes whoever left.

CREATE TABLE IF NOT EXISTS public.forgejo_class_staff_teams (
  class_id bigint NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  instance_url text NOT NULL,
  org text NOT NULL,
  team text NOT NULL,
  team_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, instance_url)
);

COMMENT ON TABLE public.forgejo_class_staff_teams IS
  'Classes whose Forgejo staff team has been created, so membership removal keeps running once their repos are archived. Written by the service role.';

ALTER TABLE public.forgejo_class_staff_teams ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.forgejo_class_staff_teams FROM public, anon, authenticated;

-- Called once the team exists on Forgejo. ON CONFLICT DO NOTHING: the row is a marker, and re-recording it
-- every pass would churn created_at for nothing.
CREATE OR REPLACE FUNCTION public.record_forgejo_staff_team(
  p_class_id bigint,
  p_instance_url text,
  p_org text,
  p_team text,
  p_team_id bigint
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.forgejo_class_staff_teams (class_id, instance_url, org, team, team_id)
  VALUES (p_class_id, p_instance_url, p_org, p_team, p_team_id)
  ON CONFLICT (class_id, instance_url) DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.record_forgejo_staff_team(bigint, text, text, text, bigint) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_forgejo_staff_team(bigint, text, text, text, bigint) TO service_role;

-- From 20261121170000_forgejo_staff_teams.sql. The only change is the third arm of forgejo_classes: a class
-- with a recorded staff team stays in the backlog even once its repos and handouts are gone.
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
      -- The team outlives the repos that caused it, and so must the removals it needs.
      OR EXISTS (
        SELECT 1 FROM public.forgejo_class_staff_teams t
        WHERE t.class_id = c.id AND t.instance_url = p_instance_url
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
