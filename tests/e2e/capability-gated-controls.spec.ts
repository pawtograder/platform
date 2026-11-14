/**
 * #1010 step 4a: controls graders can't use are hidden with useCapability(), and instructors see
 * the pages unchanged.
 *
 * - Manage Review Assignments: its actions, and the Bulk Assign and Reassign pages, need
 *   manage_review_assignments. Without it those two pages send you back to the reviews page.
 * - Manage Groups: every change needs publish_groups; without it the page is read-only.
 *
 * Default roles only: the instructor role holds both capabilities, the grader role holds neither,
 * until the last test gives the default grader role manage_review_assignments (instructors can edit
 * it since 20261112120000_custom_roles_copy_grader_role.sql).
 */
import { expect, test, type Page } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  gotoCourseUrlWhenHeadingVisible,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

const REVIEW_LINKS = ["Bulk Assign Grading", "Reassign Grading by Grader"];
const REVIEW_ACTIONS = [
  "Bulk edit grading due dates",
  "Bulk edit self-review due dates",
  "Assign Single Review",
  "Clear Assignments"
];
const GROUP_ACTIONS = [
  "Copy Groups from Prior Assignment",
  "Create New Group",
  "Bulk Create Groups",
  "Tweak a Group",
  "Edit Group",
  "Move Student"
];

test.describe("controls gated by capabilities", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let student: TestingUser;
  let assignmentId: number;
  let groupName: string;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Capability Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    student = await createUserInClass({ role: "student", class_id: course.id });

    const assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 14).toISOString(),
      name: `E2E Capability Gates ${suffix}`,
      assignment_slug: `e2e-cap-${suffix}`,
      group_config: "both",
      min_group_size: 1,
      max_group_size: 4,
      group_formation_deadline: addDays(new Date(), 14).toISOString()
    });
    assignmentId = assignment.id;

    // One review assignment, so the review table has a row with (or without) edit and delete icons.
    const submission = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignmentId,
      class_id: course.id
    });
    const { error } = await supabase.from("review_assignments").insert({
      assignee_profile_id: grader.private_profile_id,
      class_id: course.id,
      assignment_id: assignmentId,
      submission_id: submission.submission_id,
      submission_review_id: submission.grading_review_id,
      rubric_id: assignment.grading_rubric_id!,
      due_date: addDays(new Date(), 1).toUTCString()
    });
    expect(error).toBeNull();

    // One group mentored by the grader, so the mentor shows as a drop-down (or as text).
    groupName = `e2ementored${suffix.slice(0, 4)}`;
    const { error: groupError } = await supabase.from("assignment_groups").insert({
      assignment_id: assignmentId,
      class_id: course.id,
      name: groupName,
      mentor_profile_id: grader.private_profile_id
    });
    expect(groupError).toBeNull();
  });

  const reviewsUrl = () => `/course/${course.id}/manage/assignments/${assignmentId}/reviews`;

  // useCapability is false while loading, so "hidden" only means something once the answer is in.
  async function gotoWithCapabilities(page: Page, url: string, heading: string) {
    const capabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await gotoCourseUrlWhenHeadingVisible(page, url, heading);
    await capabilities;
  }

  async function openReviewsTable(page: Page) {
    await gotoWithCapabilities(page, reviewsUrl(), "Manage Review Assignments");
    await page.getByRole("tab", { name: "All Assignments" }).click();
    await expect(page.getByText(student.private_profile_name).first()).toBeVisible({ timeout: 30_000 });
  }

  async function openGroupsByGroup(page: Page) {
    await gotoWithCapabilities(
      page,
      `/course/${course.id}/manage/assignments/${assignmentId}/groups`,
      "Configure Groups"
    );
    await expect(page.getByText(student.private_profile_name).first()).toBeVisible({ timeout: 30_000 });
    // Click the switch that holds the visible checkbox; a hidden copy of its label can also be on the page.
    await page
      .locator("label")
      .filter({ has: page.getByRole("checkbox", { name: "View by group" }) })
      .click();
    await expect(page.getByRole("cell", { name: groupName })).toBeVisible();
  }

  test("a grader doesn't see the review-assignment actions", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await openReviewsTable(page);
    await expect(page.getByRole("heading", { name: "Assignment Management" })).toHaveCount(0);
    for (const name of REVIEW_LINKS) {
      await expect(page.getByRole("link", { name }), name).toHaveCount(0);
    }
    for (const name of REVIEW_ACTIONS) {
      await expect(page.getByRole("button", { name }), name).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: "Edit review assignment" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete review assignment" })).toHaveCount(0);
  });

  test("a grader who opens Bulk Assign or Reassign is sent back to the reviews page", async ({ page }) => {
    await loginAsUser(page, grader, course);
    for (const subpage of ["bulk-assign", "reassign"]) {
      await gotoWithCapabilities(page, `${reviewsUrl()}/${subpage}`, "Manage Review Assignments");
      await expect(page, subpage).toHaveURL(new RegExp(`${reviewsUrl()}$`));
    }
  });

  test("an instructor sees the review-assignment actions as before", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openReviewsTable(page);
    for (const name of REVIEW_LINKS) {
      await expect(page.getByRole("link", { name }), name).toBeVisible();
    }
    for (const name of REVIEW_ACTIONS) {
      await expect(page.getByRole("button", { name }), name).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Edit review assignment" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete review assignment" }).first()).toBeVisible();

    await gotoWithCapabilities(page, `${reviewsUrl()}/bulk-assign`, "Bulk Assign Grading");
    await expect(page.getByRole("button", { name: "Prepare Review Assignments" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Unfinished Assignments/ })).toBeVisible();

    await gotoWithCapabilities(page, `${reviewsUrl()}/reassign`, "Reassign Grading by Grader");
    await expect(page.getByRole("button", { name: "Prepare Reassignments" })).toBeVisible();
  });

  test("a grader sees Manage Groups read-only", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await openGroupsByGroup(page);
    await expect(page.getByRole("button", { name: "Export as CSV" }).first()).toBeVisible();
    for (const name of GROUP_ACTIONS) {
      await expect(page.getByRole("button", { name }), name).toHaveCount(0);
    }
    await expect(page.getByRole("combobox")).toHaveCount(0);
    const groupRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: groupName }) });
    await expect(groupRow.getByText(grader.private_profile_name)).toBeVisible();
  });

  test("an instructor can still change groups and publish", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openGroupsByGroup(page);
    for (const name of GROUP_ACTIONS) {
      await expect(page.getByRole("button", { name }).first(), name).toBeVisible();
    }
    const groupRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: groupName }) });
    await expect(groupRow.getByRole("combobox")).toHaveValue(grader.private_profile_id);

    await page.getByRole("button", { name: "Create New Group" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[name="name"]').fill(`e2egrp${Date.now().toString(36)}`);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Publish Changes" })).toBeEnabled();
  });

  // Runs last: it changes the default grader role, which every other test reads.
  test("a grader sees the review-assignment actions once the default grader role has manage_review_assignments", async ({
    page
  }) => {
    const { data: graderRole, error: roleError } = await supabase
      .from("class_roles")
      .select("id")
      .eq("class_id", course.id)
      .eq("default_for", "grader")
      .single();
    expect(roleError).toBeNull();
    const { error: addError } = await supabase
      .from("role_capabilities")
      .insert({ role_id: graderRole!.id, capability: "manage_review_assignments" });
    expect(addError).toBeNull();

    try {
      await loginAsUser(page, grader, course);
      await openReviewsTable(page);
      for (const name of REVIEW_LINKS) {
        await expect(page.getByRole("link", { name }), name).toBeVisible();
      }
      for (const name of REVIEW_ACTIONS) {
        await expect(page.getByRole("button", { name }), name).toBeVisible();
      }
      await expect(page.getByRole("button", { name: "Delete review assignment" }).first()).toBeVisible();
    } finally {
      const { error } = await supabase
        .from("role_capabilities")
        .delete()
        .eq("role_id", graderRole!.id)
        .eq("capability", "manage_review_assignments");
      expect(error).toBeNull();
    }
  });
});
