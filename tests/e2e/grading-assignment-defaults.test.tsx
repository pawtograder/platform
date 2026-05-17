import { Assignment, Course, GradingAssignmentDefaultProfile } from "@/utils/supabase/DatabaseTypes";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import { test, expect } from "../global-setup";
import {
  createClass,
  createLabSectionWithStudents,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";

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
  // Chakra renders the styled Checkbox.Control above the hidden input, so it intercepts
  // pointer events from Playwright's .check(). Click the label text instead — that's the
  // pattern used elsewhere in the suite (see gradebook.test.tsx).
  const autoAssignProfileCheckbox = page.getByRole("checkbox", { name: "Auto assign at deadline" });
  if (!(await autoAssignProfileCheckbox.isChecked())) {
    await page.getByText("Auto assign at deadline", { exact: true }).click();
  }
  await expect(autoAssignProfileCheckbox).toBeChecked();
  await page.getByLabel("Assignee pool").selectOption("instructors_and_graders");
  await page.getByLabel("Review due hours after deadline").fill("36");
  const remindersProfileCheckbox = page.getByRole("checkbox", { name: "Enable late grading reminders" });
  if (!(await remindersProfileCheckbox.isChecked())) {
    await page.getByText("Enable late grading reminders", { exact: true }).click();
  }
  await expect(remindersProfileCheckbox).toBeChecked();
  await page.getByLabel("Reminder interval (hours)").fill("12");
  await page.getByLabel("Reply-to email").fill("grading-reply@example.edu");
  await page.getByLabel("CC emails").fill("staff1@example.edu, staff2@example.edu");

  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page.getByText("Profile created")).toBeVisible();
  await expect(page.getByText(gradingProfileName)).toBeVisible();
  await expect(page.getByText("Auto assign: on | Reminder: every 12h")).toBeVisible();

  const throwawayProfileName = `E2E Throwaway Profile ${profileNameSuffix}`;
  await page.getByLabel("Profile name").fill(throwawayProfileName);
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page.getByText(throwawayProfileName)).toBeVisible();

  const { data: createdProfile, error: createdProfileError } = await supabase
    .from("grading_assignment_default_profiles")
    .select("*")
    .eq("class_id", course.id)
    .eq("name", gradingProfileName)
    .single();

  expect(createdProfileError).toBeNull();
  expect(createdProfile).not.toBeNull();

  const profile = createdProfile as GradingAssignmentDefaultProfile;

  // Toast notifications from the prior `Create profile` clicks linger at the bottom-right
  // and overlay the Delete buttons. Use dispatchEvent("click") to bypass DOM-level pointer
  // interception (force:true only skips Playwright's actionability check, not DOM stacking).
  // The handler does an async DB lookup before showing window.confirm, so the dialog lags;
  // a single page-level dialog listener driven by a counter handles both confirms.
  let dialogIndex = 0;
  const onDialog = async (dialog: import("@playwright/test").Dialog) => {
    expect(dialog.message()).toContain("Delete this grading default profile?");
    dialogIndex += 1;
    if (dialogIndex === 1) {
      await dialog.dismiss();
    } else {
      await dialog.accept();
    }
  };
  page.on("dialog", onDialog);
  try {
    await page.getByRole("button", { name: "Delete" }).first().dispatchEvent("click");
    await expect.poll(() => dialogIndex, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await expect(page.getByText(gradingProfileName)).toBeVisible();

    await page.getByRole("button", { name: "Delete" }).nth(1).dispatchEvent("click");
    await expect.poll(() => dialogIndex, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.getByText(throwawayProfileName)).not.toBeVisible();
    await expect(page.getByText(gradingProfileName)).toBeVisible();
  } finally {
    page.off("dialog", onDialog);
  }

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
  const applyProfileLabel = page.getByText("Apply profile settings on selection", { exact: true });
  if (await applyProfileCheckbox.isChecked()) {
    await applyProfileLabel.click();
  }
  await expect(applyProfileCheckbox).not.toBeChecked();
  await createDueHoursInput.fill("99");
  await savedProfileSelect.selectOption("");
  await savedProfileSelect.selectOption(String(profile.id));
  await expect(createDueHoursInput).toHaveValue("99");

  if (!(await applyProfileCheckbox.isChecked())) {
    await applyProfileLabel.click();
  }
  await expect(applyProfileCheckbox).toBeChecked();
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

  // ManageAssignmentNav (the layout for /manage/assignments/[assignment_id]/*) renders its
  // children twice — once in a desktop Flex (display: { base: 'none', lg: 'flex' }) and once
  // in a mobile Flex (display: { base: 'flex', lg: 'none' }). Both are in the DOM regardless
  // of viewport, so every field label resolves to two elements. Scope to a single visible
  // form to keep strict-mode happy.
  const editForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Save" }) })
    .first();
  const editProfileSelect = editForm.getByLabel("Saved profile");
  await expect(editProfileSelect).toHaveValue(String(profile.id));
  const editDueHoursInput = editForm.getByLabel("Review due hours after assignment deadline");
  await expect(editDueHoursInput).toHaveValue("48");
  await expect(editForm.getByLabel("Reminder interval (hours)")).toHaveValue("24");
  await expect(editForm.getByLabel("Reply-to email")).toHaveValue("seeded-reply@example.edu");
  await expect(editForm.getByLabel("CC emails")).toHaveValue("seeded-cc@example.edu");

  await editDueHoursInput.fill("77");
  await page.waitForTimeout(1500);
  await expect(editDueHoursInput).toHaveValue("77");

  await editForm.getByLabel("Reminder interval (hours)").fill("6");
  await editForm.getByLabel("Reply-to email").fill("updated-reply@example.edu");
  await editForm.getByLabel("CC emails").fill("updated-cc@example.edu");
  await editForm.getByRole("button", { name: "Save" }).click();

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

test("deadline automation assigns grading to lab leaders and queues reminder emails", async () => {
  test.setTimeout(120_000);

  const workflowSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const [labLeaderA, labLeaderB, studentA, studentB] = await createUsersInClass([
    {
      name: `E2E Lab Leader A ${workflowSuffix}`,
      email: `e2e-lab-leader-a-${workflowSuffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: `E2E Lab Leader B ${workflowSuffix}`,
      email: `e2e-lab-leader-b-${workflowSuffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: `E2E Lab Student A ${workflowSuffix}`,
      email: `e2e-lab-student-a-${workflowSuffix}@pawtograder.net`,
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: `E2E Lab Student B ${workflowSuffix}`,
      email: `e2e-lab-student-b-${workflowSuffix}@pawtograder.net`,
      role: "student",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  await createLabSectionWithStudents({
    class_id: course.id,
    day_of_week: "monday",
    lab_leaders: [labLeaderA],
    students: [studentA],
    name: `E2E Auto-Assign Lab A ${workflowSuffix}`
  });
  await createLabSectionWithStudents({
    class_id: course.id,
    day_of_week: "tuesday",
    lab_leaders: [labLeaderB],
    students: [studentB],
    name: `E2E Auto-Assign Lab B ${workflowSuffix}`
  });

  const autoAssignment = await insertAssignment({
    class_id: course.id,
    due_date: addDays(new Date(), 1).toISOString(),
    name: `E2E Deadline Automation ${workflowSuffix}`,
    assignment_slug: `e2e-deadline-automation-${workflowSuffix}`
  });

  const reminderCcEmails = { emails: ["lab-leaders-reminders@example.edu"] };
  const { error: assignmentConfigError } = await supabase
    .from("assignments")
    .update({
      due_date: addDays(new Date(), -1).toISOString(),
      auto_assign_at_deadline: true,
      auto_assign_assignee_pool: "graders",
      auto_assign_review_due_hours: 0,
      late_grading_reminders_enabled: true,
      late_grading_reminder_interval_hours: 12,
      late_grading_reply_to: "lab-leaders-reply@example.edu",
      late_grading_cc_emails: reminderCcEmails
    })
    .eq("id", autoAssignment.id);
  expect(assignmentConfigError).toBeNull();

  const firstSubmission = await insertPreBakedSubmission({
    student_profile_id: studentA.private_profile_id,
    assignment_id: autoAssignment.id,
    class_id: course.id
  });
  const secondSubmission = await insertPreBakedSubmission({
    student_profile_id: studentB.private_profile_id,
    assignment_id: autoAssignment.id,
    class_id: course.id
  });

  await supabase.from("emails").delete().eq("class_id", course.id);
  await supabase.from("email_batches").delete().eq("class_id", course.id);

  const { error: runAutomationError } = await supabase.rpc("run_assignment_grading_automation");
  expect(runAutomationError).toBeNull();

  const expectedSubmissionIds = [firstSubmission.submission_id, secondSubmission.submission_id].sort((a, b) => a - b);
  const labLeaderProfileIds = [labLeaderA.private_profile_id, labLeaderB.private_profile_id];

  await expect(async () => {
    const { data: reviewAssignments, error: reviewAssignmentsError } = await supabase
      .from("review_assignments")
      .select("submission_id, assignee_profile_id, completed_at, due_date")
      .eq("assignment_id", autoAssignment.id)
      .eq("class_id", course.id)
      .eq("rubric_id", autoAssignment.grading_rubric_id!);

    expect(reviewAssignmentsError).toBeNull();
    expect(reviewAssignments).not.toBeNull();
    expect(reviewAssignments!.length).toBe(2);
    expect(reviewAssignments!.map((row) => row.submission_id).sort((a, b) => a - b)).toEqual(expectedSubmissionIds);
    for (const row of reviewAssignments!) {
      expect(row.completed_at).toBeNull();
      expect(labLeaderProfileIds).toContain(row.assignee_profile_id);
      expect(new Date(row.due_date).getTime()).toBeLessThanOrEqual(Date.now());
    }
  }).toPass({ timeout: 20_000 });

  await expect(async () => {
    const { data: stateRow, error: stateError } = await supabase
      .from("assignment_grading_automation_state")
      .select("auto_assigned_at, last_reminder_sent_at, last_reminder_recipient_count")
      .eq("assignment_id", autoAssignment.id)
      .single();

    expect(stateError).toBeNull();
    expect(stateRow).not.toBeNull();
    expect(stateRow!.auto_assigned_at).not.toBeNull();
    expect(stateRow!.last_reminder_sent_at).not.toBeNull();
    expect(stateRow!.last_reminder_recipient_count).toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });

  await expect(async () => {
    const { data: queuedEmails, error: queuedEmailsError } = await supabase
      .from("emails")
      .select("batch_id, user_id, subject, reply_to, cc_emails")
      .eq("class_id", course.id)
      .like("subject", `Late grading reminder: ${autoAssignment.title}%`);
    expect(queuedEmailsError).toBeNull();
    expect(queuedEmails).not.toBeNull();
    expect(queuedEmails!.length).toBeGreaterThan(0);

    const queuedUserIds = new Set(queuedEmails!.map((row) => row.user_id));
    const expectedUserIds = new Set([labLeaderA.user_id, labLeaderB.user_id]);
    for (const userId of queuedUserIds) {
      expect(expectedUserIds.has(userId)).toBe(true);
    }

    for (const row of queuedEmails!) {
      expect(row.reply_to).toBe("lab-leaders-reply@example.edu");
      expect((row.cc_emails as { emails: string[] }).emails).toEqual(["lab-leaders-reminders@example.edu"]);
    }
  }).toPass({ timeout: 20_000 });
});

// ---------------------------------------------------------------------------
// Shared helpers for the assignee-pool, idempotency, cadence, and filter
// tests below. These exercise auto_assign_grading_reviews_for_assignment,
// queue_late_grading_reminders_for_assignment, and run_assignment_grading_automation
// across branches and corner cases that the higher-level happy-path tests do
// not reach.
// ---------------------------------------------------------------------------

type AutoAssignConfig = {
  due_date?: string;
  auto_assign_at_deadline?: boolean;
  auto_assign_assignee_pool: "graders" | "instructors" | "instructors_and_graders" | "lab_leaders" | "group_mentors";
  auto_assign_review_due_hours?: number;
  auto_assign_grader_subset_private_profile_ids?: string[];
  late_grading_reminders_enabled?: boolean;
  late_grading_reminder_interval_hours?: number | null;
  late_grading_reply_to?: string | null;
  late_grading_cc_emails?: { emails: string[] };
};

async function configureAutoAssign(assignmentId: number, config: AutoAssignConfig) {
  const { error } = await supabase
    .from("assignments")
    .update({
      due_date: config.due_date ?? addDays(new Date(), -1).toISOString(),
      auto_assign_at_deadline: config.auto_assign_at_deadline ?? true,
      auto_assign_assignee_pool: config.auto_assign_assignee_pool,
      auto_assign_review_due_hours: config.auto_assign_review_due_hours ?? 0,
      auto_assign_grader_subset_private_profile_ids: config.auto_assign_grader_subset_private_profile_ids ?? [],
      late_grading_reminders_enabled: config.late_grading_reminders_enabled ?? false,
      late_grading_reminder_interval_hours:
        config.late_grading_reminders_enabled === false ? null : (config.late_grading_reminder_interval_hours ?? null),
      late_grading_reply_to: config.late_grading_reply_to ?? null,
      late_grading_cc_emails: config.late_grading_cc_emails ?? { emails: [] }
    })
    .eq("id", assignmentId);
  expect(error).toBeNull();
}

async function insertGradingConflict({
  classId,
  graderProfileId,
  studentProfileId,
  createdByProfileId
}: {
  classId: number;
  graderProfileId: string;
  studentProfileId: string;
  createdByProfileId: string;
}) {
  const { error } = await supabase.from("grading_conflicts").insert({
    class_id: classId,
    grader_profile_id: graderProfileId,
    student_profile_id: studentProfileId,
    created_by_profile_id: createdByProfileId
  });
  expect(error).toBeNull();
}

async function insertAssignmentGroup({
  classId,
  assignmentId,
  name,
  mentorProfileId,
  memberProfileIds,
  addedByProfileId
}: {
  classId: number;
  assignmentId: number;
  name: string;
  mentorProfileId: string | null;
  memberProfileIds: string[];
  addedByProfileId: string;
}): Promise<number> {
  const { data: groupRow, error: groupError } = await supabase
    .from("assignment_groups")
    .insert({
      class_id: classId,
      assignment_id: assignmentId,
      name,
      mentor_profile_id: mentorProfileId
    })
    .select("id")
    .single();
  expect(groupError).toBeNull();
  const groupId = groupRow!.id;

  if (memberProfileIds.length > 0) {
    const { error: memberError } = await supabase.from("assignment_groups_members").insert(
      memberProfileIds.map((pid) => ({
        assignment_group_id: groupId,
        class_id: classId,
        assignment_id: assignmentId,
        profile_id: pid,
        added_by: addedByProfileId
      }))
    );
    expect(memberError).toBeNull();
  }
  return groupId;
}

async function fetchReviewAssignments(assignmentId: number, rubricId: number) {
  const { data, error } = await supabase
    .from("review_assignments")
    .select("submission_id, assignee_profile_id, completed_at, due_date, rubric_id")
    .eq("assignment_id", assignmentId)
    .eq("rubric_id", rubricId);
  expect(error).toBeNull();
  return data ?? [];
}

function makeSuffix(label: string) {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

test("auto-assign with 'instructors' pool rotates submissions across active instructors", async () => {
  test.setTimeout(120_000);
  const suffix = makeSuffix("instructors-pool");

  const [extraInstructorA, extraInstructorB, student1, student2, student3] = await createUsersInClass([
    {
      name: `E2E Inst Pool A ${suffix}`,
      email: `e2e-inst-pool-a-${suffix}@pawtograder.net`,
      role: "instructor",
      class_id: course.id
    },
    {
      name: `E2E Inst Pool B ${suffix}`,
      email: `e2e-inst-pool-b-${suffix}@pawtograder.net`,
      role: "instructor",
      class_id: course.id
    },
    {
      name: `E2E IP Student 1 ${suffix}`,
      email: `e2e-ip-s1-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    },
    {
      name: `E2E IP Student 2 ${suffix}`,
      email: `e2e-ip-s2-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    },
    {
      name: `E2E IP Student 3 ${suffix}`,
      email: `e2e-ip-s3-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    }
  ]);

  const a = await insertAssignment({
    class_id: course.id,
    due_date: addDays(new Date(), 1).toISOString(),
    name: `E2E Instructors Pool ${suffix}`,
    assignment_slug: `e2e-instructors-pool-${suffix}`
  });
  await configureAutoAssign(a.id, { auto_assign_assignee_pool: "instructors" });

  await insertPreBakedSubmission({
    student_profile_id: student1.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });
  await insertPreBakedSubmission({
    student_profile_id: student2.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });
  await insertPreBakedSubmission({
    student_profile_id: student3.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });

  const { error: rpcError } = await supabase.rpc("run_assignment_grading_automation");
  expect(rpcError).toBeNull();

  // Original beforeAll instructor + extraInstructorA + extraInstructorB are eligible.
  const instructorPool = new Set([
    instructor!.private_profile_id,
    extraInstructorA.private_profile_id,
    extraInstructorB.private_profile_id
  ]);

  const rows = await fetchReviewAssignments(a.id, a.grading_rubric_id!);
  expect(rows.length).toBe(3);
  for (const row of rows) {
    expect(instructorPool.has(row.assignee_profile_id)).toBe(true);
  }
  // Round-robin: with 3 submissions and 3 instructors each instructor should be hit exactly once.
  const distinctAssignees = new Set(rows.map((r) => r.assignee_profile_id));
  expect(distinctAssignees.size).toBe(3);
});

test("auto-assign with 'instructors_and_graders' pool rotates across both roles", async () => {
  test.setTimeout(120_000);
  const suffix = makeSuffix("inst-graders-pool");

  const [graderA, graderB, student1, student2] = await createUsersInClass([
    {
      name: `E2E IG Grader A ${suffix}`,
      email: `e2e-ig-grader-a-${suffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id
    },
    {
      name: `E2E IG Grader B ${suffix}`,
      email: `e2e-ig-grader-b-${suffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id
    },
    {
      name: `E2E IG Student 1 ${suffix}`,
      email: `e2e-ig-s1-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    },
    {
      name: `E2E IG Student 2 ${suffix}`,
      email: `e2e-ig-s2-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    }
  ]);

  const a = await insertAssignment({
    class_id: course.id,
    due_date: addDays(new Date(), 1).toISOString(),
    name: `E2E Instructors+Graders ${suffix}`,
    assignment_slug: `e2e-instructors-graders-${suffix}`
  });
  await configureAutoAssign(a.id, { auto_assign_assignee_pool: "instructors_and_graders" });

  await insertPreBakedSubmission({
    student_profile_id: student1.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });
  await insertPreBakedSubmission({
    student_profile_id: student2.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });

  const { error: rpcError } = await supabase.rpc("run_assignment_grading_automation");
  expect(rpcError).toBeNull();

  // Pool includes every non-disabled instructor or grader in the course. Capture the live snapshot,
  // since prior tests may have added graders.
  const { data: pool, error: poolError } = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("class_id", course.id)
    .eq("disabled", false)
    .in("role", ["grader", "instructor"]);
  expect(poolError).toBeNull();
  const poolIds = new Set(pool!.map((r) => r.private_profile_id));
  // Sanity: the freshly created graders must be in the pool.
  expect(poolIds.has(graderA.private_profile_id)).toBe(true);
  expect(poolIds.has(graderB.private_profile_id)).toBe(true);

  const rows = await fetchReviewAssignments(a.id, a.grading_rubric_id!);
  expect(rows.length).toBe(2);
  for (const row of rows) {
    expect(poolIds.has(row.assignee_profile_id)).toBe(true);
  }
});

test("auto-assign with 'graders' subset restricts rotation to the selected graders", async () => {
  test.setTimeout(120_000);
  const suffix = makeSuffix("graders-subset");

  const [allowedGrader, excludedGrader, student1, student2, student3] = await createUsersInClass([
    {
      name: `E2E Allowed Grader ${suffix}`,
      email: `e2e-allowed-grader-${suffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id
    },
    {
      name: `E2E Excluded Grader ${suffix}`,
      email: `e2e-excluded-grader-${suffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id
    },
    {
      name: `E2E GS Student 1 ${suffix}`,
      email: `e2e-gs-s1-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    },
    {
      name: `E2E GS Student 2 ${suffix}`,
      email: `e2e-gs-s2-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    },
    {
      name: `E2E GS Student 3 ${suffix}`,
      email: `e2e-gs-s3-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    }
  ]);

  const a = await insertAssignment({
    class_id: course.id,
    due_date: addDays(new Date(), 1).toISOString(),
    name: `E2E Graders Subset ${suffix}`,
    assignment_slug: `e2e-graders-subset-${suffix}`
  });
  await configureAutoAssign(a.id, {
    auto_assign_assignee_pool: "graders",
    auto_assign_grader_subset_private_profile_ids: [allowedGrader.private_profile_id]
  });

  await insertPreBakedSubmission({
    student_profile_id: student1.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });
  await insertPreBakedSubmission({
    student_profile_id: student2.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });
  await insertPreBakedSubmission({
    student_profile_id: student3.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });

  const { error: rpcError } = await supabase.rpc("run_assignment_grading_automation");
  expect(rpcError).toBeNull();

  const rows = await fetchReviewAssignments(a.id, a.grading_rubric_id!);
  expect(rows.length).toBe(3);
  for (const row of rows) {
    // Subset only contains allowedGrader; excludedGrader must never be picked even though they
    // would otherwise qualify under the full graders pool.
    expect(row.assignee_profile_id).toBe(allowedGrader.private_profile_id);
    expect(row.assignee_profile_id).not.toBe(excludedGrader.private_profile_id);
  }
});

test("auto-assign with 'lab_leaders' pool assigns submissions to section leaders and skips conflicted leaders", async () => {
  test.setTimeout(120_000);
  const suffix = makeSuffix("lab-leaders-conflict");

  const [leaderA1, leaderA2, leaderBSolo, studentA, studentB] = await createUsersInClass([
    { name: `E2E LL A1 ${suffix}`, email: `e2e-ll-a1-${suffix}@pawtograder.net`, role: "grader", class_id: course.id },
    { name: `E2E LL A2 ${suffix}`, email: `e2e-ll-a2-${suffix}@pawtograder.net`, role: "grader", class_id: course.id },
    { name: `E2E LL B ${suffix}`, email: `e2e-ll-b-${suffix}@pawtograder.net`, role: "grader", class_id: course.id },
    {
      name: `E2E LL Student A ${suffix}`,
      email: `e2e-ll-sa-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    },
    {
      name: `E2E LL Student B ${suffix}`,
      email: `e2e-ll-sb-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    }
  ]);

  // Section A has two leaders. Leader A1 has a conflict with student A, so only Leader A2 should
  // be assigned student A's submission. Section B has a single leader (solo).
  await createLabSectionWithStudents({
    class_id: course.id,
    day_of_week: "monday",
    lab_leaders: [leaderA1, leaderA2],
    students: [studentA],
    name: `E2E Lab A (conflict) ${suffix}`
  });
  await createLabSectionWithStudents({
    class_id: course.id,
    day_of_week: "tuesday",
    lab_leaders: [leaderBSolo],
    students: [studentB],
    name: `E2E Lab B (solo) ${suffix}`
  });

  await insertGradingConflict({
    classId: course.id,
    graderProfileId: leaderA1.private_profile_id,
    studentProfileId: studentA.private_profile_id,
    createdByProfileId: instructor!.private_profile_id
  });

  const a = await insertAssignment({
    class_id: course.id,
    due_date: addDays(new Date(), 1).toISOString(),
    name: `E2E Lab Leaders Conflict ${suffix}`,
    assignment_slug: `e2e-lab-leaders-conflict-${suffix}`
  });
  await configureAutoAssign(a.id, { auto_assign_assignee_pool: "lab_leaders" });

  const subA = await insertPreBakedSubmission({
    student_profile_id: studentA.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });
  const subB = await insertPreBakedSubmission({
    student_profile_id: studentB.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });

  const { error: rpcError } = await supabase.rpc("run_assignment_grading_automation");
  expect(rpcError).toBeNull();

  const rows = await fetchReviewAssignments(a.id, a.grading_rubric_id!);
  const byAssignee = (sid: number) =>
    rows
      .filter((r) => r.submission_id === sid)
      .map((r) => r.assignee_profile_id)
      .sort();

  // Submission A should have exactly one review assignment: leaderA2 (leaderA1 was conflicted out).
  expect(byAssignee(subA.submission_id)).toEqual([leaderA2.private_profile_id].sort());
  // Submission B should have exactly one review assignment: leaderBSolo.
  expect(byAssignee(subB.submission_id)).toEqual([leaderBSolo.private_profile_id].sort());
});

test("auto-assign with 'group_mentors' pool assigns submissions to mentor and skips conflicted mentors", async () => {
  test.setTimeout(120_000);
  const suffix = makeSuffix("group-mentors");

  const [mentorClean, mentorConflict, memberClean, memberConflict] = await createUsersInClass([
    {
      name: `E2E Mentor Clean ${suffix}`,
      email: `e2e-mentor-clean-${suffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id
    },
    {
      name: `E2E Mentor Conflict ${suffix}`,
      email: `e2e-mentor-conflict-${suffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id
    },
    {
      name: `E2E GM Member Clean ${suffix}`,
      email: `e2e-gm-mc-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    },
    {
      name: `E2E GM Member Conflict ${suffix}`,
      email: `e2e-gm-mx-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    }
  ]);

  const a = await insertAssignment({
    class_id: course.id,
    due_date: addDays(new Date(), 1).toISOString(),
    name: `E2E Group Mentors ${suffix}`,
    assignment_slug: `e2e-group-mentors-${suffix}`,
    group_config: "groups",
    min_group_size: 1,
    max_group_size: 4,
    group_formation_deadline: addDays(new Date(), 7).toISOString()
  });
  await configureAutoAssign(a.id, { auto_assign_assignee_pool: "group_mentors" });

  const cleanGroupId = await insertAssignmentGroup({
    classId: course.id,
    assignmentId: a.id,
    name: `Group Clean ${suffix}`,
    mentorProfileId: mentorClean.private_profile_id,
    memberProfileIds: [memberClean.private_profile_id],
    addedByProfileId: instructor!.private_profile_id
  });
  const conflictGroupId = await insertAssignmentGroup({
    classId: course.id,
    assignmentId: a.id,
    name: `Group Conflict ${suffix}`,
    mentorProfileId: mentorConflict.private_profile_id,
    memberProfileIds: [memberConflict.private_profile_id],
    addedByProfileId: instructor!.private_profile_id
  });

  await insertGradingConflict({
    classId: course.id,
    graderProfileId: mentorConflict.private_profile_id,
    studentProfileId: memberConflict.private_profile_id,
    createdByProfileId: instructor!.private_profile_id
  });

  const subClean = await insertPreBakedSubmission({
    assignment_group_id: cleanGroupId,
    assignment_id: a.id,
    class_id: course.id
  });
  const subConflict = await insertPreBakedSubmission({
    assignment_group_id: conflictGroupId,
    assignment_id: a.id,
    class_id: course.id
  });

  const { error: rpcError } = await supabase.rpc("run_assignment_grading_automation");
  expect(rpcError).toBeNull();

  const rows = await fetchReviewAssignments(a.id, a.grading_rubric_id!);
  // Clean group's submission gets a review assignment for its mentor.
  const cleanRows = rows.filter((r) => r.submission_id === subClean.submission_id);
  expect(cleanRows.length).toBe(1);
  expect(cleanRows[0].assignee_profile_id).toBe(mentorClean.private_profile_id);
  // Conflicted group's submission gets none — the mentor is skipped, and there's no fallback.
  const conflictRows = rows.filter((r) => r.submission_id === subConflict.submission_id);
  expect(conflictRows.length).toBe(0);
});

test("run_assignment_grading_automation is idempotent across repeated calls", async () => {
  test.setTimeout(120_000);
  const suffix = makeSuffix("idempotency");

  const [grader1, student1, student2] = await createUsersInClass([
    {
      name: `E2E Idem Grader ${suffix}`,
      email: `e2e-idem-grader-${suffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id
    },
    {
      name: `E2E Idem S1 ${suffix}`,
      email: `e2e-idem-s1-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    },
    {
      name: `E2E Idem S2 ${suffix}`,
      email: `e2e-idem-s2-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    }
  ]);

  const a = await insertAssignment({
    class_id: course.id,
    due_date: addDays(new Date(), 1).toISOString(),
    name: `E2E Idempotency ${suffix}`,
    assignment_slug: `e2e-idempotency-${suffix}`
  });
  await configureAutoAssign(a.id, {
    auto_assign_assignee_pool: "graders",
    auto_assign_grader_subset_private_profile_ids: [grader1.private_profile_id],
    late_grading_reminders_enabled: true,
    late_grading_reminder_interval_hours: 12,
    late_grading_reply_to: "idem-reply@example.edu",
    late_grading_cc_emails: { emails: ["idem-cc@example.edu"] }
  });

  await insertPreBakedSubmission({
    student_profile_id: student1.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });
  await insertPreBakedSubmission({
    student_profile_id: student2.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });

  // First run.
  const { error: firstError } = await supabase.rpc("run_assignment_grading_automation");
  expect(firstError).toBeNull();

  const firstRows = await fetchReviewAssignments(a.id, a.grading_rubric_id!);
  expect(firstRows.length).toBe(2);

  const { data: firstState, error: firstStateError } = await supabase
    .from("assignment_grading_automation_state")
    .select("auto_assigned_at, last_reminder_sent_at, last_reminder_recipient_count")
    .eq("assignment_id", a.id)
    .single();
  expect(firstStateError).toBeNull();
  expect(firstState!.auto_assigned_at).not.toBeNull();
  expect(firstState!.last_reminder_sent_at).not.toBeNull();
  const firstAutoAssignedAt = firstState!.auto_assigned_at;
  const firstReminderSentAt = firstState!.last_reminder_sent_at;

  const subjectLike = `Late grading reminder: ${a.title}%`;
  const { data: batchesAfterFirst, error: batchesAfterFirstError } = await supabase
    .from("email_batches")
    .select("id")
    .eq("class_id", course.id)
    .like("subject", subjectLike);
  expect(batchesAfterFirstError).toBeNull();
  const firstBatchCount = batchesAfterFirst!.length;
  expect(firstBatchCount).toBeGreaterThan(0);

  // Second run, immediately. Inner gates (auto_assigned_at IS NULL; reminder interval not elapsed)
  // should make this a no-op for both branches; new-outer-WHERE should make the row not even
  // selected. Either way, no new review_assignments and no new reminder batches.
  const { error: secondError } = await supabase.rpc("run_assignment_grading_automation");
  expect(secondError).toBeNull();

  const secondRows = await fetchReviewAssignments(a.id, a.grading_rubric_id!);
  expect(secondRows.length).toBe(firstRows.length);

  const { data: secondState, error: secondStateError } = await supabase
    .from("assignment_grading_automation_state")
    .select("auto_assigned_at, last_reminder_sent_at")
    .eq("assignment_id", a.id)
    .single();
  expect(secondStateError).toBeNull();
  // Neither marker should have advanced.
  expect(secondState!.auto_assigned_at).toBe(firstAutoAssignedAt);
  expect(secondState!.last_reminder_sent_at).toBe(firstReminderSentAt);

  const { data: batchesAfterSecond, error: batchesAfterSecondError } = await supabase
    .from("email_batches")
    .select("id")
    .eq("class_id", course.id)
    .like("subject", subjectLike);
  expect(batchesAfterSecondError).toBeNull();
  expect(batchesAfterSecond!.length).toBe(firstBatchCount);
});

test("reminders only refire after the configured interval elapses", async () => {
  test.setTimeout(120_000);
  const suffix = makeSuffix("cadence");
  const intervalHours = 6;

  const [graderC, studentC] = await createUsersInClass([
    {
      name: `E2E Cadence Grader ${suffix}`,
      email: `e2e-cad-grader-${suffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id
    },
    {
      name: `E2E Cadence Student ${suffix}`,
      email: `e2e-cad-s-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    }
  ]);

  const a = await insertAssignment({
    class_id: course.id,
    due_date: addDays(new Date(), 1).toISOString(),
    name: `E2E Reminder Cadence ${suffix}`,
    assignment_slug: `e2e-cadence-${suffix}`
  });
  await configureAutoAssign(a.id, {
    auto_assign_assignee_pool: "graders",
    auto_assign_grader_subset_private_profile_ids: [graderC.private_profile_id],
    late_grading_reminders_enabled: true,
    late_grading_reminder_interval_hours: intervalHours,
    late_grading_reply_to: "cadence-reply@example.edu",
    late_grading_cc_emails: { emails: ["cadence-cc@example.edu"] }
  });

  await insertPreBakedSubmission({
    student_profile_id: studentC.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });

  const subjectLike = `Late grading reminder: ${a.title}%`;

  // First tick: reminder is queued.
  const { error: firstError } = await supabase.rpc("run_assignment_grading_automation");
  expect(firstError).toBeNull();
  const { data: firstBatches } = await supabase.from("email_batches").select("id").like("subject", subjectLike);
  expect(firstBatches!.length).toBe(1);

  // Second tick, immediately. Interval has not elapsed → no new batch.
  const { error: secondError } = await supabase.rpc("run_assignment_grading_automation");
  expect(secondError).toBeNull();
  const { data: secondBatches } = await supabase.from("email_batches").select("id").like("subject", subjectLike);
  expect(secondBatches!.length).toBe(1);

  // Backdate last_reminder_sent_at past the interval. Now the cadence check should fire again.
  const backdated = new Date(Date.now() - (intervalHours + 1) * 60 * 60 * 1000).toISOString();
  const { error: updateError } = await supabase
    .from("assignment_grading_automation_state")
    .update({ last_reminder_sent_at: backdated })
    .eq("assignment_id", a.id);
  expect(updateError).toBeNull();

  const { error: thirdError } = await supabase.rpc("run_assignment_grading_automation");
  expect(thirdError).toBeNull();
  const { data: thirdBatches } = await supabase.from("email_batches").select("id").like("subject", subjectLike);
  expect(thirdBatches!.length).toBe(2);
});

test("reminder email queue excludes completed, future-due, disabled, and wrong-rubric review assignments", async () => {
  test.setTimeout(120_000);
  const suffix = makeSuffix("reminder-filters");

  const [graderActive, graderDisabled, graderCompleted, graderFuture, graderWrongRubric, studentSeed] =
    await createUsersInClass([
      {
        name: `E2E Active Grader ${suffix}`,
        email: `e2e-rf-active-${suffix}@pawtograder.net`,
        role: "grader",
        class_id: course.id
      },
      {
        name: `E2E Disabled Grader ${suffix}`,
        email: `e2e-rf-disabled-${suffix}@pawtograder.net`,
        role: "grader",
        class_id: course.id
      },
      {
        name: `E2E Completed Grader ${suffix}`,
        email: `e2e-rf-completed-${suffix}@pawtograder.net`,
        role: "grader",
        class_id: course.id
      },
      {
        name: `E2E Future Grader ${suffix}`,
        email: `e2e-rf-future-${suffix}@pawtograder.net`,
        role: "grader",
        class_id: course.id
      },
      {
        name: `E2E Wrong-Rubric Grader ${suffix}`,
        email: `e2e-rf-wr-${suffix}@pawtograder.net`,
        role: "grader",
        class_id: course.id
      },
      {
        name: `E2E RF Student ${suffix}`,
        email: `e2e-rf-student-${suffix}@pawtograder.net`,
        role: "student",
        class_id: course.id
      }
    ]);

  // Disable graderDisabled so the disabled-grader filter has work to do.
  const { error: disableError } = await supabase
    .from("user_roles")
    .update({ disabled: true })
    .eq("private_profile_id", graderDisabled.private_profile_id)
    .eq("class_id", course.id);
  expect(disableError).toBeNull();

  const a = await insertAssignment({
    class_id: course.id,
    due_date: addDays(new Date(), 1).toISOString(),
    name: `E2E Reminder Filters ${suffix}`,
    assignment_slug: `e2e-reminder-filters-${suffix}`
  });
  await configureAutoAssign(a.id, {
    auto_assign_at_deadline: false, // We seed review_assignments by hand for full control.
    auto_assign_assignee_pool: "graders",
    late_grading_reminders_enabled: true,
    late_grading_reminder_interval_hours: 12,
    late_grading_reply_to: "filters-reply@example.edu",
    late_grading_cc_emails: { emails: ["filters-cc@example.edu"] }
  });

  // Single submission — each review_assignment row is keyed differently so all five can coexist
  // on the same submission_review/rubric combo by assigning to distinct assignees.
  const sub = await insertPreBakedSubmission({
    student_profile_id: studentSeed.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });

  // Look up (or create) the submission_review rows that review_assignments FK-reference. Other
  // triggers in the system may auto-create the grading-rubric submission_review on submission
  // insert, so use upsert-style logic to be robust to that.
  const ensureSubmissionReview = async (rubricId: number, name: string): Promise<number> => {
    const { data: existing } = await supabase
      .from("submission_reviews")
      .select("id")
      .eq("submission_id", sub.submission_id)
      .eq("rubric_id", rubricId)
      .maybeSingle();
    if (existing) return existing.id;
    const { data: created, error: createErr } = await supabase
      .from("submission_reviews")
      .insert({
        submission_id: sub.submission_id,
        rubric_id: rubricId,
        class_id: course.id,
        name,
        total_score: 0,
        total_autograde_score: 0,
        tweak: 0
      })
      .select("id")
      .single();
    expect(createErr).toBeNull();
    return created!.id;
  };
  const gradingReviewId = await ensureSubmissionReview(a.grading_rubric_id!, "Grading review for reminder-filter test");
  const selfReviewId = await ensureSubmissionReview(a.self_review_rubric_id!, "Self review for reminder-filter test");

  const overdue = addDays(new Date(), -1).toISOString();
  const future = addDays(new Date(), 3).toISOString();

  const { error: raInsertError } = await supabase.from("review_assignments").insert([
    // INCLUDED: overdue, incomplete, enabled grader, matching rubric.
    {
      assignee_profile_id: graderActive.private_profile_id,
      submission_id: sub.submission_id,
      submission_review_id: gradingReviewId,
      assignment_id: a.id,
      rubric_id: a.grading_rubric_id!,
      class_id: course.id,
      due_date: overdue
    },
    // EXCLUDED (completed_at set).
    {
      assignee_profile_id: graderCompleted.private_profile_id,
      submission_id: sub.submission_id,
      submission_review_id: gradingReviewId,
      assignment_id: a.id,
      rubric_id: a.grading_rubric_id!,
      class_id: course.id,
      due_date: overdue,
      completed_at: new Date().toISOString()
    },
    // EXCLUDED (due_date in future).
    {
      assignee_profile_id: graderFuture.private_profile_id,
      submission_id: sub.submission_id,
      submission_review_id: gradingReviewId,
      assignment_id: a.id,
      rubric_id: a.grading_rubric_id!,
      class_id: course.id,
      due_date: future
    },
    // EXCLUDED (disabled grader).
    {
      assignee_profile_id: graderDisabled.private_profile_id,
      submission_id: sub.submission_id,
      submission_review_id: gradingReviewId,
      assignment_id: a.id,
      rubric_id: a.grading_rubric_id!,
      class_id: course.id,
      due_date: overdue
    },
    // EXCLUDED (rubric mismatch — uses the self-review rubric instead of the grading rubric).
    {
      assignee_profile_id: graderWrongRubric.private_profile_id,
      submission_id: sub.submission_id,
      submission_review_id: selfReviewId,
      assignment_id: a.id,
      rubric_id: a.self_review_rubric_id!,
      class_id: course.id,
      due_date: overdue
    }
  ]);
  expect(raInsertError).toBeNull();

  const subjectLike = `Late grading reminder: ${a.title}%`;
  const { error: rpcError } = await supabase.rpc("run_assignment_grading_automation");
  expect(rpcError).toBeNull();

  const { data: emails, error: emailsErr } = await supabase
    .from("emails")
    .select("user_id, subject")
    .like("subject", subjectLike);
  expect(emailsErr).toBeNull();

  const recipientUserIds = new Set(emails!.map((row) => row.user_id));

  // Only the active grader with an overdue incomplete review on the matching rubric should be
  // emailed; the four excluded cases must not appear.
  expect(recipientUserIds.has(graderActive.user_id)).toBe(true);
  expect(recipientUserIds.has(graderCompleted.user_id)).toBe(false);
  expect(recipientUserIds.has(graderFuture.user_id)).toBe(false);
  expect(recipientUserIds.has(graderDisabled.user_id)).toBe(false);
  expect(recipientUserIds.has(graderWrongRubric.user_id)).toBe(false);
});

test("late submission after deadline is auto-assigned at submission time without running the cron", async () => {
  test.setTimeout(120_000);
  const suffix = makeSuffix("late-submission");

  const [graderLate, studentEarly, studentLate] = await createUsersInClass([
    {
      name: `E2E Late Grader ${suffix}`,
      email: `e2e-late-grader-${suffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id
    },
    {
      name: `E2E Early Student ${suffix}`,
      email: `e2e-early-s-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    },
    {
      name: `E2E Late Student ${suffix}`,
      email: `e2e-late-s-${suffix}@pawtograder.net`,
      role: "student",
      class_id: course.id
    }
  ]);

  const a = await insertAssignment({
    class_id: course.id,
    due_date: addDays(new Date(), 1).toISOString(),
    name: `E2E Late Submission ${suffix}`,
    assignment_slug: `e2e-late-submission-${suffix}`
  });

  // Pre-deadline configuration: submission inserted now should NOT be auto-assigned by the
  // trigger, because the deadline is still in the future. The cron is the right path for these.
  await configureAutoAssign(a.id, {
    auto_assign_at_deadline: true,
    auto_assign_assignee_pool: "graders",
    auto_assign_grader_subset_private_profile_ids: [graderLate.private_profile_id],
    due_date: addDays(new Date(), 1).toISOString()
  });

  const earlySub = await insertPreBakedSubmission({
    student_profile_id: studentEarly.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });

  // Trigger must NOT fire on this pre-deadline submission.
  {
    const { data: preRows, error: preErr } = await supabase
      .from("review_assignments")
      .select("submission_id")
      .eq("assignment_id", a.id)
      .eq("rubric_id", a.grading_rubric_id!);
    expect(preErr).toBeNull();
    expect(preRows!.length).toBe(0);
  }

  // Now flip the deadline to the past, simulating a student with a due-date extension who is
  // submitting after the assignment's nominal deadline has already passed.
  const { error: pastDueError } = await supabase
    .from("assignments")
    .update({ due_date: addDays(new Date(), -1).toISOString() })
    .eq("id", a.id);
  expect(pastDueError).toBeNull();

  // Capture review_assignments count immediately before the late insert so the post-condition
  // is unambiguous.
  const lateSub = await insertPreBakedSubmission({
    student_profile_id: studentLate.private_profile_id,
    assignment_id: a.id,
    class_id: course.id
  });

  // Trigger must have fired during the INSERT — assert without invoking the cron RPC.
  const lateRows = await fetchReviewAssignments(a.id, a.grading_rubric_id!);
  const lateRowForSub = lateRows.find((r) => r.submission_id === lateSub.submission_id);
  expect(lateRowForSub).toBeDefined();
  expect(lateRowForSub!.assignee_profile_id).toBe(graderLate.private_profile_id);
  // The earlier (pre-deadline) submission still has no review_assignment — the cron handles those.
  expect(lateRows.find((r) => r.submission_id === earlySub.submission_id)).toBeUndefined();

  // Verify the cron makes the early submission whole. After running, both submissions have a row.
  const { error: rpcError } = await supabase.rpc("run_assignment_grading_automation");
  expect(rpcError).toBeNull();
  const finalRows = await fetchReviewAssignments(a.id, a.grading_rubric_id!);
  expect(finalRows.length).toBe(2);
  expect(finalRows.every((r) => r.assignee_profile_id === graderLate.private_profile_id)).toBe(true);
});
