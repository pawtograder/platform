-- Course-level default repository host for new code assignments (#1388).
-- Nullable: NULL falls back to Forgejo for classes with no GitHub org (when cloud-workspaces is on),
-- and GitHub otherwise. Honored only while cloud-workspaces is enabled.
ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS default_git_provider text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'classes_default_git_provider_check'
      AND conrelid = 'public.classes'::regclass
  ) THEN
    ALTER TABLE public.classes
      ADD CONSTRAINT classes_default_git_provider_check
      CHECK (default_git_provider IN ('github', 'forgejo'));
  END IF;
END $$;

COMMENT ON COLUMN public.classes.default_git_provider IS
  'Default repository host for new code assignments when cloud-workspaces is enabled. NULL defaults to forgejo when github_org is unset, otherwise github.';

-- Instructors save default_git_provider from Course Settings -> Feature flags.
-- classes has a column allowlist for instructor updates (only_calendar_or_discord_ids_changed),
-- so the new column has to be on it too. Body matches 20261117174100 with one key added.
CREATE OR REPLACE FUNCTION public.only_calendar_or_discord_ids_changed(new_row classes)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (
      SELECT COALESCE(
        (
          SELECT bool_and(changed.key = ANY(ARRAY[
            -- discord_server_id is absent on purpose: claim_discord_guild() is its only writer.
            -- A category id inside a guild the class already controls, so it stays editable.
            'discord_channel_group_id',
            'office_hours_ics_url',
            'events_ics_url',
            'office_hours_description',
            'office_hours_health_thresholds',
            'default_git_provider',
            'updated_at'
          ]))
          FROM (
            SELECT t.key
            FROM jsonb_each(to_jsonb(new_row)) AS t(key, value)
            WHERE (to_jsonb(old_row)->t.key) IS DISTINCT FROM t.value
          ) AS changed
        ),
        true  -- no differences -> allow
      )
      FROM public.classes old_row
      WHERE old_row.id = new_row.id
    ),
    false -- no matching row found
  );
$function$;
