-- Fix error_pins created_by foreign key constraint violation
-- The issue: save_error_pin was using auth.uid() (which returns auth.users.id)
-- but error_pins.created_by references profiles.id (which is private_profile_id)

-- ============================================================================
-- Update save_error_pin to use private_profile_id from user_privileges
-- ============================================================================

CREATE OR REPLACE FUNCTION save_error_pin(
    p_error_pin jsonb,
    p_rules jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_pin_id bigint;
    v_assignment_id bigint;
    v_class_id bigint;
    v_submission_id bigint;
    v_rule jsonb;
    v_grader_result_id bigint;
    v_test_id bigint;
    v_pin_record error_pins%ROWTYPE;
    v_rule_record error_pin_rules%ROWTYPE;
    v_rule_matches boolean;
    v_all_rules_match boolean;
    v_processed_count int := 0;
    v_matching_test_id bigint;
    v_has_grader_level_rule boolean;
    v_first_test_id bigint;
    v_private_profile_id uuid;
BEGIN
    -- Get assignment_id (can be NULL for class-level pins)
    v_assignment_id := (p_error_pin->>'assignment_id')::bigint;
    
    -- Look up class_id: either from assignment (if provided) or directly from input
    IF v_assignment_id IS NOT NULL THEN
        SELECT class_id INTO v_class_id
        FROM assignments
        WHERE id = v_assignment_id;
        
        IF v_class_id IS NULL THEN
            RAISE EXCEPTION 'Assignment not found';
        END IF;
    ELSE
        -- For class-level pins, class_id must be provided directly
        v_class_id := (p_error_pin->>'class_id')::bigint;
        
        IF v_class_id IS NULL THEN
            RAISE EXCEPTION 'class_id is required for class-level pins';
        END IF;
        
        -- Verify the class exists
        IF NOT EXISTS (SELECT 1 FROM classes WHERE id = v_class_id) THEN
            RAISE EXCEPTION 'Class not found';
        END IF;
    END IF;
    
    IF NOT authorizeforclassgrader(v_class_id) THEN  
        RAISE EXCEPTION 'Only instructors and graders can create or modify error pins';  
    END IF;
    
    -- Look up the user's private_profile_id for this class
    -- This is needed because created_by references profiles.id, not auth.users.id
    SELECT up.private_profile_id INTO v_private_profile_id
    FROM user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = v_class_id;
    
    IF v_private_profile_id IS NULL THEN
        RAISE EXCEPTION 'User profile not found for this class';
    END IF;
    
    -- Validate that discussion_thread_id belongs to the target class (prevent cross-class linkage)
    IF (p_error_pin->>'discussion_thread_id')::bigint IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM discussion_threads dt
            WHERE dt.id = (p_error_pin->>'discussion_thread_id')::bigint
              AND dt.class_id = v_class_id
        ) THEN
            RAISE EXCEPTION 'Discussion thread not found or does not belong to this class';
        END IF;
    END IF;
  
    -- Insert or update error_pin
    IF (p_error_pin->>'id')::bigint IS NOT NULL THEN
        -- Update existing pin - first verify the pin exists and belongs to a class we're authorized for
        DECLARE
            v_existing_class_id bigint;
        BEGIN
            SELECT class_id INTO v_existing_class_id
            FROM error_pins
            WHERE id = (p_error_pin->>'id')::bigint;
            
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Error pin not found';
            END IF;
            
            -- Verify caller is authorized for the existing pin's class (prevent cross-class updates)
            IF NOT authorizeforclassgrader(v_existing_class_id) THEN
                RAISE EXCEPTION 'Permission denied: not authorized for this error pin';
            END IF;
        END;
        
        -- Update existing pin (only allow changing discussion_thread_id, assignment_id, rule_logic, enabled)
        -- class_id is derived from assignment_id (or provided for class-level), created_by is not updated
        UPDATE error_pins
        SET discussion_thread_id = (p_error_pin->>'discussion_thread_id')::bigint,
            assignment_id = v_assignment_id,
            class_id = v_class_id,
            rule_logic = COALESCE(p_error_pin->>'rule_logic', 'and'),
            enabled = COALESCE((p_error_pin->>'enabled')::boolean, true)
        WHERE id = (p_error_pin->>'id')::bigint
        RETURNING id, assignment_id INTO v_pin_id, v_assignment_id;
    ELSE
        -- Insert new pin using private_profile_id (NOT auth.uid())
        INSERT INTO error_pins (
            discussion_thread_id,
            assignment_id,
            class_id,
            created_by,
            rule_logic,
            enabled
        )
        VALUES (
            (p_error_pin->>'discussion_thread_id')::bigint,
            v_assignment_id,
            v_class_id,
            v_private_profile_id,  -- Use private_profile_id, not auth.uid()
            COALESCE(p_error_pin->>'rule_logic', 'and'),
            COALESCE((p_error_pin->>'enabled')::boolean, true)
        )
        RETURNING id, assignment_id INTO v_pin_id, v_assignment_id;
    END IF;

    -- Delete old rules
    DELETE FROM error_pin_rules WHERE error_pin_id = v_pin_id;

    -- Insert new rules
    FOR v_rule IN SELECT * FROM jsonb_array_elements(p_rules)
    LOOP
        INSERT INTO error_pin_rules (
            error_pin_id,
            target,
            match_type,
            match_value,
            match_value_max,
            test_name_filter,
            ordinal
        )
        VALUES (
            v_pin_id,
            (v_rule->>'target')::error_pin_rule_target,
            COALESCE(v_rule->>'match_type', 'contains'),
            v_rule->>'match_value',
            v_rule->>'match_value_max',
            v_rule->>'test_name_filter',
            COALESCE((v_rule->>'ordinal')::smallint, 0)
        );
    END LOOP;

    -- Auto-populate: compute matches for all active submissions
    -- Clear existing matches first
    DELETE FROM error_pin_submission_matches WHERE error_pin_id = v_pin_id;

    -- Get pin record with rules
    SELECT * INTO v_pin_record FROM error_pins WHERE id = v_pin_id;

    -- Process each active submission
    -- For assignment-level pins: only submissions for that assignment
    -- For class-level pins: all submissions in the class
    FOR v_submission_id IN
        SELECT s.id FROM submissions s
        JOIN assignments a ON a.id = s.assignment_id
        WHERE ((v_assignment_id IS NOT NULL AND s.assignment_id = v_assignment_id)
           OR (v_assignment_id IS NULL AND a.class_id = v_class_id))
          AND s.is_active = true
    LOOP
        -- Get grader result
        SELECT id INTO v_grader_result_id
        FROM grader_results
        WHERE submission_id = v_submission_id
        ORDER BY created_at DESC
        LIMIT 1;
        
        IF v_grader_result_id IS NULL THEN
            CONTINUE;
        END IF;

        -- Evaluate rules based on logic (AND/OR)
        IF v_pin_record.rule_logic = 'and' THEN
            -- AND logic: all rules must match
            v_all_rules_match := true;
            v_matching_test_id := NULL;
            v_has_grader_level_rule := false;
            v_first_test_id := NULL;
            
            FOR v_rule_record IN
                SELECT * FROM error_pin_rules
                WHERE error_pin_id = v_pin_id
                ORDER BY ordinal
            LOOP
                v_rule_matches := false;
                IF v_rule_record.target IN ('lint_output', 'lint_failed', 'grader_score_range', 'grader_output_student', 'grader_output_hidden') THEN
                    v_has_grader_level_rule := true;
                    v_rule_matches := evaluate_error_pin_rule(
                        v_rule_record.target,
                        v_rule_record.match_type,
                        v_rule_record.match_value,
                        v_rule_record.match_value_max,
                        v_rule_record.test_name_filter,
                        v_submission_id,
                        v_grader_result_id
                    );
                ELSE
                    -- For test-level rules, check if any test matches
                    FOR v_test_id IN
                        SELECT id FROM grader_result_tests
                        WHERE grader_result_id = v_grader_result_id
                    LOOP
                        IF evaluate_error_pin_rule(
                            v_rule_record.target,
                            v_rule_record.match_type,
                            v_rule_record.match_value,
                            v_rule_record.match_value_max,
                            v_rule_record.test_name_filter,
                            v_submission_id,
                            v_grader_result_id,
                            v_test_id
                        ) THEN
                            v_rule_matches := true;
                            -- Track the test_id that matched
                            IF v_first_test_id IS NULL THEN
                                v_first_test_id := v_test_id;
                            ELSIF v_first_test_id != v_test_id THEN
                                -- Different test matched, can't use specific test_id
                                v_first_test_id := NULL;
                            END IF;
                            EXIT;
                        END IF;
                    END LOOP;
                END IF;
                IF NOT v_rule_matches THEN
                    v_all_rules_match := false;
                    EXIT;
                END IF;
            END LOOP;
            
            IF v_all_rules_match THEN
                -- If all rules are test-level and they all match the same test, use that test_id
                -- Otherwise, use NULL (submission-level match)
                IF NOT v_has_grader_level_rule AND v_first_test_id IS NOT NULL THEN
                    v_matching_test_id := v_first_test_id;
                END IF;
                
                INSERT INTO error_pin_submission_matches (error_pin_id, submission_id, grader_result_test_id)
                VALUES (v_pin_id, v_submission_id, v_matching_test_id)
                ON CONFLICT DO NOTHING;
                v_processed_count := v_processed_count + 1;
            END IF;
        ELSE
            -- OR logic: any rule must match
            FOR v_rule_record IN
                SELECT * FROM error_pin_rules
                WHERE error_pin_id = v_pin_id
                ORDER BY ordinal
            LOOP
                IF v_rule_record.target IN ('lint_output', 'lint_failed', 'grader_score_range', 'grader_output_student', 'grader_output_hidden') THEN
                    v_rule_matches := evaluate_error_pin_rule(
                        v_rule_record.target,
                        v_rule_record.match_type,
                        v_rule_record.match_value,
                        v_rule_record.match_value_max,
                        v_rule_record.test_name_filter,
                        v_submission_id,
                        v_grader_result_id
                    );
                    IF v_rule_matches THEN
                        INSERT INTO error_pin_submission_matches (error_pin_id, submission_id, grader_result_test_id)
                        VALUES (v_pin_id, v_submission_id, NULL)
                        ON CONFLICT DO NOTHING;
                        v_processed_count := v_processed_count + 1;
                        EXIT; -- Found a match, done with this submission
                    END IF;
                ELSE
                    FOR v_test_id IN
                        SELECT id FROM grader_result_tests
                        WHERE grader_result_id = v_grader_result_id
                    LOOP
                        v_rule_matches := evaluate_error_pin_rule(
                            v_rule_record.target,
                            v_rule_record.match_type,
                            v_rule_record.match_value,
                            v_rule_record.match_value_max,
                            v_rule_record.test_name_filter,
                            v_submission_id,
                            v_grader_result_id,
                            v_test_id
                        );
                        IF v_rule_matches THEN
                            INSERT INTO error_pin_submission_matches (error_pin_id, submission_id, grader_result_test_id)
                            VALUES (v_pin_id, v_submission_id, v_test_id)
                            ON CONFLICT DO NOTHING;
                            v_processed_count := v_processed_count + 1;
                            EXIT; -- Found a match for this rule
                        END IF;
                    END LOOP;
                    IF v_rule_matches THEN
                        EXIT; -- Found a match, done with this submission
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'error_pin_id', v_pin_id,
        'matches_populated', v_processed_count
    );
END;
$$;
