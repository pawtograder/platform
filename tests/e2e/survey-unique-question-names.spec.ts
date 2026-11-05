/**
 * What an instructor sees around duplicate question names (#1005). SurveyJS saves answers under
 * the question's name, so two questions named `question_1` share one answer. The database decides
 * what counts as a repeat (survey-unique-question-names-db.spec.ts). This covers the builder's
 * warning and default names, and each way of publishing showing the database's refusal.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase, type TestingUser } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;

const REPEATED = {
  pages: [
    {
      name: "page1",
      elements: [
        { type: "text", name: "question_1", title: "First" },
        { type: "text", name: "question_1", title: "Second" }
      ]
    }
  ]
};
const UNIQUE = {
  pages: [
    {
      name: "page1",
      elements: [
        { type: "text", name: "question_1", title: "First" },
        { type: "text", name: "question_2", title: "Second" }
      ]
    }
  ]
};

test.describe("survey builder: duplicate question names", () => {
  test.setTimeout(180_000);

  let course: Course;
  let instructor: TestingUser;

  test.beforeAll(async () => {
    course = await createClass({ name: "E2E Survey Builder Unique Names" });
    [instructor] = await createUsersInClass([
      {
        role: "instructor",
        class_id: course.id,
        name: "Bea Builder",
        email: `survey-builder-unique-${course.id}@pawtograder.net`,
        useMagicLink: true
      }
    ]);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    if (instructor) await logMagicLinksOnFailure([instructor]);
  });

  async function surveysTitled(title: string) {
    const { data, error } = await supabase
      .from("surveys")
      .select("status, json")
      .eq("class_id", course.id)
      .eq("title", title);
    if (error) throw new Error(`Failed to read surveys: ${error.message}`);
    return data ?? [];
  }

  async function seedSurvey(title: string, status: "draft" | "published", json: object) {
    const { data, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        created_by: instructor.private_profile_id,
        assigned_to_all: true,
        allow_response_editing: false,
        json: JSON.stringify(json),
        version: 1,
        status,
        title,
        description: "#1005"
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to seed a survey: ${error?.message}`);
    return data.id;
  }

  // The e2e fixture hides the toaster (data-visual-test="removed") to keep screenshots stable, so
  // a toast is in the page but never visible here.
  const toast = (page: Page, title: string) =>
    page.locator('[data-scope="toast"][data-part="root"]').filter({ hasText: title });

  async function expectRefusal(page: Page) {
    const refusal = toast(page, "Cannot Publish Survey");
    await expect(refusal, "the instructor gets one toast with the reason").toHaveCount(1);
    await expect(refusal).toContainText('more than one question is named "question_1"');
    await expect(refusal).toContainText("Rename the repeats");
  }

  test("the builder warns about a repeated name, and the form says why it can't be published", async ({ page }) => {
    const title = "Reused question name";
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/new`);
    await page.getByPlaceholder("e.g. Week 3 Team Check-in").fill(title);

    await page.getByRole("button", { name: /Open Visual Builder/i }).click();
    await page.getByRole("button", { name: /\+ Short Text/i }).click();
    await page.getByRole("button", { name: /\+ Short Text/i }).click();
    // The instructor gives the second question the first one's name.
    const secondName = page.getByPlaceholder("Short Text question").nth(1);
    await secondName.fill("question_1");

    const message = '"question_1" is used by page 1, question 1 and page 1, question 2.';
    await expect(page.getByTestId("survey-builder-duplicate-names")).toContainText(message);
    await expect(page.getByRole("status").filter({ hasText: message }).first()).toBeAttached();
    await expect(secondName, "the repeated field is marked invalid").toHaveAttribute("aria-invalid", "true");
    await expect(secondName, "and its error is read with it").toHaveAccessibleDescription(new RegExp(message));

    await page.getByRole("button", { name: /Use This Survey/i }).click();

    // Publishing is refused, and the reason isn't buried under generic errors.
    await page.getByText("Published — visible to students").click();
    await page.getByRole("button", { name: "Publish Survey" }).click();
    await expectRefusal(page);
    expect(await surveysTitled(title), "nothing was saved").toHaveLength(0);
    // Counted once. A toast times out in about 5 s, so a retrying toHaveCount(0) would just wait
    // for this one to go, and pass.
    expect(await toast(page, "Changes not saved").count(), 'no generic "please try again" on top').toBe(0);

    // Saving a draft is allowed, so work in progress is not lost.
    await page.getByText("Draft — saved but hidden from students").click();
    await page.getByRole("button", { name: "Save Draft" }).click();
    await expect
      .poll(async () => (await surveysTitled(title)).map((s) => s.status), {
        timeout: 15_000,
        message: "the draft should be saved"
      })
      .toEqual(["draft"]);
  });

  test("a refused edit leaves a published survey published, with its questions unchanged", async ({ page }) => {
    const title = "Published, then edited";
    const id = await seedSurvey(title, "published", UNIQUE);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/${id}/edit`);
    await page.getByRole("button", { name: /Open Visual Builder/i }).click();
    await page.getByPlaceholder("Short Text question").nth(1).fill("question_1");

    const warning = page.getByTestId("survey-builder-duplicate-names");
    await expect(warning).toContainText('"question_1" is used by page 1, question 1 and page 1, question 2.');
    // Saving a published survey as a draft would take it away from students.
    await expect(warning).not.toContainText("draft");

    await page.getByRole("button", { name: /Use This Survey/i }).click();
    await page.getByRole("button", { name: "Publish Survey" }).click();
    await expectRefusal(page);

    expect(await surveysTitled(title)).toEqual([{ status: "published", json: JSON.stringify(UNIQUE) }]);
  });

  test("the surveys table's Publish says why it was refused", async ({ page }) => {
    const title = "Draft published from the table";
    await seedSurvey(title, "draft", REPEATED);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys`);
    await page.getByRole("row").filter({ hasText: title }).getByRole("button").last().click();
    await page.getByRole("menuitem", { name: "Publish" }).click();
    await expectRefusal(page);

    expect((await surveysTitled(title)).map((s) => s.status)).toEqual(["draft"]);
  });

  test("a question added on a new page gets a name no other question uses", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/new`);

    await page.getByRole("button", { name: /Open Visual Builder/i }).click();
    await page.getByRole("button", { name: /\+ Short Text/i }).click();
    await page.getByRole("button", { name: /Add Page/i }).click();
    await page.getByRole("button", { name: /\+ Short Text/i }).click();

    // Default names used to restart at question_1 on every page. Check while the builder is open:
    // closing it removes the warning, so this could never fail after "Use This Survey".
    const newQuestion = page.getByPlaceholder("Short Text question");
    await expect(newQuestion).toBeVisible();
    const warning = page.getByTestId("survey-builder-duplicate-names");
    await expect(warning).toHaveCount(0);
    // The same locator finds the warning as soon as the names do repeat.
    await newQuestion.fill("question_1");
    await expect(warning).toBeVisible();
    await newQuestion.fill("question_2");
    await expect(warning).toHaveCount(0);

    await page.getByRole("button", { name: /Use This Survey/i }).click();
    await page.getByRole("button", { name: /Edit survey definition \(JSON\)/i }).click();
    const parsed = JSON.parse(await page.getByRole("textbox", { name: /Survey definition \(JSON\)/i }).inputValue());
    const names = parsed.pages.flatMap((p: { elements: { name: string }[] }) => p.elements.map((el) => el.name));
    expect(names).toEqual(["question_1", "question_2"]);
  });

  test("a new question's default name avoids a name used inside a panel", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/new`);

    await page.getByRole("button", { name: /Edit survey definition \(JSON\)/i }).click();
    await page.getByRole("textbox", { name: /Survey definition \(JSON\)/i }).fill(
      JSON.stringify({
        pages: [
          {
            name: "page1",
            elements: [{ type: "panel", name: "group", elements: [{ type: "text", name: "question_2" }] }]
          }
        ]
      })
    );
    await page.getByRole("button", { name: /Open Visual Builder/i }).click();
    await page.getByRole("button", { name: /\+ Short Text/i }).click();

    await expect(page.getByPlaceholder("Short Text question")).toHaveValue("question_3");
  });
});
