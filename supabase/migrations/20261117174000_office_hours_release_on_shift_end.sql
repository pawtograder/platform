-- When a TA's shift ends, the requests they were still helping go back to the queue (open,
-- unassigned) instead of staying in_progress with someone who is no longer working.
--
-- Which requests: nothing stops a TA from helping on a queue they are not on shift in (Start
-- Helping checks only the request's status), so "the queue whose shift ended" is not enough on its
-- own. Requests on that queue are always released. Requests the TA is helping on other queues are
-- released only when this was their last shift still running in the class, because a TA with
-- another shift open is still working office hours and should keep what they are holding.
--
-- Behind the course feature "office-hours-shift-release", which defaults off. The work-session
-- trigger (20251226204315) closes the TA's session when the assignee is cleared, so this only needs
-- to change the request rows.

CREATE OR REPLACE FUNCTION public.release_help_requests_on_shift_end()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enabled boolean;
BEGIN
  IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Same rule as courseFeatureEnabled() in lib/courseFeatures.ts: a missing or non-boolean entry
  -- means the feature's default, which is off here.
  SELECT COALESCE(
    (
      SELECT CASE WHEN jsonb_typeof(f -> 'enabled') = 'boolean' THEN (f -> 'enabled')::boolean END
      FROM public.classes c,
           LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(c.features) = 'array' THEN c.features ELSE '[]'::jsonb END
           ) AS f
      WHERE c.id = NEW.class_id
        AND f ->> 'name' = 'office-hours-shift-release'
      LIMIT 1
    ),
    false
  ) INTO v_enabled;

  IF NOT v_enabled THEN
    RETURN NEW;
  END IF;

  -- This is an AFTER trigger, so the row that just ended is already visible with its ended_at set
  -- and does not count itself as a shift that is still running.
  UPDATE public.help_requests
  SET status = 'open',
      assignee = NULL,
      updated_at = now()
  WHERE class_id = NEW.class_id
    AND assignee = NEW.ta_profile_id
    AND status = 'in_progress'
    AND (
      help_queue = NEW.help_queue_id
      OR NOT EXISTS (
        SELECT 1
        FROM public.help_queue_assignments a
        WHERE a.class_id = NEW.class_id
          AND a.ta_profile_id = NEW.ta_profile_id
          AND a.ended_at IS NULL
      )
    );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS release_help_requests_on_shift_end ON public.help_queue_assignments;
CREATE TRIGGER release_help_requests_on_shift_end
  AFTER UPDATE OF ended_at ON public.help_queue_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.release_help_requests_on_shift_end();
