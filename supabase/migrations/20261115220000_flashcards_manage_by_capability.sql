-- #1010, area 13: creating, editing, deleting and copying flashcard decks and cards follow
-- manage_flashcards.
--
-- Why: graders can manage flashcards today. This moves those writes onto the capability tables so
-- an instructor can turn the action off for a role, while default graders and instructors keep
-- exactly what they had.
--
-- What:
--   * Inserts manage_flashcards and puts it on every class's default instructor role, default
--     grader role, and every custom role. Updates seed_default_class_roles() so new classes put
--     it on the default grader role too (instructors still get every capability via the CROSS JOIN).
--   * flashcard_decks INSERT / UPDATE / DELETE: the authorizeforclassgrader checks become the
--     capability check from docs/capabilities.md. The creator_id = auth.uid() identity check on
--     INSERT stays. The old creator OR on UPDATE / DELETE is dropped so turning the capability
--     off stops management even for decks that person created.
--   * flashcards INSERT / UPDATE / DELETE: same, with the deck still required to match the card's
--     class_id.
--
-- Not changed (views and student actions):
--   * "Allow users to view decks in their class" / "Allow users to view cards in accessible decks"
--   * "Allow students to see own logs, instructors/graders to see clas" (staff half is a view)
--   * "View progress based on role" and the student insert / update / delete progress policies
--   * "Allow students to insert own interaction logs"
--   * log_flashcard_interaction, update_card_progress, reset_all_flashcard_progress
--   * the flashcard_* analytics views

INSERT INTO public.capabilities (name, description) VALUES
  ('manage_flashcards', 'Create, edit and delete flashcard decks and cards')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'manage_flashcards' FROM public.class_roles cr
WHERE cr.default_for IN ('instructor', 'grader') OR cr.default_for IS NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.seed_default_class_roles(p_class_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.class_roles (class_id, name, default_for)
  VALUES
    (p_class_id, 'instructor', 'instructor'),
    (p_class_id, 'grader', 'grader'),
    (p_class_id, 'student', 'student'),
    (p_class_id, 'admin', 'admin')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, c.name
  FROM public.class_roles cr
  CROSS JOIN public.capabilities c
  WHERE cr.class_id = p_class_id AND cr.default_for = 'instructor'
  ON CONFLICT DO NOTHING;

  -- Graders can manage flashcards today (#1010 area 13), so new classes put it on the default
  -- grader role. Instructors already get it from the CROSS JOIN above.
  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, 'manage_flashcards'
  FROM public.class_roles cr
  WHERE cr.class_id = p_class_id AND cr.default_for = 'grader'
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_class_roles(bigint) FROM PUBLIC, anon, authenticated;

-- flashcard_decks -----------------------------------------------------------

DROP POLICY IF EXISTS "Allow instructors/graders to create decks" ON public.flashcard_decks;
DROP POLICY IF EXISTS "Allow creator or instructor/grader to update decks" ON public.flashcard_decks;
DROP POLICY IF EXISTS "Allow creator or instructor/grader to delete decks" ON public.flashcard_decks;
DROP POLICY IF EXISTS "Flashcard managers can create decks" ON public.flashcard_decks;
DROP POLICY IF EXISTS "Flashcard managers can update decks" ON public.flashcard_decks;
DROP POLICY IF EXISTS "Flashcard managers can delete decks" ON public.flashcard_decks;

CREATE POLICY "Flashcard managers can create decks"
ON public.flashcard_decks
FOR INSERT TO authenticated
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_flashcards'))
  AND creator_id = (SELECT auth.uid())
);

CREATE POLICY "Flashcard managers can update decks"
ON public.flashcard_decks
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_flashcards')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_flashcards')));

CREATE POLICY "Flashcard managers can delete decks"
ON public.flashcard_decks
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_flashcards')));

-- flashcards ----------------------------------------------------------------

DROP POLICY IF EXISTS "Allow deck managers to create cards" ON public.flashcards;
DROP POLICY IF EXISTS "Allow deck managers to update cards" ON public.flashcards;
DROP POLICY IF EXISTS "Allow deck managers to delete cards" ON public.flashcards;
DROP POLICY IF EXISTS "Flashcard managers can create cards" ON public.flashcards;
DROP POLICY IF EXISTS "Flashcard managers can update cards" ON public.flashcards;
DROP POLICY IF EXISTS "Flashcard managers can delete cards" ON public.flashcards;

CREATE POLICY "Flashcard managers can create cards"
ON public.flashcards
FOR INSERT TO authenticated
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_flashcards'))
  AND EXISTS (
    SELECT 1
    FROM public.flashcard_decks fd
    WHERE fd.id = flashcards.deck_id
      AND fd.class_id = flashcards.class_id
  )
);

CREATE POLICY "Flashcard managers can update cards"
ON public.flashcards
FOR UPDATE TO authenticated
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_flashcards'))
  AND EXISTS (
    SELECT 1
    FROM public.flashcard_decks fd
    WHERE fd.id = flashcards.deck_id
      AND fd.class_id = flashcards.class_id
  )
)
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_flashcards'))
  AND EXISTS (
    SELECT 1
    FROM public.flashcard_decks fd
    WHERE fd.id = flashcards.deck_id
      AND fd.class_id = flashcards.class_id
  )
);

CREATE POLICY "Flashcard managers can delete cards"
ON public.flashcards
FOR DELETE TO authenticated
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_flashcards'))
  AND EXISTS (
    SELECT 1
    FROM public.flashcard_decks fd
    WHERE fd.id = flashcards.deck_id
      AND fd.class_id = flashcards.class_id
  )
);
