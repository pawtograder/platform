-- Fix leaderboard triggers to handle max_score = 0 case
-- The check_max_score_positive constraint requires max_score > 0
-- But COALESCE doesn't treat 0 as falsy, so we need NULLIF to convert 0 to NULL
--
-- Also fix RLS policy to use user_privileges instead of user_roles

-- Fix RLS policy: must use user_privileges not user_roles
DROP POLICY IF EXISTS "Users can view leaderboard in their class" ON public.assignment_leaderboard;

CREATE POLICY "Users can view leaderboard in their class"
ON public.assignment_leaderboard
FOR SELECT
USING (
    -- Allow anonymous users to view all leaderboard entries
    auth.uid() IS NULL
    OR
    -- Authenticated users can only view leaderboard for their classes
    EXISTS (
        SELECT 1 FROM public.user_privileges up
        WHERE up.user_id = auth.uid()
        AND up.class_id = assignment_leaderboard.class_id
    )
);

-- Update the main leaderboard update function
CREATE OR REPLACE FUNCTION public.update_assignment_leaderboard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_submission RECORD;
    v_user_role RECORD;
    v_active_submission RECORD;
    v_max_score INTEGER;
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

    -- Get the user role to find public_profile_id
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
            -- Upsert the leaderboard entry
            -- Use NULLIF to treat 0 as NULL so COALESCE falls through to the default
            INSERT INTO public.assignment_leaderboard (
                assignment_id,
                class_id,
                public_profile_id,
                autograder_score,
                max_score,
                submission_id,
                updated_at
            ) VALUES (
                v_submission.assignment_id,
                v_submission.class_id,
                v_user_role.public_profile_id,
                NEW.score,
                COALESCE(NULLIF(NEW.max_score, 0), NULLIF(v_submission.autograder_points, 0), 100),
                NEW.submission_id,
                NOW()
            )
            ON CONFLICT (assignment_id, public_profile_id)
            DO UPDATE SET
                autograder_score = EXCLUDED.autograder_score,
                max_score = EXCLUDED.max_score,
                submission_id = EXCLUDED.submission_id,
                updated_at = NOW();
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
            INSERT INTO public.assignment_leaderboard (
                assignment_id,
                class_id,
                public_profile_id,
                autograder_score,
                max_score,
                submission_id,
                updated_at
            ) VALUES (
                v_submission.assignment_id,
                v_submission.class_id,
                v_user_role.public_profile_id,
                NEW.score,
                COALESCE(NULLIF(NEW.max_score, 0), NULLIF(v_submission.autograder_points, 0), 100),
                NEW.submission_id,
                NOW()
            )
            ON CONFLICT (assignment_id, public_profile_id)
            DO UPDATE SET
                autograder_score = EXCLUDED.autograder_score,
                max_score = EXCLUDED.max_score,
                submission_id = EXCLUDED.submission_id,
                updated_at = NOW();
        END LOOP;
    END IF;

    RETURN NEW;
END;
$function$;

-- Update the submission active change function
CREATE OR REPLACE FUNCTION public.update_leaderboard_on_submission_active_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_user_role RECORD;
    v_grader_result RECORD;
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
                -- Handle individual submissions
                IF NEW.profile_id IS NOT NULL THEN
                    SELECT ur.public_profile_id
                    INTO v_user_role
                    FROM public.user_roles ur
                    WHERE ur.private_profile_id = NEW.profile_id
                    AND ur.class_id = NEW.class_id
                    LIMIT 1;

                    IF FOUND THEN
                        -- Use NULLIF to treat 0 as NULL so COALESCE falls through to the default
                        INSERT INTO public.assignment_leaderboard (
                            assignment_id,
                            class_id,
                            public_profile_id,
                            autograder_score,
                            max_score,
                            submission_id,
                            updated_at
                        ) VALUES (
                            NEW.assignment_id,
                            NEW.class_id,
                            v_user_role.public_profile_id,
                            v_grader_result.score,
                            COALESCE(NULLIF(v_grader_result.max_score, 0), NULLIF(v_grader_result.autograder_points, 0), 100),
                            NEW.id,
                            NOW()
                        )
                        ON CONFLICT (assignment_id, public_profile_id)
                        DO UPDATE SET
                            autograder_score = EXCLUDED.autograder_score,
                            max_score = EXCLUDED.max_score,
                            submission_id = EXCLUDED.submission_id,
                            updated_at = NOW();
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
                        INSERT INTO public.assignment_leaderboard (
                            assignment_id,
                            class_id,
                            public_profile_id,
                            autograder_score,
                            max_score,
                            submission_id,
                            updated_at
                        ) VALUES (
                            NEW.assignment_id,
                            NEW.class_id,
                            v_user_role.public_profile_id,
                            v_grader_result.score,
                            COALESCE(NULLIF(v_grader_result.max_score, 0), NULLIF(v_grader_result.autograder_points, 0), 100),
                            NEW.id,
                            NOW()
                        )
                        ON CONFLICT (assignment_id, public_profile_id)
                        DO UPDATE SET
                            autograder_score = EXCLUDED.autograder_score,
                            max_score = EXCLUDED.max_score,
                            submission_id = EXCLUDED.submission_id,
                            updated_at = NOW();
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

-- Some performance fixes slide in...

ALTER TABLE pgmq.a_gradebook_row_recalculate SET UNLOGGED;
ALTER TABLE pgmq.q_gradebook_row_recalculate SET UNLOGGED;
DROP INDEX idx_gradebook_column_students_class_column_student;
DROP INDEX idx_gradebook_column_students_class_id;
DROP INDEX idx_gcs_class_gradebook_student_privacy;
DROP INDEX idx_gradebook_column_students_class_student_covering;
