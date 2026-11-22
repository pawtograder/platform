-- Which onboarding guides each user has seen, so a guide that is meant to show once shows once per
-- user, not once per browser. The office hours hints for students (#1347) and the escalation
-- walkthrough for staff (#1261) both use it, each with its own key.
--
-- One row per user per key. A row means the user has seen that guide. Rows are never updated or
-- deleted by users: once seen, always seen. A second insert for the same key does nothing, because
-- the client inserts with ON CONFLICT DO NOTHING.

CREATE TABLE public.user_onboarding_seen (
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.users (user_id) ON DELETE CASCADE,
  -- Short, stable names such as 'office-hours-student-onboarding' or 'oh-escalation:v1'. The check
  -- keeps keys to lowercase words joined by dashes or colons, so a typo can't create a key that
  -- looks like another one. A colon can mark a version, so a changed guide can get a new key.
  key text NOT NULL CHECK (key ~ '^[a-z0-9]+([-:][a-z0-9]+)*$' AND length(key) <= 64),
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

COMMENT ON TABLE public.user_onboarding_seen IS
  'Onboarding guides each user has seen. Each user reads and inserts only their own rows.';

ALTER TABLE public.user_onboarding_seen ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_onboarding_seen_select_own ON public.user_onboarding_seen
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY user_onboarding_seen_insert_own ON public.user_onboarding_seen
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- No UPDATE or DELETE policy, so RLS refuses both. The grants match: signed-in users can only read
-- and insert, and anon gets nothing.
REVOKE ALL ON public.user_onboarding_seen FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.user_onboarding_seen TO authenticated;
GRANT ALL ON public.user_onboarding_seen TO service_role;
