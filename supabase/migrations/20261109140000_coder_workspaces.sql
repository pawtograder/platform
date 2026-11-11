-- CW-17c (#1222): Coder accounts and workspaces that workspace-open creates.
--
-- Coder's sign-ups are off (#1165), so workspace-open creates each student's Coder user and records
-- it in coder_accounts. It then creates one workspace per student per repository and records it in
-- coder_workspaces. The row is written before Coder is called and coder_workspace_id is filled in
-- after, so a crash between the two leaves a row the cleanup job (#1223) can match by name.
--
-- Only the service role writes either table. Students read their own rows; instructors and graders
-- read the rows of their classes.

CREATE TABLE public.coder_accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users (user_id) ON DELETE CASCADE,
  -- CODER_URL at creation, so pointing a deployment at a new Coder creates accounts there again.
  instance_url text NOT NULL,
  coder_user_id uuid NOT NULL,
  coder_username text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, instance_url),
  UNIQUE (instance_url, coder_user_id)
);

COMMENT ON TABLE public.coder_accounts IS
  'Coder users Pawtograder created for its users. Written only by workspace-open.';

CREATE TABLE public.coder_workspaces (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- SET NULL, not CASCADE: the cleanup job still needs the row to delete the Coder workspace.
  class_id bigint REFERENCES public.classes (id) ON DELETE SET NULL,
  assignment_id bigint REFERENCES public.assignments (id) ON DELETE SET NULL,
  -- The repository the workspace clones. Not a foreign key: keys into repositories must be NO ACTION
  -- and cleared by every delete path (AGENTS.md), and this row has to outlive the repository until
  -- the cleanup job deletes the workspace.
  repository_id bigint NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users (user_id) ON DELETE CASCADE,
  profile_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  instance_url text NOT NULL,
  coder_user_id uuid NOT NULL,
  coder_workspace_name text NOT NULL,
  -- NULL until Coder answers the create request.
  coder_workspace_id uuid,
  -- The template's repo_url parameter. Coder doesn't let it change after create.
  repo_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- For the cleanup job (#1223). workspace-open only reads them.
  cleanup_status text NOT NULL DEFAULT 'active'
    CHECK (cleanup_status IN ('active', 'deleting', 'deleted', 'parked')),
  cleanup_attempts integer NOT NULL DEFAULT 0,
  cleanup_last_error text,
  -- Set by workspace-open when the student opens a different repository for the same assignment
  -- (they changed groups), cleared if they open this one again. The old workspace may hold unpushed
  -- work, so it gets the same 14 days as the conditions below.
  superseded_at timestamptz,
  -- The restart claim, while a workspace is stopped and started again after a failed startup:
  -- `stopping` from workspace-open's stop, then `starting` from the moment one call wins the right
  -- to post the start (a conditional update on the token) until it has posted it. restart_token
  -- says which call holds it. A claim older than 60 s is abandoned, since every holder answers
  -- within 20 s.
  restart_started_at timestamptz,
  restart_phase text CHECK (restart_phase IN ('stopping', 'starting')),
  restart_token uuid,
  CHECK ((restart_started_at IS NULL) = (restart_phase IS NULL) AND (restart_phase IS NULL) = (restart_token IS NULL)),
  -- When the cleanup job first saw each condition. Cleared when it goes away, so a recurrence
  -- starts a fresh grace period.
  class_archived_seen_at timestamptz,
  assignment_archived_seen_at timestamptz,
  assignment_deleted_seen_at timestamptz,
  student_inactive_seen_at timestamptz,
  -- One workspace per student per repository. A group change gives the student a new repository,
  -- and so a new workspace; the old row is superseded rather than reused.
  UNIQUE (user_id, repository_id, instance_url),
  UNIQUE (instance_url, coder_user_id, coder_workspace_name),
  UNIQUE (instance_url, coder_workspace_id)
);

CREATE INDEX coder_workspaces_class_id_idx ON public.coder_workspaces (class_id);
CREATE INDEX coder_workspaces_assignment_id_idx ON public.coder_workspaces (assignment_id);
CREATE INDEX coder_workspaces_user_assignment_idx ON public.coder_workspaces (user_id, assignment_id);

COMMENT ON TABLE public.coder_workspaces IS
  'Coder workspaces workspace-open created, one per student per repository. Written only by the service role.';

ALTER TABLE public.coder_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coder_workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY coder_accounts_select_own ON public.coder_accounts
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY coder_accounts_select_class_staff ON public.coder_accounts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = coder_accounts.user_id AND public.authorizeforclassgrader(ur.class_id)
    )
  );

CREATE POLICY coder_workspaces_select_own ON public.coder_workspaces
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY coder_workspaces_select_class_staff ON public.coder_workspaces
  FOR SELECT USING (public.authorizeforclassgrader(class_id));

-- When the workspace is due to be deleted (#1223): 14 days after the latest final due date over the
-- owner's current group members, plus the assignment's full late-token allowance. This can be late
-- but never early. Archiving the class or assignment, deleting the assignment, or the student
-- leaving starts its own 14 days once the cleanup job has seen it, and so does a group change that
-- superseded the workspace. The earliest date wins.
CREATE OR REPLACE FUNCTION public.coder_workspace_deletion_date(p_workspace_id bigint)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH w AS (
    SELECT * FROM public.coder_workspaces WHERE id = p_workspace_id
  ),
  grp AS (
    SELECT m.assignment_group_id
    FROM public.assignment_groups_members m, w
    WHERE m.assignment_id = w.assignment_id AND m.profile_id = w.profile_id
    LIMIT 1
  ),
  members AS (
    SELECT m.profile_id, m.assignment_group_id
    FROM public.assignment_groups_members m
    JOIN grp USING (assignment_group_id)
    UNION ALL
    SELECT w.profile_id, NULL::bigint FROM w WHERE NOT EXISTS (SELECT 1 FROM grp)
  ),
  due AS (
    SELECT max(public.calculate_final_due_date(w.assignment_id, members.profile_id, members.assignment_group_id))
             + make_interval(hours => 24 * a.max_late_tokens)
             + interval '14 days' AS at
    FROM w
    JOIN public.assignments a ON a.id = w.assignment_id
    CROSS JOIN members
    WHERE members.profile_id IS NOT NULL
    GROUP BY a.max_late_tokens
  )
  SELECT least(
    (SELECT at FROM due),
    w.class_archived_seen_at + interval '14 days',
    w.assignment_archived_seen_at + interval '14 days',
    w.assignment_deleted_seen_at + interval '14 days',
    w.student_inactive_seen_at + interval '14 days',
    w.superseded_at + interval '14 days'
  )
  FROM w;
$$;

REVOKE ALL ON FUNCTION public.coder_workspace_deletion_date(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coder_workspace_deletion_date(bigint) TO service_role;
