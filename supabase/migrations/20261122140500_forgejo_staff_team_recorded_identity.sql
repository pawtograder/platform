-- Review follow-up on #1397 (CW-P2, #1375): a staff team keeps being reconciled under the name it was
-- created with, whatever later happens to the class's slug or forgejo_org.
--
-- forgejo_staff_teams() derived each class's team from the current classes.slug and forgejo_org. The
-- marker row in forgejo_class_staff_teams kept the original org and team, but only as a flag. So after
-- admin_update_class changed the slug, the backlog named a new `<new-slug>-staff` team, ensureStaffTeam
-- created it, and the team holding every existing grant was never synced again: a staff member removed
-- later kept write access to all of its repos.
--
-- The recorded identity is now the team. For each recorded team the backlog returns that org and team,
-- so members are synced against it (removals included) and new repos in its org are added to it; a slug
-- change only changes the names of repos created afterwards, which land in the same team.
--
-- A team belongs to one org, so a class whose forgejo_org changes needs a team in the new org as well
-- for the repos created there. The marker is therefore keyed per org: (class_id, instance_url, org). A
-- derived team is listed only when the class has no recorded team in that org yet; once created it is
-- recorded and listed by its recorded name from then on. The old org's team stays listed, so staff
-- removals keep reaching the repos it still holds.

ALTER TABLE public.forgejo_class_staff_teams DROP CONSTRAINT forgejo_class_staff_teams_pkey;
ALTER TABLE public.forgejo_class_staff_teams ADD PRIMARY KEY (class_id, instance_url, org);

-- From 20261122140200_forgejo_staff_team_records.sql; the conflict target follows the new key.
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
  VALUES (p_class_id, p_instance_url, lower(p_org), lower(p_team), p_team_id)
  ON CONFLICT (class_id, instance_url, org) DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.record_forgejo_staff_team(bigint, text, text, text, bigint) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_forgejo_staff_team(bigint, text, text, text, bigint) TO service_role;

-- From 20261122140200_forgejo_staff_team_records.sql. One row per team rather than per class: every
-- recorded team under its recorded name, plus the derived team for a class with live Forgejo repos or
-- handouts but no recorded team in its current org.
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
  WITH derived AS (
    -- Lowercase, like every Forgejo name Pawtograder stores (forgejo_repos_needed).
    SELECT c.id AS class_id,
           lower(coalesce(nullif(c.forgejo_org, ''), c.slug)) AS org,
           lower(c.slug) || '-staff' AS team
    FROM public.classes c
    WHERE EXISTS (
        SELECT 1 FROM public.repositories r
        WHERE r.class_id = c.id AND r.git_provider = 'forgejo' AND r.is_github_ready
      )
      OR EXISTS (
        SELECT 1 FROM public.assignments a
        WHERE a.class_id = c.id AND a.git_provider = 'forgejo' AND coalesce(a.template_repo, '') <> ''
      )
  ),
  teams AS (
    SELECT t.class_id, lower(t.org) AS org, lower(t.team) AS team
    FROM public.forgejo_class_staff_teams t
    WHERE t.instance_url = p_instance_url
    UNION ALL
    SELECT d.class_id, d.org, d.team
    FROM derived d
    WHERE NOT EXISTS (
      SELECT 1 FROM public.forgejo_class_staff_teams t
      WHERE t.class_id = d.class_id AND t.instance_url = p_instance_url AND lower(t.org) = d.org
    )
  )
  SELECT k.class_id,
         k.org,
         k.team,
         coalesce((
           SELECT array_agg(DISTINCT ga.login ORDER BY ga.login)
           FROM public.user_roles ur
           JOIN public.git_accounts ga ON ga.user_id = ur.user_id AND ga.provider = 'forgejo'
             AND ga.instance_url = p_instance_url AND ga.remote_user_id IS NOT NULL AND ga.login IS NOT NULL
           WHERE ur.class_id = k.class_id
             AND ur.role IN ('instructor', 'grader', 'admin')
             AND NOT ur.disabled
         ), '{}'),
         coalesce((
           SELECT array_agg(DISTINCT x.repository ORDER BY x.repository)
           FROM (
             SELECT lower(r.repository) AS repository
             FROM public.repositories r
             WHERE r.class_id = k.class_id AND r.git_provider = 'forgejo' AND r.is_github_ready
             UNION
             SELECT lower(a.template_repo)
             FROM public.assignments a
             WHERE a.class_id = k.class_id AND a.git_provider = 'forgejo' AND coalesce(a.template_repo, '') <> ''
           ) x
           -- A team can only hold repos in its own org.
           WHERE split_part(x.repository, '/', 1) = k.org
         ), '{}')
  FROM teams k
  -- Random, as in the other backlogs: a team that keeps failing can't hold a place every pass.
  ORDER BY random()
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.forgejo_staff_teams(text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forgejo_staff_teams(text, integer) TO service_role;
