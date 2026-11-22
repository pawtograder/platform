-- "What's new" walkthroughs each user has seen or dismissed (#1261).
--
-- A walkthrough opens on its own at most once per person. The record lives here rather than in
-- localStorage so it holds across browsers, devices and cleared profiles. `item` names the
-- walkthrough and its version (for example 'oh-escalation:v1'), so a later walkthrough is a new
-- row, not a new table.
--
-- Users can read and add only their own rows. Nothing updates or deletes them from the app; the
-- rows go when the user does.

CREATE TABLE public.user_whats_new_seen (
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  item text NOT NULL CHECK (char_length(item) BETWEEN 1 AND 100),
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item)
);

COMMENT ON TABLE public.user_whats_new_seen IS
  'One row per user per "What''s new" walkthrough they have seen or dismissed, so it opens on its own only once.';

ALTER TABLE public.user_whats_new_seen ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_whats_new_seen FROM public, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.user_whats_new_seen TO authenticated;

CREATE POLICY user_whats_new_seen_select_own ON public.user_whats_new_seen
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY user_whats_new_seen_insert_own ON public.user_whats_new_seen
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));
