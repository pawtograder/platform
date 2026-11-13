-- Per-class thresholds for the office hours queue health colors.
-- waiting_red: the waiting count turns red at this many students or more.
-- oldest_wait_red_minutes: the oldest wait turns red at this many minutes or more.

ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS office_hours_health_thresholds jsonb NOT NULL
  DEFAULT '{"waiting_red": 5, "oldest_wait_red_minutes": 30}'::jsonb;

-- Instructors save these from Queue Settings. classes has a column allowlist for instructor
-- updates (only_calendar_or_discord_ids_changed), so the new column has to be on it too.
-- Body is the current definition with one key added.
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
