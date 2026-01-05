DROP TRIGGER IF EXISTS trg_update_discord_profile ON auth.identities;
CREATE TRIGGER trg_update_discord_profile 
  AFTER INSERT OR UPDATE ON auth.identities 
  FOR EACH ROW 
  EXECUTE FUNCTION public.update_discord_profile();