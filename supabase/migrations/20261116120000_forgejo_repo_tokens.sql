-- Coder workspaces on Forgejo assignments clone and push with a Forgejo token that Pawtograder mints for
-- the student, scoped to the one repository (ForgejoWrapper.mintRepoToken). Forgejo tokens never
-- expire, so revoking them is the only way they end.
--
-- forgejo_repo_tokens records which tokens may exist, never the token itself: a token's name is fixed
-- by its repository id (coderTokenName), so the student's Forgejo login and the repository id are
-- enough to revoke it. A row is written before the mint, so a crash between the two leaves a row and
-- never an untracked token.
--
-- forgejo-reconciler revokes a token once its student no longer has an enabled role in the
-- repository's class, or the repository is gone. It claims the row, deletes the token in Forgejo, then
-- deletes the row. A claim older than the stale window belonged to a pass that died, and the next pass
-- takes it over; deleting a token that is already gone succeeds, so retrying is safe.

CREATE TABLE public.forgejo_repo_tokens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users (user_id) ON DELETE CASCADE,
  -- Not a foreign key, like coder_workspaces.repository_id: the row has to outlive the repository
  -- until the token is revoked, and keys into repositories must be NO ACTION and cleared by every
  -- delete path (AGENTS.md).
  repository_id bigint NOT NULL,
  -- FORGEJO_URL at the mint, matching git_accounts.instance_url.
  instance_url text NOT NULL,
  -- The latest mint. Written before Forgejo is called.
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- Set by the pass revoking the token; cleared by a new mint.
  revoke_claimed_at timestamptz,
  UNIQUE (user_id, repository_id, instance_url)
);

CREATE INDEX forgejo_repo_tokens_repository_id_idx ON public.forgejo_repo_tokens (repository_id);

COMMENT ON TABLE public.forgejo_repo_tokens IS
  'Forgejo workspace tokens that may exist, one per student per repository. Holds no token. Written only by the service role.';

ALTER TABLE public.forgejo_repo_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.forgejo_repo_tokens FROM public, anon, authenticated;

-- Whether this student's token for this repository should be revoked: the repository is gone, or the
-- student has no enabled role in its class.
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

-- Records a mint that is about to happen. Clears any revocation claim, so a pass that claimed the row
-- before the student came back doesn't delete the row of the token minted now.
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
    DO UPDATE SET recorded_at = now(), revoke_claimed_at = NULL;
$$;

-- Tokens on this instance whose student has left the repository's class, with no claim younger than
-- the stale window. login is the student's Forgejo login, NULL when they have no finished account.
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

-- True when the caller now owns revoking this token. Checks again that it should be revoked, so a
-- student who re-enrolled since the list was read keeps their token.
CREATE OR REPLACE FUNCTION public.claim_forgejo_repo_token_revocation(
  p_id bigint,
  p_stale_minutes integer
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH claimed AS (
    UPDATE public.forgejo_repo_tokens t
    SET revoke_claimed_at = now()
    WHERE t.id = p_id
      AND (t.revoke_claimed_at IS NULL OR t.revoke_claimed_at <= now() - make_interval(mins => p_stale_minutes))
      AND public.forgejo_repo_token_revocable(t.user_id, t.repository_id)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

REVOKE ALL ON FUNCTION public.forgejo_repo_token_revocable(uuid, bigint) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_forgejo_repo_token(uuid, bigint, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.forgejo_repo_tokens_to_revoke(text, integer, integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_forgejo_repo_token_revocation(bigint, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_forgejo_repo_token(uuid, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.forgejo_repo_tokens_to_revoke(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_forgejo_repo_token_revocation(bigint, integer) TO service_role;

-- A drop kicks the reconciler, so the token stops working within minutes rather than at the next
-- hourly run. Statement-level, so a roster sync that disables hundreds of rows kicks once, and only
-- when one of those students holds a token.
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

-- Transition tables can't be combined with a column list (UPDATE OF disabled), so the function
-- compares old and new itself.
CREATE TRIGGER forgejo_reconciler_on_role_disable
  AFTER UPDATE ON public.user_roles
  REFERENCING OLD TABLE AS old_roles NEW TABLE AS new_roles
  FOR EACH STATEMENT EXECUTE FUNCTION public.kick_forgejo_reconciler_on_drop();

CREATE TRIGGER forgejo_reconciler_on_role_delete
  AFTER DELETE ON public.user_roles
  REFERENCING OLD TABLE AS old_roles
  FOR EACH STATEMENT EXECUTE FUNCTION public.kick_forgejo_reconciler_on_drop();
