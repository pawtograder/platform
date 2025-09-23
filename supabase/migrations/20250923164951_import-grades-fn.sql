-- Bulk import of gradebook scores for multiple columns/students in one call
-- Accepts a JSONB payload describing scores to set. Performs authorization
-- and validation that gradebook columns belong to the provided class.
-- Updates private rows in public.gradebook_column_students only.

-- Payload shape (JSONB array):
-- [
--   {
--     "gradebook_column_id": 123,
--     "entries": [
--       { "student_id": "<uuid>", "score": 9.5 },
--       { "student_id": "<uuid>", "score": null }
--     ]
--   },
--   ...
-- ]

CREATE OR REPLACE FUNCTION public.import_gradebook_scores(
  p_class_id bigint,
  p_updates jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invalid_column_id bigint;
BEGIN
  -- Authorization: only instructors for the class may import
  IF NOT public.authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'Access denied: Only instructors can import grades for class %', p_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Basic shape validation
  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
    RAISE EXCEPTION 'p_updates must be a JSON array of column update objects'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Validate that all referenced columns exist and belong to this class
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT (elem->>'gradebook_column_id')::bigint AS gradebook_column_id
      FROM jsonb_array_elements(p_updates) AS elem
    ) pc
    LEFT JOIN public.gradebook_columns gc ON gc.id = pc.gradebook_column_id
    WHERE gc.id IS NULL OR gc.class_id <> p_class_id
  ) THEN
    SELECT pc.gradebook_column_id INTO v_invalid_column_id
    FROM (
      SELECT DISTINCT (elem->>'gradebook_column_id')::bigint AS gradebook_column_id
      FROM jsonb_array_elements(p_updates) AS elem
    ) pc
    LEFT JOIN public.gradebook_columns gc ON gc.id = pc.gradebook_column_id
    WHERE gc.id IS NULL OR gc.class_id <> p_class_id
    LIMIT 1;

    RAISE EXCEPTION 'Invalid gradebook_column_id % for class %', v_invalid_column_id, p_class_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Update score_override for computed columns
  WITH parsed AS (
    SELECT
      (col_elem->>'gradebook_column_id')::bigint AS gradebook_column_id,
      (entry_elem->>'student_id')::uuid AS student_id,
      CASE
        WHEN entry_elem ? 'score' THEN NULLIF(entry_elem->>'score','')::numeric
        WHEN entry_elem ? 'value' THEN NULLIF(entry_elem->>'value','')::numeric
        ELSE NULL
      END AS new_score
    FROM jsonb_array_elements(p_updates) AS col_elem
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(col_elem->'entries', col_elem->'student_scores', '[]'::jsonb)
    ) AS entry_elem
  ), target_rows AS (
    SELECT gcs.id, gcs.gradebook_column_id, gcs.student_id
    FROM parsed p
    JOIN public.gradebook_column_students gcs
      ON gcs.gradebook_column_id = p.gradebook_column_id
     AND gcs.student_id = p.student_id
     AND gcs.class_id = p_class_id
     AND gcs.is_private = true
  ), cols AS (
    SELECT id, score_expression
    FROM public.gradebook_columns
    WHERE class_id = p_class_id
      AND id IN (SELECT DISTINCT gradebook_column_id FROM parsed)
  )
  UPDATE public.gradebook_column_students g
  SET score_override = p.new_score
  FROM target_rows tr
  JOIN cols c ON c.id = tr.gradebook_column_id AND c.score_expression IS NOT NULL
  JOIN parsed p ON p.gradebook_column_id = tr.gradebook_column_id AND p.student_id = tr.student_id
  WHERE g.id = tr.id;

  -- Update score for non-computed columns
  WITH parsed AS (
    SELECT
      (col_elem->>'gradebook_column_id')::bigint AS gradebook_column_id,
      (entry_elem->>'student_id')::uuid AS student_id,
      CASE
        WHEN entry_elem ? 'score' THEN NULLIF(entry_elem->>'score','')::numeric
        WHEN entry_elem ? 'value' THEN NULLIF(entry_elem->>'value','')::numeric
        ELSE NULL
      END AS new_score
    FROM jsonb_array_elements(p_updates) AS col_elem
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(col_elem->'entries', col_elem->'student_scores', '[]'::jsonb)
    ) AS entry_elem
  ), target_rows AS (
    SELECT gcs.id, gcs.gradebook_column_id, gcs.student_id
    FROM parsed p
    JOIN public.gradebook_column_students gcs
      ON gcs.gradebook_column_id = p.gradebook_column_id
     AND gcs.student_id = p.student_id
     AND gcs.class_id = p_class_id
     AND gcs.is_private = true
  ), cols AS (
    SELECT id, score_expression
    FROM public.gradebook_columns
    WHERE class_id = p_class_id
      AND id IN (SELECT DISTINCT gradebook_column_id FROM parsed)
  )
  UPDATE public.gradebook_column_students g
  SET score = p.new_score
  FROM target_rows tr
  JOIN cols c ON c.id = tr.gradebook_column_id AND c.score_expression IS NULL
  JOIN parsed p ON p.gradebook_column_id = tr.gradebook_column_id AND p.student_id = tr.student_id
  WHERE g.id = tr.id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.import_gradebook_scores(bigint, jsonb) TO authenticated;

COMMENT ON FUNCTION public.import_gradebook_scores(bigint, jsonb) IS
'Bulk-imports scores into gradebook_column_students (private rows) for the given class. 
Validates instructor permissions and that gradebook columns belong to the class. 
Updates score_override when the column has a score_expression, otherwise updates score directly.';


