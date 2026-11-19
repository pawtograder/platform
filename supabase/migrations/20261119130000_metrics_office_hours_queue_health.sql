-- Office hours queue health as a metric, so the red-queue condition from
-- 20261117174200_office_hours_queue_health.sql can be watched without an instructor sitting on the
-- staff dashboard. That RPC answers "which queues need attention in my class, right now" for one
-- class and refuses anyone who is not staff; this answers "how many queues are red across the
-- deployment" for the metrics scrape, which runs as service_role and has no class.
--
-- The definitions are copied from that RPC on purpose, so a queue the dashboard paints red is a
-- queue this counts as red:
--   * only active queues (q.is_active), the set the dashboard draws cards for;
--   * waiting  = help_requests with status 'open' on the queue;
--   * staffed  = help_queue_assignments rows with ended_at IS NULL;
--   * red      = waiting at or over the class's waiting_red, or the oldest open request at or over
--                oldest_wait_red_minutes. Same thresholds column the instructor edits in Queue
--                Settings, so a class that raised its limit stops alerting here too.
--
-- One row per class, not per queue: Prometheus labels have to stay bounded, and queue names are
-- free text an instructor can add to at will. class_id is already a label on every other metric
-- here. See the cardinality note in 20260904120000_metrics_gap_remediation.sql, which retired
-- metrics_workflow_errors_by_name for exactly this reason.

CREATE OR REPLACE FUNCTION public.metrics_office_hours_queue_health()
RETURNS TABLE (
  class_id bigint,
  queues_active integer,
  queues_red integer,
  queues_unstaffed integer,
  requests_waiting integer,
  oldest_wait_minutes integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH thresholds AS (
    SELECT
      c.id AS cid,
      COALESCE((c.office_hours_health_thresholds->>'waiting_red')::int, 5) AS waiting_red,
      COALESCE((c.office_hours_health_thresholds->>'oldest_wait_red_minutes')::int, 30) AS oldest_red
    FROM public.classes c
    WHERE c.archived = false
  ),
  queues AS (
    SELECT q.id, q.class_id
    FROM public.help_queues q
    JOIN thresholds t ON t.cid = q.class_id
    WHERE q.is_active
  ),
  per_queue AS (
    SELECT
      qu.class_id AS cid,
      qu.id AS qid,
      COALESCE(w.n, 0) AS waiting,
      -- No open request means no wait, not a zero-minute wait; both read as "not red".
      COALESCE(EXTRACT(EPOCH FROM (now() - w.oldest)) / 60, 0)::int AS oldest_minutes,
      COALESCE(s.n, 0) AS staffed
    FROM queues qu
    LEFT JOIN (
      SELECT r.help_queue AS qid, COUNT(*)::int AS n, MIN(r.created_at) AS oldest
      FROM public.help_requests r
      WHERE r.status = 'open'
      GROUP BY r.help_queue
    ) w ON w.qid = qu.id
    LEFT JOIN (
      SELECT a.help_queue_id AS qid, COUNT(*)::int AS n
      FROM public.help_queue_assignments a
      WHERE a.ended_at IS NULL
      GROUP BY a.help_queue_id
    ) s ON s.qid = qu.id
  )
  SELECT
    t.cid,
    COUNT(p.qid)::int,
    COUNT(*) FILTER (
      WHERE p.waiting >= t.waiting_red OR p.oldest_minutes >= t.oldest_red
    )::int,
    COUNT(*) FILTER (WHERE p.staffed = 0)::int,
    COALESCE(SUM(p.waiting), 0)::int,
    COALESCE(MAX(p.oldest_minutes), 0)::int
  FROM thresholds t
  LEFT JOIN per_queue p ON p.cid = t.cid
  GROUP BY t.cid
$$;

COMMENT ON FUNCTION public.metrics_office_hours_queue_health() IS
  'Office hours queue health per class: active queues, how many are red by the class''s own office_hours_health_thresholds, how many have nobody on shift, total open requests and the oldest open wait in minutes. Mirrors office_hours_queue_health so the metric and the staff dashboard agree. Driver for pawtograder_office_hours_queues_red.';

-- Privileges. GRANT alone is NOT sufficient: 20250330003141_remote_schema.sql:3593-3596 sets
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon, authenticated, so a new function in
-- this schema is executable by both the moment it exists. This one is SECURITY DEFINER and reads
-- every class, so it must be revoked before it is granted. Same pattern as
-- 20260904120000_metrics_gap_remediation.sql.
REVOKE ALL ON FUNCTION public.metrics_office_hours_queue_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.metrics_office_hours_queue_health() TO service_role;
