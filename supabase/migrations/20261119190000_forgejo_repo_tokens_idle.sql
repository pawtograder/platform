-- Forgejo tokens don't expire. Besides a dropped student's, the reconciler now also revokes a workspace token that no
-- open has re-minted for 14 days (IDLE_TOKEN_MS in ForgejoWrapper.ts). Every workspace start through Pawtograder
-- re-mints the token and moves recorded_at, so this only ends tokens for repositories the student stopped opening.
-- Only the two listing functions change; forgejo_repo_token_revocable still means "dropped".

CREATE OR REPLACE FUNCTION public.forgejo_repo_tokens_to_revoke(
  p_instance_url text,
  p_stale_minutes integer,
  p_limit integer
) RETURNS TABLE (id bigint, user_id uuid, repository_id bigint, login text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT t.id, t.user_id, t.repository_id, ga.login
  FROM public.forgejo_repo_tokens t
  LEFT JOIN public.git_accounts ga
    ON ga.user_id = t.user_id AND ga.provider = 'forgejo' AND ga.instance_url = t.instance_url
  WHERE t.instance_url = p_instance_url
    -- The row is recorded before the mint. Wait out any mint still in flight, so the revoke can't run
    -- before the token exists and delete the only row tracking it. Same grace as REPLACED_TOKEN_GRACE_MS.
    AND t.recorded_at <= now() - interval '10 minutes'
    AND (t.revoke_claimed_at IS NULL OR t.revoke_claimed_at <= now() - make_interval(mins => p_stale_minutes))
    AND (
      t.recorded_at <= now() - interval '14 days'
      OR public.forgejo_repo_token_revocable(t.user_id, t.repository_id)
    )
  ORDER BY t.revoke_claimed_at ASC NULLS FIRST, t.id
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION public.claim_forgejo_repo_token_revocation(
  p_id bigint,
  p_stale_minutes integer
) RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.forgejo_repo_tokens t
  SET revoke_claimed_at = now(),
      revoke_claim_id = nextval('public.forgejo_repo_token_claims')
  WHERE t.id = p_id
    -- A re-mint between listing and claiming moves recorded_at; skip the row until that mint has settled.
    -- It also takes an idle row out of the 14-day condition.
    AND t.recorded_at <= now() - interval '10 minutes'
    AND (t.revoke_claimed_at IS NULL OR t.revoke_claimed_at <= now() - make_interval(mins => p_stale_minutes))
    AND (
      t.recorded_at <= now() - interval '14 days'
      OR public.forgejo_repo_token_revocable(t.user_id, t.repository_id)
    )
  RETURNING t.revoke_claim_id;
$$;

REVOKE ALL ON FUNCTION public.forgejo_repo_tokens_to_revoke(text, integer, integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_forgejo_repo_token_revocation(bigint, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forgejo_repo_tokens_to_revoke(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_forgejo_repo_token_revocation(bigint, integer) TO service_role;
