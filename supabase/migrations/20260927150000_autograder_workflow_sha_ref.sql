-- Record which commit autograder.workflow_sha was computed at, and use it to stop a pinned hash
-- write from replacing a newer one.
--
-- workflow_sha is compared against the hash of grade.yml in every Actions submission, so it has to
-- describe the same revision assignments.latest_template_sha hands to students. The handout push
-- webhook keeps the two together by writing the new revision's hash FIRST and advancing
-- latest_template_sha afterwards. The inherit path in assignment-create-handout-repo writes the
-- other way round: inherit_handout_from_source pins the target to the source's recorded revision
-- S1, and only then is grade.yml hashed at S1 and written to every assignment sharing the
-- repository. When a push to S2 is being processed at that moment, the webhook has already
-- written S2's hash while the rows still read latest_template_sha = S1, so the S1 write replaced
-- it, and the webhook then advanced the pointer to S2 over a hash describing S1. Students were
-- sent S2 and every Actions submission failed the hash check until another push.
--
-- Filtering the write on latest_template_sha cannot tell those rows apart: they genuinely are on
-- S1. What differs is the hash, and nothing recorded which revision a hash describes. Now
-- workflow_sha_ref does, and the pinned write refuses a row whose hash is for a different revision.
-- NULL means "unknown": every row written before this migration, and a fresh autograder row.

ALTER TABLE public.autograder ADD COLUMN IF NOT EXISTS workflow_sha_ref text;

COMMENT ON COLUMN public.autograder.workflow_sha_ref IS
    'Commit of the handout repository that workflow_sha was computed at. NULL when unknown.';

----------------------------------------------------------------------------------------
-- set_workflow_sha_at_pinned_revision: the pinned hash write, as one conditional statement
----------------------------------------------------------------------------------------

-- A single UPDATE, with the revision check on the row being written. That placement is what makes
-- it safe against a concurrent webhook write: if the webhook updates the same autograder row
-- first, this statement waits for it and re-evaluates its WHERE against the committed version,
-- which then carries workflow_sha_ref = S2 and no longer matches. (The latest_template_sha test is
-- on the joined `assignments` row, which READ COMMITTED does not re-read that way; it only narrows
-- the candidates, and the ref test is what protects the hash.)
--
-- A row whose ref is NULL is written, which is the previous behaviour for every row that predates
-- this column. A row whose ref differs from p_ref is left alone even when that ref is OLDER: from
-- the database alone an older and a newer revision look the same, and overwriting a newer hash
-- blocks submissions, while keeping an older one only matters if grade.yml changed between them.
-- inherit_handout_from_source clears the ref when it switches repositories, which is the case
-- where a stale hash is certain.
CREATE OR REPLACE FUNCTION public.set_workflow_sha_at_pinned_revision(
    p_template_repo text,
    p_ref text,
    p_workflow_sha text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_count integer;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Access denied: service role required';
    END IF;
    IF p_template_repo IS NULL OR p_ref IS NULL OR p_workflow_sha IS NULL THEN
        RAISE EXCEPTION 'set_workflow_sha_at_pinned_revision: template repo, ref and hash are required';
    END IF;

    UPDATE public.autograder g
       SET workflow_sha = p_workflow_sha,
           workflow_sha_ref = p_ref
      FROM public.assignments a
     WHERE a.id = g.id
       AND a.template_repo = p_template_repo
       AND a.latest_template_sha = p_ref
       AND (g.workflow_sha_ref IS NULL OR g.workflow_sha_ref = p_ref);

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_workflow_sha_at_pinned_revision(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_workflow_sha_at_pinned_revision(text, text, text) TO service_role;

----------------------------------------------------------------------------------------
-- inherit_handout_from_source: unchanged from 20260927140000 except where marked
----------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.inherit_handout_from_source(
    p_assignment_id bigint,
    p_source_assignment_id bigint,
    p_source_template_repo text,
    p_source_latest_template_sha text,
    p_expected_repo_mode public.assignment_repo_mode,
    p_expected_has_autograder boolean,
    p_expected_submission_mode text,
    p_expected_template_repo text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_repo text;
    v_sha text;
    v_source_has_autograder boolean;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Access denied: service role required';
    END IF;

    -- FOR SHARE, not a bare read: this only needs the source to hold still, not to change it, and
    -- an unlocked read would leave the same gap at READ COMMITTED that the whole function exists to
    -- close. A concurrent edit of the source waits for this one UPDATE.
    SELECT a.template_repo, a.latest_template_sha, a.has_autograder
      INTO v_repo, v_sha, v_source_has_autograder
      FROM public.assignments a
     WHERE a.id = p_source_assignment_id
       FOR SHARE;

    -- has_autograder is compared under the same lock as the pointer, not just validated in the
    -- caller. The two assignments SHARE one handout repository, so the flag is a property of that
    -- repository and the caller refuses the inheritance outright when they disagree. Checking it
    -- only in the caller left the window this function exists to close: the source being disabled
    -- after that check still let the handout be copied onto an enabled target, and the source's own
    -- workflow synchronization may already have snapshotted who shares that repository while the
    -- target had no pointer — so nothing would realign the target, and solution creation would go
    -- on to publish a grader pointer for an assignment whose inherited handout has had grade.yml
    -- removed. Compared against the TARGET's expected flag, which the caller has already checked
    -- equals the source's.
    IF NOT FOUND
       OR v_repo IS DISTINCT FROM p_source_template_repo
       OR v_sha IS DISTINCT FROM p_source_latest_template_sha
       OR (v_source_has_autograder IS FALSE) IS DISTINCT FROM (p_expected_has_autograder IS FALSE) THEN
        RETURN false;
    END IF;

    -- upstream_repo moves with the pointer for a PR-mode assignment, exactly as the create branch
    -- does it. Without this an inherited handout left it NULL, and github-repo-webhook resolves an
    -- incoming pull request by matching upstream_repo — so every student PR on such an assignment
    -- went unrecognized, while solution creation published grader_repo and took the row out of
    -- every repair scan. The value is the same one the edit page writes for PR mode: this
    -- assignment's own template_repo, which for a fork is the inherited one. (That is a different
    -- thing from the per-student fork parent used by repo syncing, which resolves to each student's
    -- prior-assignment repository and is not stored here.)
    --
    -- submission_mode joins the predicate for the same reason it is in the create branch's: this
    -- write's behaviour depends on it, so it has to still hold.
    UPDATE public.assignments
       SET template_repo = p_source_template_repo,
           latest_template_sha = p_source_latest_template_sha,
           upstream_repo = CASE WHEN p_expected_submission_mode = 'pr' THEN p_source_template_repo ELSE upstream_repo END
     WHERE id = p_assignment_id
       AND repo_mode = p_expected_repo_mode
       AND source_assignment_id IS NOT DISTINCT FROM p_source_assignment_id
       AND has_autograder IS NOT DISTINCT FROM p_expected_has_autograder
       AND submission_mode::text IS NOT DISTINCT FROM p_expected_submission_mode
       AND template_repo IS NOT DISTINCT FROM p_expected_template_repo;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- New in this migration. Switching the target to a DIFFERENT repository makes its stored hash
    -- one of another repository's revisions, which can never be a newer revision of this one — so
    -- its workflow_sha_ref is cleared to "unknown", letting set_workflow_sha_at_pinned_revision
    -- replace it. Left alone when the repository is unchanged: then a ref that differs from the
    -- new pointer may be a push webhook for this repository that has already written its newer
    -- hash, which is exactly what that function must not overwrite. The UPDATE above required
    -- template_repo to equal p_expected_template_repo, so that is the value being replaced.
    IF p_expected_template_repo IS DISTINCT FROM p_source_template_repo THEN
        UPDATE public.autograder
           SET workflow_sha_ref = NULL
         WHERE id = p_assignment_id;
    END IF;

    RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.inherit_handout_from_source(bigint, bigint, text, text, public.assignment_repo_mode, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inherit_handout_from_source(bigint, bigint, text, text, public.assignment_repo_mode, boolean, text, text) TO service_role;

----------------------------------------------------------------------------------------
-- Service-role-only RPCs: revoke the default grants as well as PUBLIC
----------------------------------------------------------------------------------------

-- Supabase's default privileges grant EXECUTE on every new function in `public` to anon and
-- authenticated directly, so the `REVOKE ... FROM PUBLIC` above and in 20260927140000 left both
-- roles able to call these. Each body refuses anything but service_role, which holds through
-- PostgREST because it always sets the JWT claims; revoking the grants means a missing or bypassed
-- check no longer leaves them callable.
REVOKE EXECUTE ON FUNCTION public.set_workflow_sha_at_pinned_revision(text, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inherit_handout_from_source(bigint, bigint, text, text, public.assignment_repo_mode, boolean, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_autograder_head_metadata(bigint, text, text, jsonb, numeric, text, text, text, text, boolean, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.publish_grader_repo(bigint, text, text, boolean) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_autograder_points_for_repo(bigint, text, numeric) FROM anon, authenticated;
