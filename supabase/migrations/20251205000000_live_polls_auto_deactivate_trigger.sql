-- Trigger to automatically set deactivates_at when is_live becomes true
CREATE OR REPLACE FUNCTION public.set_poll_deactivates_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When is_live changes from false to true, set deactivates_at to 1 hour from now
  IF NEW.is_live = true AND (OLD.is_live = false OR OLD.is_live IS NULL) THEN
    NEW.deactivates_at := NOW() + INTERVAL '1 hour';
  END IF;
  
  -- When is_live changes from true to false, clear deactivates_at
  IF NEW.is_live = false AND OLD.is_live = true THEN
    NEW.deactivates_at := NULL;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create the trigger
DROP TRIGGER IF EXISTS set_poll_deactivates_at_trigger ON live_polls;
CREATE TRIGGER set_poll_deactivates_at_trigger
  BEFORE UPDATE ON live_polls
  FOR EACH ROW
  EXECUTE FUNCTION public.set_poll_deactivates_at();

COMMENT ON FUNCTION public.set_poll_deactivates_at() IS 
'Automatically sets deactivates_at to 1 hour when is_live becomes true, and clears it when is_live becomes false.';

