-- Add change tracking to discord_messages so the hourly stats cron job
-- only enqueues update_message when discussion thread stats actually changed.
-- Without this, every single discussion thread gets a fresh update_message
-- every hour, flooding the discord_async_calls queue.

ALTER TABLE public.discord_messages
ADD COLUMN IF NOT EXISTS last_synced_stats jsonb;

COMMENT ON COLUMN public.discord_messages.last_synced_stats IS
  'Snapshot of stats at last Discord sync (likes_count, children_count, answer). '
  'Used by discord-discussion-stats-update to skip no-op updates.';

-- Backfill last_synced_stats for all existing discussion_thread messages
-- so the first cron run after this migration doesn't re-enqueue all 5k+ threads.
UPDATE public.discord_messages dm
SET last_synced_stats = jsonb_build_object(
  'likes_count', COALESCE(dt.likes_count, 0),
  'children_count', COALESCE(dt.children_count, 0),
  'is_question', dt.is_question,
  'has_answer', dt.answer IS NOT NULL
)
FROM public.discussion_threads dt
WHERE dm.resource_type = 'discussion_thread'
  AND dm.resource_id = dt.id
  AND dm.last_synced_stats IS NULL;
