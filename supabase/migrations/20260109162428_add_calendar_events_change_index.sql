-- Add missing partial index for change announcements query pattern
-- This optimizes queries that filter by change_announced_at IS NULL

CREATE INDEX IF NOT EXISTS idx_calendar_events_unannounced_change 
ON public.calendar_events USING btree (class_id, end_time) 
WHERE (change_announced_at IS NULL);
