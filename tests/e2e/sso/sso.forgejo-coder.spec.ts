/** CW-04: sign in to Forgejo and Coder with Pawtograder; run via tests/e2e/forgejo-coder/run-e2e.sh. */
import { test, expect, type Browser, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { createClass, createUserInClass, loginAsUser, type TestingUser } from "../TestingUtils";

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
async function coderUsersWithEmail(email: string): Promise<CoderUser[]> {
  if (!coderAdminToken) {
    const login = await fetch(`${cfg.coderBaseUrl}/api/v2/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: cfg.coder.admin.email, password: cfg.coder.admin.password })
    });
    expect(login.ok, `Coder admin login: ${login.status}`).toBeTruthy();
    coderAdminToken = ((await login.json()) as { session_token: string }).session_token;
  }
  const res = await fetch(`${cfg.coderBaseUrl}/api/v2/users?q=${encodeURIComponent(email)}`, {
    headers: { "Coder-Session-Token": coderAdminToken }
  });
  expect(res.ok, `Coder users: ${res.status}`).toBeTruthy();
  const { users } = (await res.json()) as { users: CoderUser[] };
  return users.filter((u) => u.email === email);
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
  test("5. signed in to Pawtograder: consent, then a Coder OIDC account", async ({ browser }) => {
    const user = users.coderWarm;
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
    expect(body.email).toBe(user.email);
    expect(body.login_type).toBe("oidc");
  });

  test("6a. cold start: sign in to Pawtograder mid-flow", async ({ browser }) => {
    const user = users.coderCold;
    const page = await newPage(browser);

    await startCoderSignIn(page);
    await signInToPawtograderForm(page, user);
    await expectConsentFor(page, "Coder", user);
    await page.getByRole("button", { name: "Authorize" }).click();

    await page.waitForURL(`${cfg.coderBaseUrl}/**`);
    const [account] = await coderUsersWithEmail(user.email);
    expect(account?.login_type).toBe("oidc");
  });

  test("6b. deny: back on Coder, no account created", async ({ browser }) => {
    const user = users.coderDeny;
    const page = await newPage(browser);
    await loginAsUser(page, user);

    await startCoderSignIn(page);
    await expectConsentFor(page, "Coder", user);
    await page.getByRole("button", { name: "Deny" }).click();

    await page.waitForURL(`${cfg.coderBaseUrl}/**`);
    expect(await coderUsersWithEmail(user.email)).toHaveLength(0);
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
