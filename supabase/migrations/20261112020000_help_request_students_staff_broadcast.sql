-- Send help_request_students changes to the class's office hours staff channel too.
--
-- broadcast_help_request_data_change sends each help_request_students change only to
-- help_request:<id>. A TA joins that channel when they open the request, not while they look at
-- the queue. When a student creates a request, nobody holds a lease on help_request:<id> yet, so
-- safe_broadcast sends nothing. A TA who already had office hours open never gets the new
-- request's roster rows, and the request shows "0 students" until the TA reloads. The same happens
-- when a student is added to or removed from a request that the TA does not have open.
--
-- Every TA with office hours open has joined help_queues:<class_id>:staff, and only graders and
-- instructors may join it (check_unified_realtime_authorization). Staff can already read every
-- help_request_students row in their class, so they get nothing on this channel that a reload
-- wouldn't show them.
--
-- This is a second trigger rather than a change to broadcast_help_request_data_change, because
-- that function also sends chat messages, read receipts, feedback, file references, work sessions
-- and student_help_activity changes. A TA who has the request open now gets each roster change
-- twice, once on each channel. When a message about an inserted row arrives and the
-- helpRequestStudents cache already has that row, TableController skips the message.

CREATE OR REPLACE FUNCTION public.broadcast_help_request_students_to_staff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;

  -- Same payload as the help_request:<id> broadcast, so the client handles both the same way.
  PERFORM public.safe_broadcast(
    jsonb_build_object(
      'type', 'request_change',
      'operation', TG_OP,
      'table', TG_TABLE_NAME,
      'row_id', v_row.id,
      'help_request_id', v_row.help_request_id,
      'class_id', v_row.class_id,
      'data', to_jsonb(v_row),
      'timestamp', now()
    ),
    'broadcast',
    'help_queues:' || v_row.class_id || ':staff',
    true
  );

  RETURN NULL;
END;
$$;

-- Only the trigger calls it.
REVOKE ALL ON FUNCTION public.broadcast_help_request_students_to_staff() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS broadcast_help_request_students_to_staff ON public.help_request_students;
CREATE TRIGGER broadcast_help_request_students_to_staff
AFTER INSERT OR UPDATE OR DELETE ON public.help_request_students
FOR EACH ROW EXECUTE FUNCTION public.broadcast_help_request_students_to_staff();
