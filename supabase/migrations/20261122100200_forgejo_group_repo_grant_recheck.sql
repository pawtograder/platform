-- Review follow-up on #1397 (CW-P1, #1374): a member who leaves a group never keeps its Forgejo repo.
--
-- reconcileForgejoGroupRepos reads a group's roster from forgejo_group_repos_needed at the start of the
-- pass. Granting from that list alone leaves two holes:
--   * a member who leaves before the group's repositories row is reserved queues no revocation, because
--     forgejo_group_members_left joins public.repositories and finds nothing, yet is still granted;
--   * a pass slow enough to grant after the revocation's 10-minute second removal leaves access behind.
-- The reconciler now reads the roster again with forgejo_group_member_logins after the row is reserved,
-- grants only those logins, then reads it once more and removes anyone granted who has left since. A leave
-- after that last read finds the row and queues a revocation whose removals run after the grant, so the
-- outcome no longer depends on the grace period.
CREATE OR REPLACE FUNCTION public.forgejo_group_member_logins(p_assignment_group_id bigint, p_instance_url text)
RETURNS TABLE (login text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  -- The same membership test as forgejo_group_repos_needed: enabled roles with a Forgejo login here.
  SELECT DISTINCT ga.login
  FROM public.assignment_groups_members m
  JOIN public.assignment_groups g ON g.id = m.assignment_group_id
  JOIN public.assignments a ON a.id = g.assignment_id
  JOIN public.user_roles ur ON ur.class_id = a.class_id AND ur.private_profile_id = m.profile_id AND NOT ur.disabled
  JOIN public.git_accounts ga ON ga.user_id = ur.user_id AND ga.provider = 'forgejo'
    AND ga.instance_url = p_instance_url AND ga.login IS NOT NULL
  WHERE m.assignment_group_id = p_assignment_group_id
  ORDER BY ga.login;
$$;

REVOKE ALL ON FUNCTION public.forgejo_group_member_logins(bigint, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forgejo_group_member_logins(bigint, text) TO service_role;

-- From 20261121210100_forgejo_group_repo_revocations.sql. A rejoin now cancels only rows no pass has claimed.
-- A claimed row is mid-removal: deleting it would leave nothing to retry if that pass fails before
-- finish_forgejo_group_repo_revocation, which is what re-grants a member who is back. Kept, a retry removes
-- the member briefly and finish re-grants them.
CREATE OR REPLACE FUNCTION public.forgejo_group_members_rejoined(p_group_ids bigint[], p_profile_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.forgejo_group_repo_revocations v
  USING unnest(p_group_ids, p_profile_ids) AS l(gid, pid)
  WHERE v.assignment_group_id = l.gid AND v.profile_id = l.pid AND v.claim_id IS NULL;
$$;

REVOKE ALL ON FUNCTION public.forgejo_group_members_rejoined(bigint[], uuid[]) FROM public, anon, authenticated;
