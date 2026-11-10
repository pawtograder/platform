-- CW-12 (#1092): one Forgejo account per Pawtograder user enrolled in a cloud-workspaces class.
--
-- Forgejo's chart leaves auto-registration off, so a student can only sign in to Forgejo once
-- Pawtograder has created their account. forgejo-reconciler does that: it asks
-- forgejo_accounts_needed() who is missing, claims each user with claim_git_account(), creates or
-- adopts the account through Forgejo's admin API, then fills in remote_user_id and login.
--
-- A row with remote_user_id NULL is a claim in flight. Claiming before calling Forgejo is what keeps
-- two overlapping runs from creating two accounts for one person; a claim older than the stale window
-- belonged to a run that died, and the next run may take it over and adopt whatever that run created.

CREATE TABLE public.git_accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users (user_id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('forgejo')),
  -- FORGEJO_URL at creation, so pointing a deployment at a new instance provisions there again.
  instance_url text NOT NULL,
  remote_user_id bigint,
  login text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, instance_url),
  UNIQUE (provider, instance_url, remote_user_id),
  CHECK ((remote_user_id IS NULL) = (login IS NULL))
);

COMMENT ON TABLE public.git_accounts IS
  'Accounts Pawtograder created for its users on other git hosts. Written only by forgejo-reconciler.';

ALTER TABLE public.git_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY git_accounts_select_own ON public.git_accounts
  FOR SELECT USING (user_id = auth.uid());

-- Staff see the Forgejo usernames of people in their classes on the roster.
CREATE POLICY git_accounts_select_class_staff ON public.git_accounts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = git_accounts.user_id AND public.authorizeforclassgrader(ur.class_id)
    )
  );

-- Same first-entry, boolean-only semantics as courseFeatureEnabled and #1128's provider trigger.
-- A missing or malformed features value is off.
CREATE OR REPLACE FUNCTION public.cloud_workspaces_enabled(p_features jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT f -> 'enabled' = 'true'::jsonb
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_features) = 'array' THEN p_features ELSE '[]'::jsonb END) f
    WHERE f ->> 'name' = 'cloud-workspaces'
    LIMIT 1
  ), false);
$$;

-- Everyone with an enabled role in a cloud-workspaces class who has no finished account on this
-- instance and no claim younger than the stale window.
CREATE OR REPLACE FUNCTION public.forgejo_accounts_needed(
  p_instance_url text,
  p_stale_minutes integer,
  p_limit integer
) RETURNS TABLE (user_id uuid, email text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.user_id, u.email, u.name
  FROM public.users u
  WHERE EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.classes c ON c.id = ur.class_id
      WHERE ur.user_id = u.user_id
        AND NOT ur.disabled
        AND public.cloud_workspaces_enabled(c.features)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.git_accounts ga
      WHERE ga.user_id = u.user_id
        AND ga.provider = 'forgejo'
        AND ga.instance_url = p_instance_url
        AND (ga.remote_user_id IS NOT NULL OR ga.claimed_at > now() - make_interval(mins => p_stale_minutes))
    )
  ORDER BY u.user_id
  LIMIT p_limit;
$$;

-- True when the caller now owns creating this user's account: there was no row, or only a claim
-- older than the stale window.
CREATE OR REPLACE FUNCTION public.claim_git_account(
  p_user_id uuid,
  p_instance_url text,
  p_stale_minutes integer
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH claimed AS (
    INSERT INTO public.git_accounts AS ga (user_id, provider, instance_url)
    VALUES (p_user_id, 'forgejo', p_instance_url)
    ON CONFLICT (user_id, provider, instance_url) DO UPDATE SET claimed_at = now()
      WHERE ga.remote_user_id IS NULL AND ga.claimed_at <= now() - make_interval(mins => p_stale_minutes)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

REVOKE ALL ON FUNCTION public.cloud_workspaces_enabled(jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.forgejo_accounts_needed(text, integer, integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_git_account(uuid, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forgejo_accounts_needed(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_git_account(uuid, text, integer) TO service_role;
