-- handout_sync and handout_sync_dlq in the queue gauges (docs/handout-sync-git-worker.md §10,
-- build plan WP5 "Carried over").
--
-- 20261109120000 created both queues, but get_async_queue_sizes() has fixed columns and does not
-- read them, so the metrics edge function cannot emit pawtograder_queue_depth or
-- pawtograder_queue_oldest_message_seconds for them. The chart's PawtograderHandoutSyncQueueAging
-- (warning and critical) and PawtograderHandoutSyncDLQGrowing select on queue="handout_sync" and
-- queue="handout_sync_dlq" and stay silent until those series exist.
--
-- Same function as 20260811130400 with two depth and two age columns appended, computed the same
-- way: depth counts visible messages only, so a job the worker holds under its heartbeat is not
-- counted as waiting; age reads the first row by msg_id and does not filter on vt, so a message
-- deferred by retry backoff still ages.
--
-- DROP first: adding OUT columns changes the return type, which CREATE OR REPLACE rejects. The
-- grants are restated with the posture 20261015120000 gave this function (service_role only).

DROP FUNCTION IF EXISTS public.get_async_queue_sizes();

CREATE OR REPLACE FUNCTION public.get_async_queue_sizes()
RETURNS TABLE (
    async_queue_size bigint,
    dlq_queue_size bigint,
    gradebook_row_recalculate_queue_size bigint,
    gradebook_row_recalculate_dlq_queue_size bigint,
    discord_queue_size bigint,
    discord_dlq_queue_size bigint,
    async_low_priority_queue_size bigint,
    notification_emails_queue_size bigint,
    handout_sync_queue_size bigint,
    handout_sync_dlq_queue_size bigint,
    async_oldest_seconds bigint,
    dlq_oldest_seconds bigint,
    gradebook_row_recalculate_oldest_seconds bigint,
    gradebook_row_recalculate_dlq_oldest_seconds bigint,
    discord_oldest_seconds bigint,
    discord_dlq_oldest_seconds bigint,
    async_low_priority_oldest_seconds bigint,
    notification_emails_oldest_seconds bigint,
    handout_sync_oldest_seconds bigint,
    handout_sync_dlq_oldest_seconds bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pgmq
AS $$
BEGIN
    RETURN QUERY
    SELECT
        (SELECT count(*)::bigint FROM pgmq.q_async_calls WHERE vt <= now()) AS async_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_async_calls_dlq WHERE vt <= now()) AS dlq_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_gradebook_row_recalculate WHERE vt <= now()) AS gradebook_row_recalculate_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_gradebook_row_recalculate_dlq WHERE vt <= now()) AS gradebook_row_recalculate_dlq_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_discord_async_calls WHERE vt <= now()) AS discord_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_discord_async_calls_dlq WHERE vt <= now()) AS discord_dlq_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_async_calls_low_priority WHERE vt <= now()) AS async_low_priority_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_notification_emails WHERE vt <= now()) AS notification_emails_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_handout_sync WHERE vt <= now()) AS handout_sync_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_handout_sync_dlq WHERE vt <= now()) AS handout_sync_dlq_queue_size,
        -- 0 when empty, so the gauge reads "nothing is old" rather than going absent.
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_async_calls ORDER BY msg_id LIMIT 1)), 0)::bigint) AS async_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_async_calls_dlq ORDER BY msg_id LIMIT 1)), 0)::bigint) AS dlq_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_gradebook_row_recalculate ORDER BY msg_id LIMIT 1)), 0)::bigint) AS gradebook_row_recalculate_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_gradebook_row_recalculate_dlq ORDER BY msg_id LIMIT 1)), 0)::bigint) AS gradebook_row_recalculate_dlq_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_discord_async_calls ORDER BY msg_id LIMIT 1)), 0)::bigint) AS discord_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_discord_async_calls_dlq ORDER BY msg_id LIMIT 1)), 0)::bigint) AS discord_dlq_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_async_calls_low_priority ORDER BY msg_id LIMIT 1)), 0)::bigint) AS async_low_priority_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_notification_emails ORDER BY msg_id LIMIT 1)), 0)::bigint) AS notification_emails_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_handout_sync ORDER BY msg_id LIMIT 1)), 0)::bigint) AS handout_sync_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_handout_sync_dlq ORDER BY msg_id LIMIT 1)), 0)::bigint) AS handout_sync_dlq_oldest_seconds;
END;
$$;

COMMENT ON FUNCTION public.get_async_queue_sizes() IS
  'Per-queue pgmq depth (visible messages only) and oldest-message age in seconds (all messages, including those deferred by retry backoff), for all ten queues including the four dead-letter queues. Consumed by the metrics edge function.';

REVOKE ALL ON FUNCTION public.get_async_queue_sizes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_async_queue_sizes() TO service_role;
