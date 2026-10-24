-- Two gaps in queue observability.
--
-- 1. notification_emails was never reported. get_async_queue_sizes() covers six queues; the
--    notification email queue (created in 20250615004114_pgmq_notifications.sql) is not one of
--    them. So when the email processor stopped draining, the backlog was invisible to monitoring
--    as well as to the code -- there was no gauge to alert on and no panel to notice.
--
-- 2. Every signal here is a DEPTH. Depth thresholds have to be tuned against enrollment and
--    against the deadline calendar, so they drift out of calibration and get raised until they
--    stop firing. Age does not: a queue whose oldest message has been sitting for twenty minutes
--    is broken at any scale, in any week of the term. Adding oldest-message age per queue gives
--    the one queue signal that needs no seasonal tuning.
--
-- The age columns intentionally do NOT filter on vt. A message deferred far into the future by
-- repeated retry backoff is precisely the stuck case worth catching; excluding it would hide the
-- failure mode the metric exists for.
--
-- The age reads take `ORDER BY msg_id LIMIT 1`, not `min(enqueued_at)`. pgmq's q_* tables are
-- indexed on msg_id and vt only, so min(enqueued_at) is a sequential scan -- seven of them on every
-- Prometheus scrape, over the highest-churn tables in the database, and worst at exactly the moment
-- the metric matters (a deadline burst). msg_id is a monotonic identity column, so the first row by
-- msg_id is the oldest message; the two can differ by at most the duration of a long enqueueing
-- transaction, which is noise against a threshold measured in minutes.
--
-- DROP first: adding OUT columns changes the function's return type, which CREATE OR REPLACE
-- rejects. All three prior revisions of this function do the same.

DROP FUNCTION IF EXISTS public.get_async_queue_sizes();

CREATE OR REPLACE FUNCTION public.get_async_queue_sizes()
RETURNS TABLE (
    async_queue_size bigint,
    dlq_queue_size bigint,
    gradebook_row_recalculate_queue_size bigint,
    discord_queue_size bigint,
    discord_dlq_queue_size bigint,
    async_low_priority_queue_size bigint,
    notification_emails_queue_size bigint,
    async_oldest_seconds bigint,
    dlq_oldest_seconds bigint,
    gradebook_row_recalculate_oldest_seconds bigint,
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
        (SELECT count(*)::bigint FROM pgmq.q_discord_async_calls WHERE vt <= now()) AS discord_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_discord_async_calls_dlq WHERE vt <= now()) AS discord_dlq_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_async_calls_low_priority WHERE vt <= now()) AS async_low_priority_queue_size,
        (SELECT count(*)::bigint FROM pgmq.q_notification_emails WHERE vt <= now()) AS notification_emails_queue_size,
        -- 0 when empty, so the gauge reads "nothing is old" rather than going absent.
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_async_calls ORDER BY msg_id LIMIT 1)), 0)::bigint) AS async_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_async_calls_dlq ORDER BY msg_id LIMIT 1)), 0)::bigint) AS dlq_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_gradebook_row_recalculate ORDER BY msg_id LIMIT 1)), 0)::bigint) AS gradebook_row_recalculate_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_discord_async_calls ORDER BY msg_id LIMIT 1)), 0)::bigint) AS discord_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_discord_async_calls_dlq ORDER BY msg_id LIMIT 1)), 0)::bigint) AS discord_dlq_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_async_calls_low_priority ORDER BY msg_id LIMIT 1)), 0)::bigint) AS async_low_priority_oldest_seconds,
        (SELECT coalesce(extract(epoch FROM now() - (SELECT enqueued_at FROM pgmq.q_notification_emails ORDER BY msg_id LIMIT 1)), 0)::bigint) AS notification_emails_oldest_seconds;
END;
$$;

COMMENT ON FUNCTION public.get_async_queue_sizes() IS
  'Per-queue pgmq depth (visible messages only) and oldest-message age in seconds (all messages, including those deferred by retry backoff). Consumed by the metrics edge function.';

REVOKE ALL ON FUNCTION public.get_async_queue_sizes() FROM public;
GRANT EXECUTE ON FUNCTION public.get_async_queue_sizes() TO service_role;
