/**
 * Instructor group management (issue #404): RPC publish flow, TableController-backed UI,
 * and async GitHub queue side-effects when template_repo is set.
 *
 * Requires: local Supabase (`npx supabase start`), `.env.local` with service role keys,
 * and `npm run dev` on port 3000 (or set BASE_URL).
 */
import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  dismissTimeZonePreferenceModal,
  insertAssignment,
  supabase
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

test.describe("Instructor group management", () => {
  test.describe.configure({ timeout: 180_000 });
  let classId: number;
  let assignmentId: number;
  let instructorEmail: string;
  let instructorPassword: string;
  let studentAName: string;
  let studentBName: string;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Group Mgmt ${suffix}` });
    classId = course.id;

    const instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `E2E Instructor ${suffix}`,
      email: `e2e-inst-grp-${suffix}@pawtograder.net`
    });
    instructorEmail = instructor.email;
    instructorPassword = instructor.password;

    const studentA = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Student A ${suffix}`,
      email: `e2e-stu-a-${suffix}@pawtograder.net`
    });
    studentAName = studentA.private_profile_name;
    const studentB = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Student B ${suffix}`,
      email: `e2e-stu-b-${suffix}@pawtograder.net`
    });
    studentBName = studentB.private_profile_name;

    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 14).toISOString(),
      name: `E2E Groups Assignment ${suffix}`,
      assignment_slug: `e2e-grp-${suffix}`,
      group_config: "groups",
      min_group_size: 1,
      max_group_size: 4,
      group_formation_deadline: addDays(new Date(), 14).toISOString()
    });
    assignmentId = assignment.id;
  });

  test("publish group changes (RPC + queue) and move student in same session", async ({ page }) => {
    const { data: beforeRows, error: beforeErr } = await supabase.rpc("get_async_queue_sizes");
    expect(beforeErr).toBeNull();
    const beforeSize = beforeRows?.[0]?.async_queue_size ?? 0;

    await page.goto("/sign-in");
    await page.getByLabel("Sign in email").fill(instructorEmail);
    await page.getByLabel("Sign in password").fill(instructorPassword);
    await page.getByRole("button", { name: "Sign in with email" }).click();
    await page.waitForURL((url) => !url.pathname.includes("/sign-in"), { timeout: 30_000 });
    await dismissTimeZonePreferenceModal(page, 15_000);

    await page.goto(`/course/${classId}/manage/assignments/${assignmentId}/groups`);
    await dismissTimeZonePreferenceModal(page, 15_000);
    await expect(page.getByRole("heading", { name: "Configure Groups" })).toBeVisible({ timeout: 30_000 });

    const groupName = `e2egrp${Date.now().toString(36)}`;

    await page.getByRole("button", { name: "Create New Group" }).click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog.getByRole("heading", { name: "Create New Group" })).toBeVisible();
    await createDialog.locator('input[name="name"]').fill(groupName);

    const memberCombo = createDialog.getByRole("combobox").first();
    await memberCombo.click();
    await memberCombo.fill(studentAName.slice(0, 24));
    await page.getByRole("option", { name: new RegExp(studentAName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
    await createDialog.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Pending Changes")).toBeVisible();
    await page.getByRole("button", { name: "Publish Changes" }).click();

    await expect(page.getByText(/Changes published/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/permission sync\(s\) queued|group\(s\) created/i).first()).toBeVisible({
      timeout: 15_000
    });

    let sawLargerQueue = false;
    for (let i = 0; i < 15; i++) {
      const { data: afterRows, error: afterErr } = await supabase.rpc("get_async_queue_sizes");
      expect(afterErr).toBeNull();
      const afterSize = afterRows?.[0]?.async_queue_size ?? 0;
      if (afterSize > beforeSize) {
        sawLargerQueue = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sawLargerQueue).toBe(true);

    let targetGroupId = "";
    await expect(async () => {
      const { data, error } = await supabase
        .from("assignment_groups")
        .select("id")
        .eq("assignment_id", assignmentId)
        .eq("name", groupName)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBeDefined();
      targetGroupId = String(data!.id);
    }).toPass({ timeout: 60_000 });

    await expect(page.getByRole("row").filter({ hasText: studentAName }).getByText(groupName)).toBeVisible({
      timeout: 60_000
    });

    const rowB = page.getByRole("row").filter({ hasText: studentBName });
    await rowB.getByRole("button", { name: /Move Student/i }).click();

    const moveDialog = page.getByRole("dialog");
    await expect(moveDialog.getByText(/Move student/i)).toBeVisible();

    const groupSelect = moveDialog.locator("select").first();
    await expect(async () => {
      await expect(groupSelect.locator(`option[value="${targetGroupId}"]`)).toBeAttached();
    }).toPass({ timeout: 60_000 });

    await groupSelect.selectOption(targetGroupId);
    await moveDialog.getByRole("button", { name: "Stage Changes" }).click();

    await expect(page.getByText("Pending Changes")).toBeVisible();
    await page.getByRole("button", { name: "Publish Changes" }).click();
    await expect(page.getByText(/Changes published/i).first()).toBeVisible({ timeout: 30_000 });

    await expect(page.getByRole("row").filter({ hasText: studentBName }).getByText(groupName)).toBeVisible({
      timeout: 60_000
    });
  });
});
