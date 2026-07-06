/**
 * Register (upsert) the local Canvas instance as an LTI platform in Pawtograder's
 * database, so the tool will accept launches from it and can call NRPS/AGS.
 *
 * Standalone (run via tsx) — deliberately uses @supabase/supabase-js directly
 * with the service role key, and does NOT import lib/lti/* (those are
 * `server-only`). The tool's signing key is created lazily on first /api/lti/jwks
 * hit, so this script only needs to write the platform row.
 *
 * Required env:
 *   SUPABASE_URL                 e.g. http://127.0.0.1:54321
 *   SUPABASE_SERVICE_ROLE_KEY    local service-role key (npx supabase status)
 *   CANVAS_ISSUER                id_token `iss` (e.g. https://canvas.instructure.com)
 *   CANVAS_CLIENT_ID             developer key global id (from create_dev_key.rb)
 *   CANVAS_BASE_URL              tool-reachable Canvas base (e.g. http://localhost:3001)
 * Optional:
 *   CANVAS_PLATFORM_NAME         default "Local Canvas (e2e)"
 */
import { createClient } from "@supabase/supabase-js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const supabaseUrl = need("SUPABASE_URL");
  const serviceKey = need("SUPABASE_SERVICE_ROLE_KEY");
  const issuer = need("CANVAS_ISSUER");
  const clientId = need("CANVAS_CLIENT_ID");
  const base = need("CANVAS_BASE_URL").replace(/\/$/, "");
  const name = process.env.CANVAS_PLATFORM_NAME ?? "Local Canvas (e2e)";

  // Canvas LTI 1.3 platform endpoints (stable paths).
  const authLoginUrl = `${base}/api/lti/authorize_redirect`;
  const tokenUrl = `${base}/login/oauth2/token`;
  const jwksUrl = `${base}/api/lti/security/jwks`;

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Find existing row for (issuer, client_id) so re-runs update in place.
  const { data: existing, error: selErr } = await supabase
    .from("lti_platforms")
    .select("id")
    .eq("issuer", issuer)
    .eq("client_id", clientId)
    .maybeSingle();
  if (selErr) throw selErr;

  const { data, error } = await supabase.rpc("admin_upsert_lti_platform", {
    p_id: existing?.id ?? null,
    p_name: name,
    p_issuer: issuer,
    p_client_id: clientId,
    p_auth_login_url: authLoginUrl,
    p_token_url: tokenUrl,
    p_jwks_url: jwksUrl,
    p_enabled: true
  });
  if (error) throw error;

  console.log(`Registered LTI platform "${name}"`);
  console.log(`  issuer=${issuer}`);
  console.log(`  client_id=${clientId}`);
  console.log(`  auth=${authLoginUrl}`);
  console.log(`  token=${tokenUrl}`);
  console.log(`  jwks=${jwksUrl}`);
  console.log(`  row=${JSON.stringify(data)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
