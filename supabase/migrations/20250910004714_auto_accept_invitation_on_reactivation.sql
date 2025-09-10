-- Automatically accept/reactivate invitations when they change from expired -> pending
-- This complements the existing triggers that run on INSERT and on section updates

-- Wrapper trigger function to keep intent clear in logs/catalog while delegating
-- to the existing acceptance logic.
CREATE OR REPLACE FUNCTION public.auto_accept_invitation_on_reactivation() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
AS $$
BEGIN
  -- Delegate to existing logic which handles pending invitations by creating/updating user_roles
  RETURN public.auto_accept_invitation_if_user_exists();
END;
$$;

-- Create a trigger that fires when an invitation status transitions from 'expired' to 'pending'
CREATE OR REPLACE TRIGGER trigger_auto_accept_invitation_on_reactivation
AFTER UPDATE ON public.invitations
FOR EACH ROW
WHEN (OLD.status = 'expired' AND NEW.status = 'pending')
EXECUTE FUNCTION public.auto_accept_invitation_on_reactivation();


