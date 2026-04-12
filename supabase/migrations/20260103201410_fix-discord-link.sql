CREATE TRIGGER trg_update_discord_profile_on_update 
  AFTER UPDATE ON auth.identities 
  FOR EACH ROW 
  EXECUTE FUNCTION public.update_discord_profile();