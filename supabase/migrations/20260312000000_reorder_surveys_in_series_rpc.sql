-- RPC to atomically reorder surveys within a series.
-- SECURITY INVOKER so RLS applies and caller permissions are honored.

CREATE OR REPLACE FUNCTION public.reorder_surveys_in_series(
  p_series_id uuid,
  p_ordinal_updates jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_class_id bigint;
  v_updated_count integer;
  v_series_survey_count integer;
  v_payload_count integer;
  v_ordinal_min integer;
  v_ordinal_max integer;
  v_ordinal_distinct_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Resolve series and verify caller is instructor for the class
  SELECT class_id INTO v_class_id
  FROM public.survey_series
  WHERE id = p_series_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Survey series not found';
  END IF;

  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'Permission denied: only instructors can reorder surveys in a series';
  END IF;

  -- Reject duplicate IDs in payload
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT (elem->>'id')::uuid AS id
      FROM jsonb_array_elements(p_ordinal_updates) AS elem
    ) t
    GROUP BY id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate survey IDs in ordinal updates';
  END IF;

  -- Payload must cover every non-deleted survey in the series
  SELECT COUNT(*)::integer INTO v_series_survey_count
  FROM public.surveys
  WHERE series_id = p_series_id AND deleted_at IS NULL;

  v_payload_count := COALESCE(jsonb_array_length(p_ordinal_updates), 0);

  IF v_series_survey_count != v_payload_count THEN
    RAISE EXCEPTION 'Payload count (%) does not match series survey count (%)', v_payload_count, v_series_survey_count;
  END IF;

  -- Ordinals must form a strict permutation 1..N (no gaps, no duplicates)
  IF v_payload_count > 0 THEN
    SELECT
      MIN((elem->>'series_ordinal')::integer),
      MAX((elem->>'series_ordinal')::integer),
      COUNT(DISTINCT (elem->>'series_ordinal')::integer)
    INTO v_ordinal_min, v_ordinal_max, v_ordinal_distinct_count
    FROM jsonb_array_elements(p_ordinal_updates) AS elem;

    IF v_ordinal_min IS NULL OR v_ordinal_max IS NULL OR
       v_ordinal_min != 1 OR v_ordinal_max != v_payload_count OR
       v_ordinal_distinct_count != v_payload_count THEN
      RAISE EXCEPTION 'Ordinals must form a strict permutation 1..% with no gaps or duplicates', v_payload_count;
    END IF;
  END IF;

  -- Single atomic UPDATE: only affects surveys in this series; RLS further restricts
  WITH updates AS (
    SELECT
      (elem->>'id')::uuid AS id,
      (elem->>'series_ordinal')::integer AS series_ordinal
    FROM jsonb_array_elements(p_ordinal_updates) AS elem
  )
  UPDATE public.surveys s
  SET series_ordinal = u.series_ordinal
  FROM updates u
  WHERE s.id = u.id
    AND s.series_id = p_series_id
    AND s.deleted_at IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count != jsonb_array_length(p_ordinal_updates) THEN
    RAISE EXCEPTION 'Partial update: expected % rows updated, got %', jsonb_array_length(p_ordinal_updates), v_updated_count;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.reorder_surveys_in_series(uuid, jsonb) IS
'Atomically update series_ordinal for multiple surveys in a series. p_ordinal_updates
must be a JSON array of {id: uuid, series_ordinal: integer}. All surveys must belong
to p_series_id. Requires instructor access for the series class.';

GRANT EXECUTE ON FUNCTION public.reorder_surveys_in_series(uuid, jsonb) TO authenticated;
