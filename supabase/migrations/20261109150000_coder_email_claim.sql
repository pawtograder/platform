-- CW-17c (#1222): a Coder email that only the token's own subject can present.
--
-- Coder v2.37.3 finds the user for a first OIDC sign-in by email (coderd/userauth.go:2223-2283), and
-- no API binds a subject in advance. A real email can move from one Pawtograder account to another,
-- so workspace-open creates each Coder user with `<auth user id>@coder.pawtograder.invalid`, and
-- Coder reads the email from this claim (CODER_OIDC_EMAIL_FIELD=coder_email in the chart).
--
-- GoTrue's OAuth server builds its ID token and userinfo from a fixed set of claims with no hook
-- (internal/tokens/service.go GenerateIDToken, internal/api/oauthserver/handlers.go OAuthUserInfo,
-- v2.186.0 and v2.189.0), so the claim goes in the access token. Coder reads access token claims
-- with CODER_OIDC_ACCESS_TOKEN_CLAIMS and verifies that token like an ID token, which requires the
-- OAuth client id in `aud`.
--
-- Only tokens issued to Coder's OAuth client change. That client is the one
-- scripts/setup-sso-clients.sh registers: named "Coder", with Coder's OIDC callback
-- (<coder url>/api/v2/users/oidc/callback) as a redirect URI. The script recognises its own Coder
-- client the same way, and tests/e2e/sso/register-oauth-clients.ts registers the same name and URI.
-- GoTrue's client id is auth.oauth_clients.id, and redirect_uris is comma-separated
-- (internal/models/oauth_client.go). Pawtograder's own sessions (no client_id) and every other
-- client's tokens, such as Forgejo's, get the event back unchanged.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path = ''
AS $function$
DECLARE
  claims jsonb := event->'claims';
  aud jsonb;
BEGIN
  IF coalesce(claims->>'client_id', '') = '' THEN
    RETURN event;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM auth.oauth_clients c
    WHERE c.id::text = claims->>'client_id'
      AND c.deleted_at IS NULL
      AND c.client_name = 'Coder'
      AND EXISTS (
        SELECT 1 FROM unnest(string_to_array(c.redirect_uris, ',')) AS r(uri)
        WHERE r.uri LIKE '%/api/v2/users/oidc/callback'
      )
  ) THEN
    RETURN event;
  END IF;
  aud := CASE jsonb_typeof(claims->'aud')
    WHEN 'array' THEN claims->'aud'
    WHEN 'string' THEN jsonb_build_array(claims->'aud')
    ELSE '[]'::jsonb
  END;
  IF NOT aud @> jsonb_build_array(claims->'client_id') THEN
    aud := aud || jsonb_build_array(claims->'client_id');
  END IF;
  -- Must match CODER_EMAIL_DOMAIN in supabase/functions/_shared/CoderWorkspace.ts.
  claims := claims || jsonb_build_object(
    'aud', aud,
    'coder_email', lower(event->>'user_id') || '@coder.pawtograder.invalid'
  );
  RETURN jsonb_set(event, '{claims}', claims);
END;
$function$;
