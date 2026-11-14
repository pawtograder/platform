-- Queue health for the staff dashboard: one row per queue in the class.
--
-- waiting: open requests (no TA yet). oldest_wait_seconds: age of the longest-waiting open request.
-- helping: in-progress requests. staffed_tas: TA shifts with no end time.
-- unstaffed_seconds: time since the queue's last shift ended, when it has no shift running now.
-- resolved_today: resolved since midnight in the class time zone.
-- median_wait_seconds_today: for requests picked up today, the median of (first pickup - created_at).
-- Shift state uses ended_at, not is_active, so a shift that was ended but never flagged inactive
-- does not count as staffed.

CREATE OR REPLACE FUNCTION public.office_hours_queue_health(p_class_id bigint)
RETURNS TABLE (
  queue_id bigint,
  queue_name text,
  waiting integer,
  oldest_wait_seconds integer,
  helping integer,
  staffed_tas integer,
  unstaffed_seconds integer,
  resolved_today integer,
  median_wait_seconds_today integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_zone text;
  v_start timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = p_class_id
      AND up.role IN ('instructor', 'grader')
  ) THEN
    RAISE EXCEPTION 'Only course staff can view queue health' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(c.time_zone, 'UTC') INTO v_zone FROM public.classes c WHERE c.id = p_class_id;
  v_start := date_trunc('day', now() AT TIME ZONE v_zone) AT TIME ZONE v_zone;

  RETURN QUERY
  WITH queues AS (
    SELECT q.id, q.name FROM public.help_queues q WHERE q.class_id = p_class_id
  ),
  open_now AS (
    SELECT r.help_queue AS qid, COUNT(*)::int AS n, MIN(r.created_at) AS oldest
    FROM public.help_requests r
    WHERE r.class_id = p_class_id AND r.status = 'open'
    GROUP BY r.help_queue
  ),
  helping_now AS (
    SELECT r.help_queue AS qid, COUNT(*)::int AS n
    FROM public.help_requests r
    WHERE r.class_id = p_class_id AND r.status = 'in_progress'
    GROUP BY r.help_queue
  ),
  staffed AS (
    SELECT a.help_queue_id AS qid, COUNT(*)::int AS n
    FROM public.help_queue_assignments a
    WHERE a.class_id = p_class_id AND a.ended_at IS NULL
    GROUP BY a.help_queue_id
  ),
  last_shift_end AS (
    SELECT a.help_queue_id AS qid, MAX(a.ended_at) AS ended
    FROM public.help_queue_assignments a
    WHERE a.class_id = p_class_id AND a.ended_at IS NOT NULL
    GROUP BY a.help_queue_id
  ),
  resolved_today AS (
    SELECT r.help_queue AS qid, COUNT(*)::int AS n
    FROM public.help_requests r
    WHERE r.class_id = p_class_id AND r.status = 'resolved' AND r.resolved_at >= v_start
    GROUP BY r.help_queue
  ),
  first_pickup AS (
    SELECT s.help_request_id, MIN(s.started_at) AS picked_at
    FROM public.help_request_work_sessions s
    WHERE s.class_id = p_class_id
    GROUP BY s.help_request_id
  ),
  median_wait AS (
    SELECT r.help_queue AS qid,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (fp.picked_at - r.created_at))
           ) AS med
    FROM public.help_requests r
    JOIN first_pickup fp ON fp.help_request_id = r.id
    WHERE r.class_id = p_class_id AND fp.picked_at >= v_start
    GROUP BY r.help_queue
  )
  SELECT
    q.id,
    q.name,
    COALESCE(o.n, 0),
    COALESCE(EXTRACT(EPOCH FROM (now() - o.oldest)), 0)::int,
    COALESCE(h.n, 0),
    COALESCE(s.n, 0),
    CASE WHEN COALESCE(s.n, 0) = 0 AND le.ended IS NOT NULL
         THEN EXTRACT(EPOCH FROM (now() - le.ended))::int
         ELSE NULL END,
    COALESCE(rt.n, 0),
    COALESCE(m.med, 0)::int
  FROM queues q
  LEFT JOIN open_now o ON o.qid = q.id
  LEFT JOIN helping_now h ON h.qid = q.id
  LEFT JOIN staffed s ON s.qid = q.id
  LEFT JOIN last_shift_end le ON le.qid = q.id
  LEFT JOIN resolved_today rt ON rt.qid = q.id
  LEFT JOIN median_wait m ON m.qid = q.id
  ORDER BY q.name;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.office_hours_queue_health(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.office_hours_queue_health(bigint) TO authenticated;
