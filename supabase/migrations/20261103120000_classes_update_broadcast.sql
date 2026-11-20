-- Broadcast class row updates to the students topic and the staff topic.
--
-- Subscribers on class:<id>:students are authorized by authorizeforclass, the same check as the
-- "Read if in in class" SELECT policy on public.classes. The payload is the full row, which relies
-- on members being able to read every column of classes. If a column is ever hidden from students,
-- this trigger must send a narrower payload.
--
-- Staff subscribe to class:<id>:staff, so they don't join the students topic and receive its events
-- too. The trigger skips updates that change nothing.

CREATE OR REPLACE FUNCTION public.broadcast_classes_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  payload jsonb;
BEGIN
  payload := jsonb_build_object(
    'type', 'classes_update',
    'class_id', NEW.id,
    'data', to_jsonb(NEW),
    'timestamp', now()
  );
  PERFORM public.safe_broadcast(payload, 'broadcast', 'class:' || NEW.id || ':students', true);
  PERFORM public.safe_broadcast(payload, 'broadcast', 'class:' || NEW.id || ':staff', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_classes_update ON public.classes;

CREATE TRIGGER trg_broadcast_classes_update
  AFTER UPDATE ON public.classes
  FOR EACH ROW
  WHEN (OLD IS DISTINCT FROM NEW)
  EXECUTE FUNCTION public.broadcast_classes_update();
