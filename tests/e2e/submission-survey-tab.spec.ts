/**
 * Browser coverage for the Survey tab on a submission.
 *
 * Thin by design. `survey-responses-for-submission-db.spec.ts` carries the authorization matrix
 * against the RPC; this spec only checks that the page asks the right question and renders the two
 * states that are easy to get wrong: a member who has not started (an explicit card, not a blank
 * form) and a student who must not see a teammate's answers.
 */
import { test, expect } from "../global-setup";
import type { Locator, Page } from "@playwright/test";
import { viewAsCookieName } from "@/lib/viewAs";
import { loginAsUser } from "./TestingUtils";
import {
  SURVEY_ANSWER_TEXT,
  SURVEY_TITLES,
  UNASSIGNED_SURVEY_QUESTION_TEXT,
  seedSurveySubmissionFixture,
  type SurveySubmissionFixture
} from "./surveySubmissionSeeding";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

const SURVEY_TAB = '[data-testid="submission-survey-tab"]';
const SURVEY_PANEL = '[data-testid="submission-survey-panel"]';

function memberChip(page: Page | Locator, profileId: string): Locator {
  return page.locator(`[data-testid="survey-member-status-${profileId}"]`);
}

async function openSurveyTab(page: Page, courseId: number, assignmentId: number, submissionId: number) {
  await page.goto(`/course/${courseId}/assignments/${assignmentId}/submissions/${submissionId}`);
  const tab = page.locator(SURVEY_TAB);
  await expect(tab, "the Survey tab renders when a survey is linked to the assignment").toBeVisible();
  await tab.click();
  const panel = page.locator(SURVEY_PANEL);
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Switch the panel to another linked survey and wait for the switch to land.
 *
 * `submission-survey-panel` is also the loading spinner's testid, so "the panel is visible" is not
 * evidence that anything has loaded. Waiting on the picker, which only exists once more than one
 * survey has come back, is what makes a later "this text is absent" assertion mean something.
 */
async function selectSurvey(panel: Locator, title: string) {
  const picker = panel.getByRole("combobox", { name: "Survey" });
  await expect(picker, "the survey picker appears once the RPC has returned more than one survey").toBeVisible();
  await picker.selectOption({ label: title });
  await expect(panel.getByRole("heading", { name: title })).toBeVisible();
}

test.describe("Submission survey tab", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let fx: SurveySubmissionFixture;

  test.beforeAll(async () => {
    fx = await seedSurveySubmissionFixture();
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    if (!fx) return;
    await logMagicLinksOnFailure([fx.instructor, fx.submitter, fx.teammate, fx.notStarted]);
  });

  test("an instructor sees a status chip for every group member, including one who never started", async ({ page }) => {
    await loginAsUser(page, fx.instructor, fx.course);
    const panel = await openSurveyTab(page, fx.course.id, fx.assignmentId, fx.groupSubmissionId);

    for (const member of [fx.submitter, fx.teammate, fx.notStarted, fx.softDeleted]) {
      await expect(
        memberChip(panel, member.private_profile_id),
        `${member.private_profile_name} must have a status chip`
      ).toBeVisible();
    }

    // The member with no response row gets an explicit empty state, not a blank survey form that
    // reads as "answered nothing".
    const notStartedChip = memberChip(panel, fx.notStarted.private_profile_id);
    await expect(notStartedChip).toContainText(/not started/i);

    // No clicking: the panel auto-expands every member who has a response, so a grader reads the
    // whole roster on arrival. The not-started member's body is deliberately never mounted, which
    // is why this asserts on the card and chip rather than on an empty form.
    await expect(panel, "the submitter's answer renders without a click").toContainText(SURVEY_ANSWER_TEXT.submitter);
    await expect(panel, "a teammate's answer renders without a click").toContainText(SURVEY_ANSWER_TEXT.teammate);
    await expect(panel, "a soft-deleted answer stays hidden even from staff").not.toContainText(
      SURVEY_ANSWER_TEXT.softDeleted
    );
    await expect(panel, "the not-started member gets an explicit card, not a blank form").toContainText(
      /has not started/i
    );
  });

  test("a student sees only their own response, never a teammate's", async ({ page }) => {
    await loginAsUser(page, fx.submitter, fx.course);
    const panel = await openSurveyTab(page, fx.course.id, fx.assignmentId, fx.groupSubmissionId);

    await expect(memberChip(panel, fx.submitter.private_profile_id)).toBeVisible();
    await expect(panel).toContainText(SURVEY_ANSWER_TEXT.submitter);

    // Scoped to the panel: the teammate's name legitimately appears elsewhere on the submission
    // page, in the group membership header. Her survey answers must not appear anywhere.
    for (const other of [fx.teammate, fx.notStarted, fx.softDeleted]) {
      await expect(
        memberChip(panel, other.private_profile_id),
        `${other.private_profile_name} must not be listed in a student's survey panel`
      ).toHaveCount(0);
    }
    await expect(panel).not.toContainText(fx.teammate.private_profile_name);
    await expect(page.locator("body"), "a teammate's survey answer must never reach another student").not.toContainText(
      SURVEY_ANSWER_TEXT.teammate
    );
  });

  test("a group member who did not submit still sees their own response", async ({ page }) => {
    // The panel opens `find(is_submitter) ?? members[0]`. This student's only row has
    // is_submitter false, so the fallback is what makes their own answer visible.
    await loginAsUser(page, fx.teammate, fx.course);
    const panel = await openSurveyTab(page, fx.course.id, fx.assignmentId, fx.groupSubmissionId);

    await expect(memberChip(panel, fx.teammate.private_profile_id)).toBeVisible();
    await expect(panel, "a non-submitting member's own response still opens").toContainText(
      SURVEY_ANSWER_TEXT.teammate
    );
    await expect(memberChip(panel, fx.submitter.private_profile_id)).toHaveCount(0);
    await expect(page.locator("body"), "the submitter's answer must not reach a teammate").not.toContainText(
      SURVEY_ANSWER_TEXT.submitter
    );
  });

  test("a member who was never assigned the survey reads as 'not assigned', not 'not started'", async ({ page }) => {
    // The targeted survey names exactly one group member in `survey_assignments`. Both members
    // checked here have a null response, so `response == null` cannot tell them apart; only
    // `is_assigned` can. Labelling the unassigned one "Not started" tells a grader a student
    // skipped work that was never asked of them, which is the bug this guards.
    await loginAsUser(page, fx.instructor, fx.course);
    const panel = await openSurveyTab(page, fx.course.id, fx.assignmentId, fx.groupSubmissionId);
    await selectSurvey(panel, SURVEY_TITLES.targeted);

    const unassignedChip = memberChip(panel, fx.untargetedStudent.private_profile_id);
    await expect(unassignedChip, "an unassigned member stays on the roster rather than disappearing").toBeVisible();
    await expect(unassignedChip, "the unassigned member is labelled as such").toContainText(/not assigned/i);
    await expect(unassignedChip, "and is not blamed for not starting").not.toContainText(/not started/i);

    // The contrast is the whole point: the assigned member, equally answerless, keeps the
    // "Not started" label. Without this the test would also pass on a panel that says
    // "Not assigned" about everybody.
    const assignedChip = memberChip(panel, fx.targetedStudent.private_profile_id);
    await expect(assignedChip, "the assigned member has genuinely not started").toContainText(/not started/i);
    await expect(assignedChip).not.toContainText(/not assigned/i);

    await expect(panel, "no card may say the unassigned member failed to start the survey").not.toContainText(
      `${fx.untargetedStudent.private_profile_name} has not started this survey.`
    );
  });

  test("an answer survives its assignment being revoked, and is not hidden behind 'Not assigned'", async ({ page }) => {
    // Tina is unassigned on BOTH the targeted survey and this one. The only difference is that
    // here she has a response, and that alone has to flip her from "Not assigned" to an answer a
    // grader can read. Ordering `is_assigned` ahead of `response` in memberStatus would file real
    // work under "we never asked", and the grader would record no participation.
    await loginAsUser(page, fx.instructor, fx.course);
    const panel = await openSurveyTab(page, fx.course.id, fx.assignmentId, fx.groupSubmissionId);
    await selectSurvey(panel, SURVEY_TITLES.revoked);

    const answeredChip = memberChip(panel, fx.revokedStudent.private_profile_id);
    await expect(answeredChip).toBeVisible();
    await expect(answeredChip, "a submitted response reads as completed however it was assigned").toContainText(
      /completed/i
    );
    await expect(answeredChip, "and must not be filed under 'we never asked'").not.toContainText(/not assigned/i);
    await expect(panel, "the answer itself is on screen, not behind a card").toContainText(SURVEY_ANSWER_TEXT.revoked);

    // Same survey, same `is_assigned: false`, no response. This is what "Not assigned" is for, and
    // having both on one screen is what pins the precedence rather than just the labels.
    const silentChip = memberChip(panel, fx.notStarted.private_profile_id);
    await expect(silentChip, "an unassigned member with nothing to show still reads as not assigned").toContainText(
      /not assigned/i
    );
    await expect(panel, "no card may claim the answered member was not assigned").not.toContainText(
      `${fx.revokedStudent.private_profile_name} was not assigned this survey.`
    );
  });

  test("view-as-student shows staff only the impersonated student's row", async ({ page }) => {
    // The RPC still answers as the instructor here — it has no idea view-as is on — so the panel
    // receives the whole group roster and has to narrow it itself. Leaving that out would show a
    // teammate's free-text answers on a page a student is being shown, and in a screen-share demo
    // that is a disclosure to the student sitting next to the instructor.
    await loginAsUser(page, fx.instructor, fx.course);
    await page
      .context()
      .addCookies([{ name: viewAsCookieName(fx.course.id), value: fx.submitter.private_profile_id, url: BASE_URL }]);

    const panel = await openSurveyTab(page, fx.course.id, fx.assignmentId, fx.groupSubmissionId);

    await expect(
      page.getByRole("alert", { name: "Viewing as student" }),
      "view-as must actually be engaged, or this test proves nothing"
    ).toBeVisible();

    // Positive first, so everything below is asserted against a loaded panel and not a spinner.
    await expect(memberChip(panel, fx.submitter.private_profile_id)).toBeVisible();
    await expect(panel).toContainText(SURVEY_ANSWER_TEXT.submitter);

    for (const other of [fx.teammate, fx.notStarted, fx.softDeleted]) {
      await expect(
        memberChip(panel, other.private_profile_id),
        `${other.private_profile_name} must not be listed while previewing as one group member`
      ).toHaveCount(0);
    }
    await expect(page.locator("body"), "no teammate answer text may reach the impersonated view").not.toContainText(
      SURVEY_ANSWER_TEXT.teammate
    );

    // Narrowing the roster is not enough on its own. The RPC answers as staff, so it returns every
    // linked survey — including ones the impersonated student's own call would have withheld — and
    // a row for every roster member on each, the impersonated profile included. Dropping surveys
    // with no row for that profile would therefore drop nothing. The panel has to restate the
    // non-staff predicate instead: available_at past, and is_assigned on the viewer's own row.
    const picker = panel.getByRole("combobox", { name: "Survey" });
    await expect(picker, "four surveys are legitimately visible to this student, so the picker renders").toBeVisible();
    const offered = await picker.locator("option").allTextContents();

    // Positive first, so an empty or unrendered picker cannot make the exclusions below vacuous.
    expect(offered, "the surveys this student really can see are still offered").toContain(SURVEY_TITLES.published);
    expect(offered, "a survey scheduled ahead is not part of this student's view").not.toContain(SURVEY_TITLES.future);
    expect(offered, "nor is one assigned to someone else").not.toContain(SURVEY_TITLES.unassignedFuture);

    // The picker assertion is the stronger one: absent question text could just mean the survey is
    // not currently selected, which passes while the disclosure is one click away. This is the
    // backstop for the selected survey.
    await expect(panel, "unreleased question text must not render in a student-facing view").not.toContainText(
      UNASSIGNED_SURVEY_QUESTION_TEXT
    );
  });

  test("the tab does not render for an assignment with no linked survey", async ({ page }) => {
    await loginAsUser(page, fx.instructor, fx.course);
    await page.goto(
      `/course/${fx.course.id}/assignments/${fx.surveylessAssignmentId}/submissions/${fx.surveylessSubmissionId}`
    );

    // Wait for the tab bar itself before asserting an absence, so this cannot pass on a page that
    // simply has not finished rendering.
    await expect(page.locator("#submission-tabs")).toBeVisible();
    await expect(page.locator(SURVEY_TAB), "no linked survey means no Survey tab").toHaveCount(0);
  });
});
