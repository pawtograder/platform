-- One conditional transaction for the "this revision is live" transition.
--
-- assignment-create-solution-repo has to move four things together: autograder.config,
-- autograder.latest_autograder_sha, assignments.autograder_points, and an autograder_commits row.
-- They span two tables, so PostgREST cannot condition them as a unit, and successive review rounds
-- kept finding new orderings in which a concurrent push webhook and a slow provisioning request
-- interleave badly — a compare-and-set that guards only the SHA still lets config and points be
-- overwritten first, leaving the webhook's newer SHA paired with the older request's metadata.
--
-- The fix is a primitive rather than another guard. Everything happens in one function invocation,
-- which is one transaction, gated on the caller's expectation of the CURRENT sha. Either the whole
-- transition applies or none of it does, and a caller that lost the race is told so and leaves the
-- winner's values completely alone.
--
-- `IS NOT DISTINCT FROM` rather than `=`, so a NULL expectation (nothing recorded yet) is a first
-- class case rather than a comparison that is never true.
CREATE OR REPLACE FUNCTION public.record_autograder_head_metadata(
    p_assignment_id bigint,
    p_expected_sha text,
    p_new_sha text,
    p_config jsonb,
    -- numeric, not integer. `points` in pawtograder.yml is typed as a plain number and the
    -- validator accepts fractions, so calculateTotalAutograderPoints can legitimately return 1.5.
    -- Declared as integer, PostgREST could not resolve the call at all ("function ... (numeric)
    -- does not exist") — and this path treats that as fatal before publishing grader_repo, so a
    -- perfectly good solution repository would stay permanently unattached until somebody changed
    -- the scoring. The pre-existing push-webhook path writes the same value straight into
    -- assignments.autograder_points, which is bigint, so the fraction is rounded on assignment;
    -- numeric here reproduces that behaviour exactly rather than inventing a second one.
    p_points numeric,
    p_message text,
    p_author text,
    p_ref text,
    p_expected_grader_repo text DEFAULT NULL,
    p_expected_has_autograder boolean DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_class_id bigint;
    v_has_autograder boolean;
BEGIN
    -- Service role only: this is called by an edge function during repo provisioning, never by a
    -- user session, and it writes grading-relevant totals.
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Access denied: service role required';
    END IF;

    -- p_points is derived from the caller's snapshot of has_autograder: a disabled assignment gets
    -- 0, because copying the solution template's graded points into autograder_points would have
    -- the rubric editor treat them as an automated allocation and subtract them from hand grading.
    -- The flag is toggleable while the caller's GitHub calls run, so the snapshot can be wrong by
    -- the time the points land — committing zero points for an assignment that was just enabled, or
    -- template points for one that was just disabled, and neither the SHA nor the pointer predicate
    -- below notices. Nothing recomputes it either, until the next push to the solution repository.
    --
    -- Checked FIRST and under FOR UPDATE, for the reason publish_grader_repo takes the same lock: a
    -- toggle committing between an unlocked read and the write would be invisible at READ
    -- COMMITTED. Declining is the coherent answer rather than recomputing here — the caller's whole
    -- snapshot is stale, it does not publish the pointer when this returns false, and the retry runs
    -- against the flag as it now stands. NULL means "do not care", for callers that write no points.
    IF p_expected_has_autograder IS NOT NULL THEN
        SELECT a.has_autograder INTO v_has_autograder
          FROM public.assignments a
         WHERE a.id = p_assignment_id
           FOR UPDATE;
        IF v_has_autograder IS DISTINCT FROM p_expected_has_autograder THEN
            RETURN false;
        END IF;
    END IF;

    -- `grader_repo` is part of the condition, not just the SHA. The autograder settings page
    -- writes a custom repository's parsed config BEFORE it writes the pointer, so a provisioning
    -- request that checked only the SHA could overwrite that config with the conventionally derived
    -- repository's metadata. Including the pointer means a request whose expectation is already
    -- stale declines instead.
    --
    -- Compared with IS NOT DISTINCT FROM in every case, including NULL. An earlier revision read a
    -- NULL expectation as "do not care", which disabled the check on the ONLY path that normally
    -- reaches it: provisioning observes grader_repo as NULL, or clears a stale one to NULL, so NULL
    -- is what it passes. An instructor saving a custom repository during the GitHub work — config
    -- first, pointer second — could then have that config, SHA and points overwritten here, and the
    -- publish CAS afterwards would correctly refuse the derived pointer, leaving their pointer
    -- attached to this repository's metadata. "Expect no pointer" is a real expectation and is now
    -- treated as one. There is no "do not care" caller; the one call site always has a definite
    -- expectation.
    UPDATE public.autograder
       SET config = p_config,
           latest_autograder_sha = p_new_sha
     WHERE id = p_assignment_id
       AND latest_autograder_sha IS NOT DISTINCT FROM p_expected_sha
       AND grader_repo IS NOT DISTINCT FROM p_expected_grader_repo
    RETURNING class_id INTO v_class_id;

    IF NOT FOUND THEN
        -- Somebody else moved it. Report rather than raise: losing this race is an expected outcome
        -- with a correct resolution (leave the winner alone), not an error.
        RETURN false;
    END IF;

    UPDATE public.assignments
       SET autograder_points = p_points
     WHERE id = p_assignment_id;

    IF v_class_id IS NOT NULL THEN
        INSERT INTO public.autograder_commits (autograder_id, message, sha, author, class_id, ref)
        VALUES (p_assignment_id, p_message, p_new_sha, p_author, v_class_id, p_ref)
        ON CONFLICT (autograder_id, sha) DO UPDATE
            SET message = EXCLUDED.message,
                author = EXCLUDED.author,
                ref = EXCLUDED.ref;
    END IF;

    RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_autograder_head_metadata(bigint, text, text, jsonb, numeric, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_autograder_head_metadata(bigint, text, text, jsonb, numeric, text, text, text, text, boolean) TO service_role;

----------------------------------------------------------------------------------------
-- publish_grader_repo: attach the solution pointer, or refuse
----------------------------------------------------------------------------------------

-- assignment-create-solution-repo has to check two things that live on different tables before it
-- attaches grader_repo: that nobody else changed the pointer while it worked (autograder), and that
-- the assignment still uses a repo-backed mode (assignments). A read followed by an update leaves a
-- gap in which an instructor can opt the assignment out of repositories entirely — and because that
-- edit clears grader_repo to NULL, the update's own `grader_repo IS NULL` condition then SUCCEEDS,
-- attaching a repository to an assignment that just declined one. Nothing cleans that up: the
-- solution endpoint rejects the new mode and the reconciler excludes no-repo modes.
--
-- The handout endpoint does not need this — its pointer and repo_mode are both on `assignments`, so
-- one predicate covers it. This exists because the solution pointer is not.
CREATE OR REPLACE FUNCTION public.publish_grader_repo(
    p_assignment_id bigint,
    p_expected_grader_repo text,
    p_new_grader_repo text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_mode public.assignment_repo_mode;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Access denied: service role required';
    END IF;

    IF p_new_grader_repo IS NULL OR trim(p_new_grader_repo) = '' THEN
        RAISE EXCEPTION 'A grader repository is required';
    END IF;

    -- FOR UPDATE, not a bare read. Putting both checks in one transaction is not by itself enough
    -- at READ COMMITTED: an opt-out committing between this SELECT and the UPDATE below would still
    -- be invisible to this snapshot, which is the whole failure being fixed. Locking the assignment
    -- row serializes the two. Whichever transaction takes the lock first wins outright — if the
    -- instructor's edit does, this re-reads the committed mode and declines; if this does, the edit
    -- waits and its own clearing of grader_repo lands afterwards, which is the outcome they asked
    -- for. The lock is held for one UPDATE on a single row.
    SELECT a.repo_mode INTO v_mode FROM public.assignments a WHERE a.id = p_assignment_id FOR UPDATE;
    IF v_mode IS NULL OR v_mode IN ('none', 'no_submission') THEN
        RETURN false;
    END IF;

    UPDATE public.autograder
       SET grader_repo = p_new_grader_repo
     WHERE id = p_assignment_id
       AND grader_repo IS NOT DISTINCT FROM p_expected_grader_repo;

    RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.publish_grader_repo(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_grader_repo(bigint, text, text) TO service_role;

----------------------------------------------------------------------------------------
-- inherit_handout_from_source: copy a fork source's handout onto the forking assignment, or refuse
----------------------------------------------------------------------------------------

-- `fork_from_prior_assignment` does not create a handout; assignment-create-handout-repo copies the
-- SOURCE assignment's template_repo and latest_template_sha onto the forking one. That write has to
-- agree with two rows at once — the target still being configured the way this request resolved it,
-- and the source still holding the values this request read — and they cannot be conditioned
-- together over PostgREST.
--
-- The target half was already a compare-and-set. The source half was not: the source is read near
-- the top of the request, and an instructor repointing THAT assignment's handout in the meantime
-- left this copying a repository the source no longer uses, hashing its workflow, and letting the
-- caller publish a solution pointer over the result — which takes the assignment out of every
-- repair scan, so nothing revisits it.
--
-- Declining rather than copying the source's CURRENT values, which would be the tempting fix: the
-- caller resolved its whole plan from the snapshot, including the repository it hashes the workflow
-- from immediately afterwards. Writing values the caller did not plan around would just move the
-- inconsistency. Returning false leaves the assignment untouched and repairable, and the retry
-- reads the source as it now stands.
-- Prerequisite: the BEFORE UPDATE trigger on `assignments` mirrors template_repo changes into
-- autograder_regression_test using UNQUALIFIED table names and carries no search_path of its own,
-- so it resolves against whatever the calling function set. Every function in this migration uses
-- `SET search_path = ''` (the project convention, and what protects a SECURITY DEFINER body from
-- schema shadowing), which made the trigger fail with `relation "autograder_regression_test" does
-- not exist` the moment one of them changed template_repo.
--
-- Fixed on the trigger rather than by relaxing the callers' search_path, because the trap belongs to
-- the trigger: ANY function with a restricted search_path that touches assignments.template_repo
-- hits it, and there is no reason for each of them to widen its own path to compensate. ALTER
-- FUNCTION rather than CREATE OR REPLACE — the body is untouched, only its name resolution is
-- pinned, and `pg_temp` goes last so a temporary table cannot shadow a real one. This matches the
-- sibling trigger assignments_check_source_assignment, which already carries exactly this setting.
ALTER FUNCTION public.assignment_before_update() SET search_path = public, pg_temp;

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

    RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.inherit_handout_from_source(bigint, bigint, text, text, public.assignment_repo_mode, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inherit_handout_from_source(bigint, bigint, text, text, public.assignment_repo_mode, boolean, text, text) TO service_role;
