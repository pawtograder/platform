/**
 * The visual builder and the survey form refuse to publish a survey whose questions share a name
 * (#1005). SurveyJS saves answers under the question name, so two questions named `question_1`
 * share one answer. The database refuses these too (survey-unique-question-names-db.spec.ts);
 * this covers what the instructor sees.
 */
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase, type TestingUser } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;

test.describe("survey builder: duplicate question names", () => {
  test.describe.configure({ mode: "serial" });
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

  test("the builder names a repeated question name, and the form will not publish it", async ({ page }) => {
    const title = "Reused question name";
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/new`);
    await page.getByPlaceholder("e.g. Week 3 Team Check-in").fill(title);

    await page.getByRole("button", { name: /Open Visual Builder/i }).click();
    await page.getByRole("button", { name: /\+ Short Text/i }).click();
    await page.getByRole("button", { name: /\+ Short Text/i }).click();
    // The instructor gives the second question the first one's name.
    await page.getByPlaceholder("Short Text question").nth(1).fill("question_1");

    const message = '"question_1" is used by page 1, question 1 and page 1, question 2. Rename one of them.';
    const summary = page.getByTestId("survey-builder-duplicate-names");
    await expect(summary, "the builder says which name is repeated and where").toContainText(message);
    await expect(summary, "and that a draft can still be saved").toContainText("save the survey as a draft");
    await expect(page.getByRole("status").filter({ hasText: message }).first()).toBeAttached();

    const secondName = page.getByPlaceholder("Short Text question").nth(1);
    await expect(secondName, "the repeated field is marked invalid").toHaveAttribute("aria-invalid", "true");
    await expect(secondName, "and its error is read with it").toHaveAccessibleDescription(new RegExp(message));

    await page.getByRole("button", { name: /Use This Survey/i }).click();
    await expect(page.getByRole("status").filter({ hasText: message }).first()).toBeVisible();

    // Publishing is refused, with the same message.
    await page.getByText("Published — visible to students").click();
    await expect(page.getByText("Two questions share a name. Rename one under Survey Questions")).toBeVisible();
    await page.getByRole("button", { name: "Publish Survey" }).click();
    await expect(page.getByText("Cannot Publish Survey").first()).toBeVisible();
    expect(await surveysTitled(title), "nothing was saved").toHaveLength(0);

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

  test("a question added on a new page gets a name no other question uses", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/new`);

    await page.getByRole("button", { name: /Open Visual Builder/i }).click();
    await page.getByRole("button", { name: /\+ Short Text/i }).click();
    await page.getByRole("button", { name: /Add Page/i }).click();
    await page.getByRole("button", { name: /\+ Short Text/i }).click();
    await page.getByRole("button", { name: /Use This Survey/i }).click();

    await page.getByRole("button", { name: /Edit survey definition \(JSON\)/i }).click();
    const parsed = JSON.parse(await page.getByRole("textbox", { name: /Survey definition \(JSON\)/i }).inputValue());
    const names = parsed.pages.flatMap((p: { elements: { name: string }[] }) => p.elements.map((el) => el.name));
    // Default names used to restart at question_1 on every page.
    expect(names).toEqual(["question_1", "question_2"]);
    await expect(page.getByTestId("survey-builder-duplicate-names")).toHaveCount(0);
  });
});
