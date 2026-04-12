-- Replace single-purpose `use_monaco_grading_editor` with extensible jsonb `preferences`.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.users.preferences IS
  'User preferences object (application type: UserPreferences). Add keys as needed; unknown keys are preserved.';

-- Migrate legacy boolean column into preferences.grading.useMonacoEditor when present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'use_monaco_grading_editor'
  ) THEN
    UPDATE public.users u
    SET preferences = jsonb_set(
      COALESCE(u.preferences, '{}'::jsonb),
      '{grading}',
      COALESCE(u.preferences->'grading', '{}'::jsonb)
        || jsonb_build_object('useMonacoEditor', u.use_monaco_grading_editor),
      true
    );
    ALTER TABLE public.users DROP COLUMN use_monaco_grading_editor;
  END IF;
END $$;

DROP POLICY IF EXISTS "Users can update own grading editor preference" ON public.users;

CREATE POLICY "Users can update own preferences"
  ON public.users
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
