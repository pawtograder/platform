-- Migration: Rubric check application statistics for the instructor assignment dashboard.
--
-- Provides get_rubric_check_application_stats(assignment, filter, review_round): for each
-- rubric check in the assignment's rubric, how many submissions in a (filterable) cohort had
-- that check applied, plus per-option counts for choice checks.
--
-- SECURITY / SQL-INJECTION DESIGN:
--   The instructor-supplied filter is a typed JSON boolean tree (AND/OR/NOT over a CLOSED set
--   of leaf predicates). It is (1) validated against that closed set by _validate_rubric_report_filter
--   and (2) INTERPRETED by _eval_rubric_report_filter — there is NO dynamic SQL anywhere. Every value
--   from the filter is compared using typed operators/casts (text equality, numeric >=, = ANY(...)),
--   so no instructor input can ever reach the SQL parser. Depth and fan-out are capped to bound work.

-- ---------------------------------------------------------------------------
-- Validate the filter AST against a closed predicate set. Raises on anything unexpected.
-- Pure (no table access); not granted to clients.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._validate_rubric_report_filter(p_node jsonb, p_depth integer)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO ''
AS $$
DECLARE
  v_op text;
  v_args jsonb;
  v_arg jsonb;
BEGIN
  IF p_node IS NULL THEN
    RETURN;
  END IF;
  IF p_depth > 25 THEN
    RAISE EXCEPTION 'Filter nesting too deep' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(p_node) <> 'object' THEN
    RAISE EXCEPTION 'Filter node must be an object' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Boolean node: { "op": "and"|"or"|"not", "args": [...] }
  IF p_node ? 'op' THEN
    v_op := p_node ->> 'op';
    IF v_op NOT IN ('and', 'or', 'not') THEN
      RAISE EXCEPTION 'Invalid filter op: %', v_op USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_args := p_node -> 'args';
    IF v_args IS NULL OR jsonb_typeof(v_args) <> 'array' THEN
      RAISE EXCEPTION 'Filter op requires an args array' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF jsonb_array_length(v_args) > 50 THEN
      RAISE EXCEPTION 'Too many filter args' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_op = 'not' AND jsonb_array_length(v_args) <> 1 THEN
      RAISE EXCEPTION 'not requires exactly one arg' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    FOR v_arg IN SELECT * FROM jsonb_array_elements(v_args) LOOP
      PERFORM public._validate_rubric_report_filter(v_arg, p_depth + 1);
    END LOOP;
    RETURN;
  END IF;

  -- Leaf predicate: exactly one recognized key with the correct value type.
  IF p_node ? 'checkApplied' THEN
    IF jsonb_typeof(p_node -> 'checkApplied') <> 'number' THEN
      RAISE EXCEPTION 'checkApplied must be a number' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_node ? 'optionSelected' THEN
    IF jsonb_typeof(p_node -> 'optionSelected') <> 'object'
       OR jsonb_typeof(p_node -> 'optionSelected' -> 'checkId') <> 'number'
       OR jsonb_typeof(p_node -> 'optionSelected' -> 'optionIndex') <> 'number' THEN
      RAISE EXCEPTION 'optionSelected requires numeric checkId and optionIndex' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_node ? 'section' THEN
    IF jsonb_typeof(p_node -> 'section') <> 'string' THEN
      RAISE EXCEPTION 'section must be a string' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_node ? 'lab' THEN
    IF jsonb_typeof(p_node -> 'lab') <> 'string' THEN
      RAISE EXCEPTION 'lab must be a string' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_node ? 'scoreAtLeast' THEN
    IF jsonb_typeof(p_node -> 'scoreAtLeast') <> 'number' THEN
      RAISE EXCEPTION 'scoreAtLeast must be a number' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_node ? 'scoreAtMost' THEN
    IF jsonb_typeof(p_node -> 'scoreAtMost') <> 'number' THEN
      RAISE EXCEPTION 'scoreAtMost must be a number' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown filter predicate' USING ERRCODE = 'invalid_parameter_value';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Interpret the (already-validated) filter AST against one submission's precomputed facts.
-- Pure; no dynamic SQL. Returns whether the submission is in the cohort.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._eval_rubric_report_filter(
  p_node jsonb,
  p_check_ids bigint[],
  p_option_keys text[],
  p_class_section text,
  p_lab_section text,
  p_total_score numeric
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO ''
AS $$
DECLARE
  v_op text;
  v_arg jsonb;
BEGIN
  IF p_node IS NULL THEN
    RETURN true;
  END IF;

  IF p_node ? 'op' THEN
    v_op := p_node ->> 'op';
    IF v_op = 'and' THEN
      FOR v_arg IN SELECT * FROM jsonb_array_elements(COALESCE(p_node -> 'args', '[]'::jsonb)) LOOP
        IF NOT public._eval_rubric_report_filter(v_arg, p_check_ids, p_option_keys, p_class_section, p_lab_section, p_total_score) THEN
          RETURN false;
        END IF;
      END LOOP;
      RETURN true;
    ELSIF v_op = 'or' THEN
      FOR v_arg IN SELECT * FROM jsonb_array_elements(COALESCE(p_node -> 'args', '[]'::jsonb)) LOOP
        IF public._eval_rubric_report_filter(v_arg, p_check_ids, p_option_keys, p_class_section, p_lab_section, p_total_score) THEN
          RETURN true;
        END IF;
      END LOOP;
      RETURN false;
    ELSE
      -- 'not' (validation guarantees a single arg)
      RETURN NOT public._eval_rubric_report_filter(p_node -> 'args' -> 0, p_check_ids, p_option_keys, p_class_section, p_lab_section, p_total_score);
    END IF;
  END IF;

  IF p_node ? 'checkApplied' THEN
    RETURN (p_node ->> 'checkApplied')::bigint = ANY (p_check_ids);
  ELSIF p_node ? 'optionSelected' THEN
    RETURN ((p_node -> 'optionSelected' ->> 'checkId') || ':' || (p_node -> 'optionSelected' ->> 'optionIndex')) = ANY (p_option_keys);
  ELSIF p_node ? 'section' THEN
    RETURN p_class_section IS NOT DISTINCT FROM (p_node ->> 'section');
  ELSIF p_node ? 'lab' THEN
    RETURN p_lab_section IS NOT DISTINCT FROM (p_node ->> 'lab');
  ELSIF p_node ? 'scoreAtLeast' THEN
    RETURN p_total_score IS NOT NULL AND p_total_score >= (p_node ->> 'scoreAtLeast')::numeric;
  ELSIF p_node ? 'scoreAtMost' THEN
    RETURN p_total_score IS NOT NULL AND p_total_score <= (p_node ->> 'scoreAtMost')::numeric;
  ELSE
    RETURN false;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Core aggregation (no authorization). Returns:
--   { "cohort_total": <int>, "checks": [ { "rubric_check_id", "applied_count", "options":[{option_index,count}] } ] }
-- Cohort unit = one row per student with an active submission (matches the dashboard's score stats);
-- for group submissions every member row shares the group's applied checks.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._rubric_check_application_stats(
  p_assignment_id bigint,
  p_rubric_id bigint,
  p_filter jsonb
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
WITH checks AS (
  -- rubric_checks has a direct rubric_id index, so we don't need to join rubric_criteria.
  SELECT rc.id, rc.is_annotation, rc.data
  FROM public.rubric_checks rc
  WHERE rc.rubric_id = p_rubric_id
),
cohort_rows AS (
  SELECT v.id AS row_id,
         v.activesubmissionid AS submission_id,
         v.class_section_name,
         v.lab_section_name,
         v.total_score
  FROM public.submissions_with_grades_for_assignment_nice v
  WHERE v.assignment_id = p_assignment_id
    AND v.activesubmissionid IS NOT NULL
),
-- Review ids for the REQUESTED rubric (i.e. the resolved review round) on the cohort's
-- active submissions. Keyed off the rubric rather than submissions.grading_review_id so the
-- function is correct for any review round, not just grading-review. Scoping the (BIG) comment
-- tables to these reviews + this rubric's checks lets the planner use the partial index
-- (submission_review_id, rubric_check_id, deleted_at) instead of a full scan.
cohort_reviews AS (
  SELECT sr.id AS review_id
  FROM public.submission_reviews sr
  WHERE sr.submission_id IN (SELECT DISTINCT submission_id FROM cohort_rows)
    AND sr.rubric_id = p_rubric_id
),
raw_comments AS (
  SELECT sc.submission_id, sc.rubric_check_id, sc.points
  FROM public.submission_comments sc
  WHERE sc.submission_review_id IN (SELECT review_id FROM cohort_reviews)
    AND sc.deleted_at IS NULL
    AND sc.rubric_check_id IN (SELECT id FROM checks)
  UNION ALL
  SELECT sfc.submission_id, sfc.rubric_check_id, sfc.points
  FROM public.submission_file_comments sfc
  WHERE sfc.submission_review_id IN (SELECT review_id FROM cohort_reviews)
    AND sfc.deleted_at IS NULL
    AND sfc.rubric_check_id IN (SELECT id FROM checks)
  UNION ALL
  SELECT sac.submission_id, sac.rubric_check_id, sac.points
  FROM public.submission_artifact_comments sac
  WHERE sac.submission_review_id IN (SELECT review_id FROM cohort_reviews)
    AND sac.deleted_at IS NULL
    AND sac.rubric_check_id IN (SELECT id FROM checks)
),
applied_detail AS (
  SELECT comments.submission_id,
         comments.rubric_check_id,
         opt.option_index
  FROM raw_comments comments
  JOIN checks c ON c.id = comments.rubric_check_id
  LEFT JOIN LATERAL (
    SELECT (o.ord - 1)::int AS option_index
    FROM jsonb_array_elements(c.data -> 'options') WITH ORDINALITY AS o(elem, ord)
    WHERE c.is_annotation = false
      AND jsonb_typeof(c.data -> 'options') = 'array'
      AND comments.points IS NOT NULL
      AND (o.elem ->> 'points') IS NOT NULL
      AND (o.elem ->> 'points')::numeric = comments.points
    ORDER BY o.ord
    LIMIT 1
  ) opt ON true
),
per_submission AS (
  SELECT submission_id,
         array_agg(DISTINCT rubric_check_id) AS check_ids,
         array_remove(
           array_agg(DISTINCT CASE WHEN option_index IS NOT NULL
                                   THEN rubric_check_id::text || ':' || option_index::text END),
           NULL
         ) AS option_keys
  FROM applied_detail
  GROUP BY submission_id
),
facts AS (
  SELECT cr.row_id,
         cr.class_section_name,
         cr.lab_section_name,
         cr.total_score,
         COALESCE(ps.check_ids, ARRAY[]::bigint[]) AS check_ids,
         COALESCE(ps.option_keys, ARRAY[]::text[]) AS option_keys
  FROM cohort_rows cr
  LEFT JOIN per_submission ps ON ps.submission_id = cr.submission_id
),
cohort AS (
  SELECT *
  FROM facts f
  WHERE p_filter IS NULL
     OR public._eval_rubric_report_filter(p_filter, f.check_ids, f.option_keys, f.class_section_name, f.lab_section_name, f.total_score)
),
check_counts AS (
  SELECT u.check_id, COUNT(*)::bigint AS applied_count
  FROM cohort, LATERAL unnest(cohort.check_ids) AS u(check_id)
  GROUP BY u.check_id
),
option_counts AS (
  SELECT split_part(k.key, ':', 1)::bigint AS check_id,
         split_part(k.key, ':', 2)::int AS option_index,
         COUNT(*)::bigint AS cnt
  FROM cohort, LATERAL unnest(cohort.option_keys) AS k(key)
  GROUP BY 1, 2
),
options_by_check AS (
  SELECT check_id,
         jsonb_agg(jsonb_build_object('option_index', option_index, 'count', cnt) ORDER BY option_index) AS options
  FROM option_counts
  GROUP BY check_id
)
SELECT jsonb_build_object(
  'cohort_total', (SELECT COUNT(*) FROM cohort),
  'checks', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'rubric_check_id', c.id,
        'applied_count', COALESCE(cc.applied_count, 0),
        'options', COALESCE(ob.options, '[]'::jsonb)
      ) ORDER BY c.id
    )
    FROM checks c
    LEFT JOIN check_counts cc ON cc.check_id = c.id
    LEFT JOIN options_by_check ob ON ob.check_id = c.id
  ), '[]'::jsonb)
);
$$;

-- ---------------------------------------------------------------------------
-- Public RPC: authorize the caller as an instructor, validate the filter, resolve the
-- assignment's rubric for the requested review round, then aggregate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_rubric_check_application_stats(
  p_assignment_id bigint,
  p_filter jsonb DEFAULT NULL,
  p_review_round text DEFAULT 'grading-review'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_class_id bigint;
  v_rubric_id bigint;
BEGIN
  SELECT a.class_id INTO v_class_id FROM public.assignments a WHERE a.id = p_assignment_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Assignment % does not exist', p_assignment_id USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Authorize: caller must be an instructor for this class. Inlined against user_privileges
  -- (rather than calling authorizeforclassinstructor) so the planner can use the
  -- (user_id, class_id, role) index and we avoid a nested SECURITY DEFINER call.
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.class_id = v_class_id
      AND up.user_id = auth.uid()
      AND up.role = 'instructor'::public.app_role
  ) THEN
    RAISE EXCEPTION 'Access denied: insufficient permissions for assignment %', p_assignment_id USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM public._validate_rubric_report_filter(p_filter, 0);

  SELECT r.id INTO v_rubric_id
  FROM public.rubrics r
  WHERE r.assignment_id = p_assignment_id
    AND r.review_round = p_review_round::public.review_round
  ORDER BY r.id
  LIMIT 1;

  IF v_rubric_id IS NULL THEN
    RETURN jsonb_build_object('cohort_total', 0, 'checks', '[]'::jsonb);
  END IF;

  RETURN public._rubric_check_application_stats(p_assignment_id, v_rubric_id, p_filter);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._validate_rubric_report_filter(jsonb, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._eval_rubric_report_filter(jsonb, bigint[], text[], text, text, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._rubric_check_application_stats(bigint, bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rubric_check_application_stats(bigint, jsonb, text) TO authenticated;

COMMENT ON FUNCTION public.get_rubric_check_application_stats(bigint, jsonb, text) IS
'Instructor-only. Returns, for each rubric check of an assignment''s rubric (default grading-review round), the count of cohort submissions that had the check applied (and per-option counts for choice checks), plus cohort_total. The optional p_filter is a typed JSON boolean tree (and/or/not over checkApplied/optionSelected/section/lab/scoreAtLeast/scoreAtMost) that is validated and interpreted (never compiled to SQL) to define the cohort.';
