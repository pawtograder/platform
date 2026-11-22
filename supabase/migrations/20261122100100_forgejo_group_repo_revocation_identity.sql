-- Review follow-up on #1397 (CW-P1, #1374): a delayed revocation must act on the repository it was queued
-- for, not on whatever now answers to that name.
--
-- Each revocation is carried out twice: once right away and once after a 10-minute grace, in case a group
-- pass that read the roster before the student left granted them afterwards. The row identified its target
-- by `owner/name` alone, deliberately, so it could outlive the repository row.
--
-- That holds until a name is reused. #1398 archives a repo by removing every collaborator and renaming it
-- `archived-<timestamp>-<name>`, which frees the original name, and deleting an assignment removes the
-- `repositories` rows outright. So between the two revokes a new group can be given a repo with the old
-- name, and if that group includes the same student, the second revoke removes them from a repo they
-- belong to. The repair path cannot fix it either: finish_forgejo_group_repo_revocation checks membership
-- of the OLD group id, so it never marks the new group's repo not ready.
--
-- The row now records which repository row it was queued for. The reconciler re-reads that row before the
-- removal and discards the revocation when the id is gone or the name has moved, because an archived repo
-- has already had every collaborator removed.
--
-- repository_id stays NULLABLE on purpose. Rows queued before this migration have no id, and the only
-- honest backfill is by name. Deleting what cannot be matched would silently drop a real pending removal:
-- the justification for dropping them ("archiving already stripped the collaborators") rests on #1398,
-- which has not merged. A null id means "queued before the identity check existed", and those rows take
-- the old name-only path. Only rows queued in the few minutes before deploy can be null.

ALTER TABLE public.forgejo_group_repo_revocations
  ADD COLUMN IF NOT EXISTS repository_id bigint;

COMMENT ON COLUMN public.forgejo_group_repo_revocations.repository_id IS
  'The repositories row this revocation was queued for. No foreign key: the row must outlive it. Null for rows queued before the identity check, which fall back to matching on name alone.';

-- Best effort, and total in practice: repositories_validate_git_provider refuses to delete a Forgejo
-- repositories row today, so nothing queued can have lost its row yet.
UPDATE public.forgejo_group_repo_revocations v
SET repository_id = r.id
FROM public.repositories r
WHERE v.repository_id IS NULL
  AND r.git_provider = 'forgejo'
  AND r.repository = v.repository;

-- From 20261121200000_forgejo_group_repo_revocations.sql. The only change is recording r.id, on insert and
-- on the conflict update: a re-queue for the same (repo, login) may well be a different repository row.
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
    (assignment_group_id, profile_id, repository, repository_id, instance_url, login)
  SELECT DISTINCT ON (r.repository, ga.instance_url, ga.login)
         l.gid, l.pid, r.repository, r.id, ga.instance_url, ga.login
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
        repository_id = EXCLUDED.repository_id,
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

-- From the same migration, now also returning repository_id. Mismatched rows are NOT filtered out here:
-- the reconciler has to claim them to delete them, and a filter would leave them queued for good.
CREATE OR REPLACE FUNCTION public.forgejo_group_repo_revocations_needed(
  p_instance_url text,
  p_stale_minutes integer,
  p_limit integer
) RETURNS TABLE (
  id bigint,
  assignment_group_id bigint,
  profile_id uuid,
  repository text,
  repository_id bigint,
  login text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT v.id, v.assignment_group_id, v.profile_id, v.repository, v.repository_id, v.login
  FROM public.forgejo_group_repo_revocations v
  WHERE v.instance_url = p_instance_url
    AND (v.claimed_at IS NULL OR v.claimed_at <= now() - make_interval(mins => p_stale_minutes))
    AND (v.first_revoked_at IS NULL OR now() >= v.created_at + interval '10 minutes')
  ORDER BY v.claimed_at ASC NULLS FIRST, v.id
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.forgejo_group_repo_revocations_needed(text, integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forgejo_group_repo_revocations_needed(text, integer, integer) TO service_role;
