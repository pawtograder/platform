ALTER TABLE public.classes
  ADD COLUMN git_provider text NOT NULL DEFAULT 'github' CHECK (git_provider IN ('github', 'forgejo')),
  ADD COLUMN forgejo_org text;

COMMENT ON COLUMN public.classes.git_provider IS
  'Which git host this class provisions repos on. Independent of whether the class uses workspaces.';
COMMENT ON COLUMN public.classes.forgejo_org IS 'Forgejo organization for a class whose git_provider is forgejo.';

ALTER TABLE public.repositories
  ADD COLUMN git_provider text NOT NULL DEFAULT 'github' CHECK (git_provider IN ('github', 'forgejo'));

CREATE TABLE public.git_accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users (user_id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('forgejo')),
  instance_url text NOT NULL,
  remote_user_id bigint NOT NULL,
  login text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, instance_url),
  UNIQUE (provider, instance_url, remote_user_id)
);

ALTER TABLE public.git_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own git accounts" ON public.git_accounts
  FOR SELECT USING (user_id = auth.uid());

CREATE TABLE public.git_setup_codes (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users (user_id) ON DELETE CASCADE,
  class_id bigint NOT NULL REFERENCES public.classes (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

ALTER TABLE public.git_setup_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.git_setup_codes FROM anon, authenticated;

CREATE INDEX git_setup_codes_user_id_idx ON public.git_setup_codes (user_id);
