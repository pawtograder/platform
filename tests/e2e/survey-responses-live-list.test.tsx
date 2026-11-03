/**
 * Issue #977: an instructor watching a survey's responses page must not see a student's unfinished
 * draft, and must see the response appear, without a reload, once the student completes.
 *
 * Every survey now autosaves drafts as the student types, and each write to survey_responses is
 * broadcast to the class staff channel. The responses page's live list used to accept any
 * broadcast row for the survey, so the draft showed up as a response: Total Responses 1, Response
 * Rate 100%, and Export to CSV enabled with the draft in it.
 *
 * The instructor page records the realtime frames it receives, so the test can wait for the
 * draft's broadcast to arrive before checking that nothing changed. Without that, a slow channel
 * join would make the "still 0" checks pass without testing anything.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase, type TestingUser } from "./TestingUtils";

/** Text of every realtime frame the page receives, from any websocket it opens. */
function recordRealtimeFrames(page: Page): string[] {
  const frames: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      frames.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8"));
    });
  });
  return frames;
}

/** The value under one of the summary cards' labels, such as "TOTAL RESPONSES". */
const summaryValue = (page: Page, label: string) =>
  page.getByText(label, { exact: true }).locator("xpath=following-sibling::*[1]");

test.describe("survey responses page while a student is answering", () => {
  test.setTimeout(180_000);

  let student: TestingUser;
  let instructor: TestingUser;

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([student, instructor]);
  });

  test("a draft stays off the live list, and the response appears once the student completes", async ({
    page,
    browser
  }) => {
    const course = await createClass({ name: "E2E Survey Live Responses" });
    [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Lia Live", useMagicLink: true },
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

    // The instructor opens the responses page before the student starts.
    const frames = recordRealtimeFrames(page);
    await loginAsUser(page, instructor, course);
    frames.length = 0;
    await page.goto(`/course/${course.id}/manage/surveys/${survey.survey_id}/responses`);
    const totalResponses = summaryValue(page, "TOTAL RESPONSES");
    const responseRate = summaryValue(page, "RESPONSE RATE");
    const exportButton = page.getByRole("button", { name: "Export to CSV" });
    await expect(totalResponses).toHaveText("0");
    await expect(exportButton).toBeDisabled();
    // The staff channel has joined, so the student's writes will reach this page.
    await expect
      .poll(
        () =>
          frames.some(
            (f) =>
              f.includes(`realtime:class:${course.id}:staff`) && f.includes("phx_reply") && f.includes('"status":"ok"')
          ),
        { timeout: 30_000 }
      )
      .toBe(true);

    // The student answers without completing; autosave writes a draft.
    const studentContext = await browser.newContext();
    const studentPage = await studentContext.newPage();
    await loginAsUser(studentPage, student, course);
    await studentPage.goto(`/course/${course.id}/surveys/${survey.id}`);
    const answer = studentPage.getByRole("textbox", { name: "Question 1" });
    await answer.fill("Draft answer from Lia");

    let draftId: string | undefined;
    await expect
      .poll(
        async () => {
          const { data, error: readError } = await supabase
            .from("survey_responses")
            .select("id, is_submitted, response")
            .eq("survey_id", survey.id)
            .eq("profile_id", student.private_profile_id)
            .maybeSingle();
          if (readError) throw new Error(readError.message);
          draftId = data?.id;
          return data ? { q1: (data.response as { q1?: string }).q1, is_submitted: data.is_submitted } : null;
        },
        { timeout: 15_000 }
      )
      .toEqual({ q1: "Draft answer from Lia", is_submitted: false });

    // The draft's broadcast reached the instructor's page...
    await expect
      .poll(() => frames.some((f) => f.includes(draftId!) && f.includes("Draft answer from Lia")), { timeout: 15_000 })
      .toBe(true);
    // ...and the list applies broadcasts after a debounce of at most 1 s. Give it 3 s.
    await page.waitForTimeout(3_000);
    await expect(totalResponses).toHaveText("0");
    await expect(responseRate).toHaveText("0%");
    await expect(exportButton).toBeDisabled();
    await expect(page.getByText("Students haven't submitted any responses to this survey.")).toBeVisible();
    await expect(page.getByText("Draft answer from Lia")).toHaveCount(0);

    // The student completes; the response appears on the instructor's page without a reload.
    await answer.fill("Final answer from Lia");
    await studentPage.getByRole("button", { name: "Complete" }).click();
    await expect(studentPage).toHaveURL(new RegExp(`/course/${course.id}/surveys$`), { timeout: 15_000 });

    await expect(totalResponses).toHaveText("1", { timeout: 15_000 });
    await expect(responseRate).toHaveText("100%");
    await expect(exportButton).toBeEnabled();
    const row = page.getByRole("row", { name: /Lia Live/ });
    await expect(row).toContainText("Final answer from Lia");
    await expect(page.getByText("Draft answer from Lia")).toHaveCount(0);

    await studentContext.close();
  });
});
