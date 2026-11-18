/**
 * DB-level coverage for the access token hook's Coder email claim
 * (20261113210100_coder_email_claim.sql, #1222). Only tokens issued to Coder's OAuth client gain
 * `coder_email` and Coder's client id in `aud`. Pawtograder's own sessions and every other OAuth
 * client's tokens, such as Forgejo's, come out of the hook unchanged.
 *
 * The clients are registered the way scripts/setup-sso-clients.sh registers them: "Forgejo" with
 * Forgejo's login-source callback, and "Coder" with Coder's OIDC callback. The hook is checked twice:
 * called directly with the claims GoTrue passes it, and through GoTrue, by decoding real access
 * tokens from a password-less session and from an authorization-code exchange for each client.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { test, expect } from "../global-setup";
import { createClass, createUserInClass, getAuthTokenForUser, type TestingUser } from "./TestingUtils";

test.use({ trace: "off", video: "off", screenshot: "off" });
test.skip(({ browserName }) => browserName !== "chromium", "database-only spec; runs in the chromium project only");

const DB_URL =
  process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const AUTH = `${process.env.SUPABASE_URL!.replace(/\/$/, "")}/auth/v1`;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!;

type OAuthClient = { client_id: string; client_secret: string; redirect_uri: string };
type Claims = Record<string, unknown>;

async function gotrue<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${AUTH}${path}`, {
    ...init,
    headers: {
      apikey: token === SERVICE_KEY ? SERVICE_KEY : ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers
    }
  });
  const body = await res.text();
  expect(res.ok, `${init.method ?? "GET"} ${path}: ${res.status} ${body}`).toBeTruthy();
  return (body ? JSON.parse(body) : null) as T;
}

async function registerClient(name: string, redirectUri: string): Promise<OAuthClient> {
  const c = await gotrue<{ client_id: string; client_secret: string }>("/admin/oauth/clients", SERVICE_KEY, {
    method: "POST",
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], client_type: "confidential" })
  });
  return { client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirectUri };
}

function payload(jwt: string): Claims {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}

/**
 * `aud` as a list. GoTrue turns off golang-jwt's MarshalSingleStringAsArray only when it first
 * signs a token (internal/tokens/service.go:960, v2.189.0), so the hook input of the first token
 * after a GoTrue start carries ["authenticated"], and later ones "authenticated", whatever the hook does.
 */
function audience(claims: Claims): unknown[] {
  return [claims.aud].flat();
}

/** The authorization-code flow a client runs, with the consent step the consent page performs. */
async function oauthAccessToken(client: OAuthClient, user: TestingUser): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uri,
    scope: "openid email profile",
    state: randomUUID(),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256"
  });
  const authorize = await fetch(`${AUTH}/oauth/authorize?${params}`, { redirect: "manual" });
  const consentUrl = new URL(authorize.headers.get("location") ?? "", "http://x");
  const authorizationId = consentUrl.searchParams.get("authorization_id");
  expect(authorizationId, `authorize: ${authorize.status} ${authorize.headers.get("location")}`).toBeTruthy();

  const session = await getAuthTokenForUser(user);
  const details = await gotrue<{ authorization_id?: string; redirect_url?: string }>(
    `/oauth/authorizations/${authorizationId}`,
    session
  );
  const back = details.authorization_id
    ? (
        await gotrue<{ redirect_url: string }>(`/oauth/authorizations/${authorizationId}/consent`, session, {
          method: "POST",
          body: JSON.stringify({ action: "approve" })
        })
      ).redirect_url
    : details.redirect_url!;
  const code = new URL(back).searchParams.get("code");
  expect(code, `consent redirect: ${back}`).toBeTruthy();

  const res = await fetch(`${AUTH}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: client.redirect_uri,
      code_verifier: verifier
    })
  });
  const body = await res.text();
  expect(res.ok, `token: ${res.status} ${body}`).toBeTruthy();
  return (JSON.parse(body) as { access_token: string }).access_token;
}

/** The event GoTrue passes the hook, shaped like its AccessTokenClaims. */
function hookEvent(user: TestingUser, clientId?: string) {
  const now = Math.floor(Date.now() / 1000);
  const claims: Claims = {
    iss: AUTH,
    sub: user.user_id,
    aud: "authenticated",
    exp: now + 3600,
    iat: now,
    email: user.email,
    phone: "",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { email_verified: true },
    role: "authenticated",
    aal: "aal1",
    amr: [{ method: clientId ? "oauth" : "password", timestamp: now }],
    session_id: randomUUID(),
    is_anonymous: false,
    ...(clientId ? { client_id: clientId } : {})
  };
  return { user_id: user.user_id, claims, authentication_method: clientId ? "oauth" : "password" };
}

test.describe("the access token hook adds coder_email only to Coder's tokens", () => {
  test.setTimeout(120_000);
  let pg: Client;
  let user: TestingUser;
  let forgejo: OAuthClient;
  let coder: OAuthClient;
  let namedCoderElsewhere: OAuthClient;
  const runHook = async (event: object) =>
    (await pg.query("select public.custom_access_token_hook($1::jsonb) as out", [JSON.stringify(event)])).rows[0]
      .out as { claims: Claims };

  test.beforeAll(async () => {
    pg = new Client({ connectionString: DB_URL });
    await pg.connect();
    const course = await createClass({ name: "Coder email claim" });
    user = await createUserInClass({ role: "student", class_id: course.id, name: "Claim Student" });
    const tag = randomUUID().slice(0, 8);
    forgejo = await registerClient("Forgejo", `http://localhost:3100/user/oauth2/pawtograder-${tag}/callback`);
    coder = await registerClient("Coder", "http://localhost:7080/api/v2/users/oidc/callback");
    // The name alone doesn't make a client Coder's.
    namedCoderElsewhere = await registerClient("Coder", `http://localhost:7080/elsewhere-${tag}/callback`);
  });

  test.afterAll(async () => {
    for (const c of [forgejo, coder, namedCoderElsewhere]) {
      if (c)
        await fetch(`${AUTH}/admin/oauth/clients/${c.client_id}`, {
          method: "DELETE",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        });
    }
    await pg?.end();
  });

  test("an ordinary session's claims come back unchanged", async () => {
    const event = hookEvent(user);
    expect(await runHook(event)).toEqual(event);

    const token = payload(await getAuthTokenForUser(user));
    expect(token.sub).toBe(user.user_id);
    expect(audience(token)).toEqual(["authenticated"]);
    expect(token).not.toHaveProperty("coder_email");
    expect(token).not.toHaveProperty("client_id");
  });

  test("Forgejo's claims, and another client named Coder, come back unchanged", async () => {
    for (const c of [forgejo, namedCoderElsewhere]) {
      const event = hookEvent(user, c.client_id);
      expect(await runHook(event)).toEqual(event);
    }

    const token = payload(await oauthAccessToken(forgejo, user));
    expect(token.client_id).toBe(forgejo.client_id);
    expect(audience(token)).toEqual(["authenticated"]);
    expect(token).not.toHaveProperty("coder_email");
  });

  test("Coder's claims gain coder_email and Coder's client id in aud, and nothing else changes", async () => {
    const event = hookEvent(user, coder.client_id);
    const out = await runHook(event);
    expect(out).toEqual({
      ...event,
      claims: {
        ...event.claims,
        aud: ["authenticated", coder.client_id],
        coder_email: `${user.user_id}@coder.pawtograder.invalid`
      }
    });

    const token = payload(await oauthAccessToken(coder, user));
    expect(token.client_id).toBe(coder.client_id);
    expect(token.aud).toEqual(["authenticated", coder.client_id]);
    expect(token.coder_email).toBe(`${user.user_id}@coder.pawtograder.invalid`);
    expect(token.email).toBe(user.email);
  });
});
