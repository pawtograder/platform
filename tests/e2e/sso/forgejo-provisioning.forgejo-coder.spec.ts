import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { createClass, createUserInClass, loginAsUser, supabase, type TestingUser } from "../TestingUtils";

// forgejo-reconciler (#1092, #1093): Pawtograder creates the student's Forgejo account and repo before
// they ever sign in, and their first sign-in lands on that account. The lane turns on Forgejo's
// auto-registration, so a sign-in that failed to match would quietly create a second account.

type SsoConfig = {
  pawtograderBaseUrl: string;
  forgejoBaseUrl: string;
  forgejo: { authSourceName: string; authSourceId: number; admin: { username: string; password: string } };
};
const cfg: SsoConfig = JSON.parse(fs.readFileSync(path.join(__dirname, ".forgejo-coder-e2e.json"), "utf8"));
const forgejoAuth =
  "Basic " + Buffer.from(`${cfg.forgejo.admin.username}:${cfg.forgejo.admin.password}`).toString("base64");

async function forgejo(method: string, apiPath: string, body?: unknown) {
  return fetch(`${cfg.forgejoBaseUrl}/api/v1${apiPath}`, {
    method,
    headers: { Authorization: forgejoAuth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function forgejoAccountsFor(user: TestingUser): Promise<{ id: number; login: string }[]> {
  const query = new URLSearchParams({ source_id: String(cfg.forgejo.authSourceId), login_name: user.user_id });
  const res = await forgejo("GET", `/admin/users?${query}`);
  expect(res.ok, `Forgejo admin users: ${res.status}`).toBeTruthy();
  return res.json();
}

// The lane runs Supabase without the edge runtime, so the pass runs under Deno directly.
function runPass(): { accounts: number; repos: number; groupRepos: number; hashes: number; failures: string[] } {
  const out = execFileSync(
    "deno",
    [
      "run",
      "--no-check",
      "--allow-env",
      "--allow-net",
      "--allow-read",
      "supabase/functions/forgejo-reconciler/run-pass.ts"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FORGEJO_URL: cfg.forgejoBaseUrl,
        FORGEJO_ADMIN_USERNAME: cfg.forgejo.admin.username,
        FORGEJO_ADMIN_PASSWORD: cfg.forgejo.admin.password,
        FORGEJO_AUTH_SOURCE_ID: String(cfg.forgejo.authSourceId)
      }
    }
  );
  return JSON.parse(out.trim().split("\n").pop()!);
}

test.describe.configure({ mode: "serial" });

let student: TestingUser;
let assignmentSlug: string;

test.beforeAll(async () => {
  const klass = await createClass({ name: "Forgejo provisioning E2E" });
  // Not setCourseFeature: it also revalidates a page cache, through an E2E-only route this lane's server doesn't serve.
  const { error: flagError } = await supabase.rpc("merge_class_feature_as_service_role", {
    p_class_id: klass.id,
    p_name: "cloud-workspaces",
    p_enabled: true
  });
  if (flagError) throw flagError;
  student = await createUserInClass({ role: "student", class_id: klass.id, name: "Forgejo provisioning student" });

  // The handout lives on Forgejo; setting it up there is #1237.
  const staffOrg = `e2e-staff-${klass.id}`;
  expect((await forgejo("POST", "/orgs", { username: staffOrg, visibility: "private" })).status).toBe(201);
  expect(
    (await forgejo("POST", `/orgs/${staffOrg}/repos`, { name: "handout", auto_init: true, private: true })).status
  ).toBe(201);
  expect((await forgejo("PATCH", `/repos/${staffOrg}/handout`, { template: true })).ok).toBeTruthy();

  const { data: settings, error: settingsError } = await supabase
    .from("assignment_self_review_settings")
    .insert({ class_id: klass.id })
    .select("id")
    .single();
  if (settingsError) throw settingsError;
  assignmentSlug = `hw-${klass.id}`;
  const { error } = await supabase.from("assignments").insert({
    class_id: klass.id,
    title: "Forgejo provisioning",
    slug: assignmentSlug,
    due_date: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    release_date: new Date(Date.now() - 60_000).toISOString(),
    group_config: "individual",
    template_repo: `${staffOrg}/handout`,
    git_provider: "forgejo",
    self_review_setting_id: settings.id
  });
  if (error) throw error;
});

test("a pass creates the student's account and repo, and a second pass changes nothing", async () => {
  const first = runPass();
  expect(first.failures).toEqual([]);

  const [account] = await forgejoAccountsFor(student);
  expect(account, "the pass should have created the student's Forgejo account").toBeTruthy();

  const { data: repo } = await supabase
    .from("repositories")
    .select("repository, git_provider, is_github_ready")
    .eq("profile_id", student.private_profile_id)
    .single();
  expect(repo).toEqual({
    repository: expect.stringMatching(new RegExp(`/${assignmentSlug}-${account.login}$`)),
    git_provider: "forgejo",
    is_github_ready: true
  });

  const permission = await forgejo("GET", `/repos/${repo!.repository}/collaborators/${account.login}/permission`);
  expect(((await permission.json()) as { permission: string }).permission).toBe("write");

  const second = runPass();
  expect(second).toEqual({ accounts: 0, repos: 0, groupRepos: 0, hashes: 0, failures: [] });
});

test("the student's first sign-in lands on that account, which can see the repo", async ({ browser }) => {
  const [before] = await forgejoAccountsFor(student);

  const page = await (await browser.newContext({ baseURL: cfg.pawtograderBaseUrl })).newPage();
  await loginAsUser(page, student);
  await page.goto(`${cfg.forgejoBaseUrl}/user/login`);
  await page.locator(`a[href$="/user/oauth2/${cfg.forgejo.authSourceName}"]`).click();
  await page.getByRole("button", { name: "Authorize" }).click();
  await page.waitForURL(`${cfg.forgejoBaseUrl}/**`);

  const after = await forgejoAccountsFor(student);
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(before.id);
  await expect(page.getByRole("link", { name: new RegExp(`${assignmentSlug}-${before.login}`) })).toBeVisible();
});
