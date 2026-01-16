-- Fix: Treat empty string test_name_filter the same as NULL
-- This prevents issues when the form sends empty string instead of null
-- for the optional test_name_filter field

-- First, clean up existing rules with empty string test_name_filter
-- by converting them to NULL
UPDATE error_pin_rules
SET test_name_filter = NULL
WHERE test_name_filter = '';

-- Also clean up empty match_value_max
UPDATE error_pin_rules
SET match_value_max = NULL
WHERE match_value_max = '';

-- Clear all cached matches so they get recomputed with the fixed logic
-- Matches will be recomputed on-demand when submissions are viewed
TRUNCATE error_pin_submission_matches;

CREATE OR REPLACE FUNCTION evaluate_error_pin_rule(
    p_target error_pin_rule_target,
    p_match_type text,
    p_match_value text,
    p_match_value_max text,
    p_test_name_filter text,
    p_submission_id bigint,
    p_grader_result_id bigint,
    p_test_id bigint DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_match_value text;
    v_match_result boolean := false;
    v_test_name text;
    v_test_part text;
    v_test_output text;
    v_test_score numeric;
    v_grader_score numeric;
    v_lint_output text;
    v_lint_passed boolean;
    v_grader_output_student text;
    v_grader_output_hidden text;
    v_test_hidden_output text;
BEGIN
    -- Apply test_name_filter if specified (skip if NULL or empty string)
    IF p_test_name_filter IS NOT NULL AND p_test_name_filter != '' AND p_test_id IS NOT NULL THEN
        SELECT name INTO v_test_name
        FROM grader_result_tests
        WHERE id = p_test_id;
        
        IF v_test_name IS NULL THEN
            RETURN false;
        END IF;
        
        BEGIN
            IF v_test_name !~ p_test_name_filter THEN
                RETURN false;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RETURN false;
        END;
    END IF;

    -- Evaluate based on target type
    CASE p_target
        WHEN 'test_name' THEN
            IF p_test_id IS NULL THEN RETURN false; END IF;
            SELECT name INTO v_test_name FROM grader_result_tests WHERE id = p_test_id;
            IF v_test_name IS NULL THEN RETURN false; END IF;
            v_match_value := v_test_name;

        WHEN 'test_part' THEN
            IF p_test_id IS NULL THEN RETURN false; END IF;
            SELECT part INTO v_test_part FROM grader_result_tests WHERE id = p_test_id;
            IF v_test_part IS NULL THEN RETURN false; END IF;
            v_match_value := v_test_part;

        WHEN 'test_output' THEN
            IF p_test_id IS NULL THEN RETURN false; END IF;
            SELECT output INTO v_test_output FROM grader_result_tests WHERE id = p_test_id;
            IF v_test_output IS NULL THEN RETURN false; END IF;
            v_match_value := v_test_output;

        WHEN 'test_hidden_output' THEN
            IF p_test_id IS NULL THEN RETURN false; END IF;
            SELECT gro.output INTO v_test_hidden_output
            FROM grader_result_test_output gro
            WHERE gro.grader_result_test_id = p_test_id
            LIMIT 1;
            IF v_test_hidden_output IS NULL THEN RETURN false; END IF;
            v_match_value := v_test_hidden_output;

        WHEN 'test_score_range' THEN
            IF p_test_id IS NULL THEN RETURN false; END IF;
            SELECT score INTO v_test_score FROM grader_result_tests WHERE id = p_test_id;
            IF v_test_score IS NULL THEN RETURN false; END IF;
            -- Range matching handled separately below
            IF p_match_type = 'range' THEN
                BEGIN
                    RETURN v_test_score >= p_match_value::numeric 
                       AND (p_match_value_max IS NULL OR v_test_score <= p_match_value_max::numeric);
                EXCEPTION WHEN OTHERS THEN
                    RETURN false;
                END;
            END IF;
            RETURN false;

        WHEN 'grader_score_range' THEN
            SELECT score INTO v_grader_score FROM grader_results WHERE id = p_grader_result_id;
            IF v_grader_score IS NULL THEN RETURN false; END IF;
            IF p_match_type = 'range' THEN
                BEGIN
                    RETURN v_grader_score >= p_match_value::numeric 
                       AND (p_match_value_max IS NULL OR v_grader_score <= p_match_value_max::numeric);
                EXCEPTION WHEN OTHERS THEN
                    RETURN false;
                END;
            END IF;
            RETURN false;

        WHEN 'lint_output' THEN
            SELECT lint_output INTO v_lint_output FROM grader_results WHERE id = p_grader_result_id;
            IF v_lint_output IS NULL THEN RETURN false; END IF;
            v_match_value := v_lint_output;

        WHEN 'lint_failed' THEN
            SELECT lint_passed INTO v_lint_passed FROM grader_results WHERE id = p_grader_result_id;
            RETURN v_lint_passed = false;

        WHEN 'grader_output_student' THEN
            SELECT output INTO v_grader_output_student
            FROM grader_result_output
            WHERE grader_result_id = p_grader_result_id
              AND visibility = 'visible'
            LIMIT 1;
            IF v_grader_output_student IS NULL THEN RETURN false; END IF;
            v_match_value := v_grader_output_student;

        WHEN 'grader_output_hidden' THEN
            SELECT output INTO v_grader_output_hidden
            FROM grader_result_output
            WHERE grader_result_id = p_grader_result_id
              AND visibility != 'visible'
            LIMIT 1;
            IF v_grader_output_hidden IS NULL THEN RETURN false; END IF;
            v_match_value := v_grader_output_hidden;

        ELSE
            RETURN false;
    END CASE;

    -- Apply match type (skip for range and lint_failed which are handled above)
    IF p_target IN ('test_score_range', 'grader_score_range', 'lint_failed') THEN
        RETURN v_match_result;
    END IF;

    CASE p_match_type
        WHEN 'contains' THEN
            -- Escape SQL wildcards: backslash, percent, underscore
            RETURN v_match_value ILIKE '%' || REPLACE(REPLACE(REPLACE(p_match_value, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\';
        WHEN 'equals' THEN
            RETURN v_match_value = p_match_value;
        WHEN 'regex' THEN
            BEGIN
                RETURN v_match_value ~ p_match_value;
            EXCEPTION WHEN OTHERS THEN
                RETURN false;
            END;
        ELSE
            RETURN false;
    END CASE;
END;
$$;
