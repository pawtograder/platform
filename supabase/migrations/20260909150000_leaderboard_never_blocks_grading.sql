-- The leaderboard must never be able to fail a grading run.
--
-- What broke. `assignment_leaderboard` is maintained by AFTER-row triggers on `grader_results` and
-- `submissions` (20251221230000_assignment_leaderboard.sql, last rewritten by
-- 20260120140000_fix_leaderboard_max_score_zero.sql), so its CHECK constraints are evaluated inside
-- the same transaction as the autograder's feedback insert. On a real submission
-- `check_score_bounds` (autograder_score <= max_score) fired and came back out of
-- autograder-submit-feedback as
--
--     HTTP 500 ... new row for relation "assignment_leaderboard" violates check constraint
--     "check_score_bounds"
--
-- The assignment-action classifies that as recoverable and retried four times; the violation is
-- deterministic, so every attempt hit the same constraint and the run ended with the student's
-- grade discarded. A leaderboard is a display surface. It has no business rejecting a grade.
--
-- Why the constraint itself was wrong. `score > max_score` is a shape the grading path legitimately
-- produces, in at least two ways:
--
--   * OverlayGrader's linear mutation scoring awards
--     (mutantsDetected / linearScoring.total_faults) * points. `total_faults` is a number the
--     grader config declares; `mutantsDetected` is counted from the mutants the tool actually
--     generated for the unit's locations. When a run generates more mutants than the config
--     declares, the unit awards more than its own max_score, and that surplus sums into the total.
--   * autograder-submit-feedback totals `score` over the tests that are not hide_until_released but
--     totals `max_score` over every test, and it honors a grader-supplied `feedback.score` while
--     still computing max_score from the tests. The two totals need not share a source.
--
-- Neither is worth losing a grade over, and "105/100" is honest output for a leaderboard. So the
-- bound comes off, the remaining two constraints are made unreachable by sanitizing in one place
-- instead of four, and the upsert gets an exception handler so that no future leaderboard problem
-- -- a constraint, a bad grant, a broken realtime broadcast -- can take grading down with it.

ALTER TABLE public.assignment_leaderboard DROP CONSTRAINT IF EXISTS check_score_bounds;

COMMENT ON CONSTRAINT check_score_non_negative ON public.assignment_leaderboard IS
  'Sanity bound only. public.upsert_assignment_leaderboard_entry() clamps before writing, and swallows a violation if one somehow reaches the table -- nothing here may abort the grading transaction that fired the trigger.';


-- ---------------------------------------------------------------------------
-- One writer for the table.
-- ---------------------------------------------------------------------------
-- Both trigger functions had two copies each of the same upsert -- four in total -- which is how
-- the max_score = 0 fix in 20260120140000 had to be applied four times. They now share this one,
-- which owns the clamping and the exception handling.
--
-- The score parameters are NUMERIC because that is what `grader_results.score` and
-- `grader_results.max_score` are: 20250505234500_remote_schema.sql widened them from smallint, so
-- graders can report fractional scores. Declaring these INTEGER makes the PERFORM fail function
-- resolution before it ever enters the exception handler below -- the one error shape this
-- migration must not introduce. Rounding into the table's INTEGER columns is not new; the previous
-- inline INSERTs got the same rounding for free from the assignment cast.
--
-- p_max_score arrives already resolved by the caller (grader max_score, else the assignment's
-- autograder_points, else 100); the GREATEST here only catches a resolved value that is still not
-- positive, e.g. a negative autograder_points.
CREATE OR REPLACE FUNCTION public.upsert_assignment_leaderboard_entry(
    p_assignment_id BIGINT,
    p_class_id BIGINT,
    p_public_profile_id UUID,
    p_score NUMERIC,
    p_max_score NUMERIC,
    p_submission_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    INSERT INTO public.assignment_leaderboard (
        assignment_id,
        class_id,
        public_profile_id,
        autograder_score,
        max_score,
        submission_id,
        updated_at
    ) VALUES (
        p_assignment_id,
        p_class_id,
        p_public_profile_id,
        GREATEST(ROUND(COALESCE(p_score, 0)), 0)::INTEGER,
        GREATEST(ROUND(COALESCE(p_max_score, 100)), 1)::INTEGER,
        p_submission_id,
        NOW()
    )
    ON CONFLICT (assignment_id, public_profile_id)
    DO UPDATE SET
        autograder_score = EXCLUDED.autograder_score,
        max_score = EXCLUDED.max_score,
        submission_id = EXCLUDED.submission_id,
        updated_at = NOW();
EXCEPTION
    -- The whole point of this migration. The caller is an AFTER-row trigger on grader_results or
    -- submissions, so an uncaught error here rolls back the grade that fired it. Losing a
    -- leaderboard row is the acceptable outcome; losing the grade is not. The WARNING lands in the
    -- Postgres log with the identifiers needed to chase it.
    WHEN OTHERS THEN
        RAISE WARNING 'assignment_leaderboard upsert skipped for assignment % profile % submission %: % (SQLSTATE %)',
            p_assignment_id, p_public_profile_id, p_submission_id, SQLERRM, SQLSTATE;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_assignment_leaderboard_entry(BIGINT, BIGINT, UUID, NUMERIC, NUMERIC, BIGINT)
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.upsert_assignment_leaderboard_entry(BIGINT, BIGINT, UUID, NUMERIC, NUMERIC, BIGINT) IS
  'Sole writer for public.assignment_leaderboard. Clamps the score and max_score into range and never raises, so a leaderboard failure cannot abort the grading transaction that triggered it.';


-- ---------------------------------------------------------------------------
-- grader_results INSERT/UPDATE -> leaderboard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_assignment_leaderboard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_submission RECORD;
    v_user_role RECORD;
    v_max_score NUMERIC;
BEGIN
    -- Get submission details
    SELECT s.*, a.autograder_points
    INTO v_submission
    FROM public.submissions s
    INNER JOIN public.assignments a ON a.id = s.assignment_id
    WHERE s.id = NEW.submission_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Only update leaderboard for active submissions
    IF v_submission.is_active IS NOT TRUE THEN
        RETURN NEW;
    END IF;

    -- NULLIF because COALESCE does not treat 0 as absent, and a grader that declares no per-test
    -- max_score reports a total of 0 rather than NULL.
    v_max_score := COALESCE(NULLIF(NEW.max_score, 0), NULLIF(v_submission.autograder_points, 0), 100);

    -- Handle both individual and group submissions
    IF v_submission.profile_id IS NOT NULL THEN
        -- Individual submission
        SELECT ur.public_profile_id
        INTO v_user_role
        FROM public.user_roles ur
        WHERE ur.private_profile_id = v_submission.profile_id
        AND ur.class_id = v_submission.class_id
        LIMIT 1;

        IF FOUND THEN
            PERFORM public.upsert_assignment_leaderboard_entry(
                v_submission.assignment_id,
                v_submission.class_id,
                v_user_role.public_profile_id,
                NEW.score,
                v_max_score,
                NEW.submission_id
            );
        END IF;
    ELSIF v_submission.assignment_group_id IS NOT NULL THEN
        -- Group submission - update leaderboard for all group members
        FOR v_user_role IN
            SELECT ur.public_profile_id
            FROM public.assignment_groups_members agm
            INNER JOIN public.user_roles ur ON ur.private_profile_id = agm.profile_id
            WHERE agm.assignment_group_id = v_submission.assignment_group_id
            AND ur.class_id = v_submission.class_id
        LOOP
            PERFORM public.upsert_assignment_leaderboard_entry(
                v_submission.assignment_id,
                v_submission.class_id,
                v_user_role.public_profile_id,
                NEW.score,
                v_max_score,
                NEW.submission_id
            );
        END LOOP;
    END IF;

    RETURN NEW;
END;
$function$;


-- ---------------------------------------------------------------------------
-- submissions.is_active flip -> leaderboard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_leaderboard_on_submission_active_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_user_role RECORD;
    v_grader_result RECORD;
    v_max_score NUMERIC;
BEGIN
    -- Only react if is_active changed
    IF OLD.is_active IS DISTINCT FROM NEW.is_active THEN
        IF NEW.is_active = TRUE THEN
            -- Submission became active - update leaderboard with its score
            SELECT gr.*, a.autograder_points
            INTO v_grader_result
            FROM public.grader_results gr
            INNER JOIN public.assignments a ON a.id = NEW.assignment_id
            WHERE gr.submission_id = NEW.id
            LIMIT 1;

            IF FOUND THEN
                v_max_score := COALESCE(
                    NULLIF(v_grader_result.max_score, 0),
                    NULLIF(v_grader_result.autograder_points, 0),
                    100
                );

                -- Handle individual submissions
                IF NEW.profile_id IS NOT NULL THEN
                    SELECT ur.public_profile_id
                    INTO v_user_role
                    FROM public.user_roles ur
                    WHERE ur.private_profile_id = NEW.profile_id
                    AND ur.class_id = NEW.class_id
                    LIMIT 1;

                    IF FOUND THEN
                        PERFORM public.upsert_assignment_leaderboard_entry(
                            NEW.assignment_id,
                            NEW.class_id,
                            v_user_role.public_profile_id,
                            v_grader_result.score,
                            v_max_score,
                            NEW.id
                        );
                    END IF;
                ELSIF NEW.assignment_group_id IS NOT NULL THEN
                    -- Group submission
                    FOR v_user_role IN
                        SELECT ur.public_profile_id
                        FROM public.assignment_groups_members agm
                        INNER JOIN public.user_roles ur ON ur.private_profile_id = agm.profile_id
                        WHERE agm.assignment_group_id = NEW.assignment_group_id
                        AND ur.class_id = NEW.class_id
                    LOOP
                        PERFORM public.upsert_assignment_leaderboard_entry(
                            NEW.assignment_id,
                            NEW.class_id,
                            v_user_role.public_profile_id,
                            v_grader_result.score,
                            v_max_score,
                            NEW.id
                        );
                    END LOOP;
                END IF;
            END IF;
        END IF;
        -- Note: When a submission becomes inactive, the old entry remains
        -- The next active submission will update it
    END IF;

    RETURN NEW;
END;
$function$;
