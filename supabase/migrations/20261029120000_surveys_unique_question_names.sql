-- Refuse to publish a survey in which two questions share a name (#1005).
--
-- SurveyJS saves each answer under its question's `name`, so two questions with the same name
-- share one answer: answering the second clears the first, a required question can be left
-- empty while the survey still completes, and the response shows one value in both places.
-- The builder and the instructor form already refuse to publish such a survey
-- (components/survey/questionNames.ts). This is the same rule for every other writer: the
-- surveys table's Publish menu, the CLI's `surveys copy` and `assignments copy`, and any
-- direct API call.
--
-- When it fires: on INSERT of a published row, on UPDATE that makes a row published, and on
-- UPDATE that changes the questions (`json`) of a published row. It does NOT fire when other
-- columns of an already-published row change. Surveys published with duplicate names before
-- this migration exist, and instructors still need to close them, move their dates or change
-- their settings; refusing those updates would strand them. Closing (status -> 'closed') never
-- fires, and neither do drafts, so an instructor can save work in progress and fix it later.
--
-- Scopes match SurveyJS's data model, and the walk matches findDuplicateQuestionNames in
-- components/survey/questionNames.ts:
--   * questions on every page and inside panels share the survey's scope;
--   * each dynamic panel's templateElements are a scope of their own (their answers are stored
--     per panel, inside the dynamic panel's value);
--   * a panel's own name holds no answer and is not counted;
--   * names are compared after trimming whitespace, as SurveyJS trims them on load.
--
-- Rollback: DROP TRIGGER IF EXISTS surveys_reject_duplicate_question_names ON public.surveys;

-- `json` is jsonb, but the instructor form writes the definition as a JSON string, so most rows
-- hold a jsonb string whose text is the survey. Unwrap it (twice at most) into the object.
-- Returns NULL for anything that is not an object once unwrapped; malformed JSON is the form's
-- concern, not this check's.
CREATE OR REPLACE FUNCTION public.survey_json_unwrapped(p_json jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v jsonb := p_json;
BEGIN
  FOR i IN 1..2 LOOP
    EXIT WHEN v IS NULL OR jsonb_typeof(v) <> 'string';
    BEGIN
      v := (v #>> '{}')::jsonb;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
  END LOOP;
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN
    RETURN NULL;
  END IF;
  RETURN v;
END;
$$;

-- Every question name in a list of SurveyJS elements, with the scope it is stored in.
-- p_scope names the answer scope; p_path is the element's position, unique per element, and
-- becomes the scope of a dynamic panel's template.
CREATE OR REPLACE FUNCTION public.survey_question_name_entries(p_elements jsonb, p_scope text, p_path text)
RETURNS TABLE (scope text, name text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_el jsonb;
  v_idx bigint;
  v_type text;
  v_name text;
  v_children jsonb;
  v_template jsonb;
BEGIN
  IF p_elements IS NULL OR jsonb_typeof(p_elements) <> 'array' THEN
    RETURN;
  END IF;

  FOR v_el, v_idx IN SELECT e.value, e.ordinality FROM jsonb_array_elements(p_elements) WITH ORDINALITY AS e LOOP
    CONTINUE WHEN jsonb_typeof(v_el) <> 'object';
    v_type := lower(coalesce(v_el ->> 'type', ''));

    -- A panel, or anything else that only groups elements, holds no answer of its own.
    IF v_type = 'panel' OR (jsonb_typeof(v_el -> 'elements') = 'array' AND v_type <> 'paneldynamic') THEN
      v_children := CASE
        WHEN jsonb_typeof(v_el -> 'elements') = 'array' THEN v_el -> 'elements'
        ELSE v_el -> 'questions'
      END;
      RETURN QUERY SELECT * FROM public.survey_question_name_entries(v_children, p_scope, p_path || '/' || v_idx);
      CONTINUE;
    END IF;

    v_name := CASE jsonb_typeof(v_el -> 'name')
      WHEN 'string' THEN btrim(v_el ->> 'name', E' \t\n\r\f\v')
      WHEN 'number' THEN v_el ->> 'name'
      ELSE NULL
    END;
    IF v_name IS NOT NULL AND v_name <> '' THEN
      scope := p_scope;
      name := v_name;
      RETURN NEXT;
    END IF;

    v_template := CASE
      WHEN jsonb_typeof(v_el -> 'templateElements') = 'array' THEN v_el -> 'templateElements'
      WHEN v_type = 'paneldynamic' THEN v_el -> 'questions'
      ELSE NULL
    END;
    IF v_template IS NOT NULL THEN
      RETURN QUERY SELECT * FROM public.survey_question_name_entries(
        v_template, p_path || '/' || v_idx, p_path || '/' || v_idx
      );
    END IF;
  END LOOP;
END;
$$;

-- The question names used by more than one question in the same scope, sorted. Empty when the
-- definition has none or cannot be read.
CREATE OR REPLACE FUNCTION public.survey_duplicate_question_names(p_json jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_survey jsonb := public.survey_json_unwrapped(p_json);
  v_result text[];
BEGIN
  IF v_survey IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;

  WITH entries AS (
    SELECT n.scope, n.name
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(v_survey -> 'pages') = 'array' THEN v_survey -> 'pages' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS p(page, idx)
    CROSS JOIN LATERAL public.survey_question_name_entries(
      CASE
        WHEN jsonb_typeof(p.page -> 'elements') = 'array' THEN p.page -> 'elements'
        ELSE p.page -> 'questions'
      END,
      'survey',
      'p' || p.idx
    ) AS n
    WHERE jsonb_typeof(p.page) = 'object'
    UNION ALL
    -- A survey with no pages keeps its questions at the root.
    SELECT r.scope, r.name
    FROM public.survey_question_name_entries(
      CASE
        WHEN jsonb_typeof(v_survey -> 'elements') = 'array' THEN v_survey -> 'elements'
        ELSE v_survey -> 'questions'
      END,
      'survey',
      'r'
    ) AS r
  )
  SELECT coalesce(array_agg(DISTINCT d.name ORDER BY d.name), ARRAY[]::text[])
  INTO v_result
  FROM (SELECT e.name FROM entries e GROUP BY e.scope, e.name HAVING count(*) > 1) AS d;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.surveys_reject_duplicate_question_names()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_duplicates text[];
  v_names text;
BEGIN
  IF NEW.status IS DISTINCT FROM 'published'::public.survey_status THEN
    RETURN NEW;
  END IF;

  -- Already published and the questions are unchanged: a date, setting or title edit on a
  -- survey that was published before this check existed. Compare the unwrapped definitions so
  -- that re-saving the same questions as a string instead of an object is not a change.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'published'::public.survey_status
     AND public.survey_json_unwrapped(NEW.json) IS NOT DISTINCT FROM public.survey_json_unwrapped(OLD.json) THEN
    RETURN NEW;
  END IF;

  v_duplicates := public.survey_duplicate_question_names(NEW.json);
  IF cardinality(v_duplicates) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(format('"%s"', d), ', ' ORDER BY d) INTO v_names FROM unnest(v_duplicates) AS d;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = format(
      'This survey cannot be published: %s %s. Each question needs its own name, because answers are saved under it. Rename the repeats, then publish again.',
      CASE WHEN cardinality(v_duplicates) = 1
        THEN 'more than one question is named'
        ELSE 'more than one question uses each of the names'
      END,
      v_names
    ),
    DETAIL = format('surveys_reject_duplicate_question_names rejected survey %s.', NEW.id),
    HINT = 'Open the survey in the Visual Builder: it marks each question whose name is used more than once.';
END;
$$;

DROP TRIGGER IF EXISTS surveys_reject_duplicate_question_names ON public.surveys;
CREATE TRIGGER surveys_reject_duplicate_question_names
  BEFORE INSERT OR UPDATE OF status, json ON public.surveys
  FOR EACH ROW
  EXECUTE FUNCTION public.surveys_reject_duplicate_question_names();

-- The trigger function runs as the writing user, and functions created by migrations get no
-- EXECUTE for authenticated by default (20261015120000). Instructors publish as authenticated,
-- so the pure helpers it calls are granted to them; they read only their argument.
GRANT EXECUTE ON FUNCTION public.survey_json_unwrapped(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.survey_question_name_entries(jsonb, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.survey_duplicate_question_names(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.surveys_reject_duplicate_question_names() TO service_role;
