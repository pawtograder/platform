-- Server-side pepper for assessment export tokenization. Combined with the
-- per-run CLI salt inside the edge function so dump recipients cannot recompute
-- subject/submission tokens offline even if they capture the salt from network
-- traffic. Each deployment gets its own random pepper at first migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'assessment-export-pepper') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'base64'),
      'assessment-export-pepper',
      'Server-side pepper for assessment export HMAC tokenization'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_assessment_export_pepper()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pepper text;
BEGIN
  SELECT decrypted_secret INTO v_pepper
  FROM vault.decrypted_secrets
  WHERE name = 'assessment-export-pepper'
  LIMIT 1;

  IF v_pepper IS NULL OR length(v_pepper) < 32 THEN
    RAISE EXCEPTION 'assessment-export-pepper vault secret is missing or shorter than 32 characters';
  END IF;

  RETURN v_pepper;
END;
$$;

REVOKE ALL ON FUNCTION public.get_assessment_export_pepper() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_assessment_export_pepper() TO service_role;
