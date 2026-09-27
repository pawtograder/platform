-- User preferences (jsonb). Application type: UserPreferences in types/UserPreferences.ts.
-- Grading file view: preferences.grading.useMonacoEditor (app default false when key absent).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.users.preferences IS
  'User preferences object (application type: UserPreferences). Add keys as needed; unknown keys are preserved.';

DROP POLICY IF EXISTS "Users can update own grading editor preference" ON public.users;
DROP POLICY IF EXISTS "Users can update own preferences" ON public.users;

CREATE POLICY "Users can update own preferences"
  ON public.users
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- RLS cannot express "only these columns may change" on UPDATE. Restrict column privileges so
-- authenticated clients can only assign `preferences`; service_role still has full table access.
REVOKE UPDATE ON TABLE public.users FROM anon;
REVOKE UPDATE ON TABLE public.users FROM authenticated;
GRANT UPDATE (preferences) ON TABLE public.users TO authenticated;
