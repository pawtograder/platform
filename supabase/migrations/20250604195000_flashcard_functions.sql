set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.log_flashcard_interaction(p_action text, p_class_id bigint, p_deck_id bigint, p_student_id uuid, p_duration_on_card_ms bigint, p_card_id bigint DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$BEGIN
  INSERT INTO public.flashcard_interaction_logs (action, class_id, deck_id, student_id, card_id, duration_on_card_ms)
  VALUES (p_action::public.flashcard_actions, p_class_id, p_deck_id, p_student_id, p_card_id, p_duration_on_card_ms);
END;$function$
;

CREATE OR REPLACE FUNCTION public.reset_all_flashcard_progress(p_class_id bigint, p_student_id uuid, p_card_ids bigint[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.student_flashcard_deck_progress
  SET
    is_mastered = FALSE,
    updated_at = NOW()
  WHERE student_id = p_student_id
    AND class_id = p_class_id
    AND card_id = ANY(p_card_ids); -- Use ANY() for array comparison
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_card_progress(p_class_id bigint, p_student_id uuid, p_card_id bigint, p_is_mastered boolean)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_existing_progress public.student_flashcard_deck_progress%ROWTYPE;
BEGIN
  SELECT * INTO v_existing_progress
  FROM public.student_flashcard_deck_progress
  WHERE student_id = p_student_id
    AND class_id = p_class_id
    AND card_id = p_card_id; -- Added semicolon here

  IF p_is_mastered THEN
    IF v_existing_progress IS NOT NULL THEN
      -- Update existing record
      UPDATE public.student_flashcard_deck_progress
      SET
        is_mastered = TRUE,
        last_answered_correctly_at = v_now,
        updated_at = v_now,
        first_answered_correctly_at = COALESCE(v_existing_progress.first_answered_correctly_at, v_now)
      WHERE student_id = p_student_id
        AND class_id = p_class_id
        AND card_id = p_card_id;
    ELSE
      -- Create new record
      INSERT INTO public.student_flashcard_deck_progress (
        student_id, class_id, card_id, is_mastered,
        first_answered_correctly_at, last_answered_correctly_at, updated_at
      ) VALUES (
        p_student_id, p_class_id, p_card_id, TRUE,
        v_now, v_now, v_now
      );
    END IF;
  ELSE
    -- Mark as not mastered (returned to practice)
    UPDATE public.student_flashcard_deck_progress
    SET
      is_mastered = FALSE,
      updated_at = v_now
    WHERE student_id = p_student_id
      AND class_id = p_class_id
      AND card_id = p_card_id;
  END IF;
END;$function$
;


