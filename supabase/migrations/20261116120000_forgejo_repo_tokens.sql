-- Forgejo tokens never expire, so revocation is the only way they end.

CREATE SEQUENCE public.forgejo_repo_token_claims AS bigint;

CREATE TABLE public.forgejo_repo_tokens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Keep the user until the reconciler has revoked every token.
  user_id uuid NOT NULL REFERENCES public.users (user_id) ON DELETE NO ACTION,
  -- No FK: the row must outlive the repository until the token is revoked.
  repository_id bigint NOT NULL,
  instance_url text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  revoke_claimed_at timestamptz,
  -- Which claim holds the row. Wall time can repeat, so the stamp above can't identify a claim.
  revoke_claim_id bigint,
  UNIQUE (user_id, repository_id, instance_url)
);

CREATE INDEX forgejo_repo_tokens_repository_id_idx ON public.forgejo_repo_tokens (repository_id);

COMMENT ON TABLE public.forgejo_repo_tokens IS
  'Forgejo workspace tokens that may exist, one per student per repository. Holds no token. Written only by the service role.';

ALTER TABLE public.forgejo_repo_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.forgejo_repo_tokens FROM public, anon, authenticated;
REVOKE ALL ON SEQUENCE public.forgejo_repo_token_claims FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.forgejo_repo_token_revocable(p_user_id uuid, p_repository_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.repositories r
    JOIN public.user_roles ur ON ur.class_id = r.class_id
    WHERE r.id = p_repository_id
      AND ur.user_id = p_user_id
      AND NOT ur.disabled
  );
$$;

CREATE OR REPLACE FUNCTION public.record_forgejo_repo_token(
  p_user_id uuid,
  p_repository_id bigint,
  p_instance_url text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.forgejo_repo_tokens AS t (user_id, repository_id, instance_url)
  VALUES (p_user_id, p_repository_id, p_instance_url)
  ON CONFLICT (user_id, repository_id, instance_url)
    DO UPDATE SET recorded_at = now(), revoke_claimed_at = NULL, revoke_claim_id = NULL;
$$;

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
    AND (t.revoke_claimed_at IS NULL OR t.revoke_claimed_at <= now() - make_interval(mins => p_stale_minutes))
    AND public.forgejo_repo_token_revocable(t.user_id, t.repository_id)
  ORDER BY t.revoke_claimed_at ASC NULLS FIRST, t.id
  LIMIT p_limit;
$$;

-- Returns the claim generation for the caller's delete to match; the stamp only ages the claim out.
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
    AND (t.revoke_claimed_at IS NULL OR t.revoke_claimed_at <= now() - make_interval(mins => p_stale_minutes))
    AND public.forgejo_repo_token_revocable(t.user_id, t.repository_id)
  RETURNING t.revoke_claim_id;
$$;

REVOKE ALL ON FUNCTION public.forgejo_repo_token_revocable(uuid, bigint) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_forgejo_repo_token(uuid, bigint, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.forgejo_repo_tokens_to_revoke(text, integer, integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_forgejo_repo_token_revocation(bigint, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_forgejo_repo_token(uuid, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.forgejo_repo_tokens_to_revoke(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_forgejo_repo_token_revocation(bigint, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.kick_forgejo_reconciler_on_drop()
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
      WHERE n.disabled AND NOT o.disabled
        AND EXISTS (SELECT 1 FROM public.forgejo_repo_tokens t WHERE t.user_id = n.user_id)
    ) THEN
      PERFORM public.kick_forgejo_reconciler();
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM old_roles o
    WHERE EXISTS (SELECT 1 FROM public.forgejo_repo_tokens t WHERE t.user_id = o.user_id)
  ) THEN
    PERFORM public.kick_forgejo_reconciler();
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.kick_forgejo_reconciler_on_drop() FROM public, anon, authenticated;

-- Postgres disallows transition tables with a column list (UPDATE OF disabled).
CREATE TRIGGER forgejo_reconciler_on_role_disable
  AFTER UPDATE ON public.user_roles
  REFERENCING OLD TABLE AS old_roles NEW TABLE AS new_roles
  FOR EACH STATEMENT EXECUTE FUNCTION public.kick_forgejo_reconciler_on_drop();

CREATE TRIGGER forgejo_reconciler_on_role_delete
  AFTER DELETE ON public.user_roles
  REFERENCING OLD TABLE AS old_roles
  FOR EACH STATEMENT EXECUTE FUNCTION public.kick_forgejo_reconciler_on_drop();
