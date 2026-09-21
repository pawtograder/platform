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
import { loginAsUser } from "./TestingUtils";
import {
  SURVEY_ANSWER_TEXT,
  seedSurveySubmissionFixture,
  type SurveySubmissionFixture
} from "./surveySubmissionSeeding";

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

test.describe("Submission survey tab", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let fx: SurveySubmissionFixture;

  test.beforeAll(async () => {
    fx = await seedSurveySubmissionFixture();
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    if (!fx) return;
    await logMagicLinksOnFailure([fx.instructor, fx.submitter, fx.teammate]);
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
