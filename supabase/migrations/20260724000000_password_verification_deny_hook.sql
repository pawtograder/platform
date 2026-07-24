-- Always-deny password-verification hook for SSO-only deployments.
--
-- Background: GoTrue / Supabase Auth has no config flag to disable the password
-- grant (grant_type=password / signInWithPassword) while keeping the email
-- provider on for magic-link / OTP — the email provider is a single on/off
-- (GOTRUE_EXTERNAL_EMAIL_ENABLED) covering both. To go SSO-only WITHOUT losing
-- magic-link (e.g. admin break-glass via the GoTrue admin generate_link API),
-- we enforce password-off with the password-verification hook instead.
--
-- GoTrue calls this hook (as supabase_auth_admin) on every password sign-in
-- attempt, AFTER checking the password, with { "user_id": uuid, "valid": bool }.
-- Returning decision=reject blocks the sign-in even when the password was
-- correct. The hook fires ONLY for password verification — never for
-- magic-link / OTP / OAuth — so those flows are unaffected.
--
-- The function is created unconditionally (harmless if never called). It is
-- only wired up when a deployment sets auth.enablePasswordLogin=false, which
-- renders GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_{ENABLED,URI} pointing here
-- (see charts/pawtograder/templates/auth.yaml). Default deployments leave the
-- hook disabled, so email + password keeps working unchanged.
--
-- Docs: https://supabase.com/docs/guides/auth/auth-hooks/password-verification-hook

CREATE OR REPLACE FUNCTION public.password_verification_hook(event jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    -- Ignore the event; password sign-in is disabled for this deployment.
    SELECT jsonb_build_object(
        'decision', 'reject',
        'message', 'Password sign-in is disabled. Please use single sign-on.'
    );
$$;

COMMENT ON FUNCTION public.password_verification_hook(jsonb) IS
    'GoTrue password-verification hook: always rejects, disabling password sign-in for SSO-only deployments (wired only when auth.enablePasswordLogin=false). Magic-link / OTP are unaffected.';

-- Lock down execution to the GoTrue admin role only. This is an auth hook, not
-- a PostgREST RPC: the API roles must never reach it. CREATE OR REPLACE
-- preserves prior ACLs, so revoke explicitly to guarantee the end state.
REVOKE ALL ON FUNCTION public.password_verification_hook(jsonb)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.password_verification_hook(jsonb) TO supabase_auth_admin;
