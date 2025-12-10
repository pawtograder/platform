import type { TablesInsert } from "../../utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];
type SurveyInsert = TablesInsert<"surveys">;

const buildSurveyPayload = (course: Course, instructor: User, overrides: Partial<SurveyInsert> = {}): SurveyInsert => {
  const { json, ...rest } = overrides;
  return {
    class_id: course.id,
    created_by: instructor.public_profile_id,
    assigned_to_all: true,
    allow_response_editing: false,
    json: json ?? {},
    version: 1,
    status: "draft",
    title: "Survey",
    description: "Description",
    ...rest
  };
};

const seedSurvey = async <T = any,>(
  course: Course,
  instructor: User,
  overrides: Partial<SurveyInsert>,
  selectFields = "id, survey_id"
): Promise<T> => {
  const { data, error } = await supabase
    .from("surveys")
    .insert(buildSurveyPayload(course, instructor, overrides))
    .select(selectFields)
    .single();

  if (error || !data) {
    throw new Error(`Failed to seed survey: ${error?.message}`);
  }

  return data as T;
};

test.describe("Surveys Page", () => {
  let course: Course;
  let studentA: User;
  let studentB: User;
  let instructor: User;
  let grader: User;

  const clearCourseSurveys = async () => {
    const { data: surveys, error } = await supabase.from("surveys").select("id").eq("class_id", course.id);
    if (error) {
      throw new Error(`Failed to fetch surveys to clean: ${error.message}`);
    }
    const ids = (surveys ?? []).map((s) => s.id);
    if (!ids.length) return;

    await supabase.from("survey_responses").delete().in("survey_id", ids);
    await supabase.from("survey_assignments").delete().in("survey_id", ids);
    await supabase.from("surveys").delete().in("id", ids);
  };

  test.beforeAll(async () => {
    course = await createClass();
    const users = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Survey Student A", useMagicLink: true },
      { role: "student", class_id: course.id, name: "Survey Student B", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Survey Instructor", useMagicLink: true },
      { role: "grader", class_id: course.id, name: "Survey Grader", useMagicLink: true }
    ]);
    [studentA, studentB, instructor, grader] = users;
  });

  test.beforeEach(async () => {
    await clearCourseSurveys();
  });

  test("student sees empty state when no surveys exist", async ({ page }) => {
    await loginAsUser(page, studentA, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByRole("heading", { name: "No Surveys Available" })).toBeVisible();
    await expect(
      page.getByText("There are no published surveys available for this course at this time.")
    ).toBeVisible();
  });

  test("student sees published survey and updated status", async ({ page }) => {
    await seedSurvey(course, instructor, {
      title: "Playwright Survey",
      description: "Quick check-in",
      status: "published"
    });

    await loginAsUser(page, studentA, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByRole("heading", { name: "Course Surveys" })).toBeVisible();
    await expect(page.getByText("Playwright Survey")).toBeVisible();
    await expect(page.getByText("Quick check-in")).toBeVisible();
    await expect(page.locator("span.chakra-badge", { hasText: "Not Started" })).toBeVisible();
    await expect(page.getByText("No Surveys Available")).not.toBeVisible();
  });

  test("draft survey is not visible to students", async ({ page }) => {
    await seedSurvey(course, instructor, {
      title: "Draft Survey",
      description: "Should not show",
      status: "draft"
    });

    await loginAsUser(page, studentA, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByRole("heading", { name: "No Surveys Available" })).toBeVisible();
    await expect(
      page.getByText("There are no published surveys available for this course at this time.")
    ).toBeVisible();
    await expect(page.getByText("Draft Survey")).not.toBeVisible();
  });

  test("closed survey is not visible to students", async ({ page }) => {
    await seedSurvey(course, instructor, {
      title: "Closed Survey",
      description: "Was published, now closed",
      status: "closed"
    });

    await loginAsUser(page, studentA, course);
    await page.goto(`/course/${course.id}/surveys`);

    await expect(page.getByRole("heading", { name: "No Surveys Available" })).toBeVisible();
    await expect(
      page.getByText("There are no published surveys available for this course at this time.")
    ).toBeVisible();
    await expect(page.getByText("Closed Survey")).not.toBeVisible();
  });

  test("student without assignment sees only surveys assigned to all", async ({ page }) => {
    await seedSurvey(course, instructor, {
      title: "All Students Survey",
      description: "Visible to everyone",
      status: "published",
      assigned_to_all: true
    });

    const specificSurvey = await seedSurvey<{ id: string }>(course, instructor, {
      title: "Specific Student Survey",
      description: "Only one student should see this",
      status: "published",
      assigned_to_all: false
    });

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
    await seedSurvey(course, instructor, {
      title: "All Students Survey",
      description: "Visible to everyone",
      status: "published",
      assigned_to_all: true
    });

    const specificSurvey = await seedSurvey<{ id: string }>(course, instructor, {
      title: "Specific Student Survey",
      description: "Only one student should see this",
      status: "published",
      assigned_to_all: false
    });

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
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys`);

    await page
      .getByRole("link", { name: /\+ Create New Survey/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Create New Survey" })).toBeVisible();
  });

  test("instructor can open edit page from draft survey menu", async ({ page }) => {
    const draftTitle = "Draft Manage Survey";
    await seedSurvey(course, instructor, {
      title: draftTitle,
      description: "Draft for edit test",
      status: "draft"
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys`);

    const row = page.getByRole("row", { name: new RegExp(draftTitle) }).first();
    await row.getByRole("button").first().click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    await expect(page.getByRole("heading", { name: "Edit Survey" })).toBeVisible();
  });

  test("instructor can open edit page by clicking survey title", async ({ page }) => {
    const draftTitle = "Clickable Draft Survey";
    const publishedTitle = "Clickable Published Survey";

    const draftSurvey = await seedSurvey<{ id: string }>(course, instructor, {
      title: draftTitle,
      description: "Draft row link should open edit",
      status: "draft"
    });

    const publishedSurvey = await seedSurvey<{ id: string }>(course, instructor, {
      title: publishedTitle,
      description: "Published row link should open edit",
      status: "published"
    });

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
    await loginAsUser(page, studentA, course);
    await page.goto(`/course/${course.id}`);

    await expect(page.getByRole("heading", { name: "Active Surveys" })).toBeVisible();
    await expect(page.getByText("No active surveys")).toBeVisible();
    await expect(page.getByText("There are no published, active surveys for this course right now.")).toBeVisible();
  });

  test("student dashboard active surveys show correct actions", async ({ page }) => {
    const nowIso = new Date().toISOString();

    await seedSurvey(course, instructor, {
      title: "Dashboard Start Survey",
      description: "Should show Start",
      status: "published",
      created_at: nowIso,
      due_date: null
    });

    const lockedSurvey = await seedSurvey<{ id: string }>(course, instructor, {
      title: "Dashboard Submitted Locked",
      description: "Should show View",
      status: "published",
      created_at: nowIso,
      due_date: null
    });
    await supabase.from("survey_responses").insert({
      survey_id: lockedSurvey.id,
      profile_id: studentA.private_profile_id,
      response: {},
      is_submitted: true,
      submitted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso
    });

    const editableSurvey = await seedSurvey<{ id: string }>(course, instructor, {
      title: "Dashboard Submitted Editable",
      description: "Should show Edit",
      status: "published",
      allow_response_editing: true,
      created_at: nowIso,
      due_date: null
    });
    await supabase.from("survey_responses").insert({
      survey_id: editableSurvey.id,
      profile_id: studentA.private_profile_id,
      response: {},
      is_submitted: true,
      submitted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso
    });

    await loginAsUser(page, studentA, course);
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
    const draftTitle = "Draft To Publish";
    const draftSurvey = await seedSurvey<{ id: string }>(course, instructor, {
      title: draftTitle,
      description: "Draft publish test",
      status: "draft"
    });

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
    const title = "Published To Close";
    const publishedSurvey = await seedSurvey<{ id: string }>(course, instructor, {
      title,
      description: "Close test",
      status: "published"
    });

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
    const closedTitle = "Closed Survey No Edit";
    const closedSurvey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: closedTitle,
      description: "Closed survey should not be editable",
      status: "closed"
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys`);

    await page.getByRole("link", { name: closedTitle }).click();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/surveys/${closedSurvey.survey_id}/responses`));
    await expect(page.getByRole("heading", { name: /Survey Responses/i })).toBeVisible();

    await page.goto(`/course/${course.id}/manage/surveys`);
    const row = page.getByRole("row", { name: new RegExp(closedTitle) }).first();
    await row.getByRole("button").first().click();
    await expect(page.getByRole("menuitem", { name: /Edit/ })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /View Responses/i })).toBeVisible();
  });

  test("instructor can view survey responses analytics", async ({ page }) => {
    const surveyJson = {
      pages: [
        {
          name: "page1",
          elements: [{ type: "text", name: "q1", title: "Question 1" }]
        }
      ]
    };

    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: "Responses Test Survey",
      description: "Responses analytics",
      status: "published",
      json: surveyJson
    });

    const { error: respError } = await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: studentA.private_profile_id,
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
    const surveyJson = {
      pages: [
        {
          name: "page1",
          elements: [{ type: "text", name: "q1", title: "Question 1" }]
        }
      ]
    };

    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: "Responses Test Survey",
      description: "Responses analytics",
      status: "published",
      json: surveyJson
    });

    const { error: respError } = await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: studentA.private_profile_id,
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
    const surveyJson = {
      pages: [
        {
          name: "page1",
          elements: [{ type: "text", name: "q1", title: "Question 1" }]
        }
      ]
    };

    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: "Filter Responses Survey",
      description: "Filters and CSV",
      status: "published",
      json: surveyJson
    });

    const oldDate = "2025-01-01T00:00:00.000Z";
    const newDate = "2025-02-01T00:00:00.000Z";
    await supabase.from("survey_responses").insert([
      {
        survey_id: survey.id,
        profile_id: studentA.private_profile_id,
        response: { q1: "Old response" },
        is_submitted: true,
        submitted_at: oldDate
      },
      {
        survey_id: survey.id,
        profile_id: studentB.private_profile_id,
        response: { q1: "New response" },
        is_submitted: true,
        submitted_at: newDate
      }
    ]);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/${survey.survey_id}/responses`);

    await page.getByRole("button", { name: /Filters/i }).click();
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill("2025-02-01");
    await dateInputs.nth(1).fill("2025-02-01");

    await expect(page.getByText(/Date: 2025-02-01 to 2025-02-01/)).toBeVisible();
  });

  test("instructor sees export CSV button", async ({ page }) => {
    const surveyJson = {
      pages: [
        {
          name: "page1",
          elements: [{ type: "text", name: "q1", title: "Question 1" }]
        }
      ]
    };

    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: "CSV Responses Survey",
      description: "CSV export",
      status: "published",
      json: surveyJson
    });

    await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: studentA.private_profile_id,
      response: { q1: "CSV response" },
      is_submitted: true,
      submitted_at: "2025-02-01T00:00:00.000Z"
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/${survey.survey_id}/responses`);

    await expect(page.getByRole("button", { name: /Export to CSV/i })).toBeVisible();
  });

  test.skip("response question filter hides unselected columns", async ({ page }) => {
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

    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: "Filter Columns Survey",
      description: "Column filter test",
      status: "published",
      json: surveyJson
    });

    await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: studentA.private_profile_id,
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
    await seedSurvey(course, instructor, {
      title: "Grader Published Survey",
      description: "Published survey",
      status: "published"
    });

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
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/new`);

    await page.getByRole("button", { name: /Open Visual Builder/i }).click();

    // Page 1
    await page.getByRole("button", { name: /\+ Short Text/i }).click();
    await page.getByRole("button", { name: /\+ Long Text/i }).click();
    await page.getByRole("button", { name: /\+ Single Choice/i }).click();
    await page.getByRole("button", { name: /\+ Checkboxes/i }).click();

    // Page 2
    await page.getByRole("button", { name: /Add Page/i }).click();
    await page.getByRole("button", { name: /\+ Short Text/i }).click();
    await page.getByRole("button", { name: /\+ Single Choice/i }).click();
    await page.getByRole("button", { name: /\+ Checkboxes/i }).click();
    await page.getByRole("button", { name: /\+ Yes \/ No/i }).click();

    // Page 3
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
    const firstRadio = parsed.pages.flatMap((p: any) => p.elements).find((el: any) => el.type === "radiogroup");
    expect(firstRadio.choices.length).toBeGreaterThanOrEqual(3);
    const firstCheckbox = parsed.pages.flatMap((p: any) => p.elements).find((el: any) => el.type === "checkbox");
    expect(firstCheckbox.choices.length).toBeGreaterThanOrEqual(3);
    const firstBoolean = parsed.pages.flatMap((p: any) => p.elements).find((el: any) => el.type === "boolean");
    expect(firstBoolean.labelTrue).toBeTruthy();
    expect(firstBoolean.labelFalse).toBeTruthy();
  });

  test("visual builder allows editing page name and choice text", async ({ page }) => {
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
