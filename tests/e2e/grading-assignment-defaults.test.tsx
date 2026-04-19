import { Assignment, Course, GradingAssignmentDefaultProfile } from "@/utils/supabase/DatabaseTypes";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, insertAssignment, loginAsUser, supabase, TestingUser } from "./TestingUtils";

dotenv.config({ path: ".env.local" });

test.describe.configure({ mode: "serial" });

let course: Course;
let instructor: TestingUser | undefined;
let assignment: Assignment | undefined;

const profileNameSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const gradingProfileName = `E2E Grading Defaults ${profileNameSuffix}`;

test.beforeAll(async () => {
  course = await createClass({ name: `E2E Grading Defaults Course ${profileNameSuffix}` });
  [instructor] = await createUsersInClass([
    {
      name: `E2E Grading Instructor ${profileNameSuffix}`,
      email: `e2e-grading-instructor-${profileNameSuffix}@pawtograder.net`,
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  assignment = await insertAssignment({
    class_id: course.id,
    due_date: addDays(new Date(), 7).toISOString(),
    name: `E2E Grading Assignment ${profileNameSuffix}`,
    assignment_slug: `e2e-grading-defaults-${profileNameSuffix}`
  });
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([instructor]);
});

test("instructors can manage grading default profiles and apply them on assignment create/edit workflows", async ({
  page
}) => {
  test.setTimeout(180_000);
  await loginAsUser(page, instructor!, course);

  await page.goto(`/course/${course.id}/manage/course/grading-assignment-defaults`);
  await expect(page.getByRole("heading", { name: "Grading Assignment Defaults" })).toBeVisible();

  await page.getByLabel("Profile name").fill(gradingProfileName);
  await page.getByLabel("Description").fill("Profile used by E2E test coverage.");
  await page.getByRole("checkbox", { name: "Auto assign at deadline" }).check();
  await page.getByLabel("Assignee pool").selectOption("instructors_and_graders");
  await page.getByLabel("Review due hours after deadline").fill("36");
  await page.getByRole("checkbox", { name: "Enable late grading reminders" }).check();
  await page.getByLabel("Reminder interval (hours)").fill("12");
  await page.getByLabel("Reply-to email").fill("grading-reply@example.edu");
  await page.getByLabel("CC emails").fill("staff1@example.edu, staff2@example.edu");

  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page.getByText("Profile created")).toBeVisible();
  await expect(page.getByText(gradingProfileName)).toBeVisible();
  await expect(page.getByText("Auto assign: on | Reminder: every 12h")).toBeVisible();

  const { data: createdProfile, error: createdProfileError } = await supabase
    .from("grading_assignment_default_profiles")
    .select("*")
    .eq("class_id", course.id)
    .eq("name", gradingProfileName)
    .single();

  expect(createdProfileError).toBeNull();
  expect(createdProfile).not.toBeNull();

  const profile = createdProfile as GradingAssignmentDefaultProfile;

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete this grading default profile?");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Delete" }).first().click();
  await expect(page.getByText(gradingProfileName)).toBeVisible();

  await page.goto(`/course/${course.id}/manage/assignments/new`);
  await expect(page.getByRole("heading", { name: "Create New Assignment" })).toBeVisible();

  const savedProfileSelect = page.getByLabel("Saved profile");
  await savedProfileSelect.selectOption(String(profile.id));

  await expect(page.getByRole("checkbox", { name: "Auto assign grading at deadline" })).toBeChecked();
  await expect(page.getByLabel("Assignee pool")).toHaveValue("instructors_and_graders");
  const createDueHoursInput = page.getByLabel("Review due hours after assignment deadline");
  await expect(createDueHoursInput).toHaveValue("36");
  await expect(page.getByRole("checkbox", { name: "Enable late grading reminders" })).toBeChecked();
  await expect(page.getByLabel("Reminder interval (hours)")).toHaveValue("12");
  await expect(page.getByLabel("Reply-to email")).toHaveValue("grading-reply@example.edu");
  await expect(page.getByLabel("CC emails")).toHaveValue("staff1@example.edu, staff2@example.edu");

  const applyProfileCheckbox = page.getByRole("checkbox", { name: "Apply profile settings on selection" });
  await applyProfileCheckbox.uncheck();
  await createDueHoursInput.fill("99");
  await savedProfileSelect.selectOption("");
  await savedProfileSelect.selectOption(String(profile.id));
  await expect(createDueHoursInput).toHaveValue("99");

  await applyProfileCheckbox.check();
  await savedProfileSelect.selectOption("");
  await savedProfileSelect.selectOption(String(profile.id));
  await expect(createDueHoursInput).toHaveValue("36");

  const seededCcEmails = { emails: ["seeded-cc@example.edu"] };
  const { error: seedAssignmentError } = await supabase
    .from("assignments")
    .update({
      grading_default_profile_id: profile.id,
      auto_assign_at_deadline: true,
      auto_assign_assignee_pool: "instructors_and_graders",
      auto_assign_review_due_hours: 48,
      late_grading_reminders_enabled: true,
      late_grading_reminder_interval_hours: 24,
      late_grading_reply_to: "seeded-reply@example.edu",
      late_grading_cc_emails: seededCcEmails
    })
    .eq("id", assignment!.id);
  expect(seedAssignmentError).toBeNull();

  await page.goto(`/course/${course.id}/manage/assignments/${assignment!.id}/edit`);
  await expect(page.getByRole("heading", { name: "Edit Assignment" })).toBeVisible();

  const editProfileSelect = page.getByLabel("Saved profile");
  await expect(editProfileSelect).toHaveValue(String(profile.id));
  const editDueHoursInput = page.getByLabel("Review due hours after assignment deadline");
  await expect(editDueHoursInput).toHaveValue("48");
  await expect(page.getByLabel("Reminder interval (hours)")).toHaveValue("24");
  await expect(page.getByLabel("Reply-to email")).toHaveValue("seeded-reply@example.edu");
  await expect(page.getByLabel("CC emails")).toHaveValue("seeded-cc@example.edu");

  await editDueHoursInput.fill("77");
  await page.waitForTimeout(1500);
  await expect(editDueHoursInput).toHaveValue("77");

  await page.getByLabel("Reminder interval (hours)").fill("6");
  await page.getByLabel("Reply-to email").fill("updated-reply@example.edu");
  await page.getByLabel("CC emails").fill("updated-cc@example.edu");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("Assignment Updated")).toBeVisible({ timeout: 20_000 });

  await expect(async () => {
    const { data: persistedAssignment, error: persistedAssignmentError } = await supabase
      .from("assignments")
      .select(
        "grading_default_profile_id, auto_assign_review_due_hours, late_grading_reminder_interval_hours, late_grading_reply_to, late_grading_cc_emails"
      )
      .eq("id", assignment!.id)
      .single();

    expect(persistedAssignmentError).toBeNull();
    expect(persistedAssignment).not.toBeNull();
    expect(persistedAssignment!.grading_default_profile_id).toBe(profile.id);
    expect(persistedAssignment!.auto_assign_review_due_hours).toBe(77);
    expect(persistedAssignment!.late_grading_reminder_interval_hours).toBe(6);
    expect(persistedAssignment!.late_grading_reply_to).toBe("updated-reply@example.edu");
    expect((persistedAssignment!.late_grading_cc_emails as { emails: string[] }).emails).toEqual([
      "updated-cc@example.edu"
    ]);
  }).toPass({ timeout: 20_000 });
});
