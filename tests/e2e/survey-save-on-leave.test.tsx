import type { TablesInsert } from "../../utils/supabase/SupabaseTypes";
import type { Page } from "@playwright/test";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase } from "./TestingUtils";

// Answers typed on a survey must reach survey_responses even when the student reloads before the
// 1 s autosave debounce fires or loses the network, and the page must say whether they are saved.
// The maintainer ruled out keeping drafts in browser storage (#977), so the database is the only
// place an answer may be kept.

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];

const ONE_QUESTION_JSON = {
  pages: [{ name: "page1", elements: [{ type: "text", name: "q1", title: "Question 1" }] }]
};

test.describe("Survey answers survive leaving the page and losing the network", () => {
  let course: Course;
  let student: User;
  let instructor: User;

  test.beforeAll(async () => {
    course = await createClass();
    [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Save On Leave Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Save On Leave Instructor", useMagicLink: true }
    ]);
  });
  test.afterEach(async ({ page, logMagicLinksOnFailure }) => {
    await page.context().setOffline(false);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await logMagicLinksOnFailure([student, instructor]);
  });

  const seedSurvey = async (title: string) => {
    const insert: TablesInsert<"surveys"> = {
      class_id: course.id,
      created_by: instructor.public_profile_id,
      assigned_to_all: true,
      allow_response_editing: false,
      json: ONE_QUESTION_JSON,
      version: 1,
      status: "published",
      title,
      description: "Description"
    };
    const { data, error } = await supabase.from("surveys").insert(insert).select("id").single();
    if (error || !data) throw new Error(`Failed to seed survey: ${error?.message}`);
    return data;
  };

  // The student's stored answer to q1 and whether the row is submitted, or null when there is no row.
  const storedResponse = async (surveyId: string) => {
    const { data, error } = await supabase
      .from("survey_responses")
      .select("response, is_submitted")
      .eq("survey_id", surveyId)
      .eq("profile_id", student.private_profile_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? { q1: (data.response as { q1?: string }).q1, is_submitted: data.is_submitted } : null;
  };

  // Holds the first draft write forever: the request is sent but never gets a response.
  const neverAnswerFirstWrite = async (page: Page) => {
    let writes = 0;
    await page.route("**/rest/v1/survey_responses*", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      writes += 1;
      if (writes === 1) return;
      await route.fallback();
    });
    return () => writes;
  };

  test("a save that never gets a response does not hold up later saves", async ({ page }) => {
    // The stuck write is only given up on after the page's 10 s save time limit.
    test.setTimeout(90_000);
    const survey = await seedSurvey("Stuck Save Survey");
    await loginAsUser(page, student, course);
    const writesSent = await neverAnswerFirstWrite(page);

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    const input = page.getByRole("textbox", { name: "Question 1" });
    await input.fill("First answer");
    await expect.poll(writesSent, { timeout: 10_000 }).toBe(1);
    await input.fill("Second answer");

    await expect
      .poll(() => storedResponse(survey.id), { timeout: 30_000 })
      .toEqual({ q1: "Second answer", is_submitted: false });
  });

  test("a save that never gets a response does not hold up Complete", async ({ page }) => {
    test.setTimeout(90_000);
    const survey = await seedSurvey("Stuck Save Complete Survey");
    await loginAsUser(page, student, course);
    const writesSent = await neverAnswerFirstWrite(page);

    await page.goto(`/course/${course.id}/surveys/${survey.id}`);
    await page.getByRole("textbox", { name: "Question 1" }).fill("Answer behind a stuck save");
    await expect.poll(writesSent, { timeout: 10_000 }).toBe(1);
    await page.getByRole("button", { name: "Complete" }).click();

    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/surveys$`), { timeout: 30_000 });
    await expect
      .poll(() => storedResponse(survey.id))
      .toEqual({ q1: "Answer behind a stuck save", is_submitted: true });
  });
});
