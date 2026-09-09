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
    p_points integer,
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
    -- stale declines instead. NULL means "do not care", which is what the pre-pointer paths pass.
    UPDATE public.autograder
       SET config = p_config,
           latest_autograder_sha = p_new_sha
     WHERE id = p_assignment_id
       AND latest_autograder_sha IS NOT DISTINCT FROM p_expected_sha
       AND (p_expected_grader_repo IS NULL OR grader_repo IS NOT DISTINCT FROM p_expected_grader_repo)
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

REVOKE EXECUTE ON FUNCTION public.record_autograder_head_metadata(bigint, text, text, jsonb, integer, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_autograder_head_metadata(bigint, text, text, jsonb, integer, text, text, text, text, boolean) TO service_role;

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
