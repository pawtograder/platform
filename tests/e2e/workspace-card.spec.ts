/**
 * The workspace card on a Forgejo assignment, in a real browser, with `workspace-open` and
 * `workspace-status` mocked. Covers starting, ready, failed and link-account, plus axe and 320px
 * reflow on the states with the most content. The real Forgejo and Coder journey runs in the
 * forgejo-coder lane, which is started by hand. This spec runs on every PR.
 */
import type { Page, Route } from "@playwright/test";
import { addDays } from "date-fns";
import type { WorkspaceOpenResponse } from "@/supabase/functions/_shared/FunctionTypes.js";
import { expect, test } from "../global-setup";
import { assertReflowAt320, assertStudentPageAccessible } from "./axeStudentA11y";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  loginAsUser,
  setCourseFeature,
  supabase,
  type TestingUser
} from "./TestingUtils";

const EDITOR_URL = "https://coder.e2e.invalid/@student/hw1/apps/code-server";
const LINK_URL = "https://coder.e2e.invalid/external-auth/forgejo";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

/**
 * Answers the card's two edge function calls from `replies`, which a test changes as it goes. Counts
 * the calls to workspace-open, so a test can check that a button opened the workspace.
 */
async function mockWorkspace(page: Page, replies: { status: WorkspaceOpenResponse; open: WorkspaceOpenResponse }) {
  const calls = { open: 0 };
  const answer = (pick: () => WorkspaceOpenResponse) => async (route: Route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    await route.fulfill({ status: 200, headers: CORS_HEADERS, json: pick() });
  };
  await page.route(
    "**/functions/v1/workspace-status",
    answer(() => replies.status)
  );
  await page.route(
    "**/functions/v1/workspace-open",
    answer(() => {
      calls.open++;
      return replies.open;
    })
  );
  return calls;
}

test.describe("Workspace card on the assignment page", () => {
  test.describe.configure({ timeout: 180_000 });
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let course: Awaited<ReturnType<typeof createClass>>;
  let student: TestingUser;
  let assignment: { id: number };

  test.beforeAll(async () => {
    course = await createClass({ name: `E2E Workspace Card ${suffix}` });
    await setCourseFeature(course.id, "cloud-workspaces", true);
    student = await createUserInClass({ role: "student", class_id: course.id });
    assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 14).toISOString(),
      name: `Workspace Card HW ${suffix}`,
      assignment_slug: `ws-card-${suffix}`,
      git_provider: "forgejo"
    });
    // The card only shows once the student has a ready repo on a host Coder can clone from.
    const repo = await supabase.from("repositories").insert({
      class_id: course.id,
      assignment_id: assignment.id,
      profile_id: student.private_profile_id,
      repository: `e2e-ignore/ws-card-${suffix}`,
      git_provider: "forgejo",
      is_github_ready: true
    });
    expect(repo.error).toBeNull();
  });

  async function openAssignment(page: Page) {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments/${assignment.id}`);
    await expect(page.getByRole("heading", { name: "Your workspace" })).toBeVisible();
  }

  test("Open in Coder shows each step while starting, then the editor link once ready", async ({ page }) => {
    const replies: { status: WorkspaceOpenResponse; open: WorkspaceOpenResponse } = {
      status: { status: "not_started" },
      open: { status: "starting", step: "clone" }
    };
    const calls = await mockWorkspace(page, replies);
    await openAssignment(page);
    const status = page.getByTestId("workspace-status");

    await expect(status).toHaveText("Your workspace is not running.");
    // Polls while starting keep answering "starting" until the test says otherwise.
    replies.status = { status: "starting", step: "clone" };
    await page.getByRole("button", { name: "Open in Coder" }).click();

    await expect(status).toHaveText("Starting your workspace: Clone your repository…");
    expect(calls.open).toBe(1);
    await expect(page.getByRole("button", { name: "Starting…" })).toBeDisabled();
    await expect(page.locator('[data-step="build"]')).toHaveAttribute("data-mark", "done");
    await expect(page.locator('[data-step="clone"]')).toHaveAttribute("data-mark", "running");
    await expect(page.locator('[data-step="editor"]')).toHaveAttribute("data-mark", "pending");
    await expect(page.getByRole("link", { name: /Open in VS Code/ })).toHaveCount(0);

    // The next poll finds every step done.
    replies.status = { status: "ready", redirect_url: EDITOR_URL };
    await expect(status).toHaveText("Your workspace is ready.", { timeout: 20_000 });
    const editor = page.getByRole("link", { name: /Open in VS Code/ });
    await expect(editor).toHaveAttribute("href", EDITOR_URL);
    await expect(editor).toHaveAttribute("target", "_blank");
    for (const step of ["build", "clone", "editor"]) {
      await expect(page.locator(`[data-step="${step}"]`)).toHaveAttribute("data-mark", "done");
    }

    await assertStudentPageAccessible(page, "workspace card ready");
    await assertReflowAt320(page, "workspace card ready");
  });

  test("a failed clone shows the failing step and its message, and Retry opens again", async ({ page }) => {
    const replies: { status: WorkspaceOpenResponse; open: WorkspaceOpenResponse } = {
      status: { status: "failed", step: "clone", message: "fatal: could not read from remote repository" },
      open: { status: "ready", redirect_url: EDITOR_URL }
    };
    const calls = await mockWorkspace(page, replies);
    await openAssignment(page);
    const status = page.getByTestId("workspace-status");

    await expect(status).toHaveText("Workspace not ready: Clone your repository failed.");
    await expect(page.getByText("Clone your repository failed", { exact: true })).toBeVisible();
    await expect(page.getByText("fatal: could not read from remote repository")).toBeVisible();
    await expect(page.locator('[data-step="build"]')).toHaveAttribute("data-mark", "done");
    await expect(page.locator('[data-step="clone"]')).toHaveAttribute("data-mark", "failed");
    await expect(page.getByRole("link", { name: /Open in VS Code/ })).toHaveCount(0);

    await assertStudentPageAccessible(page, "workspace card failed");
    await assertReflowAt320(page, "workspace card failed");

    replies.status = { status: "ready", redirect_url: EDITOR_URL };
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(status).toHaveText("Your workspace is ready.");
    expect(calls.open).toBe(1);
    await expect(page.getByRole("link", { name: /Open in VS Code/ })).toHaveAttribute("href", EDITOR_URL);
  });

  test("asks the student to link Forgejo, and checks again when they come back to the tab", async ({ page }) => {
    const replies: { status: WorkspaceOpenResponse; open: WorkspaceOpenResponse } = {
      status: {
        status: "needs_linking",
        authenticate_url: LINK_URL,
        message: "Link your Forgejo account in Coder once."
      },
      open: { status: "ready", redirect_url: EDITOR_URL }
    };
    await mockWorkspace(page, replies);
    await openAssignment(page);
    const status = page.getByTestId("workspace-status");

    await expect(status).toHaveText("Link your Forgejo account to open your workspace.");
    await expect(page.getByText("Link your Forgejo account in Coder once.", { exact: false })).toBeVisible();
    const link = page.getByRole("link", { name: /Link Forgejo account/ });
    await expect(link).toHaveAttribute("href", LINK_URL);
    await expect(link).toHaveAttribute("target", "_blank");

    await assertStudentPageAccessible(page, "workspace card link account");

    // The student linked the account in the other tab and comes back to this one.
    replies.status = { status: "ready", redirect_url: EDITOR_URL };
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(status).toHaveText("Your workspace is ready.");
    await expect(page.getByRole("link", { name: /Link Forgejo account/ })).toHaveCount(0);
  });
});
