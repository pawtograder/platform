import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { type Page } from "@playwright/test";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
import { assertStudentPageAccessible } from "./axeStudentA11y";
import { stabilizeRubricSidebar, visualScreenshot } from "./VisualTestUtils";

dotenv.config({ path: ".env.local", quiet: true });

// Helper function to retry clicks that should make textboxes appear
async function clickWithTextboxRetry(
  page: Page,
  clickTarget: ReturnType<Page["getByLabel"]>,
  textboxSelector: ReturnType<Page["getByRole"]>,
  maxRetries = 3
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await clickTarget.click();

    try {
      // Wait for textbox to appear within 300ms
      await textboxSelector.waitFor({ state: "visible", timeout: 300 });
      return; // Success - textbox appeared
    } catch {
      if (attempt === maxRetries) {
        throw new Error(`Textbox did not appear after ${maxRetries} attempts`);
      }
      // Wait a bit before retrying
      await page.waitForTimeout(100);
    }
  }
}

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let submission_id: number | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let grader: TestingUser | undefined;
let student2: TestingUser | undefined;
let submission_id2: number | undefined;
/** Grading review row for submission_id2 — used to unreleased after "Release All" from an earlier serial test */
let submission2_grading_review_id: number | undefined;
test.beforeAll(async () => {
  course = await createClass();
  [student, instructor, grader, student2] = await createUsersInClass([
    {
      name: "Grading Student",
      public_profile_name: "Grading Pseudonym Student",
      email: "grading-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Grading Instructor",
      public_profile_name: "Grading Pseudonym Instructor",
      email: "grading-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Grading Grader",
      public_profile_name: "Grading Pseudonym Grader",
      email: "grading-grader@pawtograder.net",
      role: "grader",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Grading Student 2",
      public_profile_name: "Grading Pseudonym Student 2",
      email: "grading-student2@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Grading Assignment"
  });

  const submission_res = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = submission_res.submission_id;

  const submission_res2 = await insertPreBakedSubmission({
    student_profile_id: student2.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id2 = submission_res2.submission_id;
  submission2_grading_review_id = submission_res2.grading_review_id!;
  // Assign grader to the first rubric part
  const private_profile_id = grader!.private_profile_id;
  const review_assignment_res = await supabase
    .from("review_assignments")
    .insert({
      assignee_profile_id: private_profile_id,
      class_id: course.id,
      assignment_id: assignment!.id,
      submission_id: submission_id2!,
      submission_review_id: submission_res2.grading_review_id!,
      rubric_id: assignment!.grading_rubric_id!,
      due_date: addDays(new Date(), 1).toUTCString()
    })
    .select("id")
    .single();
  if (review_assignment_res.error) {
    console.error(review_assignment_res.error);
    throw new Error(`Failed to create review assignment: ${review_assignment_res.error.message}`);
  }
  await supabase
    .from("review_assignment_rubric_parts")
    .insert({
      review_assignment_id: review_assignment_res.data!.id,
      rubric_part_id: assignment!.rubricParts[2]!.id,
      class_id: course.id
    })
    .select("id");
});
test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor, grader, student2]);
});
const SELF_REVIEW_COMMENT_1 = "I'm pretty sure this code works, but I'm not betting my grade on it";
const SELF_REVIEW_COMMENT_2 = "This method is so clean it could pass a white glove test";
const GRADING_REVIEW_COMMENT_1 = "Your code is clear and easy to follow—great job on making your logic understandable!";
const GRADING_REVIEW_COMMENT_2 =
  "This is the kind of code that makes grading enjoyable: well-structured and thoughtful work!";
const GRADING_REVIEW_COMMENT_3 = "I have stared at this for a long time, and I am still not sure what to write here.";

const REGRADE_COMMENT = "I think that I deserve better than a 10/10!";
const REGRADE_RESOLUTION = "I do not think it is possible to get more than 10/10!";
/** Grading Review Check 3 on line 4 starts at 10 pts; fractional resolve must persist in DB/UI */
const REGRADE_RESOLVE_ADJUSTMENT = "0.5";
const REGRADE_RESOLVE_EXPECTED_POINTS = "10.5";
const REGRADE_ESCALATION = "But I heard that Ben Bitdiddle got an 11/10!";
const REGRADE_FINAL_COMMENT = "Alright, 11/10 it is then!";

test.describe("An end-to-end grading workflow self-review to grading", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);
  test("Students can submit self-review early", async ({ page }) => {
    await loginAsUser(page, student!, course);
    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.locator("#primary-nav").getByRole("link").filter({ hasText: "Assignments" }).click();
    await page.waitForURL("**/assignments");
    await page.getByRole("link", { name: assignment!.title }).click();

    await expect(page.getByText("Self Review Notice")).toBeVisible();
    // The "Submission Limit for this assignment" alert renders asynchronously
    // after a separate RPC and is now hidden in visual tests (see the
    // data-visual-test="removed" on the alert in page.tsx) so its
    // arrival timing can't affect this screenshot's page height.
    await visualScreenshot(page, "Student can submit self-review early");
    await page.getByRole("button", { name: "Finalize Submission Early" }).click();
    await page.getByRole("button", { name: "Confirm action" }).click();
    // The "Submission finalized" success toast is the explicit signal that
    // finalize_submission_early completed and reviewAssignments has been
    // refetched (see finalizeSubmissionEarly.tsx). Without this, the test
    // races the "Complete Self Review" button into existence.
    // Visual-test mode removes toasts from layout before screenshots, so the
    // explicit app signal is attachment rather than visibility.
    await expect(page.getByText("Submission finalized").first()).toBeAttached();
    // Even after the toast appears, the "Complete Self Review" button only
    // renders once useMyReviewAssignments() observes the new row AND
    // useRubric("self-review") returns the matching rubric (see
    // components/ui/self-review-notice.tsx). Under webkit CI load both
    // inputs can lag behind the toast: the realtime UPDATE delivering the
    // new review_assignment row to other clients can race the server-direct
    // refetch. Gate the click on the DB truth — poll review_assignments
    // with the service-role supabase client until the new self-review row
    // exists for this student + submission. (Same pattern as
    // pseudonymous-grading.test.tsx.)
    await expect(async () => {
      const { data: selfReviewRubric } = await supabase
        .from("rubrics")
        .select("id")
        .eq("assignment_id", assignment!.id)
        .eq("review_round", "self-review")
        .single();
      expect(selfReviewRubric?.id).toBeTruthy();
      const { data: ra } = await supabase
        .from("review_assignments")
        .select("id, rubric_id, assignee_profile_id, submission_id")
        .eq("submission_id", submission_id!)
        .eq("assignee_profile_id", student!.private_profile_id)
        .eq("rubric_id", selfReviewRubric!.id);
      expect(ra?.length ?? 0).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000, intervals: [250, 500, 1000] });
    await page.getByRole("button", { name: "Complete Self Review" }).click();
    await expect(page.getByText('When you are done, click "Complete Review Assignment".')).toBeVisible();

    //Scroll self-review rubric to top of its container
    await page.getByRole("region", { name: "Self-Review Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });

    await page.getByText("public int doMath(int a, int").click({
      button: "right"
    });

    await page.getByRole("option", { name: "Leave a comment" }).click();

    await page.getByRole("textbox", { name: "Add a comment about this line" }).click();
    await page.getByRole("textbox", { name: "Add a comment about this line" }).fill(SELF_REVIEW_COMMENT_1);
    await visualScreenshot(page, "Adding a comment on the self-review", { stabilizeRubric: "Self-Review Rubric" });
    await page.getByRole("button", { name: "Add Comment" }).click();
    await page.getByText("Annotate line 15 with a check:").waitFor({ state: "hidden" });

    await page.getByText('5 System.out.println("Hello,').click({
      button: "right"
    });
    await page.getByRole("option", { name: "Self Review Check 1 (+5)" }).click();
    await page.getByRole("textbox", { name: "Optionally add a comment, or" }).fill("comment");
    await visualScreenshot(page, "Adding a second self-review check", { stabilizeRubric: "Self-Review Rubric" });
    await page.getByRole("button", { name: "Add Check" }).click();
    // await clickAddCheckWithRetry(page);
    await page.getByText("Annotate line 5 with a check:").waitFor({ state: "hidden" });

    await clickWithTextboxRetry(
      page,
      page.getByLabel("Self Review Check 2 (+5)"),
      page.getByRole("textbox", { name: "Optional: comment on check Self Review Check 2" })
    );
    //Wait for the add check button to stabilize
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page
      .getByRole("textbox", { name: "Optional: comment on check Self Review Check 2" })
      .fill(SELF_REVIEW_COMMENT_2);
    await visualScreenshot(page, "Adding a global self-review check with a comment", {
      stabilizeRubric: "Self-Review Rubric"
    });

    await page.getByRole("button", { name: "Add Check" }).click();
    //Wait for the textbox to disappear
    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Complete Review" }).click();
    await page.getByRole("button", { name: "Mark Review Assignment as Complete" }).click();
    await expect(page.getByText("Self-Review Rubric completed")).toBeVisible();
    await visualScreenshot(page, "Self-Review Rubric completed", { stabilizeRubric: "Self-Review Rubric" });
    await assertStudentPageAccessible(page, "grading self-review completed");
  });

  test("Instructors can view the student's self-review and create their own grading review", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await page.getByText("Lint Results: Passed").waitFor({ state: "visible" }); // Wait for the page to stabilize
    await page.getByRole("button", { name: "Files" }).click();

    await expect(page.getByLabel("Rubric: Self-Review Rubric")).toBeVisible();
    //Make sure that we get a very nice screenshot with a fully-loaded page
    await expect(page.getByText("public static void main(")).toBeVisible();
    await expect(page.getByText("public int doMath(int a, int")).toBeVisible();
    await expect(page.getByText(SELF_REVIEW_COMMENT_1)).toBeVisible();
    // Wait for the applied "Self Review Check 2" comment region to render.
    // The rubric-sidebar emits a `<Box role="region"
    // aria-label="Grading check {check.name}">` per applied check (see
    // components/ui/rubric-sidebar.tsx), and that region only mounts once
    // the SubmissionFileComment row has hydrated into the controller —
    // unlike the rubric-definition labels which are present from page load.
    // This is the real "comment hydrated" signal; without it the next
    // assertion races the rubric sidebar's progressive comment hydration.
    await expect(page.getByRole("region", { name: "Grading check Self Review Check 2" }).first()).toBeVisible();
    await expect(page.getByText(SELF_REVIEW_COMMENT_2)).toBeVisible();
    //Scroll self-review rubric to top of its container
    await stabilizeRubricSidebar(page, "Self-Review Rubric");
    await visualScreenshot(page, "Instructor can view the student's self-review", {
      stabilizeRubric: "Self-Review Rubric"
    });

    //Scroll grading rubric to top of its container
    await page.getByRole("region", { name: "Grading Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });

    await page.getByText("public static void main(").click({
      button: "right"
    });
    await page.getByRole("option", { name: "Grading Review Check 1 (+10)" }).click();
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page.getByRole("textbox", { name: "Optionally add a comment, or" }).fill(GRADING_REVIEW_COMMENT_1);
    await visualScreenshot(page, "Instructor adds a grading review check", { stabilizeRubric: "Grading Rubric" });
    await page.getByRole("button", { name: "Add Check" }).click();
    // await clickAddCheckWithRetry(page);
    await page.getByText("Annotate line 4 with a check:").waitFor({ state: "hidden" });

    await clickWithTextboxRetry(
      page,
      page.getByLabel("Grading Review Check 2 (+10)"),
      page.getByRole("textbox", { name: "Optional: comment on check Grading Review Check 2" })
    );
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page
      .getByRole("textbox", { name: "Optional: comment on check Grading Review Check 2" })
      .fill(GRADING_REVIEW_COMMENT_2);
    await page.getByRole("button", { name: "Add Check" }).click();

    //Wait for the textbox to disappear
    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await clickWithTextboxRetry(
      page,
      page.getByLabel("Grading Review Check 3 (+10)"),
      page.getByRole("textbox", { name: "Optional: comment on check Grading Review Check 3" })
    );
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page
      .getByRole("textbox", { name: "Optional: comment on check Grading Review Check 3" })
      .fill(GRADING_REVIEW_COMMENT_3);
    await page.getByRole("button", { name: "Add Check" }).click();

    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Complete Review" }).click();
    await visualScreenshot(page, "Instructor completes the grading review", { stabilizeRubric: "Grading Rubric" });
    await page.getByRole("button", { name: "Mark as Complete" }).click();
    await expect(page.getByText("Completed by")).toBeVisible();

    // Release selected submission reviews (select all in filtered view, then release)
    await page.goto(`/course/${course.id}/manage/assignments/${assignment!.id}`);

    await page.getByRole("button", { name: "All in view" }).click();
    const releaseBtn = page.getByRole("button", { name: /Release \d+ selected submission/ });
    await expect(releaseBtn).toBeEnabled();
    await releaseBtn.click();
    // Wait for the release to land in the DB before navigating to the
    // submission page. On webkit the SSR'd submission page sometimes paints
    // before the released flag has propagated, leading to the badge showing
    // "No" indefinitely.
    await expect(async () => {
      const { data } = await supabase
        .from("submission_reviews")
        .select("released")
        .eq("submission_id", submission_id!)
        .eq("released", true);
      expect(data?.length ?? 0).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await expect(page.getByText("Released to studentYes")).toBeVisible({ timeout: 30_000 });
  });
  test("Students can view their grading results and request a regrade", async ({ page }) => {
    // This test does a magic-link login, full assignment navigation, and an
    // axe accessibility scan plus rubric assertions. On webkit under CI
    // load loginAsUser's retry loop alone can spend ~5×15s recovering from
    // transient GoTrue contention, leaving little budget for the autograder
    // results wait at line ~373. Triple the active timeout so a slow login
    // doesn't surface as a "Lint Results: Passed" waitFor flake.
    test.slow();
    await loginAsUser(page, student!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.locator("#primary-nav").getByRole("link").filter({ hasText: "Assignments" }).click();
    await page.waitForURL("**/assignments");
    await page.getByRole("link", { name: assignment!.title, exact: true }).click();
    await page.getByRole("link", { name: "1", exact: true }).click();

    // Released submissions now default students to the Grade tab; switch to the autograder
    // detail (results) view that this test exercises.
    await page.getByRole("button", { name: "Autograder Detail" }).click();
    await page.getByText("Lint Results: Passed").waitFor({ state: "visible" }); // Wait for the page to stabilize
    // Scan the results route here so axe also covers the autograder output view, the Pyret REPL
    // header (aria-controls), the Feedbot Textarea, and any Switch-rendered toggles.
    await expect(page).toHaveURL(/\/results(?:\?.*)?$/);
    await assertStudentPageAccessible(page, "grading results /results route");
    await page.getByRole("button", { name: "Files" }).click();
    await page.getByText("public int doMath(int a, int").click();

    const rubricSidebar = page.locator(`#rubric-${assignment!.grading_rubric_id}`);
    await expect(rubricSidebar).toContainText("Grading Review Criteria 20/20");
    await expect(rubricSidebar).toContainText(GRADING_REVIEW_COMMENT_1);
    await expect(rubricSidebar).toContainText(GRADING_REVIEW_COMMENT_2);
    //Scroll grading rubric to top of its container
    await stabilizeRubricSidebar(page, "Grading Rubric");
    await visualScreenshot(page, "Student can view their grading results", { stabilizeRubric: "Grading Rubric" });
    await assertStudentPageAccessible(page, "grading results submission files");

    await expect(rubricSidebar).toContainText(`${instructor!.private_profile_name} applied today`);
    // Find the region with aria-label 'Grading checks on line 4'
    const region = await page.getByRole("region", { name: "Grading checks on line 4" });
    await expect(region).toBeVisible();
    await region.getByRole("button", { name: "Request regrade for this check" }).click();
    // The "Request regrade" popover is portalled and applies aria-hidden to the
    // rubric sidebar while open, so we cannot use stabilizeRubric here. The 7:59 vs
    // 8:06 PM applied-at timestamp diff that previously made this flaky is handled
    // by the transparent-text wrap on rubric-sidebar.tsx.
    await expect(page.getByRole("button", { name: "Draft Regrade Request" })).toBeVisible();
    await visualScreenshot(page, "Student can request a regrade");
    await page.getByRole("button", { name: "Draft Regrade Request" }).click();
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to open this")
      .click();
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to open this")
      .fill(REGRADE_COMMENT);
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByLabel("Open Request", { exact: true })
      .click();
    await expect(region.getByText(REGRADE_COMMENT)).toBeVisible();
    await expect(region.getByText("Submitting your comment...")).not.toBeVisible();
    await visualScreenshot(page, "Student can add a comment to open the regrade request", {
      stabilizeRubric: "Grading Rubric"
    });
  });
  test("Instructors can view the student's regrade request and resolve it", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);
    await expect(page.getByText("public static void main(")).toBeVisible();
    await expect(page.getByRole("region", { name: "Grading checks on line 4" })).toBeVisible();
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .click();
    await visualScreenshot(page, "Instructors can view the student's regrade request", {
      stabilizeRubric: "Grading Rubric"
    });
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .fill(REGRADE_RESOLUTION);
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByLabel("Add Comment", { exact: true })
      .click();
    await expect(
      page.getByLabel("Grading checks on line 4").filter({ hasText: "I do not think it is possible" })
    ).toBeVisible();
    await expect(page.getByText("Submitting your comment...")).not.toBeVisible();
    await page.getByLabel("Grading checks on line 4").getByRole("button", { name: "Resolve Request" }).click();
    // Popover content is portalled (not under the rubric check region); scope to the resolve dialog.
    const resolveRegradePopover = page.getByRole("dialog").filter({ hasText: "Grade Adjustment:" });
    await expect(resolveRegradePopover).toBeVisible();
    // Wait for the resolve button to render — previously the screenshot raced
    // its appearance, producing an 11k-px diff. (Button's accessible name is
    // "Resolve regrade request" via aria-label; visible text is "Resolve with
    // No Change" before any grade adjustment.)
    await expect(resolveRegradePopover.getByText("Resolve with No Change")).toBeVisible();
    // Capture only the rubric check region rather than the whole page. The
    // popover panel itself paints with sub-pixel-shifted height between runs
    // (a Chakra Popover layout race we can't otherwise pin), but the value of
    // this visual test is the rubric region's "Regrade Pending" state — the
    // popover open/close interaction is already covered by the click + assert
    // calls around it.
    await visualScreenshot(page, "Instructors can resolve the regrade request", {
      element: page.getByLabel("Grading checks on line 4")
    });
    await resolveRegradePopover.getByRole("textbox", { name: /Grade adjustment/i }).fill(REGRADE_RESOLVE_ADJUSTMENT);
    await expect(resolveRegradePopover).toContainText(
      new RegExp(`New points awarded:\\s*${REGRADE_RESOLVE_EXPECTED_POINTS.replace(".", "\\.")}`)
    );
    await resolveRegradePopover.getByRole("button", { name: "Resolve regrade request", exact: true }).click();
    await expect(
      page.getByLabel("Grading checks on line 4").getByRole("heading", { name: /Regrade Resolved/i })
    ).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByLabel("Grading checks on line 4")).toContainText(REGRADE_RESOLVE_EXPECTED_POINTS);
  });
  test("Students can view the instructor's regrade resolution and appeal it", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);
    await expect(page.getByText("public static void main(")).toBeVisible();
    await expect(page.getByRole("region", { name: "Grading checks on line 4" })).toBeVisible();
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .click();
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .fill(REGRADE_ESCALATION);
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByLabel("Add Comment", { exact: true })
      .click();
    await page.getByLabel("Grading checks on line 4").getByRole("button", { name: "Escalate to Instructor" }).click();
    // Same popover-aria-hidden issue as the "Request a regrade" popover above.
    await expect(page.getByRole("button", { name: "Escalate Request" })).toBeVisible();
    // Make sure all earlier comments have re-rendered before snapshotting —
    // the comment stream loads via realtime and races the screenshot, which
    // caused a 64px page-height delta between runs.
    {
      const appealRegion = page.getByLabel("Grading checks on line 4");
      await expect(appealRegion.getByText(REGRADE_COMMENT)).toBeVisible();
      await expect(appealRegion.getByText(REGRADE_RESOLUTION)).toBeVisible();
      await expect(appealRegion.getByText(REGRADE_ESCALATION)).toBeVisible();
    }
    await visualScreenshot(page, "Students can appeal their regrade request");
    await page.getByRole("button", { name: "Escalate Request" }).click();
    // Wait for the escalation to settle before axe runs — otherwise axe races
    // the closing popover / toast and reports transient focus-trap / labeling violations.
    await expect(
      page.getByRole("button", { name: "Escalate Request" }),
      "Escalate Request button is removed after escalation"
    ).toHaveCount(0);
    await assertStudentPageAccessible(page, "grading regrade appeal escalated");
  });
  test("Instructors can view the student's regrade appeal and resolve it", async ({ page }) => {
    const region = await page.getByRole("region", { name: "Grading checks on line 4" });
    await loginAsUser(page, instructor!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);
    await expect(page.getByText("public static void main(")).toBeVisible();
    await expect(page.getByRole("region", { name: "Grading checks on line 4" })).toBeVisible();
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .click();
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .fill(REGRADE_FINAL_COMMENT);
    // Ensure the prior regrade-discussion comments are loaded before the
    // screenshot — they arrive via realtime and otherwise race capture, giving
    // a ~64px page-height delta between runs.
    await expect(region.getByText(REGRADE_COMMENT)).toBeVisible();
    await expect(region.getByText(REGRADE_RESOLUTION)).toBeVisible();
    await expect(region.getByText(REGRADE_ESCALATION)).toBeVisible();
    await visualScreenshot(page, "Instructors can view the student's regrade appeal", {
      stabilizeRubric: "Grading Rubric"
    });
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByLabel("Add Comment", { exact: true })
      .click();
    await expect(page.getByLabel("Grading checks on line 4").filter({ hasText: REGRADE_FINAL_COMMENT })).toBeVisible();
    await expect(region.getByText("Submitting your comment...")).not.toBeVisible();
    await page.getByLabel("Grading checks on line 4").getByRole("button", { name: "Decide Escalation" }).click();
    await page.getByRole("textbox", { name: "Grade adjustment" }).fill("100");
    await expect(page.getByRole("dialog").getByText("This is a significant change")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Close regrade request" }).click();
    // Wait for the regrade status heading to actually flip to "Regrade Closed" before
    // capturing — without this the screenshot races the previous "Regrade Escalated"
    // state, producing 1-in-N visual diffs.
    await expect(page.getByLabel("Grading checks on line 4").getByRole("heading")).toContainText("Regrade Closed");
    // Several updates land asynchronously after the close, in roughly this order:
    //   1. Regrade status heading flips to "Regrade Closed".
    //   2. The check's own +points display updates.
    //   3. The "Grading Review Criteria N/20" sidebar total recomputes.
    //   4. Earlier comments in the regrade discussion stream re-render in the
    //      collapsed-after-close layout (the comment list height can grow ~64px).
    // Wait on each so the screenshot lands in a deterministic visual state.
    await expect(page.locator(`#rubric-${assignment!.grading_rubric_id}`)).toContainText("120.5");
    await expect(region.getByText(REGRADE_COMMENT)).toBeVisible();
    await expect(region.getByText(REGRADE_RESOLUTION)).toBeVisible();
    await expect(region.getByText(REGRADE_ESCALATION)).toBeVisible();
    await expect(region.getByText(REGRADE_FINAL_COMMENT)).toBeVisible();
    await visualScreenshot(page, "Instructors can close the regrade request", { stabilizeRubric: "Grading Rubric" });
  });
  test("Graders assigned to a rubric part see just that rubric part to grade", async ({ page }) => {
    // Earlier test releases all submission reviews on this assignment; second submission gets released too,
    // which blocks TA grading. Unrelease only this review so the grader can apply marks for E2E.
    const { error } = await supabase
      .from("submission_reviews")
      .update({ released: false })
      .eq("id", submission2_grading_review_id!);
    if (error) {
      throw new Error(`Failed to unrelease grading review for submission 2 (grader test): ${error.message}`);
    }

    await loginAsUser(page, grader!, course);
    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id2}/files`);

    await expect(page.getByText("(on Grading Review Part 2)")).toBeVisible();
    await expect(page.getByText("Grading Review Part 1")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "View + Grade Full Rubric" })).toBeVisible();

    await expect(page.getByText("public static void main(")).toBeVisible();

    //Scroll grading rubric to top of its container
    await stabilizeRubricSidebar(page, "Grading Rubric");
    await visualScreenshot(page, "Graders assigned to a rubric part see just that rubric part to grade", {
      stabilizeRubric: "Grading Rubric"
    });
    await page.getByText("Third check for grading review").click();

    await clickWithTextboxRetry(
      page,
      page.getByLabel("Grading Review Check 3 (+10)"),
      page.getByRole("textbox", { name: "Optional: comment on check Grading Review Check 3" })
    );
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page
      .getByRole("textbox", { name: "Optional: comment on check Grading Review Check 3" })
      .fill(GRADING_REVIEW_COMMENT_3);
    await page.getByRole("button", { name: "Add Check" }).click();

    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Complete Review Assignment" }).click();
    await page.getByRole("button", { name: "Mark Review Assignment as" }).click();
  });
});
