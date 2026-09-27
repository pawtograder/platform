-- gradebook_row_recalculate_dlq was created without a metric.
--
-- 20260811130200 gave the gradebook recalc worker a retry ceiling and a dead-letter queue, so a row
-- that exhausts its version-mismatch budget is now a durable message instead of a dropped one. But
-- get_async_queue_sizes() -- the single source for every queue gauge, alert and dashboard panel --
-- was not extended, so nothing reports it. A row that gives up is visible only by querying
-- pgmq.q_gradebook_row_recalculate_dlq by hand or by finding the Sentry event: no gauge, no alert,
-- no panel. The other two DLQs (async_calls_dlq, discord_async_calls_dlq) have all three.
--
-- Same semantics as every other column here, for the same reasons documented in 20260811120200:
-- depth counts visible messages only (WHERE vt <= now()), age deliberately does not filter on vt
-- (a message deferred far into the future by retry backoff is the stuck case worth catching), and
-- the age read is `ORDER BY msg_id LIMIT 1` rather than min(enqueued_at) to stay off a sequential
-- scan on every Prometheus scrape.
--
-- Column placement follows the existing layout: all depths, then all ages, with each DLQ sitting
-- beside the queue it drains from (dlq after async, discord_dlq after discord).
--
-- DROP first: adding OUT columns widens the function's return type, which CREATE OR REPLACE
-- rejects. Every prior revision of this function does the same.

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
    async_oldest_seconds bigint,
    dlq_oldest_seconds bigint,
    gradebook_row_recalculate_oldest_seconds bigint,
    gradebook_row_recalculate_dlq_oldest_seconds bigint,
    discord_oldest_seconds bigint,
    discord_dlq_oldest_seconds bigint,
    async_low_priority_oldest_seconds bigint,
    notification_emails_oldest_seconds bigint
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
        -- 0 when empty, so the gauge reads "nothing is old" rather than going absent.
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_async_calls ORDER BY msg_id LIMIT 1)), 0)::bigint) AS async_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_async_calls_dlq ORDER BY msg_id LIMIT 1)), 0)::bigint) AS dlq_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_gradebook_row_recalculate ORDER BY msg_id LIMIT 1)), 0)::bigint) AS gradebook_row_recalculate_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_gradebook_row_recalculate_dlq ORDER BY msg_id LIMIT 1)), 0)::bigint) AS gradebook_row_recalculate_dlq_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_discord_async_calls ORDER BY msg_id LIMIT 1)), 0)::bigint) AS discord_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_discord_async_calls_dlq ORDER BY msg_id LIMIT 1)), 0)::bigint) AS discord_dlq_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_async_calls_low_priority ORDER BY msg_id LIMIT 1)), 0)::bigint) AS async_low_priority_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_notification_emails ORDER BY msg_id LIMIT 1)), 0)::bigint) AS notification_emails_oldest_seconds;
END;
$$;

COMMENT ON FUNCTION public.get_async_queue_sizes() IS
  'Per-queue pgmq depth (visible messages only) and oldest-message age in seconds (all messages, including those deferred by retry backoff), for all eight queues including the three dead-letter queues. Consumed by the metrics edge function.';

REVOKE ALL ON FUNCTION public.get_async_queue_sizes() FROM public;
GRANT EXECUTE ON FUNCTION public.get_async_queue_sizes() TO service_role;
