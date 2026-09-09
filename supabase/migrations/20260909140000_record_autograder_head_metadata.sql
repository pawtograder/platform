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
    p_expected_grader_repo text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_class_id bigint;
BEGIN
    -- Service role only: this is called by an edge function during repo provisioning, never by a
    -- user session, and it writes grading-relevant totals.
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Access denied: service role required';
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

REVOKE EXECUTE ON FUNCTION public.record_autograder_head_metadata(bigint, text, text, jsonb, integer, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_autograder_head_metadata(bigint, text, text, jsonb, integer, text, text, text, text) TO service_role;
