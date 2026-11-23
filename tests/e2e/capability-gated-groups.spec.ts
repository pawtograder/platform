/**
 * #1010: Manage Groups uses two capabilities (20261122210600_groups_by_capability.sql).
 *
 * - manage_groups: Copy Groups from Prior Assignment, and the mentor drop-down, which saves at once.
 *   Without it the mentor is shown as text.
 * - publish_groups: staging changes (Create New Group, Bulk Create, Tweak, Edit Group, Move Student)
 *   and publishing them.
 *
 * Two Head TAs on custom roles, each with one of the two, see only that one's controls. The default
 * instructor role holds both and the default grader role neither; capability-gated-controls.spec.ts
 * covers those two.
 *
 * Nothing here reaches GitHub: the assignment has repo_mode "none" and is released next week.
 */
import { expect, test, type Page } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  gotoCourseUrlWhenHeadingVisible,
  insertAssignment,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

const STAGING_ACTIONS = ["Create New Group", "Bulk Create Groups", "Tweak a Group", "Edit Group"];

test.describe("Manage Groups controls follow manage_groups and publish_groups", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let groupTa: TestingUser;
  let publishTa: TestingUser;
  let student: TestingUser;
  let assignmentId: number;
  let groupId: number;
  let groupName: string;

  async function customRole(name: string, capability: string, user: TestingUser) {
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect((await supabase.from("role_capabilities").insert({ role_id: role!.id, capability })).error).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", user.user_id)
          .eq("class_id", course.id)
      ).error
    ).toBeNull();
  }

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Group Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    groupTa = await createUserInClass({ role: "grader", class_id: course.id });
    publishTa = await createUserInClass({ role: "grader", class_id: course.id });
    student = await createUserInClass({ role: "student", class_id: course.id });

    const assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 14).toISOString(),
      release_date: addDays(new Date(), 7).toISOString(),
      repo_mode: "none",
      name: `E2E Group Gates ${suffix}`,
      assignment_slug: `e2e-group-gates-${suffix}`,
      group_config: "both",
      min_group_size: 1,
      max_group_size: 4,
      group_formation_deadline: addDays(new Date(), 14).toISOString()
    });
    assignmentId = assignment.id;

    groupName = `e2emanaged${suffix.slice(0, 4)}`;
    const { data: group, error: groupError } = await supabase
      .from("assignment_groups")
      .insert({ assignment_id: assignmentId, class_id: course.id, name: groupName })
      .select("id")
      .single();
    expect(groupError).toBeNull();
    groupId = group!.id;

    await customRole("Group TA", "manage_groups", groupTa);
    await customRole("Publish TA", "publish_groups", publishTa);
  });

  // useCapability is false while loading, so "hidden" only means something once the answer is in.
  // ClassCapabilitiesProvider adds data-capabilities-loaded in the same render that applies the
  // answer. It also adds it, with no capabilities, after the lookup fails a few times, so the test
  // first waits for a successful lookup.
  async function openGroupsByGroup(page: Page) {
    const capabilities = page.waitForResponse(
      (r) => r.url().includes("/rpc/user_class_capabilities") && r.status() === 200
    );
    await gotoCourseUrlWhenHeadingVisible(
      page,
      `/course/${course.id}/manage/assignments/${assignmentId}/groups`,
      "Configure Groups"
    );
    await capabilities;
    await expect(page.locator('[data-capabilities-loaded="true"]').first()).toBeAttached();
    await expect(page.getByText(student.private_profile_name).first()).toBeVisible({ timeout: 30_000 });
    // Click the switch that holds the visible checkbox; a hidden copy of its label can also be on the page.
    await page
      .locator("label")
      .filter({ has: page.getByRole("checkbox", { name: "View by group" }) })
      .click();
    await expect(page.getByRole("cell", { name: groupName })).toBeVisible();
    return page.getByRole("row").filter({ has: page.getByRole("cell", { name: groupName }) });
  }

  test("a Head TA with manage_groups sees Copy Groups and can set the mentor", async ({ page }) => {
    await loginAsUser(page, groupTa, course);
    const groupRow = await openGroupsByGroup(page);

    await expect(page.getByRole("button", { name: "Copy Groups from Prior Assignment" })).toBeVisible();
    for (const name of STAGING_ACTIONS) {
      await expect(page.getByRole("button", { name }), name).toHaveCount(0);
    }

    await groupRow.getByRole("combobox").selectOption(instructor.private_profile_id);
    await expect(page.getByText("Mentor updated").first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => {
        const { data } = await supabase
          .from("assignment_groups")
          .select("mentor_profile_id")
          .eq("id", groupId)
          .single();
        return data?.mentor_profile_id;
      })
      .toBe(instructor.private_profile_id);
  });

  test("a Head TA with publish_groups only can stage changes but not copy or set the mentor", async ({ page }) => {
    expect(
      (
        await supabase
          .from("assignment_groups")
          .update({ mentor_profile_id: instructor.private_profile_id })
          .eq("id", groupId)
      ).error
    ).toBeNull();
    await loginAsUser(page, publishTa, course);
    const groupRow = await openGroupsByGroup(page);

    for (const name of STAGING_ACTIONS) {
      await expect(page.getByRole("button", { name }).first(), name).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Copy Groups from Prior Assignment" })).toHaveCount(0);
    await expect(groupRow.getByRole("combobox")).toHaveCount(0);
    // The mentor shows as text.
    await expect(groupRow.getByText(instructor.private_profile_name)).toBeVisible();
  });
});
