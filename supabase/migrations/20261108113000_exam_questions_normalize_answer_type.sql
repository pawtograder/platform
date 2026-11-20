-- Template extraction asks Gemini for each question's answer_type, and Gemini can return values
-- outside exam_questions_answer_type_check (it returned 'composite' for a section with
-- sub-questions on staging). The region editor hides the type selector on questions that have
-- children, so staff could not correct the value, and exam_upsert_questions_and_regions failed
-- the whole save with a check violation.
--
-- The client now normalizes extracted values before saving. This trigger is the backstop for any
-- other writer: an unknown answer_type becomes 'free_text', the same default the editor gives a
-- question added by hand. NULL is left alone (the check allows it).
--
-- Idempotent: it was first applied by hand on staging on 2026-11-08 so manual testing could
-- continue before the deploy.

CREATE OR REPLACE FUNCTION public.exam_questions_normalize_answer_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.answer_type IS NOT NULL
     AND NEW.answer_type NOT IN ('multiple_choice', 'free_text', 'numeric', 'true_false', 'short_answer') THEN
    NEW.answer_type := 'free_text';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.exam_questions_normalize_answer_type() IS
  'Maps an answer_type outside exam_questions_answer_type_check to free_text, so an extracted value such as composite cannot fail a whole exam save.';

REVOKE ALL ON FUNCTION public.exam_questions_normalize_answer_type() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_exam_questions_normalize_answer_type ON public.exam_questions;
CREATE TRIGGER trg_exam_questions_normalize_answer_type
  BEFORE INSERT OR UPDATE OF answer_type ON public.exam_questions
  FOR EACH ROW EXECUTE FUNCTION public.exam_questions_normalize_answer_type();
