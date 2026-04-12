-- Test Insights Analytics Migration
-- Provides analytics functions for tracking student performance on auto-graded tests

-- ============================================================================
-- Helper function for safe regex matching (returns false on invalid patterns)
-- ============================================================================

CREATE OR REPLACE FUNCTION safe_regex_match(p_text text, p_pattern text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF p_text IS NULL OR p_pattern IS NULL THEN
        RETURN false;
    END IF;
    RETURN p_text ~ p_pattern;
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$$;

-- ============================================================================
-- Step 1: RPC function to get test statistics for an assignment
-- ============================================================================

CREATE OR REPLACE FUNCTION get_test_statistics_for_assignment(p_assignment_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_class_id bigint;
    v_result jsonb;
BEGIN
    -- Get class_id from assignment
    SELECT class_id INTO v_class_id
    FROM assignments
    WHERE id = p_assignment_id;
    
    IF v_class_id IS NULL THEN
        RAISE EXCEPTION 'Assignment not found';
    END IF;
    
    -- Authorization check: must be instructor or grader
    IF NOT authorizeforclassgrader(v_class_id) THEN
        RAISE EXCEPTION 'Access denied: Only instructors and graders can view test statistics';
    END IF;
    
    -- Get comprehensive test statistics
    SELECT jsonb_build_object(
        'assignment_id', p_assignment_id,
        'total_active_submissions', (
            SELECT COUNT(DISTINCT s.id)
            FROM submissions s
            WHERE s.assignment_id = p_assignment_id
              AND s.is_active = true
        ),
        'submissions_with_results', (
            SELECT COUNT(DISTINCT s.id)
            FROM submissions s
            INNER JOIN grader_results gr ON gr.submission_id = s.id
            WHERE s.assignment_id = p_assignment_id
              AND s.is_active = true
        ),
        'tests', (
            SELECT COALESCE(jsonb_agg(test_stats ORDER BY test_stats->>'name'), '[]'::jsonb)
            FROM (
                SELECT jsonb_build_object(
                    'name', grt.name,
                    'part', grt.part,
                    'max_score', MAX(grt.max_score),
                    'total_attempts', COUNT(*),
                    'passing_count', COUNT(*) FILTER (WHERE grt.score = grt.max_score),
                    'failing_count', COUNT(*) FILTER (WHERE grt.score < grt.max_score OR grt.score IS NULL),
                    'zero_score_count', COUNT(*) FILTER (WHERE grt.score = 0 OR grt.score IS NULL),
                    'partial_score_count', COUNT(*) FILTER (WHERE grt.score > 0 AND grt.score < grt.max_score),
                    'pass_rate', ROUND(
                        (COUNT(*) FILTER (WHERE grt.score = grt.max_score)::numeric / NULLIF(COUNT(*), 0)) * 100,
                        2
                    ),
                    'avg_score', ROUND(AVG(COALESCE(grt.score, 0))::numeric, 2),
                    'median_score', PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(grt.score, 0)),
                    'score_distribution', (
                        SELECT jsonb_object_agg(score_bucket, bucket_count)
                        FROM (
                            SELECT 
                                CASE 
                                    WHEN grt2.score IS NULL OR grt2.score = 0 THEN '0'
                                    WHEN grt2.max_score > 0 THEN 
                                        CASE 
                                            WHEN (grt2.score::numeric / grt2.max_score) >= 1 THEN '100'
                                            WHEN (grt2.score::numeric / grt2.max_score) >= 0.9 THEN '90-99'
                                            WHEN (grt2.score::numeric / grt2.max_score) >= 0.8 THEN '80-89'
                                            WHEN (grt2.score::numeric / grt2.max_score) >= 0.7 THEN '70-79'
                                            WHEN (grt2.score::numeric / grt2.max_score) >= 0.6 THEN '60-69'
                                            WHEN (grt2.score::numeric / grt2.max_score) >= 0.5 THEN '50-59'
                                            WHEN (grt2.score::numeric / grt2.max_score) > 0 THEN '1-49'
                                            ELSE '0'
                                        END
                                    ELSE '0'
                                END AS score_bucket,
                                COUNT(*) AS bucket_count
                            FROM grader_result_tests grt2
                            INNER JOIN submissions s2 ON s2.id = grt2.submission_id
                            WHERE s2.assignment_id = p_assignment_id
                              AND s2.is_active = true
                              AND grt2.name = grt.name
                              AND (grt2.part = grt.part OR (grt2.part IS NULL AND grt.part IS NULL))
                            GROUP BY score_bucket
                        ) AS distribution
                    )
                ) AS test_stats
                FROM grader_result_tests grt
                INNER JOIN submissions s ON s.id = grt.submission_id
                WHERE s.assignment_id = p_assignment_id
                  AND s.is_active = true
                GROUP BY grt.name, grt.part
            ) AS all_test_stats
        ),
        'overall_score_distribution', (
            SELECT jsonb_object_agg(score_bucket, bucket_count)
            FROM (
                SELECT 
                    CASE 
                        WHEN gr.max_score IS NULL OR gr.max_score = 0 THEN 'no_max'
                        WHEN gr.score IS NULL THEN '0'
                        WHEN (gr.score::numeric / gr.max_score) >= 1 THEN '100'
                        WHEN (gr.score::numeric / gr.max_score) >= 0.9 THEN '90-99'
                        WHEN (gr.score::numeric / gr.max_score) >= 0.8 THEN '80-89'
                        WHEN (gr.score::numeric / gr.max_score) >= 0.7 THEN '70-79'
                        WHEN (gr.score::numeric / gr.max_score) >= 0.6 THEN '60-69'
                        WHEN (gr.score::numeric / gr.max_score) >= 0.5 THEN '50-59'
                        WHEN (gr.score::numeric / gr.max_score) > 0 THEN '1-49'
                        ELSE '0'
                    END AS score_bucket,
                    COUNT(*) AS bucket_count
                FROM grader_results gr
                INNER JOIN submissions s ON s.id = gr.submission_id
                WHERE s.assignment_id = p_assignment_id
                  AND s.is_active = true
                GROUP BY score_bucket
            ) AS distribution
        )
    ) INTO v_result;
    
    RETURN v_result;
END;
$$;

-- ============================================================================
-- Step 2: RPC function to get common errors with deduplication
-- Fixed: Removed error_signature from GROUP BY, using MIN() aggregate instead
-- ============================================================================

CREATE OR REPLACE FUNCTION get_common_test_errors_for_assignment(
    p_assignment_id bigint,
    p_test_name text DEFAULT NULL,
    p_test_part text DEFAULT NULL,
    p_min_occurrences int DEFAULT 2,
    p_limit int DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_class_id bigint;
    v_result jsonb;
BEGIN
    -- Get class_id from assignment
    SELECT class_id INTO v_class_id
    FROM assignments
    WHERE id = p_assignment_id;
    
    IF v_class_id IS NULL THEN
        RAISE EXCEPTION 'Assignment not found';
    END IF;
    
    -- Authorization check: must be instructor or grader
    IF NOT authorizeforclassgrader(v_class_id) THEN
        RAISE EXCEPTION 'Access denied: Only instructors and graders can view common errors';
    END IF;
    
    -- Get common errors grouped by normalized output
    -- Note: error_signature is computed via MIN() aggregate rather than in GROUP BY
    SELECT jsonb_build_object(
        'assignment_id', p_assignment_id,
        'filter', jsonb_build_object(
            'test_name', p_test_name,
            'test_part', p_test_part,
            'min_occurrences', p_min_occurrences
        ),
        'common_errors', (
            SELECT COALESCE(jsonb_agg(error_group ORDER BY (error_group->>'occurrence_count')::int DESC), '[]'::jsonb)
            FROM (
                SELECT jsonb_build_object(
                    'normalized_output', normalized_output,
                    'test_name', test_name,
                    'test_part', test_part,
                    'occurrence_count', occurrence_count,
                    'affected_submission_ids', affected_submission_ids,
                    'sample_outputs', sample_outputs,
                    'avg_score', avg_score,
                    'is_failing', is_failing,
                    'error_signature', error_signature
                ) AS error_group
                FROM (
                    SELECT 
                        -- Normalize output by removing variable parts like timestamps, memory addresses, etc.
                        regexp_replace(
                            regexp_replace(
                                regexp_replace(
                                    regexp_replace(
                                        COALESCE(grt.output, ''),
                                        '0x[0-9a-fA-F]+', '<hex>', 'g'
                                    ),
                                    '\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)?', '<timestamp>', 'g'
                                ),
                                'at line \d+', 'at line <N>', 'g'
                            ),
                            '\b\d{5,}\b', '<num>', 'g'
                        ) AS normalized_output,
                        grt.name AS test_name,
                        grt.part AS test_part,
                        COUNT(*) AS occurrence_count,
                        array_agg(DISTINCT grt.submission_id) AS affected_submission_ids,
                        -- Take first 3 distinct sample outputs
                        (array_agg(DISTINCT grt.output ORDER BY grt.output))[1:3] AS sample_outputs,
                        ROUND(AVG(COALESCE(grt.score, 0))::numeric, 2) AS avg_score,
                        (AVG(COALESCE(grt.score, 0)) < AVG(grt.max_score)) AS is_failing,
                        -- Create a short signature for UI display using MIN() aggregate
                        MIN(
                            CASE 
                                WHEN LENGTH(COALESCE(grt.output, '')) > 100 
                                THEN LEFT(COALESCE(grt.output, ''), 100) || '...'
                                ELSE COALESCE(grt.output, '(no output)')
                            END
                        ) AS error_signature
                    FROM grader_result_tests grt
                    INNER JOIN submissions s ON s.id = grt.submission_id
                    WHERE s.assignment_id = p_assignment_id
                      AND s.is_active = true
                      AND (grt.score < grt.max_score OR grt.score IS NULL OR grt.score = 0)
                      AND (p_test_name IS NULL OR grt.name = p_test_name)
                      AND (p_test_part IS NULL OR grt.part = p_test_part)
                      AND grt.output IS NOT NULL
                      AND grt.output != ''
                    GROUP BY 
                        normalized_output,
                        grt.name,
                        grt.part
                    HAVING COUNT(*) >= p_min_occurrences
                    ORDER BY occurrence_count DESC
                    LIMIT p_limit
                ) AS grouped_errors
            ) AS error_groups
        ),
        'total_error_groups', (
            SELECT COUNT(*)
            FROM (
                SELECT 1
                FROM grader_result_tests grt
                INNER JOIN submissions s ON s.id = grt.submission_id
                WHERE s.assignment_id = p_assignment_id
                  AND s.is_active = true
                  AND (grt.score < grt.max_score OR grt.score IS NULL OR grt.score = 0)
                  AND (p_test_name IS NULL OR grt.name = p_test_name)
                  AND (p_test_part IS NULL OR grt.part = p_test_part)
                  AND grt.output IS NOT NULL
                  AND grt.output != ''
                GROUP BY 
                    regexp_replace(
                        regexp_replace(
                            regexp_replace(
                                regexp_replace(
                                    COALESCE(grt.output, ''),
                                    '0x[0-9a-fA-F]+', '<hex>', 'g'
                                ),
                                '\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)?', '<timestamp>', 'g'
                            ),
                            'at line \d+', 'at line <N>', 'g'
                        ),
                        '\b\d{5,}\b', '<num>', 'g'
                    ),
                    grt.name,
                    grt.part
                HAVING COUNT(*) >= p_min_occurrences
            ) AS counted
        )
    ) INTO v_result;
    
    RETURN v_result;
END;
$$;

-- ============================================================================
-- Step 3: RPC function to get submissions to full marks statistics
-- Fixed: Replaced LATERAL join with separate distribution CTE to avoid row multiplication
-- ============================================================================

CREATE OR REPLACE FUNCTION get_submissions_to_full_marks(p_assignment_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_class_id bigint;
    v_result jsonb;
BEGIN
    -- Get class_id from assignment
    SELECT class_id INTO v_class_id
    FROM assignments
    WHERE id = p_assignment_id;
    
    IF v_class_id IS NULL THEN
        RAISE EXCEPTION 'Assignment not found';
    END IF;
    
    -- Authorization check: must be instructor or grader
    IF NOT authorizeforclassgrader(v_class_id) THEN
        RAISE EXCEPTION 'Access denied: Only instructors and graders can view submission statistics';
    END IF;
    
    -- Get per-test statistics on submissions to reach full marks
    SELECT jsonb_build_object(
        'assignment_id', p_assignment_id,
        'per_test', (
            SELECT COALESCE(jsonb_agg(test_stats ORDER BY test_stats->>'test_name'), '[]'::jsonb)
            FROM (
                WITH test_names AS (
                    SELECT DISTINCT grt.name AS test_name, grt.part AS test_part
                    FROM grader_result_tests grt
                    INNER JOIN submissions s ON s.id = grt.submission_id
                    WHERE s.assignment_id = p_assignment_id
                      AND s.is_active = true
                ),
                student_test_history AS (
                    SELECT 
                        tn.test_name,
                        tn.test_part,
                        s.profile_id,
                        grt.score,
                        grt.max_score,
                        s.ordinal,
                        ROW_NUMBER() OVER (
                            PARTITION BY tn.test_name, tn.test_part, s.profile_id 
                            ORDER BY s.ordinal
                        ) AS attempt_number,
                        CASE WHEN grt.score = grt.max_score THEN true ELSE false END AS is_full_marks
                    FROM test_names tn
                    INNER JOIN submissions s ON s.assignment_id = p_assignment_id AND s.is_active = true
                    INNER JOIN grader_result_tests grt ON grt.submission_id = s.id 
                        AND grt.name = tn.test_name 
                        AND (grt.part = tn.test_part OR (grt.part IS NULL AND tn.test_part IS NULL))
                ),
                first_full_marks AS (
                    SELECT 
                        test_name,
                        test_part,
                        profile_id,
                        MIN(CASE WHEN is_full_marks THEN attempt_number END) AS first_full_marks_attempt
                    FROM student_test_history
                    GROUP BY test_name, test_part, profile_id
                ),
                -- Compute distribution separately to avoid row multiplication
                distribution_by_test AS (
                    SELECT 
                        test_name,
                        test_part,
                        jsonb_object_agg(
                            COALESCE(first_full_marks_attempt::text, 'never'),
                            student_count
                        ) AS distribution
                    FROM (
                        SELECT 
                            test_name,
                            test_part,
                            first_full_marks_attempt,
                            COUNT(*) AS student_count
                        FROM first_full_marks
                        GROUP BY test_name, test_part, first_full_marks_attempt
                    ) AS attempt_counts
                    GROUP BY test_name, test_part
                )
                SELECT jsonb_build_object(
                    'test_name', ffm.test_name,
                    'test_part', ffm.test_part,
                    'students_with_full_marks', COUNT(*) FILTER (WHERE first_full_marks_attempt IS NOT NULL),
                    'students_without_full_marks', COUNT(*) FILTER (WHERE first_full_marks_attempt IS NULL),
                    'avg_submissions_to_full_marks', ROUND(AVG(first_full_marks_attempt)::numeric, 2),
                    'median_submissions_to_full_marks', PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_full_marks_attempt),
                    'max_submissions_to_full_marks', MAX(first_full_marks_attempt),
                    'distribution', dbt.distribution
                ) AS test_stats
                FROM first_full_marks ffm
                LEFT JOIN distribution_by_test dbt 
                    ON dbt.test_name = ffm.test_name 
                    AND (dbt.test_part = ffm.test_part OR (dbt.test_part IS NULL AND ffm.test_part IS NULL))
                GROUP BY ffm.test_name, ffm.test_part, dbt.distribution
            ) AS all_test_stats
        ),
        'overall', (
            WITH student_submission_history AS (
                SELECT 
                    s.profile_id,
                    s.ordinal,
                    gr.score,
                    gr.max_score,
                    CASE WHEN gr.score = gr.max_score THEN true ELSE false END AS is_full_marks
                FROM submissions s
                INNER JOIN grader_results gr ON gr.submission_id = s.id
                WHERE s.assignment_id = p_assignment_id
                  AND s.is_active = true
            ),
            first_full_marks AS (
                SELECT 
                    profile_id,
                    MIN(CASE WHEN is_full_marks THEN ordinal END) AS first_full_marks_ordinal
                FROM student_submission_history
                GROUP BY profile_id
            )
            SELECT jsonb_build_object(
                'students_with_full_marks', COUNT(*) FILTER (WHERE first_full_marks_ordinal IS NOT NULL),
                'students_without_full_marks', COUNT(*) FILTER (WHERE first_full_marks_ordinal IS NULL),
                'avg_submissions_to_full_marks', ROUND(AVG(first_full_marks_ordinal)::numeric, 2),
                'median_submissions_to_full_marks', PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_full_marks_ordinal)
            )
            FROM first_full_marks
        )
    ) INTO v_result;
    
    RETURN v_result;
END;
$$;

-- ============================================================================
-- Step 4: RPC function to get error pins that match a specific error pattern
-- Fixed: Use safe_regex_match helper to handle invalid regex patterns gracefully
-- ============================================================================

CREATE OR REPLACE FUNCTION get_error_pins_for_error_pattern(
    p_assignment_id bigint,
    p_test_name text,
    p_error_output text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_class_id bigint;
    v_result jsonb;
BEGIN
    -- Get class_id from assignment
    SELECT class_id INTO v_class_id
    FROM assignments
    WHERE id = p_assignment_id;
    
    IF v_class_id IS NULL THEN
        RAISE EXCEPTION 'Assignment not found';
    END IF;
    
    -- Authorization check: must be instructor or grader
    IF NOT authorizeforclassgrader(v_class_id) THEN
        RAISE EXCEPTION 'Access denied: Only instructors and graders can view error pins';
    END IF;
    
    -- Find error pins that would match this error pattern
    -- Uses safe_regex_match to handle invalid regex patterns gracefully
    SELECT jsonb_build_object(
        'matching_pins', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'error_pin_id', ep.id,
                    'discussion_thread_id', ep.discussion_thread_id,
                    'enabled', ep.enabled,
                    'rule_logic', ep.rule_logic,
                    'thread_subject', dt.subject,
                    'match_count', (
                        SELECT COUNT(*) 
                        FROM error_pin_submission_matches epsm 
                        WHERE epsm.error_pin_id = ep.id
                    )
                )
            ), '[]'::jsonb)
            FROM error_pins ep
            INNER JOIN discussion_threads dt ON dt.id = ep.discussion_thread_id
            WHERE ep.assignment_id = p_assignment_id
              AND ep.enabled = true
              AND (
                (ep.rule_logic = 'or' AND EXISTS (
                  SELECT 1 FROM error_pin_rules epr
                  WHERE epr.error_pin_id = ep.id
                    AND (
                      (epr.target = 'test_name' AND 
                        CASE epr.match_type 
                          WHEN 'contains' THEN p_test_name ILIKE '%' || epr.match_value || '%'
                          WHEN 'equals' THEN p_test_name = epr.match_value
                          WHEN 'regex' THEN safe_regex_match(p_test_name, epr.match_value)
                          ELSE false
                        END
                      )
                      OR
                      (epr.target = 'test_output' AND 
                        CASE epr.match_type 
                          WHEN 'contains' THEN p_error_output ILIKE '%' || epr.match_value || '%'
                          WHEN 'equals' THEN p_error_output = epr.match_value
                          WHEN 'regex' THEN safe_regex_match(p_error_output, epr.match_value)
                          ELSE false
                        END
                      )
                    )
                ))
                OR
                (ep.rule_logic = 'and' AND NOT EXISTS (
                  SELECT 1 FROM error_pin_rules epr
                  WHERE epr.error_pin_id = ep.id
                    AND NOT (
                      (epr.target = 'test_name' AND 
                        CASE epr.match_type 
                          WHEN 'contains' THEN p_test_name ILIKE '%' || epr.match_value || '%'
                          WHEN 'equals' THEN p_test_name = epr.match_value
                          WHEN 'regex' THEN safe_regex_match(p_test_name, epr.match_value)
                          ELSE false
                        END
                      )
                      OR
                      (epr.target = 'test_output' AND 
                        CASE epr.match_type 
                          WHEN 'contains' THEN p_error_output ILIKE '%' || epr.match_value || '%'
                          WHEN 'equals' THEN p_error_output = epr.match_value
                          WHEN 'regex' THEN safe_regex_match(p_error_output, epr.match_value)
                          ELSE false
                        END
                      )
                    )
                ))
              )
        )
    ) INTO v_result;
    
    RETURN v_result;
END;
$$;

-- ============================================================================
-- Step 5: Grant permissions
-- ============================================================================

GRANT EXECUTE ON FUNCTION safe_regex_match(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_test_statistics_for_assignment(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION get_common_test_errors_for_assignment(bigint, text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION get_submissions_to_full_marks(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION get_error_pins_for_error_pattern(bigint, text, text) TO authenticated;
