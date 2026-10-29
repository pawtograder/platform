-- Broadcast course row updates on the students topic instead of relying on postgres_changes.
--
-- Subscribers on class:<id>:students are already authorized by authorizeforclass, which is the
-- same check as the "Read if in in class" SELECT policy on public.classes. Broadcasting from a
-- trigger keeps every class subscriber on one channel and removes the per-course postgres_changes
-- channel from the client.

CREATE OR REPLACE FUNCTION public.broadcast_classes_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.safe_broadcast(
    jsonb_build_object(
      'type', 'classes_update',
      'class_id', NEW.id,
      'data', to_jsonb(NEW),
      'timestamp', now()
    ),
    'broadcast',
    'class:' || NEW.id || ':students',
    true
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_classes_update ON public.classes;

CREATE TRIGGER trg_broadcast_classes_update
  AFTER UPDATE ON public.classes
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_classes_update();
