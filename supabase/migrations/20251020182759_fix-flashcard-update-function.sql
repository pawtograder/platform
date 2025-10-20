-- Drop existing RLS policies for student_flashcard_deck_progress
DROP POLICY IF EXISTS "Allow students to insert own progress" ON public.student_flashcard_deck_progress;
DROP POLICY IF EXISTS "Allow students to see own progress, instructors/graders to see " ON public.student_flashcard_deck_progress;
DROP POLICY IF EXISTS "Allow students to update own progress" ON public.student_flashcard_deck_progress;

-- Streamlined RLS policies using direct joins to user_privileges
-- No function calls except auth.uid()

-- INSERT: Allow students to insert their own progress if they have access to the class
CREATE POLICY "Students insert own progress"
ON public.student_flashcard_deck_progress
FOR INSERT
TO authenticated
WITH CHECK (
  student_id = auth.uid()
  AND EXISTS (
    SELECT 1 
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = student_flashcard_deck_progress.class_id
  )
);

-- SELECT: Students see own progress, instructors/graders see all in their class
CREATE POLICY "View progress based on role"
ON public.student_flashcard_deck_progress
FOR SELECT
TO authenticated
USING (
  -- Students see their own progress
  (student_id = auth.uid())
  OR 
  -- Instructors/graders see all progress in their classes
  EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = student_flashcard_deck_progress.class_id
      AND up.role IN ('instructor', 'grader', 'admin')
  )
);

-- UPDATE: Students can update their own progress if they have class access
CREATE POLICY "Students update own progress"
ON public.student_flashcard_deck_progress
FOR UPDATE
TO authenticated
USING (
  student_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = student_flashcard_deck_progress.class_id
  )
)
WITH CHECK (
  student_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = student_flashcard_deck_progress.class_id
  )
);

-- Use UPSERT to handle insert/update without checking if record exists
CREATE OR REPLACE FUNCTION public.update_card_progress(p_class_id bigint, p_student_id uuid, p_card_id bigint, p_is_mastered boolean)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF p_is_mastered THEN
    -- Insert or update to mark as mastered
    INSERT INTO public.student_flashcard_deck_progress (
      student_id, class_id, card_id, is_mastered,
      first_answered_correctly_at, last_answered_correctly_at, 
      created_at, updated_at
    ) VALUES (
      p_student_id, p_class_id, p_card_id, TRUE,
      v_now, v_now, v_now, v_now
    )
    ON CONFLICT (student_id, card_id) 
    DO UPDATE SET
      is_mastered = TRUE,
      last_answered_correctly_at = v_now,
      updated_at = v_now,
      first_answered_correctly_at = COALESCE(
        public.student_flashcard_deck_progress.first_answered_correctly_at, 
        v_now
      );
  ELSE
    -- Mark as not mastered (returned to practice)
    -- Only update if record exists, don't create new record for "not mastered"
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

