-- Migration to add audit trigger to profiles table
-- This trigger logs all profile changes (including name edits) to the audit table
-- Uses the existing audit_insert_and_update() function for consistency with other audited tables

CREATE TRIGGER profiles_audit_trigger
AFTER INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.audit_insert_and_update();
