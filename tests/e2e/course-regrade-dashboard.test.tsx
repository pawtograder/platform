import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createRegradeRequest,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local" });

const ASSIGN_A_TITLE = "Course Regrade Dashboard A";
const ASSIGN_B_TITLE = "Course Regrade Dashboard B";

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let assignmentA: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let assignmentB: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;

test.beforeAll(async () => {
  course = await createClass({ name: "E2E Course Regrade Dashboard Class" });
  [student, instructor] = await createUsersInClass([
    {
      name: "Course Regrade Dash Student",
      email: "course-regrade-dash-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Course Regrade Dash Instructor",
      email: "course-regrade-dash-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  assignmentA = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: ASSIGN_A_TITLE,
    assignment_slug: `e2e-regrade-dash-a-${course.id}`
  });
  assignmentB = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: ASSIGN_B_TITLE,
    assignment_slug: `e2e-regrade-dash-b-${course.id}`
  });

  const rubricCheckIdA = assignmentA.rubricChecks[0]!.id;
  const rubricCheckIdB = assignmentB.rubricChecks[0]!.id;

  const subA = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignmentA.id,
    class_id: course.id
  });
  const subB = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignmentB.id,
    class_id: course.id
  });

  await createRegradeRequest(
    subA.submission_id,
    assignmentA.id,
    student!.private_profile_id,
    instructor!.private_profile_id,
    rubricCheckIdA,
    course.id,
    "opened"
  );
  await createRegradeRequest(
    subA.submission_id,
    assignmentA.id,
    student!.private_profile_id,
    instructor!.private_profile_id,
    rubricCheckIdA,
    course.id,
    "resolved",
    { initialPoints: 5, resolvedPoints: 5 }
  );
  await createRegradeRequest(
    subB.submission_id,
    assignmentB.id,
    student!.private_profile_id,
    instructor!.private_profile_id,
    rubricCheckIdB,
    course.id,
    "draft"
  );
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test.describe("Course-wide manage regrade requests", () => {
  test("lists opened requests by default; toggle shows draft and resolved; Open links to files hash", async ({
    page
  }) => {
    test.setTimeout(120_000);
    await loginAsUser(page, instructor!, course);

    await page.goto(`/course/${course.id}/manage/regrade-requests`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "All regrade requests" })).toBeVisible();

    const dataRows = page.locator("table tbody tr");
    await expect(dataRows).toHaveCount(1);
    const onlyRow = dataRows.first();
    await expect(onlyRow).toContainText("Pending");
    await expect(onlyRow).toContainText(ASSIGN_A_TITLE);
    await expect(onlyRow.getByText(ASSIGN_B_TITLE)).toHaveCount(0);

    const hideCheckbox = page.getByRole("checkbox", { name: /Hide draft and resolved/i });
    await expect(hideCheckbox).toBeChecked();
    // Click the visible label (Chakra positions the native input off-screen).
    await page.getByText("Hide draft and resolved", { exact: true }).click();
    await expect(hideCheckbox).not.toBeChecked();
    await expect(dataRows).toHaveCount(3);

    const openedRow = page.getByRole("row").filter({ hasText: ASSIGN_A_TITLE }).filter({ hasText: "Pending" });
    const openLink = openedRow.getByRole("link", { name: "Open" });
    await expect(openLink).toBeVisible();
    await expect(openLink).toHaveAttribute(
      "href",
      new RegExp(`/course/${course.id}/assignments/${assignmentA!.id}/submissions/\\d+/files#regrade-request-\\d+$`)
    );
  });
});
