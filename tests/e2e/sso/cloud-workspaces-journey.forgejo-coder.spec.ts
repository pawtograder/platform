import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import {
  createClass,
  createSampleGradingResult,
  createUserInClass,
  insertAssignment,
  loginAsUser,
  supabase,
  type TestingUser
} from "../TestingUtils";

// The cloud workspaces journey (CW-63 #1103, CW-65 #1105), once per Git host: an instructor turns Cloud
// workspaces on from Feature flags, a student gets their repository, opens it in Coder from the assignment page,
// watches the workspace start until it is ready with the repository cloned, and pushes a #submit commit from
// the workspace. Turning the flag off hides Open in Coder again.
//
// What's real and what isn't (tests/e2e/forgejo-coder/README.md, "Cloud workspaces journey"):
// - Real: Supabase, Pawtograder's pages, the feature flag switch, forgejo-reconciler's pass, Forgejo, Coder, the
//   workspace-open, workspace-status and forgejo-repo-webhook functions (unmodified, under Deno, since the lane
//   has no edge runtime), the chart's clone.sh, startup script and code-server, a real Coder agent, and the
//   student's git push from inside the workspace.
// - Stand-ins: the workspace runs in a container instead of a Kubernetes pod (coder-template/main.tf). GitHub is
//   played by the same Forgejo under another origin, with Forgejo's OAuth2 provider in Coder's GitHub
//   external-auth slot. The GitHub assignment and its repository row are seeded, as GitHub would have created
//   the repository. GitHub's push webhook and Actions run are the suite's usual e2e stand-ins: a check run row
//   and the e2e job token (E2E_MOCK_GITHUB), as in create-submission.test.tsx.
// - Not covered: grading a Forgejo push. That needs a Forgejo Actions runner, which the lane doesn't have.

type LaneConfig = {
  pawtograderBaseUrl: string;
  forgejoBaseUrl: string;
  coderBaseUrl: string;
  forgejo: { authSourceName: string; authSourceId: number; admin: { username: string; password: string } };
  coder: { admin: { email: string; password: string } };
  autoApproveForgejo?: boolean;
  forgejoLoginRedirect?: boolean;
  journey?: { functionsBaseUrl: string; githubStandinUrl: string; webhookSecret: string };
};
const cfg: LaneConfig = JSON.parse(fs.readFileSync(path.join(__dirname, ".forgejo-coder-e2e.json"), "utf8"));
const journey = cfg.journey;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const forgejoAuth =
  "Basic " + Buffer.from(`${cfg.forgejo.admin.username}:${cfg.forgejo.admin.password}`).toString("base64");

async function forgejo(method: string, apiPath: string, body?: unknown): Promise<Response> {
  return fetch(`${cfg.forgejoBaseUrl}/api/v1${apiPath}`, {
    method,
    headers: { Authorization: forgejoAuth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function forgejoLoginFor(user: TestingUser): Promise<string> {
  const query = new URLSearchParams({ source_id: String(cfg.forgejo.authSourceId), login_name: user.user_id });
  const res = await forgejo("GET", `/admin/users?${query}`);
  expect(res.ok, `Forgejo admin users: ${res.status}`).toBeTruthy();
  const [account] = (await res.json()) as { login: string }[];
  expect(account, "forgejo-reconciler should have created the student's Forgejo account").toBeTruthy();
  return account.login;
}

async function forgejoHead(repository: string): Promise<string> {
  const res = await forgejo("GET", `/repos/${repository}/branches/main`);
  expect(res.ok, `Forgejo branch main of ${repository}: ${res.status}`).toBeTruthy();
  return ((await res.json()) as { commit: { id: string } }).commit.id;
}

let coderSession: string | undefined;
async function coderAdminSession(): Promise<string> {
  if (!coderSession) {
    const res = await fetch(`${cfg.coderBaseUrl}/api/v2/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: cfg.coder.admin.email, password: cfg.coder.admin.password })
    });
    expect(res.ok, `Coder admin login: ${res.status}`).toBeTruthy();
    coderSession = ((await res.json()) as { session_token: string }).session_token;
  }
  return coderSession;
}

async function coderBoundSubject(coderUserId: string): Promise<string | null> {
  const res = await fetch(`${cfg.coderBaseUrl}/api/v2/debug/${coderUserId}/debug-link`, {
    headers: { "Coder-Session-Token": await coderAdminSession() }
  });
  const body = (await res.json()) as { detail?: string; id_token_claims?: { sub?: string } };
  if (res.status === 500 && /no rows/.test(body.detail ?? "")) return null;
  expect(res.ok, `Coder debug-link: ${res.status}`).toBeTruthy();
  return body.id_token_claims?.sub ?? null;
}

/**
 * Runs a shell command in the student's workspace through Coder (`coder ssh` as the owner), so it gets the
 * agent's environment, GIT_ASKPASS included, like a terminal in VS Code would.
 */
async function inWorkspace(owner: string, workspace: string, script: string): Promise<string> {
  const container = execFileSync(
    "docker",
    [
      "ps",
      "-q",
      "--filter",
      "label=com.docker.compose.project=pawtograder-sso-e2e",
      "--filter",
      "label=com.docker.compose.service=coder"
    ],
    { encoding: "utf8" }
  ).trim();
  expect(container, "the lane's Coder container").not.toBe("");
  const session = await coderAdminSession();
  try {
    return execFileSync(
      "docker",
      [
        "exec",
        "-e",
        `CODER_URL=${cfg.coderBaseUrl}`,
        "-e",
        `CODER_SESSION_TOKEN=${session}`,
        container,
        "/opt/coder",
        "ssh",
        `${owner}/${workspace}`,
        "--",
        script
      ],
      { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`coder ssh ${owner}/${workspace} failed: ${err.message}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }
}

/** One forgejo-reconciler pass under Deno, as forgejo-provisioning.forgejo-coder.spec.ts runs it. */
function runReconcilerPass(): { failures: string[] } {
  const out = execFileSync(
    "deno",
    [
      "run",
      "--no-check",
      "--no-lock",
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
        FORGEJO_AUTH_SOURCE_ID: String(cfg.forgejo.authSourceId),
        // Each class org's push hook then delivers to the lane's functions container, as it would to the
        // deployment's functions URL.
        SUPABASE_PUBLIC_URL: journey!.functionsBaseUrl,
        FORGEJO_WEBHOOK_SECRET: journey!.webhookSecret
      }
    }
  );
  return JSON.parse(out.trim().split("\n").pop()!);
}

/**
 * The lane has no edge runtime behind Kong, so the browser's function calls go to the functions container, which
 * runs the same index.ts files. Only the transport changes: the request and the reply pass through untouched.
 */
async function routeFunctions(context: BrowserContext) {
  await context.route(`${SUPABASE_URL}/functions/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${journey!.functionsBaseUrl}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

/** GitHub Actions' job token, as the suite fakes it (insertSubmissionViaAPI): accepted only with E2E_ENABLE. */
function e2eJobToken(repository: string, sha: string): string {
  const header = { alg: "RS256", typ: "JWT", kid: process.env.END_TO_END_SECRET || "not-a-secret" };
  const payload = { repository, sha, workflow_ref: ".github/workflows/grade.yml-e2e-test", run_id: 1, run_attempt: 1 };
  return (
    Buffer.from(JSON.stringify(header)).toString("base64") +
    "." +
    Buffer.from(JSON.stringify(payload)).toString("base64") +
    "."
  );
}

async function callFunction(name: string, token: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${journey!.functionsBaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = (await res.json()) as Record<string, unknown>;
  expect(res.ok && !("error" in json), `${name}: ${res.status} ${JSON.stringify(json)}`).toBeTruthy();
  return json;
}

/** Stands in for the classes cache webhook the lane has no vault entry for (TestingUtils.revalidateCourseCache). */
async function revalidateCourse(classId: number) {
  const res = await fetch(`${cfg.pawtograderBaseUrl}/api/e2e/revalidate-course`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classId })
  });
  expect(res.ok, `revalidate-course: ${res.status}`).toBeTruthy();
}

async function setCloudWorkspacesFromFeatureFlags(page: Page, classId: number, on: boolean) {
  await page.goto(`/course/${classId}/manage/course/feature-flags`);
  const toggle = page.getByLabel("Enable cloud workspaces for this course");
  await expect(toggle).toBeVisible();
  if ((await toggle.isChecked()) !== on) {
    await page.getByText("Enable Forgejo repositories and Coder cloud workspaces").click();
    await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  }
  await expect(toggle).toBeChecked({ checked: on });
  await expect
    .poll(async () => {
      const { data } = await supabase.from("classes").select("features").eq("id", classId).single();
      const features = (data?.features ?? []) as { name: string; enabled: boolean }[];
      return features.find((f) => f.name === "cloud-workspaces")?.enabled ?? false;
    })
    .toBe(on);
  await revalidateCourse(classId);
}

/** The progress card's status line, and the failure alert's text when there is one. */
async function workspaceCardText(page: Page): Promise<string> {
  const status =
    (await page
      .getByTestId("workspace-status")
      .textContent()
      .catch(() => null)) ?? "";
  const alerts = await page.getByRole("alert").allTextContents();
  return [status, ...alerts].join(" | ");
}

for (const provider of ["forgejo", "github"] as const) {
  const hostLabel = provider === "forgejo" ? "Forgejo" : "GitHub";

  test.describe(`Cloud workspaces journey on ${hostLabel}`, () => {
    test.describe.configure({ mode: "serial" });
    test.skip(!journey, "Needs run-e2e.sh's functions container and workspace template");

    let klass: Awaited<ReturnType<typeof createClass>>;
    let instructor: TestingUser;
    let student: TestingUser;
    let assignmentId: number;
    let repository: { id: number; repository: string };
    let workspace: { owner: string; name: string; dir: string };
    let pushedSha: string;

    test.beforeAll(async () => {
      // Short: the slug names the class's Forgejo org, and Forgejo caps names at 40 characters.
      klass = await createClass({ name: `CW ${provider}` });
      instructor = await createUserInClass({
        role: "instructor",
        class_id: klass.id,
        name: `CW ${provider} instructor`
      });
      student = await createUserInClass({ role: "student", class_id: klass.id, name: `CW ${provider} student` });
    });

    test("the instructor turns Cloud workspaces on from Feature flags", async ({ page }) => {
      await loginAsUser(page, instructor, klass);
      await setCloudWorkspacesFromFeatureFlags(page, klass.id, true);
    });

    test(`the student gets a ${hostLabel} repository for the assignment`, async () => {
      test.setTimeout(240_000);
      const assignment = await insertAssignment({
        class_id: klass.id,
        name: `Cloud workspaces on ${hostLabel}`,
        assignment_slug: `cw-${provider}-${klass.id}`,
        due_date: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        release_date: new Date(Date.now() - 60_000).toISOString(),
        git_provider: provider
      });
      assignmentId = assignment.id;

      if (provider === "forgejo") {
        // The handout, in the class's org with grade.yml, as in forgejo-provisioning.forgejo-coder.spec.ts.
        const classOrg = klass.forgejo_org || klass.slug!;
        expect((await forgejo("POST", "/orgs", { username: classOrg, visibility: "private" })).status).toBe(201);
        expect(
          (await forgejo("POST", `/orgs/${classOrg}/repos`, { name: "handout", auto_init: true, private: true })).status
        ).toBe(201);
        const workflow = fs.readFileSync(
          path.join(__dirname, "../../../charts/pawtograder/examples/forgejo-grade.yml")
        );
        expect(
          (
            await forgejo("POST", `/repos/${classOrg}/handout/contents/.github/workflows/grade.yml`, {
              content: workflow.toString("base64"),
              message: "Add grade.yml"
            })
          ).status
        ).toBe(201);
        expect((await forgejo("PATCH", `/repos/${classOrg}/handout`, { template: true })).ok).toBeTruthy();
        const { error } = await supabase
          .from("assignments")
          .update({ template_repo: `${classOrg}/handout` })
          .eq("id", assignment.id);
        if (error) throw error;

        expect(runReconcilerPass().failures).toEqual([]);
        const { data: repo } = await supabase
          .from("repositories")
          .select("id, repository, git_provider, is_github_ready")
          .eq("assignment_id", assignment.id)
          .eq("profile_id", student.private_profile_id)
          .single();
        expect(repo).toMatchObject({ git_provider: "forgejo", is_github_ready: true });
        repository = { id: repo!.id, repository: repo!.repository };
        const hooks = await forgejo("GET", `/orgs/${classOrg}/hooks`);
        expect(
          ((await hooks.json()) as { config: { url: string } }[]).map((h) => h.config.url),
          "the pass should give the class org its push hook"
        ).toContain(`${journey!.functionsBaseUrl}/functions/v1/forgejo-repo-webhook`);
      } else {
        // GitHub creates the repository (assignment-create-all-repos) and the student accepts the org invitation;
        // here the stand-in host gets the repository and the rows say what GitHub would have.
        expect(runReconcilerPass().failures).toEqual([]);
        const login = await forgejoLoginFor(student);
        const owner = "pawtograder-playground";
        const orgRes = await forgejo("POST", "/orgs", { username: owner, visibility: "private" });
        expect([201, 422]).toContain(orgRes.status);
        // The suite's e2e repository prefix, so the e2e job token below is accepted for it.
        const name = `test-e2e-student-repo-cw-${klass.id}`;
        expect(
          (
            await forgejo("POST", `/orgs/${owner}/repos`, {
              name,
              auto_init: true,
              private: true,
              default_branch: "main"
            })
          ).status
        ).toBe(201);
        expect(
          (await forgejo("PUT", `/repos/${owner}/${name}/collaborators/${login}`, { permission: "write" })).status
        ).toBe(204);
        const { data: repo, error } = await supabase
          .from("repositories")
          .insert({
            assignment_id: assignment.id,
            class_id: klass.id,
            profile_id: student.private_profile_id,
            repository: `${owner}/${name}`,
            git_provider: "github",
            is_github_ready: true,
            synced_handout_sha: "none"
          })
          .select("id, repository")
          .single();
        if (error) throw error;
        repository = repo;
        // The student's linked GitHub account, then the accepted org invitation; confirming the invitation
        // starts GitHub repo creation, which needs the username.
        const { error: userError } = await supabase
          .from("users")
          .update({ github_username: login })
          .eq("user_id", student.user_id);
        if (userError) throw userError;
        const { error: roleError } = await supabase
          .from("user_roles")
          .update({ github_org_confirmed: true })
          .eq("class_id", klass.id)
          .eq("private_profile_id", student.private_profile_id);
        if (roleError) throw roleError;
      }
    });

    test("the student opens the repository in Coder and the workspace starts with it cloned", async ({
      page,
      context
    }) => {
      test.setTimeout(600_000);
      await routeFunctions(context);
      await loginAsUser(page, student, klass);
      await page.goto(`/course/${klass.id}/assignments/${assignmentId}`);
      await expect(page.getByRole("heading", { name: "Your workspace" })).toBeVisible();
      await expect(page.getByTestId("workspace-status")).toHaveText("Your workspace is not running.");

      // First open: no Coder sign-in yet (and, for GitHub, no linked account), so workspace-open creates the
      // student's Coder user and sends them to link.
      await page.getByRole("button", { name: "Open in Coder" }).click();
      const link = page.getByRole("link", { name: new RegExp(`Link ${hostLabel} account`) });
      await expect(link, await workspaceCardText(page)).toBeVisible({ timeout: 60_000 });
      const linkUrl = await link.getAttribute("href");
      expect(linkUrl).toMatch(new RegExp(`^${cfg.coderBaseUrl}/api/v2/users/oidc/callback\\?`));
      const { data: coderAccount } = await supabase
        .from("coder_accounts")
        .select("coder_user_id, coder_username")
        .eq("user_id", student.user_id)
        .single();
      expect(coderAccount, "workspace-open should have recorded the student's Coder user").toBeTruthy();

      // The link, followed in another tab of the same browser, the way the card's link opens.
      const linkPage = await context.newPage();
      if (provider === "github") {
        // GitHub's sign-in, played by Forgejo's, which the lane fronts with Pawtograder's.
        await linkPage.goto(`${cfg.forgejoBaseUrl}/user/login`);
        if (!cfg.forgejoLoginRedirect) {
          await linkPage.locator(`a[href$="/user/oauth2/${cfg.forgejo.authSourceName}"]`).click();
        }
        if (!cfg.autoApproveForgejo) await linkPage.getByRole("button", { name: "Authorize" }).click();
        await linkPage.waitForURL((u) => u.origin === cfg.forgejoBaseUrl && !u.pathname.startsWith("/user/login"));
      }
      await linkPage.goto(linkUrl!);
      if (provider === "github") {
        // Coder sends the student on to the provider's authorize page; Forgejo asks once per app.
        await linkPage.waitForURL((u) => u.origin === cfg.forgejoBaseUrl || u.origin === cfg.coderBaseUrl);
        const grant = linkPage.getByRole("button", { name: /Authorize Application/i });
        if (await grant.isVisible({ timeout: 10_000 }).catch(() => false)) await grant.click();
        await linkPage.waitForURL(
          (u) => u.origin === cfg.coderBaseUrl && u.pathname.startsWith("/external-auth/github")
        );
        await expect(linkPage.getByText(/authenticated/i).first()).toBeVisible();
      } else {
        await linkPage.waitForURL((u) => u.origin === cfg.coderBaseUrl && !u.pathname.startsWith("/login"));
      }
      expect(await coderBoundSubject(coderAccount!.coder_user_id)).toBe(student.user_id);
      await linkPage.close();

      // Back on the assignment: open again, and the workspace starts.
      await page.reload();
      await page.getByRole("button", { name: "Open in Coder" }).click();
      await expect
        .poll(() => workspaceCardText(page), { timeout: 480_000, intervals: [2_000, 5_000] })
        .toMatch(/^Your workspace is ready\./);
      const steps = page.locator("li[data-step]");
      await expect(steps).toHaveCount(3);
      for (const step of await steps.all()) await expect(step).toHaveAttribute("data-mark", "done");

      const repoName = repository.repository.split("/")[1];
      // The lane's Coder has no wildcard app host, so the editor is the path-based app URL.
      const editorUrl = await page.getByRole("link", { name: /Open in VS Code/ }).getAttribute("href");
      expect(decodeURIComponent(editorUrl ?? "")).toBe(
        `${cfg.coderBaseUrl}/@${coderAccount!.coder_username}/repo-${repository.id}.main/apps/code-server/?folder=/home/coder/${repoName}`
      );

      // The clone in the workspace is the student's repository, at its head.
      workspace = {
        owner: coderAccount!.coder_username,
        name: `repo-${repository.id}`,
        dir: `/home/coder/${repoName}`
      };
      const out = await inWorkspace(
        workspace.owner,
        workspace.name,
        `git -C ${workspace.dir} remote get-url origin && git -C ${workspace.dir} rev-parse HEAD`
      );
      const [origin, head] = out.trim().split("\n").slice(-2);
      const host = provider === "forgejo" ? cfg.forgejoBaseUrl : journey!.githubStandinUrl;
      expect(origin).toBe(`${host}/${repository.repository}.git`);
      expect(head).toBe(await forgejoHead(repository.repository));
    });

    test("a #submit commit pushed from the workspace reaches Pawtograder", async ({ page }) => {
      test.setTimeout(300_000);
      const message = `Finish the ${provider} journey #submit`;
      const out = await inWorkspace(
        workspace.owner,
        workspace.name,
        `cd ${workspace.dir} && date >> journey.txt && git add journey.txt && git commit -q -m '${message}' && ` +
          `git push -q origin HEAD:main && git rev-parse HEAD && git log -1 --format=%ae`
      );
      const [sha, authorEmail] = out.trim().split("\n").slice(-2);
      pushedSha = sha;
      expect(pushedSha).toMatch(/^[0-9a-f]{40}$/);
      expect(await forgejoHead(repository.repository), "the push should have landed").toBe(pushedSha);
      // workspace-open delivers the student's real email; Coder's own is a placeholder (#1222).
      expect(authorEmail).toBe(student.email);

      if (provider === "forgejo") {
        // Forgejo's push hook, delivered to forgejo-repo-webhook, records the commit in the student's history.
        await expect
          .poll(
            async () =>
              (
                await supabase
                  .from("repository_check_runs")
                  .select("commit_message")
                  .eq("repository_id", repository.id)
                  .eq("sha", pushedSha)
                  .maybeSingle()
              ).data?.commit_message,
            { timeout: 60_000 }
          )
          .toBe(message);
        return;
      }

      // GitHub's side, as the rest of the suite stands it in: the push webhook's check run row, then the Actions
      // run's create-submission and submit-feedback calls with the e2e job token.
      const { error } = await supabase.from("repository_check_runs").insert({
        class_id: klass.id,
        repository_id: repository.id,
        check_run_id: 1,
        status: {},
        sha: pushedSha,
        commit_message: message
      });
      if (error) throw error;
      const token = e2eJobToken(repository.repository, pushedSha);
      const created = await callFunction("autograder-create-submission", token);
      const submissionId = created.submission_id as number;
      const { data: submission } = await supabase
        .from("submissions")
        .select("sha, repository, profile_id, assignment_id")
        .eq("id", submissionId)
        .single();
      expect(submission).toEqual({
        sha: pushedSha,
        repository: repository.repository,
        profile_id: student.private_profile_id,
        assignment_id: assignmentId
      });
      const feedback = createSampleGradingResult();
      const graded = await callFunction("autograder-submit-feedback", token, feedback);
      expect(graded.is_ok).toBe(true);
      const { data: result } = await supabase
        .from("grader_results")
        .select("score, max_score")
        .eq("submission_id", submissionId)
        .single();
      expect(result).toEqual({ score: feedback.feedback.score, max_score: feedback.feedback.max_score });

      await loginAsUser(page, student, klass);
      await page.goto(`/course/${klass.id}/assignments/${assignmentId}`);
      await expect(
        page
          .getByRole("row")
          .filter({ hasText: pushedSha.slice(0, 7) })
          .filter({ hasText: `${feedback.feedback.score}/${feedback.feedback.max_score}` })
      ).toHaveCount(1);
    });

    if (provider === "forgejo") {
      // Forgejo grades a push with Forgejo Actions running grade.yml, which calls autograder-create-submission
      // with a Forgejo job token. The lane has no Actions runner to mint one.
      test.fixme("the #submit push becomes a graded submission (needs a Forgejo Actions runner in the lane)", () => {});
    }

    test("turning Cloud workspaces off hides Open in Coder", async ({ browser }) => {
      const instructorPage = await (await browser.newContext({ baseURL: cfg.pawtograderBaseUrl })).newPage();
      await loginAsUser(instructorPage, instructor, klass);
      await setCloudWorkspacesFromFeatureFlags(instructorPage, klass.id, false);

      const context = await browser.newContext({ baseURL: cfg.pawtograderBaseUrl });
      await routeFunctions(context);
      const page = await context.newPage();
      await loginAsUser(page, student, klass);
      await page.goto(`/course/${klass.id}/assignments/${assignmentId}`);
      await expect(page.getByText(`Cloud workspaces on ${hostLabel}`).first()).toBeVisible();
      // The repository is still there; only the workspace card goes.
      await expect(page.getByRole("heading", { name: "Your workspace" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Open in Coder" })).toHaveCount(0);
    });
  });
}
