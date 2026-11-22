-- CW-P1 (#1374): a student who leaves a Forgejo group loses write access to the group's repo.
--
-- 20261118140200_forgejo_group_repos.sql grants every member of a group write access to its Forgejo repo, and
-- re-grants when someone joins, but left "removing a member who leaves" out of scope. This queues one row per
-- (repo, Forgejo login) whenever a membership leaves a group that has a Forgejo repo, whatever the path:
-- the instructor move function, publish_assignment_group_changes, copy_groups_from_assignment,
-- assignment-group-leave, or a cascade from deleting the group. forgejo-reconciler removes the collaborator.
--
-- Rejoining the same group before the pass cancels the row. A rejoin while the pass is removing the collaborator
-- is caught by finish_forgejo_group_repo_revocation, which marks the repo not ready so the next pass grants again.
--
-- A group pass that read the roster before the student left can still grant them afterwards. Passes end well
-- within 10 minutes (the same grace as forgejo_repo_tokens), so each row is removed once right away and once more
-- after 10 minutes, and only then deleted.

CREATE SEQUENCE public.forgejo_group_repo_revocation_claims AS bigint;

CREATE TABLE public.forgejo_group_repo_revocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- No foreign keys: the row must outlive a dissolved group, its repository row and the membership.
  assignment_group_id bigint NOT NULL,
  profile_id uuid NOT NULL,
  -- The Forgejo owner/name and login, copied when the student left, so the removal needs neither row.
  repository text NOT NULL,
  instance_url text NOT NULL,
  login text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- When the claim that removed the collaborator before the 10-minute grace was taken; null until then.
  first_revoked_at timestamptz,
  claimed_at timestamptz,
  claim_id bigint,
  UNIQUE (repository, instance_url, login)
);

CREATE INDEX forgejo_group_repo_revocations_group_profile_idx
  ON public.forgejo_group_repo_revocations (assignment_group_id, profile_id);

COMMENT ON TABLE public.forgejo_group_repo_revocations IS
  'Forgejo group repo collaborators to remove, one per student who left the group. Written by triggers and the service role.';

ALTER TABLE public.forgejo_group_repo_revocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.forgejo_group_repo_revocations FROM public, anon, authenticated;
REVOKE ALL ON SEQUENCE public.forgejo_group_repo_revocation_claims FROM public, anon, authenticated;

-- Queues the removal of each (group, profile) pair's Forgejo login from the group's Forgejo repo, and kicks
-- the reconciler. A student with no Forgejo login was never granted, so has nothing to remove.
CREATE OR REPLACE FUNCTION public.forgejo_group_members_left(p_group_ids bigint[], p_profile_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_queued integer;
BEGIN
  INSERT INTO public.forgejo_group_repo_revocations AS v
    (assignment_group_id, profile_id, repository, instance_url, login)
  SELECT DISTINCT ON (r.repository, ga.instance_url, ga.login) l.gid, l.pid, r.repository, ga.instance_url, ga.login
  FROM unnest(p_group_ids, p_profile_ids) AS l(gid, pid)
  JOIN public.repositories r ON r.assignment_group_id = l.gid AND r.git_provider = 'forgejo'
  -- Disabled roles too: a disabled student who is moved out keeps their grant otherwise.
  JOIN public.user_roles ur ON ur.class_id = r.class_id AND ur.private_profile_id = l.pid
  JOIN public.git_accounts ga ON ga.user_id = ur.user_id AND ga.provider = 'forgejo' AND ga.login IS NOT NULL
  -- A member who is still (or again) in the group keeps access: copy_groups_from_assignment deletes every
  -- membership and re-inserts most of them in the same statement sequence.
  WHERE NOT EXISTS (
    SELECT 1 FROM public.assignment_groups_members m
    WHERE m.assignment_group_id = l.gid AND m.profile_id = l.pid
  )
  ORDER BY r.repository, ga.instance_url, ga.login
  ON CONFLICT (repository, instance_url, login) DO UPDATE
    SET assignment_group_id = EXCLUDED.assignment_group_id,
        profile_id = EXCLUDED.profile_id,
        created_at = now(),
        first_revoked_at = NULL,
        claimed_at = NULL,
        claim_id = NULL;
  GET DIAGNOSTICS v_queued = ROW_COUNT;
  IF v_queued > 0 THEN
    PERFORM public.kick_forgejo_reconciler();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.forgejo_group_members_left(bigint[], uuid[]) FROM public, anon, authenticated;

-- A student who is back in the group keeps the access the grant path gives them.
CREATE OR REPLACE FUNCTION public.forgejo_group_members_rejoined(p_group_ids bigint[], p_profile_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.forgejo_group_repo_revocations v
  USING unnest(p_group_ids, p_profile_ids) AS l(gid, pid)
  WHERE v.assignment_group_id = l.gid AND v.profile_id = l.pid;
$$;

REVOKE ALL ON FUNCTION public.forgejo_group_members_rejoined(bigint[], uuid[]) FROM public, anon, authenticated;

-- From 20261118140200_forgejo_group_repos.sql, now also cancelling a pending removal for the group joined.
CREATE OR REPLACE FUNCTION public.forgejo_group_member_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.forgejo_group_members_rejoined(
    ARRAY(SELECT n.assignment_group_id FROM new_members n),
    ARRAY(SELECT n.profile_id FROM new_members n)
  );
  PERFORM public.forgejo_groups_need_grants(ARRAY(SELECT DISTINCT assignment_group_id FROM new_members));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.forgejo_group_member_added() FROM public, anon, authenticated;

-- From 20261118140200_forgejo_group_repos.sql, now also queueing the removal from the group left.
CREATE OR REPLACE FUNCTION public.forgejo_group_member_moved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_groups bigint[];
  v_new_groups bigint[];
  v_profiles uuid[];
BEGIN
  -- Parallel arrays in one order, so the nth group goes with the nth profile.
  SELECT coalesce(array_agg(o.assignment_group_id ORDER BY n.id), '{}'),
         coalesce(array_agg(n.assignment_group_id ORDER BY n.id), '{}'),
         coalesce(array_agg(n.profile_id ORDER BY n.id), '{}')
  INTO v_old_groups, v_new_groups, v_profiles
  FROM new_members n JOIN old_members o ON o.id = n.id
  WHERE n.assignment_group_id IS DISTINCT FROM o.assignment_group_id;
  IF cardinality(v_profiles) = 0 THEN
    RETURN NULL;
  END IF;
  PERFORM public.forgejo_group_members_rejoined(v_new_groups, v_profiles);
  PERFORM public.forgejo_group_members_left(v_old_groups, v_profiles);
  PERFORM public.forgejo_groups_need_grants(ARRAY(SELECT DISTINCT unnest(v_new_groups)));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.forgejo_group_member_moved() FROM public, anon, authenticated;

-- Statement-level, like the insert trigger, so dissolving a group or copying groups kicks once.
CREATE OR REPLACE FUNCTION public.forgejo_group_member_removed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.forgejo_group_members_left(
    ARRAY(SELECT o.assignment_group_id FROM old_members o ORDER BY o.id),
    ARRAY(SELECT o.profile_id FROM old_members o ORDER BY o.id)
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.forgejo_group_member_removed() FROM public, anon, authenticated;

CREATE TRIGGER forgejo_group_member_removed
  AFTER DELETE ON public.assignment_groups_members
  REFERENCING OLD TABLE AS old_members
  FOR EACH STATEMENT EXECUTE FUNCTION public.forgejo_group_member_removed();

-- Rows due for a removal: never removed, or removed only before the 10-minute grace and now past it.
CREATE OR REPLACE FUNCTION public.forgejo_group_repo_revocations_needed(
  p_instance_url text,
  p_stale_minutes integer,
  p_limit integer
) RETURNS TABLE (id bigint, assignment_group_id bigint, profile_id uuid, repository text, login text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT v.id, v.assignment_group_id, v.profile_id, v.repository, v.login
  FROM public.forgejo_group_repo_revocations v
  WHERE v.instance_url = p_instance_url
    AND (v.claimed_at IS NULL OR v.claimed_at <= now() - make_interval(mins => p_stale_minutes))
    AND (v.first_revoked_at IS NULL OR now() >= v.created_at + interval '10 minutes')
  ORDER BY v.claimed_at ASC NULLS FIRST, v.id
  LIMIT p_limit;
$$;

-- Returns the claim generation for finish_forgejo_group_repo_revocation to match, or null when another pass
-- holds the row or it isn't due.
CREATE OR REPLACE FUNCTION public.claim_forgejo_group_repo_revocation(p_id bigint, p_stale_minutes integer)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.forgejo_group_repo_revocations v
  SET claimed_at = now(),
      claim_id = nextval('public.forgejo_group_repo_revocation_claims')
  WHERE v.id = p_id
    AND (v.claimed_at IS NULL OR v.claimed_at <= now() - make_interval(mins => p_stale_minutes))
    AND (v.first_revoked_at IS NULL OR now() >= v.created_at + interval '10 minutes')
  RETURNING v.claim_id;
$$;

-- Called after Forgejo removed the collaborator. A removal claimed after the grace is the last one, so the row
-- goes; an earlier one is recorded and the row waits for its second removal. If the student is in the group
-- again, the removal took access they should have: the repo is marked not ready and the next pass re-grants.
-- The group row lock orders this against forgejo_groups_need_grants and save_forgejo_group_repo.
CREATE OR REPLACE FUNCTION public.finish_forgejo_group_repo_revocation(
  p_id bigint,
  p_claim_id bigint,
  p_assignment_group_id bigint,
  p_profile_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.assignment_groups g WHERE g.id = p_assignment_group_id FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.assignment_groups_members m
    WHERE m.assignment_group_id = p_assignment_group_id AND m.profile_id = p_profile_id
  ) THEN
    DELETE FROM public.forgejo_group_repo_revocations v
    WHERE v.id = p_id AND v.assignment_group_id = p_assignment_group_id AND v.profile_id = p_profile_id;
    PERFORM public.forgejo_groups_need_grants(ARRAY[p_assignment_group_id]);
    RETURN;
  END IF;
  DELETE FROM public.forgejo_group_repo_revocations v
  WHERE v.id = p_id AND v.claim_id = p_claim_id AND v.claimed_at >= v.created_at + interval '10 minutes';
  UPDATE public.forgejo_group_repo_revocations v
  SET first_revoked_at = v.claimed_at, claimed_at = NULL, claim_id = NULL
  WHERE v.id = p_id AND v.claim_id = p_claim_id;
END;
$$;

REVOKE ALL ON FUNCTION public.forgejo_group_repo_revocations_needed(text, integer, integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_forgejo_group_repo_revocation(bigint, integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_forgejo_group_repo_revocation(bigint, bigint, bigint, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forgejo_group_repo_revocations_needed(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_forgejo_group_repo_revocation(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_forgejo_group_repo_revocation(bigint, bigint, bigint, uuid) TO service_role;
