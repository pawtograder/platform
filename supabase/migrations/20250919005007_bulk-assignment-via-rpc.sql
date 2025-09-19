-- Bulk assignment RPC for improved bulk-assign functionality
-- This RPC handles the complex logic of creating review assignments in bulk
-- with proper conflict handling, duplicate detection, and atomic operations

CREATE OR REPLACE FUNCTION public.bulk_assign_reviews(
    p_class_id bigint,
    p_assignment_id bigint,
    p_rubric_id bigint,
    p_draft_assignments jsonb,
    p_due_date timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result jsonb := jsonb_build_object('success', true);
    v_assignment record;
    v_assignments_created integer := 0;
    v_assignments_updated integer := 0;
    v_parts_created integer := 0;
    v_submission_reviews_created integer := 0;
    v_existing_assignments bigint[];
    v_assignments_to_create jsonb[];
    v_parts_to_create jsonb[];
    v_review_assignment record;
    v_draft_assignment jsonb;
    v_submission_review_id bigint;
    v_assignee_profile_id uuid;
    v_submission_id bigint;
    v_rubric_part_id bigint;
    v_has_specific_parts boolean;
BEGIN
    -- Authorization check: only instructors can bulk assign reviews
    IF NOT authorizeforclassinstructor(p_class_id) THEN
        RAISE EXCEPTION 'Access denied: Only instructors can bulk assign reviews'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Validate that the assignment belongs to the class
    SELECT * INTO v_assignment 
    FROM assignments 
    WHERE id = p_assignment_id AND class_id = p_class_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment % not found in class %', p_assignment_id, p_class_id;
    END IF;

    -- Validate that the rubric exists and belongs to the assignment
    IF NOT EXISTS (
        SELECT 1 FROM rubrics 
        WHERE id = p_rubric_id AND assignment_id = p_assignment_id
    ) THEN
        RAISE EXCEPTION 'Rubric % not found for assignment %', p_rubric_id, p_assignment_id;
    END IF;

    -- Process each draft assignment
    FOR v_draft_assignment IN SELECT * FROM jsonb_array_elements(p_draft_assignments)
    LOOP
        v_assignee_profile_id := (v_draft_assignment->>'assignee_profile_id')::uuid;
        v_submission_id := (v_draft_assignment->>'submission_id')::bigint;
        v_rubric_part_id := CASE 
            WHEN v_draft_assignment->>'rubric_part_id' = 'null' OR v_draft_assignment->>'rubric_part_id' IS NULL 
            THEN NULL 
            ELSE (v_draft_assignment->>'rubric_part_id')::bigint 
        END;
        v_has_specific_parts := v_rubric_part_id IS NOT NULL;

        IF v_has_specific_parts THEN
        PERFORM 1 FROM rubric_parts rp WHERE rp.id = v_rubric_part_id AND rp.rubric_id = p_rubric_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Rubric part % does not belong to rubric %', v_rubric_part_id, p_rubric_id
            USING ERRCODE = 'foreign_key_violation';
        END IF;
        END IF;

        -- Validate the submission belongs to this class/assignment and is active
        PERFORM 1
        FROM submissions s
        WHERE s.id = v_submission_id
        AND s.assignment_id = p_assignment_id
        AND s.class_id = p_class_id
        AND s.is_active = true;
        IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid submission_id % for assignment % / class %', v_submission_id, p_assignment_id, p_class_id
            USING ERRCODE = 'foreign_key_violation';
        END IF;

        -- Validate assignee is enrolled in class with grader/instructor role
        PERFORM 1
        FROM user_roles ur
        WHERE ur.private_profile_id = v_assignee_profile_id
        AND ur.class_id = p_class_id
        AND ur.role IN ('grader','instructor');
        IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignee % is not authorized for class %', v_assignee_profile_id, p_class_id
            USING ERRCODE = 'insufficient_privilege';
        END IF;


        -- Ensure submission_review exists
        SELECT id INTO v_submission_review_id
        FROM submission_reviews
        WHERE submission_id = v_submission_id AND rubric_id = p_rubric_id;

        IF v_submission_review_id IS NULL THEN
            INSERT INTO submission_reviews (
                submission_id,
                rubric_id,
                class_id,
                name,
                total_score,
                total_autograde_score,
                tweak
            ) VALUES (
                v_submission_id,
                p_rubric_id,
                p_class_id,
                (SELECT name FROM rubrics WHERE id = p_rubric_id),
                0,
                0,
                0
            ) 
            ON CONFLICT (submission_id, rubric_id) DO NOTHING
            RETURNING id INTO v_submission_review_id;
            
            v_submission_reviews_created := v_submission_reviews_created + 1;
        END IF;

        -- Use UPSERT with ON CONFLICT to handle duplicates elegantly
        INSERT INTO review_assignments (
            assignee_profile_id,
            submission_id,
            submission_review_id,
            assignment_id,
            rubric_id,
            class_id,
            due_date,
            completed_at
        ) VALUES (
            v_assignee_profile_id,
            v_submission_id,
            v_submission_review_id,
            p_assignment_id,
            p_rubric_id,
            p_class_id,
            p_due_date,
            NULL
        )
        ON CONFLICT (assignee_profile_id, submission_review_id, assignment_id, rubric_id)
        DO UPDATE SET
            due_date = EXCLUDED.due_date
        RETURNING id, (xmax = 0) AS was_inserted INTO v_review_assignment;
        
        -- Track whether this was an insert or update
        IF v_review_assignment.was_inserted THEN
            v_assignments_created := v_assignments_created + 1;
        ELSE
            v_assignments_updated := v_assignments_updated + 1;
        END IF;

        -- Handle rubric parts if specified
        IF v_has_specific_parts THEN
            -- Check if this part assignment already exists
            IF NOT EXISTS (
                SELECT 1 FROM review_assignment_rubric_parts
                WHERE review_assignment_id = v_review_assignment.id
                  AND rubric_part_id = v_rubric_part_id
            ) THEN
                INSERT INTO review_assignment_rubric_parts (
                    review_assignment_id,
                    rubric_part_id,
                    class_id
                ) VALUES (
                    v_review_assignment.id,
                    v_rubric_part_id,
                    p_class_id
                );
                
                v_parts_created := v_parts_created + 1;
            END IF;
        END IF;
    END LOOP;

    -- Build result
    v_result := jsonb_build_object(
        'success', true,
        'assignments_created', v_assignments_created,
        'assignments_updated', v_assignments_updated,
        'parts_created', v_parts_created,
        'submission_reviews_created', v_submission_reviews_created,
        'total_processed', jsonb_array_length(p_draft_assignments)
    );

    RETURN v_result;

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', SQLERRM,
            'error_code', SQLSTATE
        );
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.bulk_assign_reviews(bigint, bigint, bigint, jsonb, timestamptz) TO authenticated;

-- Add helpful comment
COMMENT ON FUNCTION public.bulk_assign_reviews(bigint, bigint, bigint, jsonb, timestamptz) IS 
'Bulk assigns review assignments with proper authorization checks. Requires instructor role for the class. 
Handles creation of submission_reviews, review_assignments, and review_assignment_rubric_parts atomically.';


-- RPC to clear all unfinished review assignments for a rubric/assignment pair
-- This is useful for resetting assignments before doing a new bulk assignment

CREATE OR REPLACE FUNCTION public.clear_unfinished_review_assignments(
    p_class_id bigint,
    p_assignment_id bigint,
    p_rubric_id bigint,
    p_rubric_part_ids bigint[] DEFAULT NULL,
    p_class_section_ids bigint[] DEFAULT NULL,
    p_lab_section_ids bigint[] DEFAULT NULL,
    p_student_tag_filters jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result jsonb := jsonb_build_object('success', true);
    v_assignment record;
    v_assignments_deleted integer := 0;
    v_parts_deleted integer := 0;
    v_assignment_ids bigint[];
BEGIN
    -- Authorization check: only instructors can clear review assignments
    IF NOT authorizeforclassinstructor(p_class_id) THEN
        RAISE EXCEPTION 'Access denied: Only instructors can clear review assignments'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Validate that the assignment belongs to the class
    SELECT * INTO v_assignment 
    FROM assignments 
    WHERE id = p_assignment_id AND class_id = p_class_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment % not found in class %', p_assignment_id, p_class_id;
    END IF;

    -- Validate that the rubric exists and belongs to the assignment
    IF NOT EXISTS (
        SELECT 1 FROM rubrics 
        WHERE id = p_rubric_id AND assignment_id = p_assignment_id
    ) THEN
        RAISE EXCEPTION 'Rubric % not found for assignment %', p_rubric_id, p_assignment_id;
    END IF;

    -- Get IDs of unfinished review assignments to delete, applying all filters
    SELECT ARRAY(
        SELECT DISTINCT ra.id 
        FROM review_assignments ra
        LEFT JOIN review_assignment_rubric_parts rarp ON ra.id = rarp.review_assignment_id
        JOIN submissions s ON ra.submission_id = s.id
        LEFT JOIN assignment_groups ag ON s.assignment_group_id = ag.id
        LEFT JOIN assignment_groups_members agm ON ag.id = agm.assignment_group_id
        WHERE ra.assignment_id = p_assignment_id 
          AND ra.rubric_id = p_rubric_id 
          AND ra.class_id = p_class_id
          AND ra.completed_at IS NULL
          -- Rubric parts filter
          AND (
              p_rubric_part_ids IS NULL 
              OR array_length(p_rubric_part_ids, 1) = 0
              OR (
                  -- Either no specific parts assigned (whole rubric)
                  (NOT EXISTS (
                      SELECT 1 FROM review_assignment_rubric_parts 
                      WHERE review_assignment_id = ra.id
                  ))
                  OR
                  -- Or has specific parts that overlap with the selected parts to clear
                  (rarp.rubric_part_id = ANY(p_rubric_part_ids))
              )
          )
          -- Class section filter
          AND (
              p_class_section_ids IS NULL 
              OR array_length(p_class_section_ids, 1) = 0
              OR EXISTS (
                  SELECT 1 FROM user_roles ur 
                  WHERE ur.class_id = p_class_id 
                    AND ur.class_section_id = ANY(p_class_section_ids)
                    AND (
                        ur.private_profile_id = s.profile_id 
                        OR ur.private_profile_id = agm.profile_id
                    )
              )
          )
          -- Lab section filter  
          AND (
              p_lab_section_ids IS NULL 
              OR array_length(p_lab_section_ids, 1) = 0
              OR EXISTS (
                  SELECT 1 FROM user_roles ur 
                  WHERE ur.class_id = p_class_id 
                    AND ur.lab_section_id = ANY(p_lab_section_ids)
                    AND (
                        ur.private_profile_id = s.profile_id 
                        OR ur.private_profile_id = agm.profile_id
                    )
              )
          )
          -- Student tags filter
          AND (
              p_student_tag_filters IS NULL
              OR EXISTS (
                  SELECT 1 FROM tags t
                  WHERE t.class_id = p_class_id
                    AND (
                        t.profile_id = s.profile_id 
                        OR t.profile_id = agm.profile_id
                    )
                    AND EXISTS (
                        SELECT 1 FROM jsonb_array_elements(p_student_tag_filters) AS tag_filter
                        WHERE t.name = (tag_filter->>'name')::text
                          AND t.color = (tag_filter->>'color')::text
                    )
              )
          )
    ) INTO v_assignment_ids;

    -- Delete review assignment rubric parts first (foreign key constraint)
    IF array_length(v_assignment_ids, 1) > 0 THEN
        DELETE FROM review_assignment_rubric_parts 
        WHERE review_assignment_id = ANY(v_assignment_ids);
        
        GET DIAGNOSTICS v_parts_deleted = ROW_COUNT;

        -- Delete the review assignments
        DELETE FROM review_assignments 
        WHERE id = ANY(v_assignment_ids);
        
        GET DIAGNOSTICS v_assignments_deleted = ROW_COUNT;
    END IF;

    -- Build result
    v_result := jsonb_build_object(
        'success', true,
        'assignments_deleted', v_assignments_deleted,
        'parts_deleted', v_parts_deleted,
        'message', format('Cleared %s unfinished review assignments and %s rubric parts', 
                         v_assignments_deleted, v_parts_deleted)
    );

    RETURN v_result;

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', SQLERRM,
            'error_code', SQLSTATE
        );
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.clear_unfinished_review_assignments(bigint, bigint, bigint, bigint[], bigint[], bigint[], jsonb) TO authenticated;

-- Add helpful comment
COMMENT ON FUNCTION public.clear_unfinished_review_assignments(bigint, bigint, bigint, bigint[], bigint[], bigint[], jsonb) IS 
'Clears all unfinished review assignments for a given assignment/rubric pair, with comprehensive filtering options.
Only deletes assignments where completed_at IS NULL. Filters can be applied for:
- rubric_part_ids: specific rubric parts (clears assignments with those parts or whole-rubric assignments)
- class_section_ids: only assignments for students in specified class sections
- lab_section_ids: only assignments for students in specified lab sections  
- student_tag_filters: only assignments for students with specified tags (jsonb array of {name, color} objects)
Requires instructor role for the class.';


-- Update the submission deactivation trigger function to also reset completion status
-- When review assignments are moved to a new submission, they should be marked as incomplete

CREATE OR REPLACE FUNCTION "public"."update_review_assignments_on_submission_deactivation"()
RETURNS "trigger"
LANGUAGE "plpgsql" SECURITY DEFINER
SET search_path TO public,pg_temp
AS $$
DECLARE
    new_active_submission_id bigint;
    updated_assignments_count integer;
    updated_links_count integer;
BEGIN
    -- Only proceed if is_active changed from true to false
    IF OLD.is_active = true AND NEW.is_active = false THEN
        -- Find the new active submission for the same assignment and student/group
        IF OLD.assignment_group_id IS NOT NULL THEN
            -- Group submission: find active submission for the same assignment_group_id
            SELECT id INTO new_active_submission_id
            FROM public.submissions
            WHERE assignment_id = OLD.assignment_id
              AND assignment_group_id = OLD.assignment_group_id
              AND is_active = true
              AND id != OLD.id
            LIMIT 1;
        ELSE
            -- Individual submission: find active submission for the same profile_id
            SELECT id INTO new_active_submission_id
            FROM public.submissions
            WHERE assignment_id = OLD.assignment_id
              AND profile_id = OLD.profile_id
              AND assignment_group_id IS NULL
              AND is_active = true
              AND id != OLD.id
            LIMIT 1;
        END IF;

        -- If we found a new active submission, update review assignments and their linked submission_review
        IF new_active_submission_id IS NOT NULL THEN

            -- Ensure a submission_reviews row exists for the new submission/rubric pairs
            INSERT INTO public.submission_reviews (submission_id, rubric_id, class_id, name, total_score, total_autograde_score, tweak)
            SELECT new_active_submission_id, ra.rubric_id, ra.class_id,
                   (SELECT name FROM rubrics WHERE id = ra.rubric_id), 0, 0, 0
            FROM public.review_assignments ra
            WHERE ra.submission_id = OLD.id
            ON CONFLICT (submission_id, rubric_id) DO NOTHING;

            -- Move review assignments to the new active submission and reset completion status
            UPDATE public.review_assignments
            SET submission_id = new_active_submission_id,
                completed_at = NULL,
                completed_by = NULL
            WHERE submission_id = OLD.id;

            GET DIAGNOSTICS updated_assignments_count = ROW_COUNT;

            -- Now update the submission_review_id to the matching submission_reviews row
            -- for the new submission and the same rubric. A row should already exist due to
            -- earlier logic that creates submission_reviews for active submissions.
            UPDATE public.review_assignments AS ra
            SET submission_review_id = sr.id
            FROM public.submission_reviews AS sr
            WHERE ra.submission_id = new_active_submission_id
              AND sr.submission_id = new_active_submission_id
              AND sr.rubric_id = ra.rubric_id;

            GET DIAGNOSTICS updated_links_count = ROW_COUNT;

            -- Log the updates for observability
            RAISE NOTICE 'Updated % review_assignments from submission_id % to %, reset completion status, and updated % submission_review links',
                updated_assignments_count, OLD.id, new_active_submission_id, updated_links_count;
        ELSE
            -- Log when no new active submission is found
            RAISE NOTICE 'No new active submission found for deactivated submission_id %', OLD.id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."update_review_assignments_on_submission_deactivation"() IS 
'Updates review_assignments to point to the new active submission when a submission is deactivated (is_active changes from true to false), resets completion status (completed_at and completed_by to NULL), and also updates submission_review_id to the corresponding submission_reviews row for the new submission and rubric.';


-- Add unique constraint for review_assignments to prevent duplicates
-- This ensures we can't have multiple review assignments for the same assignee/submission/assignment/rubric combination
ALTER TABLE review_assignments 
ADD CONSTRAINT review_assignments_unique_assignee_submission_assignment_rubric 
UNIQUE (assignee_profile_id, submission_review_id, assignment_id, rubric_id);


-- RPC to clear ALL incomplete review assignments for an assignment (no filters)
-- This is useful for completely resetting all review assignments for an assignment

CREATE OR REPLACE FUNCTION public.clear_all_incomplete_review_assignments(
    p_class_id bigint,
    p_assignment_id bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result jsonb := jsonb_build_object('success', true);
    v_assignment record;
    v_assignments_deleted integer := 0;
    v_parts_deleted integer := 0;
    v_assignment_ids bigint[];
BEGIN
    -- Authorization check: only instructors can clear review assignments
    IF NOT authorizeforclassinstructor(p_class_id) THEN
        RAISE EXCEPTION 'Access denied: Only instructors can clear review assignments'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Validate that the assignment belongs to the class
    SELECT * INTO v_assignment 
    FROM assignments 
    WHERE id = p_assignment_id AND class_id = p_class_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment % not found in class %', p_assignment_id, p_class_id;
    END IF;

    -- Get IDs of ALL unfinished review assignments for this assignment
    SELECT ARRAY(
        SELECT id 
        FROM review_assignments 
        WHERE assignment_id = p_assignment_id 
          AND class_id = p_class_id
          AND completed_at IS NULL
    ) INTO v_assignment_ids;

    -- Delete review assignment rubric parts first (foreign key constraint)
    IF array_length(v_assignment_ids, 1) > 0 THEN
        DELETE FROM review_assignment_rubric_parts 
        WHERE review_assignment_id = ANY(v_assignment_ids);
        
        GET DIAGNOSTICS v_parts_deleted = ROW_COUNT;

        -- Delete the review assignments
        DELETE FROM review_assignments 
        WHERE id = ANY(v_assignment_ids);
        
        GET DIAGNOSTICS v_assignments_deleted = ROW_COUNT;
    END IF;

    -- Build result
    v_result := jsonb_build_object(
        'success', true,
        'assignments_deleted', v_assignments_deleted,
        'parts_deleted', v_parts_deleted,
        'message', format('Cleared %s unfinished review assignments and %s rubric parts for assignment', 
                         v_assignments_deleted, v_parts_deleted)
    );

    RETURN v_result;

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', SQLERRM,
            'error_code', SQLSTATE
        );
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.clear_all_incomplete_review_assignments(bigint, bigint) TO authenticated;

-- Add helpful comment
COMMENT ON FUNCTION public.clear_all_incomplete_review_assignments(bigint, bigint) IS 
'Clears ALL unfinished review assignments for an assignment (no filters applied). 
Only deletes assignments where completed_at IS NULL. Requires instructor role for the class. 
Useful for completely resetting all review assignments for an assignment.';


-- RPC to clear incomplete assignments for a specific grader, optionally scoped by rubric and parts
-- This is used by the reassign flow to remove remaining work for a grader before reassigning

CREATE OR REPLACE FUNCTION public.clear_incomplete_assignments_for_user(
    p_class_id bigint,
    p_assignment_id bigint,
    p_assignee_profile_id uuid,
    p_rubric_id bigint DEFAULT NULL,
    p_rubric_part_ids bigint[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result jsonb := jsonb_build_object('success', true);
    v_assignments_deleted integer := 0;
    v_parts_deleted integer := 0;
    v_assignment_ids bigint[];
BEGIN
    -- Authorization check
    IF NOT authorizeforclassinstructor(p_class_id) THEN
        RAISE EXCEPTION 'Access denied: Only instructors can clear review assignments'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Gather matching unfinished review assignments for the grader
    SELECT ARRAY(
        SELECT DISTINCT ra.id
        FROM review_assignments ra
        LEFT JOIN review_assignment_rubric_parts rarp ON rarp.review_assignment_id = ra.id
        WHERE ra.class_id = p_class_id
          AND ra.assignment_id = p_assignment_id
          AND ra.assignee_profile_id = p_assignee_profile_id
          AND ra.completed_at IS NULL
          AND (
            p_rubric_id IS NULL OR ra.rubric_id = p_rubric_id
          )
          AND (
            p_rubric_part_ids IS NULL OR array_length(p_rubric_part_ids, 1) = 0 OR (
              -- Either whole-rubric assignments (no specific parts)
              NOT EXISTS (SELECT 1 FROM review_assignment_rubric_parts WHERE review_assignment_id = ra.id)
              OR
              -- Or any overlap with selected parts
              rarp.rubric_part_id = ANY(p_rubric_part_ids)
            )
          )
    ) INTO v_assignment_ids;

    IF array_length(v_assignment_ids, 1) > 0 THEN
        -- Delete associated rubric parts first
        DELETE FROM review_assignment_rubric_parts
        WHERE review_assignment_id = ANY(v_assignment_ids);
        GET DIAGNOSTICS v_parts_deleted = ROW_COUNT;

        -- Delete the review assignments
        DELETE FROM review_assignments
        WHERE id = ANY(v_assignment_ids);
        GET DIAGNOSTICS v_assignments_deleted = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'assignments_deleted', v_assignments_deleted,
        'parts_deleted', v_parts_deleted
    );

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', SQLERRM,
            'error_code', SQLSTATE
        );
END;
$$;

GRANT EXECUTE ON FUNCTION public.clear_incomplete_assignments_for_user(
  bigint, bigint, uuid, bigint, bigint[]
) TO authenticated;

COMMENT ON FUNCTION public.clear_incomplete_assignments_for_user(bigint, bigint, uuid, bigint, bigint[]) IS 
'Clears unfinished review assignments for a specific grader on an assignment. Optional rubric/parts filters apply. 
Only clears rows where completed_at IS NULL. Requires instructor role.';
