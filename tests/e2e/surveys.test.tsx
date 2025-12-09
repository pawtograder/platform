import { test, expect } from "../global-setup";
import fs from "fs/promises";
import path from "path";
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
    await expect(
      page.getByText("There are no published surveys available for this course at this time.")
    ).toBeVisible();
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
    await expect(
      page.getByText("There are no published surveys available for this course at this time.")
    ).toBeVisible();
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
    await expect(
      page.getByText("There are no published surveys available for this course at this time.")
    ).toBeVisible();
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

  test("instructor can open create survey form from manage page", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Student Placeholder", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Instructor User", useMagicLink: true }
    ]);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys`);

    await page
      .getByRole("link", { name: /\+ Create New Survey/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Create New Survey" })).toBeVisible();
  });

  test("instructor can open edit page from draft survey menu", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Student Placeholder", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Instructor User", useMagicLink: true }
    ]);

    const draftTitle = "Draft Manage Survey";
    const { error } = await supabase.from("surveys").insert({
      class_id: course.id,
      title: draftTitle,
      description: "Draft for edit test",
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

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys`);

    const row = page.getByRole("row", { name: new RegExp(draftTitle) }).first();
    await row.getByRole("button").first().click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    await expect(page.getByRole("heading", { name: "Edit Survey" })).toBeVisible();
  });

  test("instructor can open edit page by clicking survey title", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Student Placeholder", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Instructor User", useMagicLink: true }
    ]);

    const draftTitle = "Clickable Draft Survey";
    const publishedTitle = "Clickable Published Survey";

    const { data: draftSurvey, error: draftError } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: draftTitle,
        description: "Draft row link should open edit",
        status: "draft",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: {},
        version: 1
      })
      .select("id")
      .single();
    if (draftError || !draftSurvey) {
      throw new Error(`Failed to seed draft survey: ${draftError?.message}`);
    }

    const { data: publishedSurvey, error: publishedError } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: publishedTitle,
        description: "Published row link should open edit",
        status: "published",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: {},
        version: 1
      })
      .select("id")
      .single();
    if (publishedError || !publishedSurvey) {
      throw new Error(`Failed to seed published survey: ${publishedError?.message}`);
    }

    await loginAsUser(page, instructor, course);

    // Draft title navigates to edit page
    await page.goto(`/course/${course.id}/manage/surveys`);
    await page.getByRole("link", { name: draftTitle }).click();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/surveys/${draftSurvey.id}/edit`));
    await expect(page.getByRole("heading", { name: "Edit Survey" })).toBeVisible();

    // Published title also navigates to edit page (new version flow)
    await page.goto(`/course/${course.id}/manage/surveys`);
    await page.getByRole("link", { name: publishedTitle }).click();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/surveys/${publishedSurvey.id}/edit`));
    await expect(page.getByRole("heading", { name: "Edit Survey" })).toBeVisible();
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

  test("student dashboard active surveys show correct actions", async ({ page }) => {
    const course = await createClass();
    const [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Dashboard Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Survey Instructor", useMagicLink: true }
    ]);

    const nowIso = new Date().toISOString();

    const { error: startError } = await supabase.from("surveys").insert({
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
    });
    if (startError) {
      throw new Error(`Failed to seed start survey: ${startError.message}`);
    }

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
    if (lockedError || !lockedSurvey) {
      throw new Error(`Failed to seed locked survey: ${lockedError?.message}`);
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
    if (editableError || !editableSurvey) {
      throw new Error(`Failed to seed editable survey: ${editableError?.message}`);
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
    await expect(startCard.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(startCard.getByText("Not started")).toBeVisible();

    const lockedCard = page.locator("div").filter({ hasText: "Dashboard Submitted Locked" }).first();
    await expect(lockedCard.getByRole("button", { name: "View" })).toBeVisible();
    await expect(lockedCard.getByText("Submitted (locked)")).toBeVisible();

    const editableCard = page.locator("div").filter({ hasText: "Dashboard Submitted Editable" }).first();
    await expect(editableCard.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(editableCard.getByText("Submitted (editable)")).toBeVisible();
  });

  test.skip("survey builder saves default JSON on create", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Student Placeholder", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Instructor User", useMagicLink: true }
    ]);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/new`);

    await page.getByRole("button", { name: "Open Visual Builder" }).click();
    await page.getByRole("button", { name: "Use This Survey" }).click();

    const jsonValue = await page.getByRole("textbox", { name: "Survey JSON Configuration" }).inputValue();
    const parsed = JSON.parse(jsonValue);

    expect(parsed.meta?.title).toBe("Survey Name");
    expect(Array.isArray(parsed.pages)).toBe(true);
    expect(parsed.pages.length).toBe(1);
    expect(parsed.pages[0].name).toBeTruthy();
    expect(Array.isArray(parsed.pages[0].elements)).toBe(true);
  });

  test("publishing a draft survey updates status", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Student Placeholder", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Instructor User", useMagicLink: true }
    ]);

    const draftTitle = "Draft To Publish";
    const { data: draftSurvey, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: draftTitle,
        description: "Draft publish test",
        status: "draft",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: {},
        version: 1
      })
      .select("id")
      .single();
    if (error || !draftSurvey) {
      throw new Error(`Failed to seed draft survey: ${error?.message}`);
    }

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys`);

    const row = page.getByRole("row", { name: new RegExp(draftTitle) }).first();
    await row.getByRole("button").first().click();
    await page.getByRole("menuitem", { name: "Publish" }).click();

    await expect
      .poll(
        async () => {
          const { data: updated, error: fetchError } = await supabase
            .from("surveys")
            .select("status")
            .eq("id", draftSurvey.id)
            .single();
          if (fetchError) {
            throw new Error(`Failed to fetch updated survey: ${fetchError.message}`);
          }
          return updated?.status;
        },
        { timeout: 5000, message: "survey should publish" }
      )
      .toBe("published");
  });

  test("closing a published survey updates status", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Student Placeholder", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Instructor User", useMagicLink: true }
    ]);

    const title = "Published To Close";
    const { data: publishedSurvey, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title,
        description: "Close test",
        status: "published",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: {},
        version: 1
      })
      .select("id")
      .single();
    if (error || !publishedSurvey) {
      throw new Error(`Failed to seed published survey: ${error?.message}`);
    }

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys`);

    const row = page.getByRole("row", { name: new RegExp(title) }).first();
    await row.getByRole("button").first().click();
    await page.getByRole("menuitem", { name: "Close" }).click();

    await expect
      .poll(
        async () => {
          const { data: updated, error: fetchError } = await supabase
            .from("surveys")
            .select("status")
            .eq("id", publishedSurvey.id)
            .single();
          if (fetchError) {
            throw new Error(`Failed to fetch updated survey: ${fetchError.message}`);
          }
          return updated?.status;
        },
        { timeout: 5000, message: "survey should close" }
      )
      .toBe("closed");
  });

  test("instructor cannot edit a closed survey", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Student Placeholder", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Instructor User", useMagicLink: true }
    ]);

    const closedTitle = "Closed Survey No Edit";
    const { data: closedSurvey, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: closedTitle,
        description: "Closed survey should not be editable",
        status: "closed",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: {},
        version: 1
      })
      .select("id, survey_id")
      .single();
    if (error || !closedSurvey) {
      throw new Error(`Failed to seed closed survey: ${error?.message}`);
    }

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys`);

    // Clicking the title should go to responses, not an edit page
    await page.getByRole("link", { name: closedTitle }).click();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/surveys/${closedSurvey.survey_id}/responses`));
    await expect(page.getByRole("heading", { name: /Survey Responses/i })).toBeVisible();

    // The actions menu should not offer an edit option
    await page.goto(`/course/${course.id}/manage/surveys`);
    const row = page.getByRole("row", { name: new RegExp(closedTitle) }).first();
    await row.getByRole("button").first().click();
    await expect(page.getByRole("menuitem", { name: /Edit/ })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /View Responses/i })).toBeVisible();
  });

  test("instructor can view survey responses analytics", async ({ page }) => {
    const course = await createClass();
    const [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Responses Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Responses Instructor", useMagicLink: true }
    ]);

    const surveyJson = {
      pages: [
        {
          name: "page1",
          elements: [{ type: "text", name: "q1", title: "Question 1" }]
        }
      ]
    };

    const { data: survey, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: "Responses Test Survey",
        description: "Responses analytics",
        status: "published",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: surveyJson,
        version: 1
      })
      .select("id, survey_id")
      .single();
    if (error || !survey) {
      throw new Error(`Failed to seed survey: ${error?.message}`);
    }

    const { error: respError } = await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: student.private_profile_id,
      response: { q1: "My feedback" },
      is_submitted: true,
      submitted_at: new Date().toISOString()
    });
    if (respError) {
      throw new Error(`Failed to seed survey response: ${respError.message}`);
    }

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/${survey.survey_id}/responses`);

    await expect(page.getByRole("heading", { name: /Survey Responses/i })).toBeVisible();
    await expect(page.getByText("Question 1")).toBeVisible();
    await expect(page.getByText("My feedback")).toBeVisible();
  });

  test("grader can view survey responses analytics", async ({ page }) => {
    const course = await createClass();
    const [student, instructor, grader] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Responses Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Responses Instructor", useMagicLink: true },
      { role: "grader", class_id: course.id, name: "Responses Grader", useMagicLink: true }
    ]);

    const surveyJson = {
      pages: [
        {
          name: "page1",
          elements: [{ type: "text", name: "q1", title: "Question 1" }]
        }
      ]
    };

    const { data: survey, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: "Responses Test Survey",
        description: "Responses analytics",
        status: "published",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: surveyJson,
        version: 1
      })
      .select("id, survey_id")
      .single();
    if (error || !survey) {
      throw new Error(`Failed to seed survey: ${error?.message}`);
    }

    const { error: respError } = await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: student.private_profile_id,
      response: { q1: "Grader can view" },
      is_submitted: true,
      submitted_at: new Date().toISOString()
    });
    if (respError) {
      throw new Error(`Failed to seed survey response: ${respError.message}`);
    }

    await loginAsUser(page, grader, course);
    await page.goto(`/course/${course.id}/manage/surveys/${survey.survey_id}/responses`);

    await expect(page.getByRole("heading", { name: /Survey Responses/i })).toBeVisible();
    await expect(page.getByText("Question 1")).toBeVisible();
    await expect(page.getByText("Grader can view")).toBeVisible();
  });

  test("instructor can apply filters on responses", async ({ page }) => {
    const course = await createClass();
    const [student1, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Filter Student 1", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Filter Instructor", useMagicLink: true }
    ]);

    const surveyJson = {
      pages: [
        {
          name: "page1",
          elements: [{ type: "text", name: "q1", title: "Question 1" }]
        }
      ]
    };

    const { data: survey, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: "Filter Responses Survey",
        description: "Filters and CSV",
        status: "published",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: surveyJson,
        version: 1
      })
      .select("id, survey_id")
      .single();
    if (error || !survey) {
      throw new Error(`Failed to seed survey: ${error?.message}`);
    }

    // Two responses on distinct dates
    const oldDate = "2025-01-01T00:00:00.000Z";
    const newDate = "2025-02-01T00:00:00.000Z";
    await supabase.from("survey_responses").insert([
      {
        survey_id: survey.id,
        profile_id: student1.private_profile_id,
        response: { q1: "Old response" },
        is_submitted: true,
        submitted_at: oldDate
      },
      {
        survey_id: survey.id,
        profile_id: student1.private_profile_id,
        response: { q1: "New response" },
        is_submitted: true,
        submitted_at: newDate
      }
    ]);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/${survey.survey_id}/responses`);

    // Open filters and apply date range to include only the newer response
    await page.getByRole("button", { name: /Filters/i }).click();
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill("2025-02-01");
    await dateInputs.nth(1).fill("2025-02-01");

    // Expect active filter chips to show date range
    await expect(page.getByText(/Date: 2025-02-01 to 2025-02-01/)).toBeVisible();
  });

  test("instructor sees export CSV button", async ({ page }) => {
    const course = await createClass();
    const [student1, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "CSV Student 1", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "CSV Instructor", useMagicLink: true }
    ]);

    const surveyJson = {
      pages: [
        {
          name: "page1",
          elements: [{ type: "text", name: "q1", title: "Question 1" }]
        }
      ]
    };

    const { data: survey, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: "CSV Responses Survey",
        description: "CSV export",
        status: "published",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: surveyJson,
        version: 1
      })
      .select("id, survey_id")
      .single();
    if (error || !survey) {
      throw new Error(`Failed to seed survey: ${error?.message}`);
    }

    await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: student1.private_profile_id,
      response: { q1: "CSV response" },
      is_submitted: true,
      submitted_at: "2025-02-01T00:00:00.000Z"
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/${survey.survey_id}/responses`);

    await expect(page.getByRole("button", { name: /Export to CSV/i })).toBeVisible();
  });

  test.skip("response question filter hides unselected columns", async ({ page }) => {
    const course = await createClass();
    const [student1, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Filter Student Columns", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Filter Instructor Columns", useMagicLink: true }
    ]);

    const surveyJson = {
      pages: [
        {
          name: "page1",
          elements: [
            { type: "text", name: "q1", title: "Question 1" },
            { type: "text", name: "q2", title: "Question 2" }
          ]
        }
      ]
    };

    const { data: survey, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        title: "Filter Columns Survey",
        description: "Column filter test",
        status: "published",
        assigned_to_all: true,
        allow_response_editing: false,
        created_by: instructor.public_profile_id,
        json: surveyJson,
        version: 1
      })
      .select("id, survey_id")
      .single();
    if (error || !survey) {
      throw new Error(`Failed to seed survey: ${error?.message}`);
    }

    await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: student1.private_profile_id,
      response: { q1: "Answer 1", q2: "Answer 2" },
      is_submitted: true,
      submitted_at: "2025-02-01T00:00:00.000Z"
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/${survey.survey_id}/responses`);

    await page.getByRole("button", { name: /Filters/i }).click();
    const q2Checkbox = page.getByText("Question 2").locator("..").locator("input[type='checkbox']");
    await q2Checkbox.click();

    const responsesTable = page.getByRole("table").first();
    const columnHeaders = (await responsesTable.locator("thead").getByRole("columnheader").allTextContents()).map(
      (text) => text.trim().toLowerCase()
    );
    expect(columnHeaders).not.toContain("question 1");
    expect(columnHeaders).toContain("question 2");

    const bodyCells = (await responsesTable.locator("tbody").getByRole("cell").allTextContents()).map((text) =>
      text.trim().toLowerCase()
    );
    expect(bodyCells).not.toContain("answer 1");
    expect(bodyCells).toContain("answer 2");
  });

  test("grader cannot create or edit surveys but can view results menu", async ({ page }) => {
    const course = await createClass();
    const [, instructor, grader] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Grader Student Placeholder", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Instructor Owner", useMagicLink: true },
      { role: "grader", class_id: course.id, name: "Grader User", useMagicLink: true }
    ]);

    const { error } = await supabase.from("surveys").insert({
      class_id: course.id,
      title: "Grader Published Survey",
      description: "Published survey",
      status: "published",
      assigned_to_all: true,
      allow_response_editing: false,
      created_by: instructor.public_profile_id,
      json: {},
      version: 1
    });
    if (error) {
      throw new Error(`Failed to seed draft survey: ${error.message}`);
    }

    await loginAsUser(page, grader, course);
    await page.goto(`/course/${course.id}/manage/surveys`);

    await expect(page.getByRole("link", { name: /\+ Create New Survey/ })).not.toBeVisible();

    const row = page.getByRole("row", { name: /Grader Published Survey/ }).first();
    await row.getByRole("button").first().click();
    await expect(page.getByRole("menuitem", { name: /View Responses/i })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Edit/ })).not.toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Close/ })).not.toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Delete/ })).not.toBeVisible();
  });

  test("visual builder supports multi-page, multi-question surveys", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Multi Builder Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Multi Builder Instructor", useMagicLink: true }
    ]);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/new`);

    await page.getByRole("button", { name: /Open Visual Builder/i }).click();

    // Page 1: four questions
    await page.getByRole("button", { name: /\+ Short Text/i }).click();
    await page.getByRole("button", { name: /\+ Long Text/i }).click();
    await page.getByRole("button", { name: /\+ Single Choice/i }).click();
    await page.getByRole("button", { name: /\+ Checkboxes/i }).click();

    // Page 2: four more, covering all types
    await page.getByRole("button", { name: /Add Page/i }).click();
    await page.getByRole("button", { name: /\+ Short Text/i }).click();
    await page.getByRole("button", { name: /\+ Single Choice/i }).click();
    await page.getByRole("button", { name: /\+ Checkboxes/i }).click();
    await page.getByRole("button", { name: /\+ Yes \/ No/i }).click();

    // Page 3: three more to push total over 10
    await page.getByRole("button", { name: /Add Page/i }).click();
    await page.getByRole("button", { name: /\+ Long Text/i }).click();
    await page.getByRole("button", { name: /\+ Checkboxes/i }).click();
    await page.getByRole("button", { name: /\+ Single Choice/i }).click();

    await page.getByRole("button", { name: /Use This Survey/i }).click();

    const jsonValue = await page.getByRole("textbox", { name: "Survey JSON Configuration" }).inputValue();
    const parsed = JSON.parse(jsonValue);

    const metaTitle = parsed.meta?.title ?? parsed.title ?? "Survey Name";
    expect(metaTitle).toBeTruthy();
    expect(parsed.pages.length).toBeGreaterThanOrEqual(3);
    const totalQuestions = parsed.pages.reduce((sum: number, page: any) => sum + (page.elements?.length || 0), 0);
    expect(totalQuestions).toBeGreaterThanOrEqual(11);

    const allTypes = parsed.pages.flatMap((p: any) => p.elements.map((el: any) => el.type));
    expect(new Set(allTypes)).toEqual(new Set(["text", "comment", "radiogroup", "checkbox", "boolean"]));

    parsed.pages.forEach((page: any) => {
      page.elements.forEach((el: any) => {
        expect(el.name).toBeTruthy();
        expect(el.title).toBeTruthy();
      });
    });

    // Validate a variety of content
    const firstRadio = parsed.pages
      .flatMap((p: any) => p.elements)
      .find((el: any) => el.type === "radiogroup");
    expect(firstRadio.choices.length).toBeGreaterThanOrEqual(3);
    const firstCheckbox = parsed.pages
      .flatMap((p: any) => p.elements)
      .find((el: any) => el.type === "checkbox");
    expect(firstCheckbox.choices.length).toBeGreaterThanOrEqual(3);
    const firstBoolean = parsed.pages
      .flatMap((p: any) => p.elements)
      .find((el: any) => el.type === "boolean");
    expect(firstBoolean.labelTrue).toBeTruthy();
    expect(firstBoolean.labelFalse).toBeTruthy();
  });

  test("visual builder allows editing page name and choice text", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Choice Edit Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Choice Edit Instructor", useMagicLink: true }
    ]);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/new`);

    await page.getByRole("button", { name: /Open Visual Builder/i }).click();

    // Add a single choice question
    await page.getByRole("button", { name: /\+ Single Choice/i }).click();
    // Add a checkbox question and a boolean for mixed types
    await page.getByRole("button", { name: /\+ Checkboxes/i }).click();
    await page.getByRole("button", { name: /\+ Yes \/ No/i }).click();

    // Rename the page
    const pageNameInput = page.getByText("Page name").locator("..").locator("input");
    await pageNameInput.fill("Custom Page Name");

    // Edit existing choice text and add four more (total 8 choices) within the single-choice region
    const singleChoiceRegion = page.getByRole("region", { name: /Single Choice/i }).first();
    await singleChoiceRegion.locator('input[value="Item 1"]').fill("Red");
    await singleChoiceRegion.locator('input[value="Item 2"]').fill("Blue");
    await singleChoiceRegion.locator('input[value="Item 3"]').fill("Yellow");
    await singleChoiceRegion.getByRole("button", { name: /Add choice/i }).click();
    await singleChoiceRegion.locator('input[value="Item 4"]').fill("Green");
    await singleChoiceRegion.getByRole("button", { name: /Add choice/i }).click();
    await singleChoiceRegion.locator('input[value="Item 5"]').fill("Orange");
    await singleChoiceRegion.getByRole("button", { name: /Add choice/i }).click();
    await singleChoiceRegion.locator('input[value="Item 6"]').fill("Purple");
    await singleChoiceRegion.getByRole("button", { name: /Add choice/i }).click();
    await singleChoiceRegion.locator('input[value="Item 7"]').fill("Gray");
    await singleChoiceRegion.getByRole("button", { name: /Add choice/i }).click();
    await singleChoiceRegion.locator('input[value="Item 8"]').fill("Teal");

    await page.getByRole("button", { name: /Use This Survey/i }).click();

    const jsonValue = await page.getByRole("textbox", { name: "Survey JSON Configuration" }).inputValue();
    const parsed = JSON.parse(jsonValue);

    expect(parsed.pages[0].name).toBe("Custom Page Name");

    const radio = parsed.pages[0].elements.find((el: any) => el.type === "radiogroup");
    const radioChoices = (radio.choices || []).map((c: any) => c.value);
    expect(radioChoices).toEqual(["Red", "Blue", "Yellow", "Green", "Orange", "Purple", "Gray", "Teal"]);
    expect(radioChoices.length).toBeGreaterThan(7);

    const checkbox = parsed.pages[0].elements.find((el: any) => el.type === "checkbox");
    expect(checkbox.choices.length).toBeGreaterThanOrEqual(3);

    const bool = parsed.pages[0].elements.find((el: any) => el.type === "boolean");
    expect(bool.labelTrue).toBeTruthy();
    expect(bool.labelFalse).toBeTruthy();
  });
});
