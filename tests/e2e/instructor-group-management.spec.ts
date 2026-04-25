/**
 * Instructor group management (issue #404): RPC publish flow, TableController-backed UI,
 * and GitHub async work when template_repo is set (asserted via repositories row).
 *
 * Chromium only: member picker uses chakra-react-select (flaky in WebKit in CI).
 *
 * Requires: local Supabase (`npx supabase start`), `.env.local` with service role keys,
 * and `npm run dev` on port 3000 (or set BASE_URL for deployed E2E).
 */
import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  dismissTimeZonePreferenceModal,
  ensureTimeZonePreferenceInitialized,
  gotoCourseUrlWhenHeadingVisible,
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
  let studentAProfileId: string;
  let studentBProfileId: string;

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
    studentAProfileId = studentA.private_profile_id;
    const studentB = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Student B ${suffix}`,
      email: `e2e-stu-b-${suffix}@pawtograder.net`
    });
    studentBName = studentB.private_profile_name;
    studentBProfileId = studentB.private_profile_id;

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

  test("publish group changes (RPC + queue) and move student in same session", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Chromium only (chakra-react-select member picker is flaky in WebKit)");

    test.setTimeout(180_000);

    await ensureTimeZonePreferenceInitialized(page, "course");

    await page.goto("/sign-in");
    await page.getByLabel("Sign in email").fill(instructorEmail);
    await page.getByLabel("Sign in password").fill(instructorPassword);
    await page.getByRole("button", { name: "Sign in with email" }).click();
    await page.waitForURL((url) => !url.pathname.includes("/sign-in"), { timeout: 30_000 });
    await dismissTimeZonePreferenceModal(page, 15_000);

    await gotoCourseUrlWhenHeadingVisible(
      page,
      `/course/${classId}/manage/assignments/${assignmentId}/groups`,
      "Configure Groups"
    );

    const groupName = `e2egrp${Date.now().toString(36)}`;

    const createDialog = page.getByRole("dialog");
    const studentAOption = page.getByRole("option", {
      name: new RegExp(studentAName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    });

    const openCreateGroup = async () => {
      await page.getByRole("button", { name: "Create New Group" }).click();
      await expect(createDialog.getByRole("heading", { name: "Create New Group" })).toBeVisible();
      await createDialog.locator('input[name="name"]').fill(groupName);
    };
    await openCreateGroup();

    // The combo's data source (useAllStudentRoles → realtime) may not yet
    // include a student that was created in beforeAll. Retry by reopening the
    // combo; if that's still not enough, reload the page so the initial fetch
    // re-runs against the now-up-to-date DB.
    const memberCombo = createDialog.getByRole("combobox").first();
    let attempt = 0;
    await expect(async () => {
      attempt += 1;
      if (attempt > 2) {
        await page.keyboard.press("Escape");
        await page.reload();
        await openCreateGroup();
      }
      await memberCombo.click();
      await memberCombo.fill("");
      await memberCombo.fill(studentAName.slice(0, 24));
      await expect(studentAOption).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 90_000, intervals: [1000, 2000, 5000, 10000] });
    await studentAOption.click();
    await createDialog.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Pending Changes")).toBeVisible();
    await page.getByRole("button", { name: "Publish Changes" }).click();

    await expect(page.getByText(/Changes published/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/permission sync\(s\) queued|group\(s\) created/i).first()).toBeVisible({
      timeout: 15_000
    });
    await expect(page.getByText("Moving students and updating GitHub permissions...")).toBeHidden({
      timeout: 120_000
    });

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

    // Proves create_repo / async path ran (template_repo set); more reliable than queue depth in CI.
    await expect(async () => {
      const { data, error } = await supabase
        .from("repositories")
        .select("id")
        .eq("assignment_group_id", Number(targetGroupId))
        .maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBeDefined();
    }).toPass({ timeout: 45_000 });

    await expect(async () => {
      const { data, error } = await supabase
        .from("assignment_groups_members")
        .select("id")
        .eq("assignment_id", assignmentId)
        .eq("profile_id", studentAProfileId)
        .eq("assignment_group_id", Number(targetGroupId))
        .maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBeDefined();
    }).toPass({ timeout: 60_000 });

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
    // Toast can show before TableController refetch finishes; wait for publish overlay to clear.
    await expect(page.getByText("Moving students and updating GitHub permissions...")).toBeHidden({
      timeout: 120_000
    });

    await expect(async () => {
      const { data, error } = await supabase
        .from("assignment_groups_members")
        .select("id")
        .eq("assignment_id", assignmentId)
        .eq("profile_id", studentBProfileId)
        .eq("assignment_group_id", Number(targetGroupId))
        .maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBeDefined();
    }).toPass({ timeout: 60_000 });
  });
});
