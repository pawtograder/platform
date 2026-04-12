-- Per-user preference: use Monaco editor in the grading file view (submission code).
-- When false, the grading UI loads a lightweight plain view and does not fetch the Monaco bundle.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS use_monaco_grading_editor boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.users.use_monaco_grading_editor IS
  'When true, the submission file grading view uses the Monaco editor; when false, a plain text view is used (no Monaco bundle).';

DROP POLICY IF EXISTS "Users can update own grading editor preference" ON public.users;

CREATE POLICY "Users can update own grading editor preference"
  ON public.users
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
