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

  -- Single UPDATE with deterministic deduplication using DISTINCT ON
  WITH parsed_with_ordinality AS (
    SELECT
      (col_elem->>'gradebook_column_id')::bigint AS gradebook_column_id,
      (entry_elem->>'student_id')::uuid AS student_id,
      CASE
        WHEN entry_elem ? 'score' THEN NULLIF(entry_elem->>'score','')::numeric
        WHEN entry_elem ? 'value' THEN NULLIF(entry_elem->>'value','')::numeric
        ELSE NULL
      END AS new_score,
      col_ordinality * 1000 + entry_ordinality AS ordinality
    FROM jsonb_array_elements(p_updates) WITH ORDINALITY AS col_elem(col_elem, col_ordinality)
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(col_elem->'entries', col_elem->'student_scores', '[]'::jsonb)
    ) WITH ORDINALITY AS entry_elem(entry_elem, entry_ordinality)
  ), parsed AS (
    SELECT DISTINCT ON (gradebook_column_id, student_id)
      gradebook_column_id,
      student_id,
      new_score
    FROM parsed_with_ordinality
    ORDER BY gradebook_column_id, student_id, ordinality DESC
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
  SET 
    score = CASE 
      WHEN c.score_expression IS NULL THEN p.new_score 
      ELSE g.score 
    END,
    score_override = CASE 
      WHEN c.score_expression IS NOT NULL THEN p.new_score 
      ELSE g.score_override 
    END
  FROM target_rows tr
  JOIN cols c ON c.id = tr.gradebook_column_id
  JOIN parsed p ON p.gradebook_column_id = tr.gradebook_column_id AND p.student_id = tr.student_id
  WHERE g.id = tr.id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.import_gradebook_scores(bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_gradebook_scores(bigint, jsonb) TO authenticated;

COMMENT ON FUNCTION public.import_gradebook_scores(bigint, jsonb) IS
'Bulk-imports scores into gradebook_column_students (private rows) for the given class. 
Validates instructor permissions and that gradebook columns belong to the class. 
Updates score_override when the column has a score_expression, otherwise updates score directly.';


