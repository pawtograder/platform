/**
 * Issue #977: the live list on a survey's responses page must hold the same rows as the page's query.
 *
 * Every survey autosaves drafts, and every write to survey_responses is broadcast to the staff
 * channel. The list used to accept any broadcast row for the survey, so an instructor saw a student's
 * draft as a response (Total Responses, Response Rate, Export to CSV) and kept seeing a deleted one.
 *
 * The writes here go straight to the table. broadcast_survey_response_change() fires the same for
 * them, and surveys.test.tsx covers the student's page writing a draft. The page applies broadcasts
 * in the order they arrive, so once a later write shows on the page, the draft before it was handled.
 */
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase, type TestingUser } from "./TestingUtils";

test.describe("survey responses page while students are answering", () => {
  test.setTimeout(90_000);

  let student: TestingUser;
  let classmate: TestingUser;
  let instructor: TestingUser;

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([student, classmate, instructor]);
  });

  test("the live list takes a submitted response, but not a draft, and drops a deleted one", async ({ page }) => {
    const course = await createClass({ name: "E2E Survey Live Responses" });
    [student, classmate, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Lia Live", useMagicLink: true },
      { role: "student", class_id: course.id, name: "Cam Classmate", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Ivo Watcher", useMagicLink: true }
    ]);
    const { data: survey, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        created_by: instructor.public_profile_id,
        assigned_to_all: true,
        allow_response_editing: false,
        json: { pages: [{ name: "page1", elements: [{ type: "text", name: "q1", title: "Question 1" }] }] },
        version: 1,
        status: "published",
        title: "Live Responses Survey",
        description: "Drafts are not responses."
      })
      .select("id, survey_id")
      .single();
    if (error || !survey) throw new Error(`Failed to seed survey: ${error?.message}`);

    const saveResponse = async (who: TestingUser, q1: string, isSubmitted: boolean) => {
      const { error: writeError } = await supabase
        .from("survey_responses")
        .upsert(
          { survey_id: survey.id, profile_id: who.private_profile_id, response: { q1 }, is_submitted: isSubmitted },
          { onConflict: "survey_id,profile_id" }
        );
      if (writeError) throw new Error(`Failed to save a response: ${writeError.message}`);
    };

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/${survey.survey_id}/responses`);
    const totalResponses = page.getByText("TOTAL RESPONSES", { exact: true }).locator("xpath=following-sibling::*[1]");
    const exportButton = page.getByRole("button", { name: "Export to CSV" });
    await expect(totalResponses).toHaveText("0");
    await expect(exportButton).toBeDisabled();

    // A broadcast sent before the list subscribes is lost, so each answer is written until it shows.
    // The first may arrive in the list's first fetch. After that only a broadcast can show a change,
    // so the second answer showing means broadcasts are reaching the list.
    const writeClassmateUntilListed = (answer: string) =>
      expect(async () => {
        await saveResponse(classmate, answer, true);
        await expect(page.getByRole("row", { name: /Cam Classmate/ })).toContainText(answer, { timeout: 3_000 });
      }).toPass({ timeout: 30_000 });
    await writeClassmateUntilListed("First classmate answer");
    await writeClassmateUntilListed("Edited classmate answer");

    // A student's draft, then the classmate's response soft-deleted. The count reaching 0 means both
    // broadcasts were handled: the old filter leaves it at 2.
    await saveResponse(student, "Draft answer", false);
    const { error: deleteError } = await supabase
      .from("survey_responses")
      .update({ deleted_at: new Date().toISOString() })
      .eq("survey_id", survey.id)
      .eq("profile_id", classmate.private_profile_id);
    if (deleteError) throw new Error(`Failed to delete a response: ${deleteError.message}`);
    await expect(totalResponses).toHaveText("0");
    await expect(page.getByText("Draft answer")).toHaveCount(0);
    await expect(exportButton).toBeDisabled();

    // The student completes, and the response appears without a reload.
    await saveResponse(student, "Final answer", true);
    await expect(totalResponses).toHaveText("1");
    await expect(page.getByRole("row", { name: /Lia Live/ })).toContainText("Final answer");
    await expect(exportButton).toBeEnabled();
  });
});
