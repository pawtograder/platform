// Raw GoTrue admin REST (supabase-js predates `auth.admin.oauth.*`); clients are re-created because GoTrue returns the secret only at creation.

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env ${name}`);
    process.exit(1);
  }
  return v.replace(/\/$/, "");
}

type OAuthClient = { client_id: string; client_secret?: string; client_name: string; redirect_uris: string[] };

async function main() {
  const auth = `${need("SUPABASE_URL")}/auth/v1`;
  const serviceKey = need("SUPABASE_SERVICE_ROLE_KEY");
  const forgejo = need("FORGEJO_BASE_URL");
  const coder = need("CODER_BASE_URL");
  const sourceName = process.env.FORGEJO_AUTH_SOURCE_NAME ?? "pawtograder";
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };

  const wanted = [
    { key: "FORGEJO", client_name: "Forgejo", redirect_uris: [`${forgejo}/user/oauth2/${sourceName}/callback`] },
    { key: "CODER", client_name: "Coder", redirect_uris: [`${coder}/api/v2/users/oidc/callback`] }
  ];

  const listRes = await fetch(`${auth}/admin/oauth/clients?per_page=1000`, { headers });
  if (!listRes.ok) throw new Error(`list clients: ${listRes.status} ${await listRes.text()}`);
  const listed = (await listRes.json()) as { clients?: OAuthClient[] } | OAuthClient[];
  const existing = Array.isArray(listed) ? listed : (listed.clients ?? []);

  for (const w of wanted) {
    for (const old of existing.filter((c) => c.client_name === w.client_name)) {
      const del = await fetch(`${auth}/admin/oauth/clients/${old.client_id}`, { method: "DELETE", headers });
      if (!del.ok && del.status !== 404) throw new Error(`delete ${old.client_id}: ${del.status}`);
    }
    const res = await fetch(`${auth}/admin/oauth/clients`, {
      method: "POST",
      headers,
      body: JSON.stringify({ client_name: w.client_name, redirect_uris: w.redirect_uris, client_type: "confidential" })
    });
    if (!res.ok) throw new Error(`create ${w.client_name}: ${res.status} ${await res.text()}`);
    const c = (await res.json()) as OAuthClient;
    if (!c.client_secret) throw new Error(`create ${w.client_name}: no client_secret in response`);
    console.log(`${w.key}_OIDC_CLIENT_ID=${c.client_id}`);
    console.log(`${w.key}_OIDC_CLIENT_SECRET=${c.client_secret}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
