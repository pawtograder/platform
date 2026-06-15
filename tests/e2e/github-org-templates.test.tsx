import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase, TestingUser } from "./TestingUtils";

test.setTimeout(120_000);

const DEFAULT_HANDOUT = "pawtograder/template-assignment-handout";
const DEFAULT_SOLUTION = "pawtograder/template-assignment-grader";

let course: Course;
let uniqueOrg: string;
let instructor: TestingUser;
let admin: TestingUser;

/** Resolve the effective template repos for a class via the service-role RPC. */
async function resolve(classId: number) {
  const { data, error } = await supabase.rpc("resolve_class_template_repos", { p_class_id: classId });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return row as { handout_template_repo: string; solution_template_repo: string };
}

test.beforeAll(async () => {
  course = (await createClass({ name: "Org Templates Course" })) as Course;
  // Give this course its own org so org-level config doesn't collide with other tests.
  uniqueOrg = `e2e-org-${course.id}`;
  const { error } = await supabase.from("classes").update({ github_org: uniqueOrg }).eq("id", course.id);
  if (error) throw new Error(`Failed to set unique org: ${error.message}`);

  [instructor, admin] = await createUsersInClass([
    { role: "instructor", class_id: course.id, name: "Org Templates Instructor", useMagicLink: true },
    { role: "instructor", class_id: course.id, name: "Org Templates Admin", useMagicLink: true }
  ]);
  // Promote the second user to a global admin (createUserInClass can't create admins).
  const { error: promoteError } = await supabase
    .from("user_roles")
    .update({ role: "admin" })
    .eq("user_id", admin.user_id)
    .eq("class_id", course.id);
  if (promoteError) throw new Error(`Failed to promote admin: ${promoteError.message}`);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([instructor, admin]);
});

test.describe("GitHub org template configuration", () => {
  test.describe.configure({ mode: "serial" });

  // The org detail page auto-mounts the RepoFileEditor for any template repo that lives in
  // this org, which calls the repository-get-file / repository-write-file edge functions.
  // Those reach the real GitHub App, which has no installation for the synthetic e2e org
  // (`e2e-org-<id>`), so getFileFromRepo throws "No octokit found ...". This suite tests
  // template *resolution* and org-default persistence, not the editor, so stub those edge
  // functions at the network layer. The editor itself is covered by repo-file-editor.test.tsx.
  test.beforeEach(async ({ page }) => {
    const CORS = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "*"
    };
    await page.route("**/functions/v1/repository-get-file", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS });
      const body = JSON.parse(route.request().postData() || "{}");
      const content = String(body.path).includes("workflows")
        ? "name: Grade\non:\n  push:\n    branches: [main]\njobs:\n  grade:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n"
        : "build:\n  preset: java-gradle\n  cmd: ./gradlew test\n  artifacts: []\nsubmissionFiles:\n  files: []\n  testFiles: []\ngradedParts: []\n";
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify({ content, sha: "sha-e2e" })
      });
    });
    await page.route("**/functions/v1/repository-write-file", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS });
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify({ commit_sha: "c-e2e", content_sha: "sha-e2e-2" })
      });
    });
  });

  test("resolves override > org default > hardcoded constant", async () => {
    // 1. Neither override nor org default configured -> hardcoded constants.
    const { error: clearClassError } = await supabase
      .from("classes")
      .update({ handout_template_repo: null, solution_template_repo: null })
      .eq("id", course.id);
    expect(clearClassError).toBeNull();
    const { error: deleteOrgError } = await supabase.from("github_orgs").delete().eq("org_name", uniqueOrg);
    expect(deleteOrgError).toBeNull();
    let resolved = await resolve(course.id);
    expect(resolved.handout_template_repo).toBe(DEFAULT_HANDOUT);
    expect(resolved.solution_template_repo).toBe(DEFAULT_SOLUTION);

    // 2. Org default configured (no class override) -> org default wins.
    const orgHandout = `${uniqueOrg}/handout-default`;
    const orgSolution = `${uniqueOrg}/grader-default`;
    const { error: upsertError } = await supabase.rpc("admin_upsert_github_org", {
      p_org_name: uniqueOrg,
      p_handout: orgHandout,
      p_solution: orgSolution
    });
    expect(upsertError).toBeNull();
    resolved = await resolve(course.id);
    expect(resolved.handout_template_repo).toBe(orgHandout);
    expect(resolved.solution_template_repo).toBe(orgSolution);

    // 3. Class override set -> override beats org default.
    const overrideHandout = `${uniqueOrg}/handout-override`;
    const overrideSolution = `${uniqueOrg}/grader-override`;
    const { error: overrideError } = await supabase.rpc("set_class_template_overrides", {
      p_class_id: course.id,
      p_handout: overrideHandout,
      p_solution: overrideSolution
    });
    expect(overrideError).toBeNull();
    resolved = await resolve(course.id);
    expect(resolved.handout_template_repo).toBe(overrideHandout);
    expect(resolved.solution_template_repo).toBe(overrideSolution);

    // Clear the override; org default should re-apply.
    const { error: clearOverrideError } = await supabase.rpc("set_class_template_overrides", {
      p_class_id: course.id
    });
    expect(clearOverrideError).toBeNull();
    resolved = await resolve(course.id);
    expect(resolved.handout_template_repo).toBe(orgHandout);
  });

  test("admin can set org defaults from the GitHub Orgs dashboard", async ({ page }) => {
    await loginAsUser(page, admin);
    await page.goto(`/admin/github-orgs/${encodeURIComponent(uniqueOrg)}`);

    await expect(page.getByRole("heading", { name: uniqueOrg })).toBeVisible();

    const newHandout = `${uniqueOrg}/handout-from-ui`;
    const newSolution = `${uniqueOrg}/grader-from-ui`;
    await page.getByLabel("Default handout template repository").fill(newHandout);
    await page.getByLabel("Default solution (grader) template repository").fill(newSolution);
    await page.getByRole("button", { name: "Save defaults" }).click();

    // The success toast appears (and auto-dismisses); confirm persistence via the RPC.
    await expect
      .poll(
        async () => {
          const { data } = await supabase.rpc("admin_get_github_orgs");
          return (data ?? []).find((o) => o.org_name === uniqueOrg)?.default_handout_template_repo;
        },
        { timeout: 15_000 }
      )
      .toBe(newHandout);

    const { data, error } = await supabase.rpc("admin_get_github_orgs");
    expect(error).toBeNull();
    const row = (data ?? []).find((o) => o.org_name === uniqueOrg);
    expect(row?.default_handout_template_repo).toBe(newHandout);
    expect(row?.default_solution_template_repo).toBe(newSolution);
  });

  test("non-admin instructor cannot access the GitHub Orgs dashboard", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto("/admin/github-orgs");
    // The admin layout redirects non-admins to /course.
    await expect(page).toHaveURL(/\/course(\/|$)/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "GitHub Orgs" })).toHaveCount(0);
  });
});
