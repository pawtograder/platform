import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { createManualSubmission } from "@/lib/edgeFunctions";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createAuthenticatedClient,
  createUsersInClass,
  createClass,
  insertAssignment,
  loginAsUser,
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

type AssignmentWithRubric = Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] };

// Regression coverage for #944: a no-submission assignment's Files and Autograder Detail tabs
// must stay hidden, and whatever route the browser lands on must render the real editable rubric
// (not the read-only Grade ledger, and not an empty Files panel from a stale link).
test.describe("No-submission assignment grading UI", () => {
  let course: Course;
  let instructor: TestingUser;
  let student: TestingUser;
  let assignment: AssignmentWithRubric;
  let submissionId: number;

  test.beforeAll(async () => {
    course = await createClass({ name: `No-Submission Grading UI ${Date.now()}` });
    [instructor, student] = await createUsersInClass([
      {
        name: "No-Sub UI Instructor",
        public_profile_name: "No-Sub UI Pseudonym Instructor",
        email: `no-sub-ui-instructor-${Date.now()}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "No-Sub UI Student",
        public_profile_name: "No-Sub UI Pseudonym Student",
        email: `no-sub-ui-student-${Date.now()}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    assignment = await insertAssignment({
      due_date: addDays(new Date(), 7).toUTCString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      class_id: course.id,
      name: `No-Submission UI Test ${Date.now()}`,
      repo_mode: "no_submission"
    });

    const instructorClient = await createAuthenticatedClient(instructor);
    submissionId = await createManualSubmission(
      { assignment_id: assignment.id, profile_id: student.private_profile_id },
      instructorClient
    );
  });

  test("root submission URL redirects to Grade, with Files/Autograder Detail hidden and the real rubric rendered", async ({
    page
  }) => {
    await loginAsUser(page, instructor, course);

    await page.goto(`/course/${course.id}/assignments/${assignment.id}/submissions/${submissionId}`);

    await expect(page).toHaveURL(/\/grade(?:\?.*)?$/, { timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Grade", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Autograder Detail" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Files", exact: true })).toHaveCount(0);

    // The real, editable rubric (not the read-only Grade ledger) must be what's showing: it carries
    // both the auto-generated check names (insertAssignment's grading rubric checks are named
    // "Grading Review Check N" — its self-review checks come first in rubricChecks, so match by
    // name rather than assuming array order) and the grader-facing "Submission Review Actions" controls.
    const rubricSidebar = page.locator(`#rubric-${assignment.grading_rubric_id}`);
    await expect(rubricSidebar).toBeVisible();
    await expect(rubricSidebar).toContainText("Grading Review Check 1");
    await expect(page.getByRole("heading", { name: "Submission Review Actions" })).toBeVisible();
  });

  test("a stale /files URL still renders the real rubric, not an empty Files panel", async ({ page }) => {
    await loginAsUser(page, instructor, course);

    // Simulates a grader arriving via a link built before this assignment's tabs were hidden (e.g.
    // "next incomplete review" navigation), which still points at /files.
    await page.goto(`/course/${course.id}/assignments/${assignment.id}/submissions/${submissionId}/files`);

    const rubricSidebar = page.locator(`#rubric-${assignment.grading_rubric_id}`);
    await expect(rubricSidebar).toBeVisible();
    await expect(rubricSidebar).toContainText("Grading Review Check 1");
    await expect(page.getByRole("heading", { name: "Submission Review Actions" })).toBeVisible();
  });

  test("the staff grading route stays put and renders the real rubric for a no-submission assignment", async ({
    page
  }) => {
    await loginAsUser(page, instructor, course);

    // The staff-prefixed route has no "/grade" sub-page (appending one 404s), so the layout skips
    // its canonicalizing redirect here and renders the rubric on the submission root itself.
    const staffSubmissionPath = `/course/${course.id}/grade/assignments/${assignment.id}/submissions/${submissionId}`;
    await page.goto(staffSubmissionPath);

    // Wait for the rubric first: once it renders, the layout has hydrated, so any redirect effect
    // would already have fired and the URL check below is meaningful.
    const rubricSidebar = page.locator(`#rubric-${assignment.grading_rubric_id}`);
    await expect(rubricSidebar).toBeVisible();
    await expect(rubricSidebar).toContainText("Grading Review Check 1");
    await expect(page.getByRole("heading", { name: "Submission Review Actions" })).toBeVisible();

    await expect(page).toHaveURL(new RegExp(`${staffSubmissionPath}(?:\\?.*)?$`));
    await expect(page.getByRole("link", { name: "Grade", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "Autograder Detail" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Files", exact: true })).toHaveCount(0);
  });
});
