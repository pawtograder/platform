import { test, expect, type Browser, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { createClass, createUserInClass, loginAsUser, supabase, type TestingUser } from "../TestingUtils";

type SsoConfig = {
  pawtograderBaseUrl: string;
  forgejoBaseUrl: string;
  coderBaseUrl: string;
  issuer: string;
  forgejo: {
    authSourceName: string;
    authSourceId: number;
    clientId: string;
    admin: { username: string; password: string };
  };
  coder: { clientId: string; admin: { email: string; password: string } };
};

const cfg: SsoConfig = JSON.parse(fs.readFileSync(path.join(__dirname, ".forgejo-coder-e2e.json"), "utf8"));

type ForgejoUser = { id: number; login: string; login_name: string; email: string; source_id: number };
type CoderUser = { id: string; username: string; email: string; login_type: string };

const forgejoAdminAuth =
  "Basic " + Buffer.from(`${cfg.forgejo.admin.username}:${cfg.forgejo.admin.password}`).toString("base64");

// Forgejo stores the OIDC `sub` as login_name.
async function forgejoUsersFor(user: TestingUser): Promise<ForgejoUser[]> {
  const params = new URLSearchParams({ source_id: String(cfg.forgejo.authSourceId), login_name: user.user_id });
  const res = await fetch(`${cfg.forgejoBaseUrl}/api/v1/admin/users?${params}`, {
    headers: { Authorization: forgejoAdminAuth }
  });
  expect(res.ok, `Forgejo admin users: ${res.status}`).toBeTruthy();
  return (await res.json()) as ForgejoUser[];
}

let coderAdminToken: string | undefined;
async function coderAdmin(path: string, init: RequestInit = {}): Promise<Response> {
  if (!coderAdminToken) {
    const login = await fetch(`${cfg.coderBaseUrl}/api/v2/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: cfg.coder.admin.email, password: cfg.coder.admin.password })
    });
    expect(login.ok, `Coder admin login: ${login.status}`).toBeTruthy();
    coderAdminToken = ((await login.json()) as { session_token: string }).session_token;
  }
  return fetch(`${cfg.coderBaseUrl}/api/v2${path}`, {
    ...init,
    headers: { "Coder-Session-Token": coderAdminToken, "Content-Type": "application/json", ...init.headers }
  });
}

async function coderUsersWithEmail(email: string): Promise<CoderUser[]> {
  const res = await coderAdmin(`/users?q=${encodeURIComponent(email)}`);
  expect(res.ok, `Coder users: ${res.status}`).toBeTruthy();
  const { users } = (await res.json()) as { users: CoderUser[] };
  return users.filter((u) => u.email === email);
}

async function coderUserCount(): Promise<number> {
  const res = await coderAdmin("/users?limit=1");
  expect(res.ok, `Coder users: ${res.status}`).toBeTruthy();
  return ((await res.json()) as { count: number }).count;
}

/**
 * The Coder email workspace-open gives each user (#1222). The access token hook puts the same address
 * in the coder_email claim, and Coder reads its email from that claim (CODER_OIDC_EMAIL_FIELD).
 */
const coderEmail = (user: TestingUser) => `${user.user_id}@coder.pawtograder.invalid`;

/**
 * Creates the user's Coder account the way workspace-open does: an OIDC user with the Coder email.
 * Sign-ups are off (the chart's default), so a sign-in can only land on an account made this way.
 */
async function createCoderUser(user: TestingUser, email = coderEmail(user)): Promise<CoderUser> {
  const res = await coderAdmin("/users", {
    method: "POST",
    body: JSON.stringify({
      email,
      username: `sso-e2e-${user.user_id.replace(/-/g, "").slice(0, 16)}`,
      name: "",
      login_type: "oidc",
      user_status: "active",
      // The nil id is Coder's default organization (coderd/users.go).
      organization_ids: ["00000000-0000-0000-0000-000000000000"]
    })
  });
  const body = await res.text();
  expect(res.ok, `Coder user create: ${res.status} ${body}`).toBeTruthy();
  return JSON.parse(body) as CoderUser;
}

/** The Pawtograder user id a Coder user's OIDC link is bound to, or null before their first sign-in. */
async function boundSubject(coderUserId: string): Promise<string | null> {
  const res = await coderAdmin(`/debug/${coderUserId}/debug-link`);
  const body = (await res.json()) as { detail?: string; id_token_claims?: { sub?: string } };
  if (res.status === 500 && /no rows/.test(body.detail ?? "")) return null;
  expect(res.ok, `Coder debug-link: ${res.status} ${JSON.stringify(body)}`).toBeTruthy();
  return body.id_token_claims?.sub ?? null;
}

async function coderAllowsSignups(): Promise<boolean> {
  const res = await coderAdmin("/deployment/config");
  expect(res.ok, `Coder deployment config: ${res.status}`).toBeTruthy();
  return ((await res.json()) as { config: { oidc: { allow_signups: boolean } } }).config.oidc.allow_signups;
}

async function expectConsentFor(page: Page, clientName: string, user: TestingUser) {
  await page.waitForURL(`${cfg.pawtograderBaseUrl}/oauth/consent?**`);
  await expect(page.getByRole("heading", { name: new RegExp(`${clientName} wants to use your`) })).toBeVisible();
  await expect(page.getByText(`Signed in as ${user.email}`)).toBeVisible();
}

async function signInToPawtograderForm(page: Page, user: TestingUser) {
  await page.waitForURL(`${cfg.pawtograderBaseUrl}/sign-in?**`);
  await page.getByLabel("Sign in email").fill(user.email);
  await page.getByLabel("Sign in password").fill(user.password);
  await page.getByRole("button", { name: "Sign in with email" }).click();
}

async function startForgejoSignIn(page: Page) {
  await page.goto(`${cfg.forgejoBaseUrl}/user/login`);
  await page.locator(`a[href$="/user/oauth2/${cfg.forgejo.authSourceName}"]`).click();
}

async function startCoderSignIn(page: Page) {
  await page.goto(`${cfg.coderBaseUrl}/login`);
  await page
    .getByRole("link", { name: "Sign in with Pawtograder" })
    .or(page.getByRole("button", { name: "Sign in with Pawtograder" }))
    .click();
}

async function newPage(browser: Browser) {
  const context = await browser.newContext({ baseURL: cfg.pawtograderBaseUrl });
  return context.newPage();
}

const users: Record<string, TestingUser> = {};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const klass = await createClass({ name: "SSO Forgejo Coder E2E" });
  const make = (role: "student" | "instructor", key: string) =>
    createUserInClass({ role, class_id: klass.id, name: `SSO ${key}` }).then((u) => (users[key] = u));
  await make("student", "forgejoWarm");
  await make("student", "forgejoCold");
  await make("student", "forgejoDeny");
  await make("instructor", "coderWarm");
  await make("student", "coderCold");
  await make("student", "coderDeny");
  await make("student", "coderOldEmail");
});

test.describe("Forgejo", () => {
  test("1. signed in to Pawtograder: consent, then a Forgejo account bound to the login source", async ({
    browser
  }) => {
    const user = users.forgejoWarm;
    const page = await newPage(browser);
    await loginAsUser(page, user);

    await startForgejoSignIn(page);
    await expectConsentFor(page, "Forgejo", user);
    await page.getByRole("button", { name: "Authorize" }).click();

    await page.waitForURL(`${cfg.forgejoBaseUrl}/**`);
    await expect(page.locator(".user-menu, [aria-label='Profile and settings…']").first()).toBeAttached();

    const accounts = await forgejoUsersFor(user);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe(user.email);
    expect(accounts[0].source_id).toBe(cfg.forgejo.authSourceId);
  });

  test("2. cold start: sign in to Pawtograder mid-flow, then back to consent", async ({ browser }) => {
    const user = users.forgejoCold;
    const page = await newPage(browser);

    await startForgejoSignIn(page);
    await signInToPawtograderForm(page, user);
    await expectConsentFor(page, "Forgejo", user);
    await page.getByRole("button", { name: "Authorize" }).click();

    await page.waitForURL(`${cfg.forgejoBaseUrl}/**`);
    const accounts = await forgejoUsersFor(user);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe(user.email);
  });

  test("3. deny: back on Forgejo, no account created", async ({ browser }) => {
    const user = users.forgejoDeny;
    const page = await newPage(browser);
    await loginAsUser(page, user);

    await startForgejoSignIn(page);
    await expectConsentFor(page, "Forgejo", user);
    await page.getByRole("button", { name: "Deny" }).click();

    await page.waitForURL(`${cfg.forgejoBaseUrl}/**`);
    await expect(page).not.toHaveURL(/\/oauth\/consent/);
    expect(await forgejoUsersFor(user)).toHaveLength(0);
  });

  test("4. repeat sign-in: no second consent, same account", async ({ browser }) => {
    const user = users.forgejoWarm;
    const [before] = await forgejoUsersFor(user);
    expect(before, "journey 1 must have created the account").toBeTruthy();

    const page = await newPage(browser);
    await loginAsUser(page, user);
    await startForgejoSignIn(page);

    await page.waitForURL(`${cfg.forgejoBaseUrl}/**`);
    await expect(page.locator(".user-menu, [aria-label='Profile and settings…']").first()).toBeAttached();
    await expect(page.getByRole("heading", { name: /wants to use your/ })).toHaveCount(0);

    const after = await forgejoUsersFor(user);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
  });
});

test.describe("Coder", () => {
  test("5. signed in to Pawtograder: consent, then the Coder account Pawtograder made, with the Coder email", async ({
    browser
  }) => {
    const user = users.coderWarm;
    const made = await createCoderUser(user);
    const page = await newPage(browser);
    await loginAsUser(page, user);

    await startCoderSignIn(page);
    await expectConsentFor(page, "Coder", user);
    await page.getByRole("button", { name: "Authorize" }).click();

    await page.waitForURL(`${cfg.coderBaseUrl}/**`);
    await expect(page).not.toHaveURL(/\/login/);

    const me = await page.request.get(`${cfg.coderBaseUrl}/api/v2/users/me`);
    expect(me.ok()).toBeTruthy();
    const body = (await me.json()) as CoderUser;
    expect(body.id).toBe(made.id);
    expect(body.email).toBe(coderEmail(user));
    expect(body.login_type).toBe("oidc");
    expect(await boundSubject(made.id)).toBe(user.user_id);
    // Coder rewrites the email from the claim on every sign-in; the real one never reaches it.
    expect(await coderUsersWithEmail(user.email)).toHaveLength(0);
  });

  test("6a. cold start: sign in to Pawtograder mid-flow", async ({ browser }) => {
    const user = users.coderCold;
    const made = await createCoderUser(user);
    const page = await newPage(browser);

    await startCoderSignIn(page);
    await signInToPawtograderForm(page, user);
    await expectConsentFor(page, "Coder", user);
    await page.getByRole("button", { name: "Authorize" }).click();

    await page.waitForURL(`${cfg.coderBaseUrl}/**`);
    const accounts = await coderUsersWithEmail(coderEmail(user));
    expect(accounts.map((a) => [a.id, a.login_type])).toEqual([[made.id, "oidc"]]);
    expect(await boundSubject(made.id)).toBe(user.user_id);
    expect(await coderUsersWithEmail(user.email)).toHaveLength(0);
  });

  test("6b. deny: back on Coder, not signed in, and the account stays unbound", async ({ browser }) => {
    const user = users.coderDeny;
    // An account the sign-in would land on if the deny were ignored.
    const made = await createCoderUser(user);
    expect((await coderUsersWithEmail(coderEmail(user))).map((a) => a.id)).toEqual([made.id]);
    const before = await coderUserCount();
    const page = await newPage(browser);
    await loginAsUser(page, user);

    await startCoderSignIn(page);
    await expectConsentFor(page, "Coder", user);
    await page.getByRole("button", { name: "Deny" }).click();

    await page.waitForURL(`${cfg.coderBaseUrl}/**`);
    expect((await page.request.get(`${cfg.coderBaseUrl}/api/v2/users/me`)).status()).toBe(401);
    expect(await boundSubject(made.id)).toBeNull();
    expect(await coderUserCount()).toBe(before);
  });

  test("6c. an account holding another user's old real email doesn't get that user's Coder account", async ({
    browser
  }) => {
    // A Coder user made with a real email (before the Coder email existed, or by hand), never signed
    // in to. Its owner's Pawtograder email then changes, and a new account takes the old one.
    const owner = users.coderOldEmail;
    const oldEmail = owner.email;
    const legacy = await createCoderUser(owner, oldEmail);
    const { error } = await supabase.auth.admin.updateUserById(owner.user_id, {
      email: `renamed-${oldEmail}`,
      email_confirm: true
    });
    expect(error).toBeNull();
    const klass = await createClass({ name: "SSO Coder old email" });
    const taker = await createUserInClass({ role: "student", class_id: klass.id, email: oldEmail });
    expect(taker.user_id).not.toBe(owner.user_id);

    const page = await newPage(browser);
    await loginAsUser(page, taker);
    await startCoderSignIn(page);
    await expectConsentFor(page, "Coder", taker);
    await page.getByRole("button", { name: "Authorize" }).click();
    await page.waitForURL(`${cfg.coderBaseUrl}/**`);

    const me = await page.request.get(`${cfg.coderBaseUrl}/api/v2/users/me`);
    if (await coderAllowsSignups()) {
      // A deployment with sign-ups on gives the new account its own user, with its own Coder email.
      expect(me.ok()).toBeTruthy();
      const body = (await me.json()) as CoderUser;
      expect(body.id).not.toBe(legacy.id);
      expect(body.email).toBe(coderEmail(taker));
    } else {
      // The chart's default: Coder finds no user with the new account's Coder email and refuses.
      await expect(page.getByText(/Signups are disabled/).first()).toBeVisible();
      expect(me.status()).toBe(401);
      expect(await coderUsersWithEmail(coderEmail(taker))).toHaveLength(0);
    }
    // Either way the old user is untouched: unbound, with the old email.
    expect(await boundSubject(legacy.id)).toBeNull();
    expect((await coderUsersWithEmail(oldEmail)).map((a) => a.id)).toEqual([legacy.id]);
  });
});

test("7. an unregistered redirect_uri is refused before any consent", async () => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.forgejo.clientId,
    redirect_uri: "https://attacker.example/callback",
    scope: "openid email profile",
    state: "x",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256"
  });
  const res = await fetch(`${cfg.issuer}/oauth/authorize?${params}`, { redirect: "manual" });
  expect(res.status).toBe(400);
  expect(res.headers.get("location") ?? "").not.toContain("attacker.example");
});
