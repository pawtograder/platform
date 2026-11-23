/**
 * #1010 step 4a: controls graders can't use are hidden with useCapability(), and instructors see
 * the pages unchanged.
 *
 * - Manage Review Assignments: its actions, and the Bulk Assign and Reassign pages, need
 *   manage_review_assignments. Without it those two pages send you back to the reviews page.
 * - Manage Groups: every change needs publish_groups; without it the page is read-only.
 * - Flashcard Decks: create / delete need manage_flashcards. The default grader role holds it; a
 *   custom role with it turned off keeps the nav entry and hides list controls and deck-detail add / edit /
 *   delete card controls.
 * - Manage Surveys: create / publish / delete need manage_surveys (instructor-only by default).
 * - Manage Polls: create / open / close / delete need run_polls. The default grader role holds it; a
 *   custom role with it turned off hides those controls.
 *
 * Default roles only for the review and groups checks: the instructor role holds those capabilities,
 * the grader role holds neither, until the last review test gives the default grader role
 * manage_review_assignments (instructors can edit it since 20261119120000_custom_roles_copy_grader_role.sql).
 * The flashcard, survey and poll checks use their own custom roles so they do not change the default
 * grader role.
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

// useCapability is false while loading, and the provider also renders its loaded marker after a
// failed lookup, with no capabilities. So "hidden" only means something once a lookup for this
// class has succeeded. The listener goes on before navigating so a fast reply isn't missed.
async function gotoWhenCapabilitiesLoaded(page: Page, classId: number, url: string, heading: string) {
  const lookup = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/user_class_capabilities") &&
      response.url().includes(`class_id=eq.${classId}`) &&
      response.ok()
  );
  await gotoCourseUrlWhenHeadingVisible(page, url, heading);
  await lookup;
  await expect(page.locator('[data-capabilities-loaded="true"]')).toBeAttached();
}

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

  async function gotoWithCapabilities(page: Page, url: string, heading: string) {
    await gotoWhenCapabilitiesLoaded(page, course.id, url, heading);
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

  // Runs last among the review checks: it changes the default grader role, which every other test reads.
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

test.describe("flashcard controls gated by manage_flashcards", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let graderWithout: TestingUser;
  let deckId: number;
  let deckName: string;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Flashcard Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    graderWithout = await createUserInClass({ role: "grader", class_id: course.id });

    const { data: role, error } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "No Flashcards TA" })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(
      (await supabase.from("role_capabilities").delete().eq("role_id", role!.id).eq("capability", "manage_flashcards"))
        .error
    ).toBeNull();

    const { data: row, error: rowError } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", graderWithout.user_id)
      .eq("class_id", course.id)
      .single();
    expect(rowError).toBeNull();
    expect((await supabase.from("user_roles").update({ class_role_id: role!.id }).eq("id", row!.id)).error).toBeNull();

    deckName = `E2E Flashcard Deck ${suffix}`;
    const { data: deck, error: deckError } = await supabase
      .from("flashcard_decks")
      .insert({
        class_id: course.id,
        creator_id: instructor.user_id,
        name: deckName,
        description: "for gating"
      })
      .select("id")
      .single();
    expect(deckError).toBeNull();
    deckId = deck!.id;
    expect(
      (
        await supabase.from("flashcards").insert({
          class_id: course.id,
          deck_id: deckId,
          title: "Gating card",
          prompt: "prompt",
          answer: "answer",
          order: 1
        })
      ).error
    ).toBeNull();
  });

  test("a grader without manage_flashcards can view decks through the nav without management controls", async ({
    page
  }) => {
    await loginAsUser(page, graderWithout, course);
    await gotoWhenCapabilitiesLoaded(
      page,
      course.id,
      `/course/${course.id}/manage/course/flashcard-decks`,
      "Flashcard Decks"
    );

    const deckRow = page.getByRole("row").filter({ hasText: deckName });
    await expect(deckRow).toBeVisible();
    await expect(page.getByRole("button", { name: "Create New Deck" })).toHaveCount(0);
    await expect(deckRow.getByRole("button", { name: "Delete deck" })).toHaveCount(0);

    // Viewing decks stays available to staff without the capability.
    await page.getByRole("button", { name: "Course Settings menu" }).click();
    await expect(page.getByRole("menuitem", { name: /Flashcard Decks/ })).toBeVisible();
  });

  test("a grader without manage_flashcards does not see add, edit or delete card controls on the deck page", async ({
    page
  }) => {
    await loginAsUser(page, graderWithout, course);
    await gotoWhenCapabilitiesLoaded(
      page,
      course.id,
      `/course/${course.id}/manage/course/flashcard-decks/${deckId}`,
      "Edit Flashcard Deck"
    );

    const cardRow = page.getByRole("group", { name: "Gating card", exact: true });
    await expect(cardRow).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Flashcard" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit Deck (YAML)" })).toHaveCount(0);
    await expect(cardRow.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(cardRow.getByRole("button", { name: /Delete flashcard/ })).toHaveCount(0);
  });
});

test.describe("survey controls gated by manage_surveys", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let plainGrader: TestingUser;
  let graderWithout: TestingUser;
  let graderWith: TestingUser;
  let surveyId: string;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Survey Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: course.id });
    graderWithout = await createUserInClass({ role: "grader", class_id: course.id });
    graderWith = await createUserInClass({ role: "grader", class_id: course.id });

    // Custom role without manage_surveys: explicit negative case beside the default grader role.
    const { data: role, error } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "No Surveys TA" })
      .select("id")
      .single();
    expect(error).toBeNull();
    const { data: row, error: rowError } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", graderWithout.user_id)
      .eq("class_id", course.id)
      .single();
    expect(rowError).toBeNull();
    expect((await supabase.from("user_roles").update({ class_role_id: role!.id }).eq("id", row!.id)).error).toBeNull();

    const { data: withRole, error: withRoleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "Surveys TA" })
      .select("id")
      .single();
    expect(withRoleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: withRole!.id, capability: "manage_surveys" })).error
    ).toBeNull();
    const { data: withRow, error: withRowError } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", graderWith.user_id)
      .eq("class_id", course.id)
      .single();
    expect(withRowError).toBeNull();
    expect(
      (await supabase.from("user_roles").update({ class_role_id: withRole!.id }).eq("id", withRow!.id)).error
    ).toBeNull();

    const { data: survey, error: surveyError } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        created_by: instructor.public_profile_id,
        assigned_to_all: true,
        json: { pages: [{ name: "page1", elements: [{ type: "text", name: "q1", title: "Q1" }] }] },
        version: 1,
        status: "draft",
        title: `E2E Survey ${suffix}`
      })
      .select("id")
      .single();
    expect(surveyError).toBeNull();
    surveyId = survey!.id;
  });

  test("a grader without manage_surveys does not see Create New Survey or Manage Series", async ({ page }) => {
    await loginAsUser(page, graderWithout, course);
    const capabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await gotoCourseUrlWhenHeadingVisible(page, `/course/${course.id}/manage/surveys`, "Manage Surveys");
    await capabilities;
    await expect(page.locator('[data-capabilities-loaded="true"]')).toBeAttached();

    await expect(page.getByRole("row").filter({ hasText: "E2E Survey" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Create New Survey/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Manage Series/ })).toHaveCount(0);
  });

  test("a default grader is redirected from the new-survey and edit pages", async ({ page }) => {
    await loginAsUser(page, plainGrader, course);
    await page.goto(`/course/${course.id}/manage/surveys/new`);
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/surveys/?$`));

    await page.goto(`/course/${course.id}/manage/surveys/${surveyId}/edit`);
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/surveys/?$`));
  });

  test("a custom-role grader without manage_surveys is redirected from the new-survey and edit pages", async ({
    page
  }) => {
    await loginAsUser(page, graderWithout, course);
    await page.goto(`/course/${course.id}/manage/surveys/new`);
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/surveys/?$`));

    await page.goto(`/course/${course.id}/manage/surveys/${surveyId}/edit`);
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/surveys/?$`));
  });

  test("a grader with manage_surveys can open the new-survey and edit pages", async ({ page }) => {
    await loginAsUser(page, graderWith, course);
    const capabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await page.goto(`/course/${course.id}/manage/surveys/new`);
    await capabilities;
    await expect(page.locator('[data-capabilities-loaded="true"]')).toBeAttached();
    await expect(page.getByRole("heading", { name: "Create New Survey" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/surveys/new`));

    const editCapabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await page.goto(`/course/${course.id}/manage/surveys/${surveyId}/edit`);
    await editCapabilities;
    await expect(page.getByRole("heading", { name: "Edit Survey" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/surveys/${surveyId}/edit`));
  });
});

test.describe("poll controls gated by run_polls", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let graderWithout: TestingUser;
  let plainGrader: TestingUser;
  let pollId: string;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Poll Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    graderWithout = await createUserInClass({ role: "grader", class_id: course.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: course.id });

    const { data: role, error } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "No Polls TA" })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(
      (await supabase.from("role_capabilities").delete().eq("role_id", role!.id).eq("capability", "run_polls")).error
    ).toBeNull();

    const { data: row, error: rowError } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", graderWithout.user_id)
      .eq("class_id", course.id)
      .single();
    expect(rowError).toBeNull();
    expect((await supabase.from("user_roles").update({ class_role_id: role!.id }).eq("id", row!.id)).error).toBeNull();

    const { data: poll, error: pollError } = await supabase
      .from("live_polls")
      .insert({
        class_id: course.id,
        created_by: instructor.public_profile_id,
        question: { elements: [{ type: "text", name: "q1", title: "Gate poll?" }] },
        is_live: false,
        require_login: true
      })
      .select("id")
      .single();
    expect(pollError).toBeNull();
    pollId = poll!.id;
  });

  test("a grader without run_polls does not see Create Poll or Open/Delete actions", async ({ page }) => {
    await loginAsUser(page, graderWithout, course);
    const capabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await gotoCourseUrlWhenHeadingVisible(page, `/course/${course.id}/manage/polls`, "Manage Polls");
    await capabilities;
    await expect(page.locator('[data-capabilities-loaded="true"]')).toBeAttached();

    await expect(page.getByRole("row").filter({ hasText: "Gate poll?" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Create Poll/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Poll actions" }).click();
    await expect(page.getByRole("menuitem", { name: /View Poll/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Open Poll|Close Poll/ })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /Delete Poll/ })).toHaveCount(0);
  });

  test("a grader without run_polls does not see Start/Stop and is redirected from new poll", async ({ page }) => {
    await loginAsUser(page, graderWithout, course);
    const capabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await page.goto(`/course/${course.id}/manage/polls/${pollId}/responses`);
    await capabilities;
    await expect(page.locator('[data-capabilities-loaded="true"]')).toBeAttached();
    // Header always shows Present for staff with view access; wait for it so a
    // still-loading page cannot pass the Start/Stop absence check below.
    await expect(page.getByRole("button", { name: "Present" })).toBeVisible();
    await expect(page.getByTestId("toggle-poll-button")).toHaveCount(0);

    await page.goto(`/course/${course.id}/manage/polls/new`);
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/polls/?$`));
  });

  test("a default grader with run_polls sees Start/Stop and can open the new-poll page", async ({ page }) => {
    await loginAsUser(page, plainGrader, course);
    const capabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await page.goto(`/course/${course.id}/manage/polls/${pollId}/responses`);
    await capabilities;
    await expect(page.locator('[data-capabilities-loaded="true"]')).toBeAttached();
    await expect(page.getByTestId("toggle-poll-button")).toBeVisible();

    const newCapabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await page.goto(`/course/${course.id}/manage/polls/new`);
    await newCapabilities;
    await expect(page.getByRole("heading", { name: "Create Poll" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/polls/new`));
  });
});
