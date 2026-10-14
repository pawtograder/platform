-- The provider is chosen per assignment, so a class can try Forgejo on one assignment and keep
-- GitHub for the rest, or move back, without a class-wide switch.
ALTER TABLE public.assignments
  ADD COLUMN git_provider text NOT NULL DEFAULT 'github' CHECK (git_provider IN ('github', 'forgejo'));

COMMENT ON COLUMN public.assignments.git_provider IS
  'Which git host this assignment provisions repos on. Fixed once any repo exists for the assignment.';

ALTER TABLE public.classes ADD COLUMN forgejo_org text;

COMMENT ON COLUMN public.classes.forgejo_org IS
  'Forgejo organization for this class''s Forgejo assignments. Defaults to the class slug when null.';

ALTER TABLE public.repositories
  ADD COLUMN git_provider text NOT NULL DEFAULT 'github' CHECK (git_provider IN ('github', 'forgejo'));

-- Switching after repos exist would strand them on the old host.
CREATE OR REPLACE FUNCTION public.assignments_lock_git_provider() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.git_provider IS DISTINCT FROM OLD.git_provider
     AND EXISTS (SELECT 1 FROM public.repositories r WHERE r.assignment_id = OLD.id) THEN
    RAISE EXCEPTION 'Cannot change git_provider for assignment %: it already has repositories', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assignments_lock_git_provider
  BEFORE UPDATE OF git_provider ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.assignments_lock_git_provider();

-- Every GitHub repo-creation and permission-sync path in SQL funnels through these two enqueue
-- functions. Rename the originals and put a same-named guard in front, so a Forgejo assignment or
-- repo in a mixed class never reaches the GitHub worker, without copying either body.
ALTER FUNCTION public.enqueue_github_create_repo(
  bigint, text, text, text, text, text[], boolean, text, bigint, uuid, bigint, text, text, text, jsonb, text
) RENAME TO enqueue_github_create_repo_unguarded;

CREATE FUNCTION public.enqueue_github_create_repo(
  p_class_id bigint,
  p_org text,
  p_repo_name text,
  p_template_repo text,
  p_course_slug text,
  p_github_usernames text[],
  p_is_template_repo boolean DEFAULT false,
  p_debug_id text DEFAULT NULL,
  p_assignment_id bigint DEFAULT NULL,
  p_profile_id uuid DEFAULT NULL,
  p_assignment_group_id bigint DEFAULT NULL,
  p_latest_template_sha text DEFAULT NULL,
  p_creation_method text DEFAULT 'template',
  p_source_repo text DEFAULT NULL,
  p_branch_protection jsonb DEFAULT NULL,
  p_student_team_permission text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_assignment_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.id = p_assignment_id AND a.git_provider <> 'github') THEN
    RETURN NULL;
  END IF;
  RETURN public.enqueue_github_create_repo_unguarded(
    p_class_id, p_org, p_repo_name, p_template_repo, p_course_slug, p_github_usernames, p_is_template_repo,
    p_debug_id, p_assignment_id, p_profile_id, p_assignment_group_id, p_latest_template_sha, p_creation_method,
    p_source_repo, p_branch_protection, p_student_team_permission
  );
END;
$$;

ALTER FUNCTION public.enqueue_github_sync_repo_permissions(bigint, text, text, text, text[], text)
  RENAME TO enqueue_github_sync_repo_permissions_unguarded;

CREATE FUNCTION public.enqueue_github_sync_repo_permissions(
  p_class_id bigint,
  p_org text,
  p_repo text,
  p_course_slug text,
  p_github_usernames text[],
  p_debug_id text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.repositories r
    WHERE r.repository = p_org || '/' || p_repo AND r.git_provider <> 'github'
  ) THEN
    RETURN NULL;
  END IF;
  RETURN public.enqueue_github_sync_repo_permissions_unguarded(
    p_class_id, p_org, p_repo, p_course_slug, p_github_usernames, p_debug_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_github_create_repo(
  bigint, text, text, text, text, text[], boolean, text, bigint, uuid, bigint, text, text, text, jsonb, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_github_create_repo(
  bigint, text, text, text, text, text[], boolean, text, bigint, uuid, bigint, text, text, text, jsonb, text
) TO service_role;
REVOKE ALL ON FUNCTION public.enqueue_github_sync_repo_permissions(bigint, text, text, text, text[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_github_sync_repo_permissions(bigint, text, text, text, text[], text)
  TO service_role;

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
