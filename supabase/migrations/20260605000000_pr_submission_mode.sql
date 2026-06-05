-- ============================================================================
-- PR submission mode + submission-mode axis (Phase 1: schema foundation)
-- ============================================================================
-- Introduces an explicit submission-mode axis (`push` vs `pr`) orthogonal to
-- the existing assignment_repo_mode, plus the upstream-repo / PR-identification
-- configuration needed for "open a PR against a class repo" assignments.
--
-- This migration is additive and changes NO behavior on its own: every new
-- assignment column defaults to today's behavior (submission_mode = 'push').
-- Webhook handling, ingestion, and UI surfaces land in later phases.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Step 1: Enums for the new axes
-- ----------------------------------------------------------------------------

-- How a submission is produced for an assignment.
--   push - a push to the student repo (today's default; may or may not autograde)
--   pr   - a pull request against an upstream/class repo is the submission
CREATE TYPE submission_mode AS ENUM ('push', 'pr');

-- For submission_mode = 'pr', how we decide which PR is "the" submission PR.
--   base_branch       - any PR whose base is the configured upstream base branch,
--                       confirmed once when more than one candidate exists
--   branch_convention - the head branch name matches a configured pattern
--   manual            - a human links the PR explicitly
CREATE TYPE pr_identification_mode AS ENUM ('base_branch', 'branch_convention', 'manual');

-- ----------------------------------------------------------------------------
-- Step 2: Assignment configuration columns
-- ----------------------------------------------------------------------------

ALTER TABLE public.assignments
  ADD COLUMN submission_mode public.submission_mode NOT NULL DEFAULT 'push',
  -- Upstream/class repo that PRs target, as "owner/name". MAY live in a
  -- different GitHub org than the class org; the ptg GitHub App must be
  -- installed there (checked at config time in a later phase).
  ADD COLUMN upstream_repo text,
  ADD COLUMN upstream_base_branch text NOT NULL DEFAULT 'main',
  ADD COLUMN pr_identification public.pr_identification_mode NOT NULL DEFAULT 'base_branch',
  -- Only consulted when pr_identification = 'branch_convention'.
  ADD COLUMN pr_branch_convention text,
  -- When true, having a (confirmed) open PR is itself a graded condition.
  ADD COLUMN require_pr_open boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.assignments.submission_mode IS
  'How submissions are produced: push (push to student repo) or pr (PR against upstream_repo).';
COMMENT ON COLUMN public.assignments.upstream_repo IS
  'For submission_mode=pr: the owner/name of the repo PRs target. May be out-of-org; ptg GitHub App must be installed there.';
COMMENT ON COLUMN public.assignments.upstream_base_branch IS
  'For submission_mode=pr: the base branch PRs must target to count as a submission.';
COMMENT ON COLUMN public.assignments.pr_identification IS
  'For submission_mode=pr: how the submission PR is identified (base_branch | branch_convention | manual).';
COMMENT ON COLUMN public.assignments.pr_branch_convention IS
  'For pr_identification=branch_convention: regex/glob the head branch name must match.';
COMMENT ON COLUMN public.assignments.require_pr_open IS
  'For submission_mode=pr: when true, an open confirmed PR is a graded condition.';

-- ----------------------------------------------------------------------------
-- Step 3: Submission columns for PR versions
-- ----------------------------------------------------------------------------
-- Each push to a PR head is a new submission row (version). base_sha/head_sha
-- are snapshotted at ingestion so the graded diff is stable even after the
-- upstream base or the PR moves. `sha` continues to hold the head sha for
-- back-compat with every existing query/view that reads submissions.sha.

ALTER TABLE public.submissions
  ADD COLUMN pr_number integer,
  ADD COLUMN base_sha text,
  ADD COLUMN head_sha text,
  -- open | closed | merged | reopened (free text mirrors the GitHub PR state;
  -- not an enum because GitHub may add states and we only read it).
  ADD COLUMN pr_state text;

COMMENT ON COLUMN public.submissions.pr_number IS
  'For pr-mode submissions: the upstream PR number this version belongs to.';
COMMENT ON COLUMN public.submissions.base_sha IS
  'For pr-mode submissions: upstream base branch sha snapshotted at ingestion (diff base).';
COMMENT ON COLUMN public.submissions.head_sha IS
  'For pr-mode submissions: PR head sha for this version (mirrors submissions.sha).';
COMMENT ON COLUMN public.submissions.pr_state IS
  'For pr-mode submissions: latest known GitHub PR state (open/closed/merged/reopened).';

CREATE INDEX idx_submissions_pr ON public.submissions (assignment_id, pr_number)
  WHERE pr_number IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Step 4: submission_pr_links — resolves the "which PR" confirm step
-- ----------------------------------------------------------------------------
-- One row per (student-or-group, candidate PR) for a pr-mode assignment.
-- Auto-confirmed when it is the only candidate; left unconfirmed when there
-- are several, at which point the student confirms exactly one in the UI.
-- Only confirmed links produce submissions.

CREATE TABLE public.submission_pr_links (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    class_id bigint NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    assignment_id bigint NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
    -- Exactly one of profile_id / assignment_group_id identifies the submitter.
    profile_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    assignment_group_id bigint REFERENCES public.assignment_groups(id) ON DELETE CASCADE,
    pr_repo text NOT NULL,
    pr_number integer NOT NULL,
    confirmed boolean NOT NULL DEFAULT false,
    CONSTRAINT submission_pr_links_owner_chk
      CHECK (num_nonnulls(profile_id, assignment_group_id) = 1)
);

-- A given PR maps to at most one link per assignment. NULLS NOT DISTINCT so the
-- unique constraint treats the absent owner column as equal (Postgres 15+).
CREATE UNIQUE INDEX submission_pr_links_unique
  ON public.submission_pr_links (assignment_id, profile_id, assignment_group_id, pr_repo, pr_number)
  NULLS NOT DISTINCT;

CREATE INDEX idx_submission_pr_links_assignment
  ON public.submission_pr_links (assignment_id);

ALTER TABLE public.submission_pr_links ENABLE ROW LEVEL SECURITY;

-- Staff (instructors + graders) can do anything with links in their class.
CREATE POLICY "Staff CRUD pr links in class"
ON public.submission_pr_links
FOR ALL
USING (public.authorizeforclassgrader(class_id))
WITH CHECK (public.authorizeforclassgrader(class_id));

-- Students can read their own links (direct or via group membership).
CREATE POLICY "Students read own pr links"
ON public.submission_pr_links
FOR SELECT
USING (
  public.authorizeforprofile(profile_id)
  OR (
    assignment_group_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.assignment_groups_members mem
      JOIN public.user_roles r ON r.private_profile_id = mem.profile_id
      WHERE mem.assignment_group_id = submission_pr_links.assignment_group_id
        AND r.user_id = auth.uid()
    )
  )
);

-- Students can confirm (only) their own link. The webhook (service role)
-- creates rows; students flip `confirmed`.
CREATE POLICY "Students confirm own pr links"
ON public.submission_pr_links
FOR UPDATE
USING (
  public.authorizeforprofile(profile_id)
  OR (
    assignment_group_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.assignment_groups_members mem
      JOIN public.user_roles r ON r.private_profile_id = mem.profile_id
      WHERE mem.assignment_group_id = submission_pr_links.assignment_group_id
        AND r.user_id = auth.uid()
    )
  )
);

GRANT ALL ON TABLE public.submission_pr_links TO authenticated;
GRANT ALL ON TABLE public.submission_pr_links TO service_role;
