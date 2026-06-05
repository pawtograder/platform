-- Migration: rubric report cohort members.
--
-- get_rubric_report_cohort_members(assignment, filter, review_round) returns the set of view
-- row ids (submissions_with_grades_for_assignment_nice.id = user_role id) whose submission matches
-- the rubric report filter. The instructor dashboard uses this to filter the submissions table to
-- the same cohort the rubric breakdown describes (whole composed filter, or a single drilled-in check).
--
-- Reuses the injection-safe _validate_rubric_report_filter / _eval_rubric_report_filter from
-- 20260603160000 — the filter is validated + interpreted, never compiled to SQL.

-- Internal (no auth): the cohort row ids matching the filter for a given rubric.
CREATE OR REPLACE FUNCTION public._rubric_report_cohort_member_ids(
  p_assignment_id bigint,
  p_rubric_id bigint,
  p_filter jsonb
)
RETURNS bigint[]
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
WITH checks AS (
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
)
SELECT COALESCE(array_agg(f.row_id), ARRAY[]::bigint[])
FROM facts f
WHERE p_filter IS NULL
   OR public._eval_rubric_report_filter(p_filter, f.check_ids, f.option_keys, f.class_section_name, f.lab_section_name, f.total_score);
$$;

-- Public RPC: instructor-only, validates the filter, resolves the rubric, returns member ids.
CREATE OR REPLACE FUNCTION public.get_rubric_report_cohort_members(
  p_assignment_id bigint,
  p_filter jsonb DEFAULT NULL,
  p_review_round text DEFAULT 'grading-review'
)
RETURNS bigint[]
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
    RETURN ARRAY[]::bigint[];
  END IF;

  RETURN public._rubric_report_cohort_member_ids(p_assignment_id, v_rubric_id, p_filter);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._rubric_report_cohort_member_ids(bigint, bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rubric_report_cohort_members(bigint, jsonb, text) TO authenticated;

COMMENT ON FUNCTION public.get_rubric_report_cohort_members(bigint, jsonb, text) IS
'Instructor-only. Returns the submissions_with_grades_for_assignment_nice row ids (user_role ids) whose submission matches the given rubric report filter (validated + interpreted, never compiled to SQL). Used to filter the submissions table to the rubric breakdown cohort.';
