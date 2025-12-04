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
});
