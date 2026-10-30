import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { expect, test } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  loginAsUser,
  setCourseFeature,
  TestingUser
} from "./TestingUtils";

import { assertReflowAt320, assertStudentPageAccessible } from "./axeStudentA11y";

dotenv.config({ path: ".env.local", quiet: true });

// CW-22: the workspace card against the simulated Coder client, through the preview route.
test.describe("Workspace status (simulated)", () => {
  test.describe.configure({ mode: "serial" });

  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let course: Course;
  let student: TestingUser;
  let assignment: Assignment;

  const previewUrl = ({ stepMs = 300, fail }: { stepMs?: number; fail?: string } = {}) =>
    `/course/${course.id}/assignments/${assignment.id}/workspace-preview?stepMs=${stepMs}${fail ? `&fail=${fail}` : ""}`;

  test.beforeAll(async () => {
    course = await createClass({ name: "Workspace Status" });
    [student] = await createUsersInClass([
      {
        name: "Workspace Student",
        public_profile_name: "Workspace Pseudonym Student",
        email: `workspace-student-${SAFE_ID}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    assignment = await insertAssignment({
      due_date: addDays(new Date(), 7).toUTCString(),
      class_id: course.id,
      name: "Workspace Assignment"
    });
  });

  test("hidden when the course does not have Cloud Workspaces", async ({ page }) => {
    await setCourseFeature(course.id, "cloud-workspaces", false);
    await loginAsUser(page, student, course);
    await page.goto(previewUrl());
    await expect(page.getByText("Cloud Workspaces is not turned on for this course.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open workspace" })).toHaveCount(0);
  });

  test("starts step by step and offers the editor only once ready", async ({ page }, testInfo) => {
    await setCourseFeature(course.id, "cloud-workspaces", true);
    await loginAsUser(page, student, course);
    await page.goto(previewUrl());

    const status = page.getByTestId("workspace-status");
    await expect(status).toHaveText("Your workspace is not running.");
    await testInfo.attach("1-not-started", { body: await page.screenshot(), contentType: "image/png" });

    await page.getByRole("button", { name: "Open workspace" }).click();
    await expect(status).toContainText("Starting your workspace");
    await expect(page.getByRole("link", { name: "Open in VS Code" })).toHaveCount(0);
    await testInfo.attach("2-starting", { body: await page.screenshot(), contentType: "image/png" });

    await expect(status).toHaveText("Your workspace is ready.", { timeout: 10_000 });
    await expect(page.getByRole("link", { name: "Open in VS Code" })).toBeVisible();
    await assertStudentPageAccessible(page, "workspace ready");
    await testInfo.attach("3-ready", { body: await page.screenshot(), contentType: "image/png" });
  });

  test("names the failed step and lets the student retry", async ({ page }, testInfo) => {
    await setCourseFeature(course.id, "cloud-workspaces", true);
    await loginAsUser(page, student, course);
    // Slow enough that Retry is visibly back on the first step before it fails again.
    await page.goto(previewUrl({ stepMs: 1500, fail: "clone" }));

    await page.getByRole("button", { name: "Open workspace" }).click();
    const status = page.getByTestId("workspace-status");
    await expect(status).toHaveText("Workspace not ready: Clone your repository failed.", { timeout: 10_000 });
    await expect(page.locator('[data-step="git_setup"]')).toHaveAttribute("data-mark", "done");
    await expect(page.locator('[data-step="clone"]')).toHaveAttribute("data-mark", "failed");
    await expect(page.getByRole("link", { name: "Open in VS Code" })).toHaveCount(0);
    await testInfo.attach("4-failed", { body: await page.screenshot(), contentType: "image/png" });

    await page.getByRole("button", { name: "Retry" }).click();
    await expect(status).toContainText("Starting your workspace");
  });

  test("ignores an unknown step in ?fail and starts normally", async ({ page }) => {
    await setCourseFeature(course.id, "cloud-workspaces", true);
    await loginAsUser(page, student, course);
    await page.goto(previewUrl({ fail: "not-a-step" }));

    await page.getByRole("button", { name: "Open workspace" }).click();
    await expect(page.getByTestId("workspace-status")).toHaveText("Your workspace is ready.", { timeout: 10_000 });
  });

  test("passes axe and reflows at 320px in each state", async ({ page }) => {
    await setCourseFeature(course.id, "cloud-workspaces", true);
    await loginAsUser(page, student, course);
    await page.goto(previewUrl({ stepMs: 600_000 }));
    const status = page.getByTestId("workspace-status");

    await expect(status).toHaveText("Your workspace is not running.");
    await assertStudentPageAccessible(page, "workspace not started");

    await page.getByRole("button", { name: "Open workspace" }).click();
    await expect(status).toContainText("Starting your workspace");
    await assertStudentPageAccessible(page, "workspace starting");
    await assertReflowAt320(page, "workspace starting");

    await page.goto(previewUrl({ stepMs: 300, fail: "git_setup" }));
    await page.getByRole("button", { name: "Open workspace" }).click();
    await expect(status).toContainText("Workspace not ready", { timeout: 10_000 });
    await assertStudentPageAccessible(page, "workspace failed");
    await assertReflowAt320(page, "workspace failed");
  });
});
