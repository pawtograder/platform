import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { AxeBuilder } from "@axe-core/playwright";
import { TZDate } from "@date-fns/tz";
import { Page } from "@playwright/test";
import type { Page as PlaywrightCorePage } from "playwright-core";
import { addDays, addHours } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { expect, test } from "../global-setup";
import {
  createClass,
  createLabSectionWithStudents,
  createUsersInClass,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";

// Covers the staff Due Date Exceptions table: sorting, filtering, column visibility, and the bulk
// Add extension / Set due date actions (#1024).

let course: Course;
let alpha: TestingUser;
let bravo: TestingUser;
let charlie: TestingUser;
let instructor: TestingUser;
let grader: TestingUser;
let assignment: Assignment;
let groupId: number;

const TZ = "America/New_York";
const dueDate = addDays(new TZDate(new Date(), TZ), 14);
dueDate.setHours(11, 0, 0, 0);

test.beforeEach(async () => {
  course = await createClass();
  [alpha, bravo, charlie, instructor, grader] = await createUsersInClass([
    { name: "Dde Alpha", role: "student", class_id: course.id, useMagicLink: true },
    { name: "Dde Bravo", role: "student", class_id: course.id, useMagicLink: true },
    { name: "Dde Charlie", role: "student", class_id: course.id, useMagicLink: true },
    { name: "Dde Instructor", role: "instructor", class_id: course.id, useMagicLink: true },
    { name: "Dde Grader", role: "grader", class_id: course.id, useMagicLink: true }
  ]);
  const { data: selfReviewSetting, error: selfReviewError } = await supabase
    .from("assignment_self_review_settings")
    .insert({ class_id: course.id, enabled: true, deadline_offset: 2, allow_early: true })
    .select("id")
    .single();
  if (selfReviewError) throw new Error(`Failed to create self review setting: ${selfReviewError.message}`);
  const { data: insertedAssignment, error: assignmentError } = await supabase
    .from("assignments")
    .insert({
      title: "Due Date Exceptions Group Assignment",
      description: "Group assignment for the due date exceptions table tests",
      due_date: dueDate.toUTCString(),
      template_repo: "pawtograder-playground/test-e2e-handout-repo-java",
      autograder_points: 100,
      total_points: 100,
      max_late_tokens: 10,
      release_date: addDays(new Date(), -1).toUTCString(),
      class_id: course.id,
      slug: "due-date-exceptions-group",
      group_config: "groups",
      allow_not_graded_submissions: false,
      self_review_setting_id: selfReviewSetting.id,
      max_group_size: 6,
      group_formation_deadline: addDays(new Date(), -1).toUTCString()
    })
    .select("*")
    .single();
  if (assignmentError) throw new Error(`Failed to create assignment: ${assignmentError.message}`);
  assignment = insertedAssignment;

  // Alpha and Bravo share a group; Charlie is on their own.
  const { data: group, error: groupError } = await supabase
    .from("assignment_groups")
    .insert({ name: "Dde Group", class_id: course.id, assignment_id: assignment.id })
    .select("id")
    .single();
  if (groupError) throw new Error(`Failed to create assignment group: ${groupError.message}`);
  groupId = group.id;
  for (const member of [alpha, bravo]) {
    const { error } = await supabase.from("assignment_groups_members").insert({
      assignment_group_id: groupId,
      profile_id: member.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id,
      added_by: instructor.private_profile_id
    });
    if (error) throw new Error(`Failed to add group member: ${error.message}`);
  }
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([alpha, bravo, charlie, instructor, grader]);
});

// The manage-assignment layout renders the page twice (desktop and a hidden mobile copy), so text
// queries are scoped to visible elements. Role queries already skip the hidden copy.
function visibleText(page: Page, text: string | RegExp) {
  return page.getByText(text, { exact: typeof text === "string" }).filter({ visible: true });
}

async function openPage(page: Page, user: TestingUser = instructor) {
  await loginAsUser(page, user, course);
  await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/due-date-exceptions`);
  await expect(visibleText(page, "3 Students")).toBeVisible({ timeout: 30_000 });
}

const row = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });
const firstDataRow = (page: Page) => page.getByRole("row").nth(1);

async function selectStudent(page: Page, name: string) {
  await page.getByRole("checkbox", { name: `Select ${name} for bulk actions` }).check({ force: true });
}

async function chooseFilter(page: Page, placeholder: string, option: string) {
  const filter = page.getByRole("combobox", { name: placeholder });
  await filter.fill(option);
  await filter.press("Enter");
}

async function exceptions() {
  const { data, error } = await supabase
    .from("assignment_due_date_exceptions")
    .select("student_id, assignment_group_id, hours, minutes, tokens_consumed")
    .eq("assignment_id", assignment.id);
  if (error) throw new Error(`Failed to read exceptions: ${error.message}`);
  // Leave out the negative exceptions that finalizeEarly writes.
  return data.filter((e) => e.hours >= 0 && e.minutes >= 0);
}

/** What finalize_submission_early writes: a negative exception that pulls the deadline to about now. */
async function finalizeEarly(student: TestingUser) {
  const minutesLeft = Math.floor((dueDate.getTime() - Date.now()) / 60_000);
  const { error } = await supabase.from("assignment_due_date_exceptions").insert({
    class_id: course.id,
    assignment_id: assignment.id,
    student_id: student.private_profile_id,
    creator_id: student.private_profile_id,
    hours: -Math.trunc(minutesLeft / 60),
    minutes: -(minutesLeft % 60),
    tokens_consumed: 0
  });
  if (error) throw new Error(`Failed to finalize early: ${error.message}`);
}

test.describe("Due date exceptions table", () => {
  test("sorts by student and filters by exact name", async ({ page }) => {
    // One name contains another, so a substring match would keep both rows.
    const { error } = await supabase
      .from("profiles")
      .update({ name: "Dde Alpha Junior" })
      .eq("id", charlie.private_profile_id);
    expect(error).toBeNull();
    await openPage(page);
    await expect(firstDataRow(page)).toContainText("Dde Alpha");
    await page.getByRole("button", { name: "Student", exact: true }).click();
    await expect(page.getByRole("columnheader", { name: /Student/ })).toHaveAttribute("aria-sort", "descending");
    await expect(firstDataRow(page)).toContainText("Dde Bravo");

    await chooseFilter(page, "Filter by name...", "Dde Alpha");
    await expect(visibleText(page, "Showing 1 of 3 Students")).toBeVisible();
    // Count row checkboxes: the header row also shows "Dde Alpha", as the chosen filter value.
    await expect(page.getByRole("checkbox", { name: /^Select Dde Alpha/ })).toHaveCount(1);
    await expect(page.getByRole("checkbox", { name: "Select Dde Alpha Junior for bulk actions" })).toHaveCount(0);
  });

  test("sorts students without a group last", async ({ page }) => {
    await openPage(page);
    await page.getByRole("button", { name: "Group", exact: true }).click();
    await expect(firstDataRow(page)).not.toContainText("Dde Charlie");
    await expect(page.getByRole("row").last()).toContainText("Dde Charlie");
  });

  test("hiding a filtered column clears its filter", async ({ page }) => {
    await openPage(page);
    await chooseFilter(page, "Filter by group...", "No group");
    await expect(visibleText(page, "Showing 1 of 3 Students")).toBeVisible();
    await page.getByRole("checkbox", { name: "Group", exact: true }).uncheck({ force: true });
    await expect(page.getByRole("button", { name: "Group", exact: true })).toHaveCount(0);
    await expect(visibleText(page, "3 Students")).toBeVisible();
  });

  test("a lab section change reaches the open page without a reload", async ({ page }) => {
    await createLabSectionWithStudents({
      class_id: course.id,
      lab_leader: grader,
      day_of_week: "monday",
      students: [alpha],
      name: "Dde Lab One"
    });
    await openPage(page);
    await expect(row(page, "Dde Alpha")).toContainText("Dde Lab One");
    // Change the role only once realtime is subscribed; an earlier change is not broadcast to this page.
    await expect(
      page.getByRole("status").filter({ hasText: "Realtime connection status: All realtime connections active" })
    ).toBeVisible({ timeout: 30_000 });
    const { error } = await supabase
      .from("user_roles")
      .update({ lab_section_id: null })
      .eq("private_profile_id", alpha.private_profile_id)
      .eq("class_id", course.id);
    expect(error).toBeNull();
    await expect(row(page, "Dde Alpha")).not.toContainText("Dde Lab One", { timeout: 20_000 });
  });

  test("bulk add extension writes one exception per group", async ({ page }) => {
    await openPage(page);
    await page.getByRole("button", { name: "All matching filters" }).click();
    await expect(visibleText(page, "3 selected")).toBeVisible();
    await page.getByRole("button", { name: "Add extension" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("1 student and 1 group");
    await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
    await dialog.getByLabel("Hours Extended").fill("2");
    await dialog.getByRole("button", { name: "Add Due Date Exceptions" }).click();

    await expect.poll(async () => (await exceptions()).length).toBe(2);
    const written = await exceptions();
    expect(written).toContainEqual(
      expect.objectContaining({ student_id: null, assignment_group_id: groupId, hours: 2, minutes: 0 })
    );
    expect(written).toContainEqual(
      expect.objectContaining({ student_id: charlie.private_profile_id, assignment_group_id: null, hours: 2 })
    );
  });

  test("bulk add extension rejects fractional minutes", async ({ page }) => {
    await openPage(page);
    await selectStudent(page, "Dde Charlie");
    await page.getByRole("button", { name: "Add extension" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Minutes Extended").fill("0.5");
    await expect(dialog).toContainText("Enter a whole number of minutes from 0 to 59");
    await expect(dialog.getByRole("button", { name: "Add Due Date Exceptions" })).toBeDisabled();
  });

  test("bulk add extension skips students who finalized early unless told otherwise", async ({ page }) => {
    await finalizeEarly(charlie);
    await openPage(page);
    await page.getByRole("button", { name: "All matching filters" }).click();
    await page.getByRole("button", { name: "Add extension" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("bulk-finalized-warning")).toContainText("will be skipped");
    await dialog.getByLabel("Hours Extended").fill("24");
    await dialog.getByRole("button", { name: "Add Due Date Exceptions" }).click();

    await expect.poll(async () => (await exceptions()).length).toBe(1);
    expect(await exceptions()).toEqual([expect.objectContaining({ assignment_group_id: groupId, hours: 24 })]);

    // Opting in extends the finalized student too.
    await selectStudent(page, "Dde Charlie");
    await page.getByRole("button", { name: "Add extension" }).click();
    await expect(dialog.getByRole("button", { name: "Add Due Date Exceptions" })).toBeDisabled();
    await dialog.getByText(/Also extend 1 student that finalized early/).click();
    await dialog.getByLabel("Hours Extended").fill("1");
    await dialog.getByRole("button", { name: "Add Due Date Exceptions" }).click();
    await expect.poll(async () => (await exceptions()).length).toBe(2);
    expect(await exceptions()).toContainEqual(
      expect.objectContaining({ student_id: charlie.private_profile_id, assignment_group_id: null, hours: 1 })
    );
  });

  test("set due date skips a group that finalized early", async ({ page }) => {
    // Group members finalize as a group: the negative exception is keyed by assignment_group_id.
    const minutesLeft = Math.floor((dueDate.getTime() - Date.now()) / 60_000);
    const { error } = await supabase.from("assignment_due_date_exceptions").insert({
      class_id: course.id,
      assignment_id: assignment.id,
      assignment_group_id: groupId,
      creator_id: alpha.private_profile_id,
      hours: -Math.trunc(minutesLeft / 60),
      minutes: -(minutesLeft % 60),
      tokens_consumed: 0
    });
    expect(error).toBeNull();
    await openPage(page);
    await page.getByRole("button", { name: "All matching filters" }).click();
    await page.getByRole("button", { name: "Set due date to..." }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("bulk-finalized-warning")).toContainText("1 group has finalized early");
    const target = addHours(dueDate, 48).getTime();
    await dialog.locator('input[type="datetime-local"]').fill(formatInTimeZone(target, TZ, "yyyy-MM-dd'T'HH:mm"));
    await dialog.getByRole("button", { name: "Set Due Date" }).click();

    await expect.poll(async () => (await exceptions()).length).toBe(1);
    expect(await exceptions()).toEqual([
      expect.objectContaining({ student_id: charlie.private_profile_id, hours: 48, minutes: 0 })
    ]);
  });

  test("bulk add extension skips a group when one member finalized on their own", async ({ page }) => {
    // A member-level finalization (e.g. from before they joined) still counts: a group exception
    // is added to the member's own, so extending the group would move that member's due date.
    await finalizeEarly(alpha);
    await openPage(page);
    await page.getByRole("button", { name: "All matching filters" }).click();
    await page.getByRole("button", { name: "Add extension" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("bulk-finalized-warning")).toContainText("1 group has finalized early");
    await dialog.getByLabel("Hours Extended").fill("24");
    await dialog.getByRole("button", { name: "Add Due Date Exceptions" }).click();

    await expect.poll(async () => (await exceptions()).length).toBe(1);
    expect(await exceptions()).toEqual([
      expect.objectContaining({ student_id: charlie.private_profile_id, assignment_group_id: null, hours: 24 })
    ]);
  });

  test("counts a group member's own exception and refuses one due date for a mixed group", async ({ page }) => {
    const { error } = await supabase.from("assignment_due_date_exceptions").insert({
      class_id: course.id,
      assignment_id: assignment.id,
      student_id: bravo.private_profile_id,
      creator_id: instructor.private_profile_id,
      hours: 5,
      minutes: 0,
      tokens_consumed: 0
    });
    expect(error).toBeNull();
    await openPage(page);
    await expect(row(page, "Dde Bravo")).toContainText(formatInTimeZone(addHours(dueDate, 5), TZ, "MMM d, h:mm a"));

    await selectStudent(page, "Dde Alpha");
    await page.getByRole("button", { name: "Set due date to..." }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("members have different current due dates");
    await expect(dialog.getByRole("button", { name: "Set Due Date" })).toBeDisabled();
  });

  test("set due date lands on or after the target when the current due date has seconds", async ({ page }) => {
    // 30 seconds past the minute: truncating the difference would land 30 seconds before the target.
    const dueWithSeconds = new Date(dueDate.getTime() + 30_000);
    const { error } = await supabase
      .from("assignments")
      .update({ due_date: dueWithSeconds.toISOString() })
      .eq("id", assignment.id);
    expect(error).toBeNull();
    await openPage(page);
    await selectStudent(page, "Dde Charlie");
    await page.getByRole("button", { name: "Set due date to..." }).click();
    const dialog = page.getByRole("dialog");
    const target = addHours(dueDate, 30).getTime() + 15 * 60_000;
    await dialog.locator('input[type="datetime-local"]').fill(formatInTimeZone(target, TZ, "yyyy-MM-dd'T'HH:mm"));
    await dialog.getByRole("button", { name: "Set Due Date" }).click();

    await expect.poll(async () => (await exceptions()).length).toBe(1);
    const [written] = await exceptions();
    expect(written.student_id).toBe(charlie.private_profile_id);
    // The gap is 30h14m30s, rounded up to a whole minute.
    expect(written.hours * 60 + written.minutes).toBe(30 * 60 + 15);
  });

  test("the table and bulk dialog have no WCAG A/AA violations", async ({ page }) => {
    await openPage(page);
    // The visual-test fixture rewrites placeholder text, which axe would then measure instead of the page.
    await page.evaluate(() => document.documentElement.removeAttribute("data-visual-tests"));
    const scan = (selector: string) =>
      new AxeBuilder({ page: page as unknown as PlaywrightCorePage })
        .include(selector)
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
    expect((await scan("table")).violations).toEqual([]);

    await selectStudent(page, "Dde Charlie");
    await page.getByRole("button", { name: "Add extension" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Scanning mid-fade measures blended colors, so wait for the open animation to finish.
    // Looping animations (spinners, skeleton pulses) never finish, so they are ignored.
    await page.waitForFunction(
      () =>
        document
          .getAnimations()
          .every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
      undefined,
      { timeout: 10_000 }
    );
    expect((await scan('[role="dialog"]')).violations).toEqual([]);
  });

  test("graders can add bulk extensions", async ({ page }) => {
    await openPage(page, grader);
    await selectStudent(page, "Dde Charlie");
    await page.getByRole("button", { name: "Add extension" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Hours Extended").fill("1");
    await dialog.getByRole("button", { name: "Add Due Date Exceptions" }).click();
    await expect.poll(async () => (await exceptions()).length).toBe(1);
  });
});
