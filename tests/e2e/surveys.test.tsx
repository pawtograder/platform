import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase } from "./TestingUtils";

test.describe("Surveys Page", () => {
  test("student sees empty state when no surveys exist", async ({ page }) => {
    const course = await createClass();
    const [student] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Survey Student", useMagicLink: true }
    ]);

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByRole("heading", { name: "No Surveys Available" })).toBeVisible();
    await expect(page.getByText("There are no published surveys available for this course at this time.")).toBeVisible();
  });

  test("student sees published survey and updated status", async ({ page }) => {
    const course = await createClass();
    const [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Survey Student A", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Survey Instructor", useMagicLink: true }
    ]);

    const { error } = await supabase.from("surveys").insert({
      class_id: course.id,
      title: "Playwright Survey",
      description: "Quick check-in",
      status: "published",
      deleted_at: null,
      assigned_to_all: true,
      allow_response_editing: false,
      created_by: instructor.public_profile_id,
      json: {},
      version: 1
    });

    if (error) {
      throw new Error(`Failed to seed survey: ${error.message}`);
    }

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByRole("heading", { name: "Course Surveys" })).toBeVisible();
    await expect(page.getByText("Playwright Survey")).toBeVisible();
    await expect(page.getByText("Quick check-in")).toBeVisible();
    await expect(page.locator("span.chakra-badge", { hasText: "Not Started" })).toBeVisible();
    await expect(page.getByText("No Surveys Available")).not.toBeVisible();
  });

  test("draft survey is not visible to students", async ({ page }) => {
    const course = await createClass();
    const [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Draft Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Draft Instructor", useMagicLink: true }
    ]);

    const { error } = await supabase.from("surveys").insert({
      class_id: course.id,
      title: "Draft Survey",
      description: "Should not show",
      status: "draft",
      assigned_to_all: true,
      allow_response_editing: false,
      created_by: instructor.public_profile_id,
      json: {},
      version: 1
    });
    if (error) {
      throw new Error(`Failed to seed draft survey: ${error.message}`);
    }

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByRole("heading", { name: "No Surveys Available" })).toBeVisible();
    await expect(page.getByText("There are no published surveys available for this course at this time.")).toBeVisible();
    await expect(page.getByText("Draft Survey")).not.toBeVisible();
  });

  test("closed survey is not visible to students", async ({ page }) => {
    const course = await createClass();
    const [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Closed Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Closed Instructor", useMagicLink: true }
    ]);

    const { error } = await supabase.from("surveys").insert({
      class_id: course.id,
      title: "Closed Survey",
      description: "Was published, now closed",
      status: "closed",
      assigned_to_all: true,
      allow_response_editing: false,
      created_by: instructor.public_profile_id,
      json: {},
      version: 1
    });
    if (error) {
      throw new Error(`Failed to seed closed survey: ${error.message}`);
    }

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByRole("heading", { name: "No Surveys Available" })).toBeVisible();
    await expect(page.getByText("There are no published surveys available for this course at this time.")).toBeVisible();
    await expect(page.getByText("Closed Survey")).not.toBeVisible();
  });

  test("student without assignment sees only surveys assigned to all", async ({ page }) => {
    const course = await createClass();
    const [studentA, studentB, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Student A", useMagicLink: true },
      { role: "student", class_id: course.id, name: "Student B", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Survey Instructor", useMagicLink: true }
    ]);

    const { error: allError } = await supabase.from("surveys").insert({
      class_id: course.id,
      title: "All Students Survey",
      description: "Visible to everyone",
      status: "published",
      assigned_to_all: true,
      allow_response_editing: false,
      created_by: instructor.public_profile_id,
      json: {},
      version: 1
    });
    if (allError) {
      throw new Error(`Failed to seed all-students survey: ${allError.message}`);
    }

    const { data: specificSurvey, error: specificError } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: "Specific Student Survey",
        description: "Only one student should see this",
        status: "published",
        assigned_to_all: false,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: {},
        version: 1
      })
      .select("id")
      .single();
    if (specificError) {
      throw new Error(`Failed to seed specific survey: ${specificError.message}`);
    }

    const { error: assignmentError } = await supabase.from("survey_assignments").insert({
      survey_id: specificSurvey.id,
      profile_id: studentB.private_profile_id
    });
    if (assignmentError) {
      throw new Error(`Failed to seed survey assignment: ${assignmentError.message}`);
    }

    await loginAsUser(page, studentA, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByText("All Students Survey")).toBeVisible();
    await expect(page.getByText("Specific Student Survey")).not.toBeVisible();
  });

  test("student with assignment sees both all-student and targeted survey", async ({ page }) => {
    const course = await createClass();
    const [studentA, studentB, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Student A", useMagicLink: true },
      { role: "student", class_id: course.id, name: "Student B", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Survey Instructor", useMagicLink: true }
    ]);

    const { error: allError } = await supabase.from("surveys").insert({
      class_id: course.id,
      title: "All Students Survey",
      description: "Visible to everyone",
      status: "published",
      assigned_to_all: true,
      allow_response_editing: false,
      created_by: instructor.public_profile_id,
      json: {},
      version: 1
    });
    if (allError) {
      throw new Error(`Failed to seed all-students survey: ${allError.message}`);
    }

    const { data: specificSurvey, error: specificError } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: "Specific Student Survey",
        description: "Only one student should see this",
        status: "published",
        assigned_to_all: false,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: {},
        version: 1
      })
      .select("id")
      .single();
    if (specificError) {
      throw new Error(`Failed to seed specific survey: ${specificError.message}`);
    }

    const { error: assignmentError } = await supabase.from("survey_assignments").insert({
      survey_id: specificSurvey.id,
      profile_id: studentB.private_profile_id
    });
    if (assignmentError) {
      throw new Error(`Failed to seed survey assignment: ${assignmentError.message}`);
    }

    await loginAsUser(page, studentB, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByText("All Students Survey")).toBeVisible();
    await expect(page.getByText("Specific Student Survey")).toBeVisible();
  });

  test("student dashboard active surveys states and buttons", async ({ page }) => {
    const course = await createClass();
    const [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Dashboard Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Survey Instructor", useMagicLink: true }
    ]);

    const nowIso = new Date().toISOString();

    // Survey with no response yet -> Start
    const { data: startSurvey, error: startError } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: "Dashboard Start Survey",
        description: "Should show Start",
        status: "published",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: {},
        version: 1,
        due_date: null,
        created_at: nowIso
      })
      .select("id")
      .single();
    if (startError) {
      throw new Error(`Failed to seed start survey: ${startError.message}`);
    }

    // Survey with in-progress response -> Continue
    const { data: progressSurvey, error: progressError } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: "Dashboard In Progress Survey",
        description: "Should show Continue",
        status: "published",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: {},
        version: 1,
        due_date: null,
        created_at: nowIso
      })
      .select("id")
      .single();
    if (progressError) {
      throw new Error(`Failed to seed in-progress survey: ${progressError.message}`);
    }
    const { error: progressResponseError } = await supabase.from("survey_responses").insert({
      survey_id: progressSurvey.id,
      profile_id: student.private_profile_id,
      response: {},
      is_submitted: false,
      created_at: nowIso,
      updated_at: nowIso
    });
    if (progressResponseError) {
      throw new Error(`Failed to seed in-progress response: ${progressResponseError.message}`);
    }

    // Survey submitted and locked -> View
    const { data: lockedSurvey, error: lockedError } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: "Dashboard Submitted Locked",
        description: "Should show View",
        status: "published",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: {},
        version: 1,
        due_date: null,
        created_at: nowIso
      })
      .select("id")
      .single();
    if (lockedError) {
      throw new Error(`Failed to seed locked survey: ${lockedError.message}`);
    }
    const { error: lockedResponseError } = await supabase.from("survey_responses").insert({
      survey_id: lockedSurvey.id,
      profile_id: student.private_profile_id,
      response: {},
      is_submitted: true,
      submitted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso
    });
    if (lockedResponseError) {
      throw new Error(`Failed to seed locked response: ${lockedResponseError.message}`);
    }

    // Survey submitted but editable -> Edit
    const { data: editableSurvey, error: editableError } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: "Dashboard Submitted Editable",
        description: "Should show Edit",
        status: "published",
        assigned_to_all: true,
        allow_response_editing: true,
        created_by: instructor.public_profile_id,
        json: {},
        version: 1,
        due_date: null,
        created_at: nowIso
      })
      .select("id")
      .single();
    if (editableError) {
      throw new Error(`Failed to seed editable survey: ${editableError.message}`);
    }
    const { error: editableResponseError } = await supabase.from("survey_responses").insert({
      survey_id: editableSurvey.id,
      profile_id: student.private_profile_id,
      response: {},
      is_submitted: true,
      submitted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso
    });
    if (editableResponseError) {
      throw new Error(`Failed to seed editable response: ${editableResponseError.message}`);
    }

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);

    await expect(page.getByRole("heading", { name: "Active Surveys" })).toBeVisible();

    const startCard = page.locator("div").filter({ hasText: "Dashboard Start Survey" }).first();
    await expect(startCard).toBeVisible();
    await expect(startCard.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(startCard.getByText("Not started")).toBeVisible();

    const progressCard = page.locator("div").filter({ hasText: "Dashboard In Progress Survey" }).first();
    await expect(progressCard).toBeVisible();
    await expect(progressCard.getByRole("button", { name: "Continue" })).toBeVisible();
    await expect(progressCard.getByText("In progress")).toBeVisible();

    const lockedCard = page.locator("div").filter({ hasText: "Dashboard Submitted Locked" }).first();
    await expect(lockedCard).toBeVisible();
    await expect(lockedCard.getByRole("button", { name: "View" })).toBeVisible();
    await expect(lockedCard.getByText("Submitted (locked)")).toBeVisible();

    const editableCard = page.locator("div").filter({ hasText: "Dashboard Submitted Editable" }).first();
    await expect(editableCard).toBeVisible();
    await expect(editableCard.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(editableCard.getByText("Submitted (editable)")).toBeVisible();
  });

  test("student dashboard shows no active surveys when none exist", async ({ page }) => {
    const course = await createClass();
    const [student] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Dashboard No Surveys Student", useMagicLink: true }
    ]);

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);

    await expect(page.getByRole("heading", { name: "Active Surveys" })).toBeVisible();
    await expect(page.getByText("No active surveys")).toBeVisible();
    await expect(page.getByText("There are no published, active surveys for this course right now.")).toBeVisible();
  });
});
