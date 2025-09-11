-- Automatically accept/reactivate invitations when they change from expired -> pending
-- This complements the existing triggers that run on INSERT and on section updates


-- Create a trigger that fires when an invitation status transitions from 'expired' to 'pending'
CREATE OR REPLACE TRIGGER trigger_auto_accept_invitation_on_reactivation
AFTER UPDATE ON public.invitations
FOR EACH ROW
WHEN (OLD.status = 'expired' AND NEW.status = 'pending')
EXECUTE FUNCTION public.auto_accept_invitation_if_user_exists();


