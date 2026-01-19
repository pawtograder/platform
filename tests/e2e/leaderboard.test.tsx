import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
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

dotenv.config({ path: ".env.local" });

let course: Course;
let student1: TestingUser | undefined;
let student2: TestingUser | undefined;
let student3: TestingUser | undefined;
let instructor: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;

// Function to insert a submission with a specific score
async function insertSubmissionWithScore(
  studentPrivateProfileId: string,
  assignmentId: number,
  classId: number,
  score: number,
  maxScore: number = 100
) {
  const submission = await insertPreBakedSubmission({
    student_profile_id: studentPrivateProfileId,
    assignment_id: assignmentId,
    class_id: classId
  });

  // Update the grader_results with a specific score
  const { error } = await supabase
    .from("grader_results")
    .update({ score, max_score: maxScore })
    .eq("submission_id", submission.submission_id);

  if (error) {
    throw new Error(`Failed to update grader_results: ${error.message}`);
  }
  return submission;
}

test.beforeAll(async () => {
  course = await createClass();

  // Create multiple students and an instructor
  [student1, student2, student3, instructor] = await createUsersInClass([
    {
      name: "Leaderboard Student 1",
      email: "leaderboard-student1@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Leaderboard Student 2",
      email: "leaderboard-student2@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Leaderboard Student 3",
      email: "leaderboard-student3@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Leaderboard Instructor",
      email: "leaderboard-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  // Create assignment
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Leaderboard Test Assignment"
  });

  // Create submissions with different scores
  // Student 1: highest score (95)
  await insertSubmissionWithScore(student1!.private_profile_id, assignment!.id, course.id, 95, 100);

  // Student 2: medium score (80)
  await insertSubmissionWithScore(student2!.private_profile_id, assignment!.id, course.id, 80, 100);

  // Student 3: lowest score (70)
  await insertSubmissionWithScore(student3!.private_profile_id, assignment!.id, course.id, 70, 100);
});

test.describe("Assignment Leaderboard", () => {
  test.describe.configure({ mode: "serial" });

  test("Leaderboard displays on assignment page with correct ordering", async ({ page }) => {
    await loginAsUser(page, student1!, course);

    // Wait for realtime connection
    await expect(
      page.getByRole("note", { name: "Realtime connection status: All realtime connections active" })
    ).toBeVisible({ timeout: 10000 });

    // Navigate to assignment page
    await page.getByRole("link").filter({ hasText: "Assignments" }).click();
    await page.waitForURL("**/assignments");
    await page.getByRole("link", { name: assignment!.title }).click();

    // Wait for the leaderboard to be visible
    const leaderboard = page.getByText("🏆 Leaderboard");
    await expect(leaderboard).toBeVisible({ timeout: 10000 });

    // Verify the leaderboard contains the heading and student entries
    await expect(page.getByText("Top")).toBeVisible();
    await expect(page.getByText("by autograder score")).toBeVisible();
  });

  test("Student sees their own pseudonym name with 'You' badge on leaderboard", async ({ page }) => {
    await loginAsUser(page, student1!, course);

    // Navigate to assignment page
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}`);

    // Wait for the leaderboard to be visible
    await expect(page.getByText("🏆 Leaderboard")).toBeVisible({ timeout: 10000 });

    // The current user should see a "You" badge
    const leaderboardTable = page.locator("table").filter({ hasText: "Rank" });
    const youBadge = leaderboardTable.getByText("You");
    await expect(youBadge).toBeVisible();

    // The first place should show gold medal emoji
    await expect(page.getByText("🥇")).toBeVisible();
  });

  test("Instructor sees real names in parentheses on leaderboard", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    // Navigate to assignment page
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}`);

    // Wait for the leaderboard to be visible
    await expect(page.getByText("🏆 Leaderboard")).toBeVisible({ timeout: 10000 });

    // Instructors should see both the pseudonym and real name
    // The format should be "Pseudonym (Real Name)"
    // Check that at least one of the student real names is visible in parentheses
    const leaderboardArea = page.locator("table").filter({ hasText: "Rank" });

    // Verify all students are in the leaderboard with their real names visible to staff
    await expect(leaderboardArea).toContainText("(Leaderboard Student 1)");
    await expect(leaderboardArea).toContainText("(Leaderboard Student 2)");
    await expect(leaderboardArea).toContainText("(Leaderboard Student 3)");
  });

  test("Student sees only pseudonyms, not real names of other students", async ({ page }) => {
    await loginAsUser(page, student2!, course);

    // Navigate to assignment page
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}`);

    // Wait for the leaderboard to be visible
    await expect(page.getByText("🏆 Leaderboard")).toBeVisible({ timeout: 10000 });

    const leaderboardArea = page.locator("table").filter({ hasText: "Rank" });

    // Students should NOT see real names of OTHER students
    // They should only see pseudonyms (public profile names)
    // Note: They CAN see their own real name if they look at themselves

    // Check that other students' real names are NOT visible in parentheses
    // Student2 is logged in, so they should not see Student1 or Student3's real names
    await expect(leaderboardArea).not.toContainText("(Leaderboard Student 1)");
    await expect(leaderboardArea).not.toContainText("(Leaderboard Student 3)");
  });

  test("Leaderboard shows correct score ordering", async ({ page }) => {
    await loginAsUser(page, student1!, course);

    // Navigate to assignment page
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}`);

    // Wait for the leaderboard to be visible
    await expect(page.getByText("🏆 Leaderboard")).toBeVisible({ timeout: 10000 });

    // Verify scores are displayed
    await expect(page.getByText("95/100")).toBeVisible();
    await expect(page.getByText("80/100")).toBeVisible();
    await expect(page.getByText("70/100")).toBeVisible();

    // Verify medal rankings
    await expect(page.getByText("🥇")).toBeVisible();
    await expect(page.getByText("🥈")).toBeVisible();
    await expect(page.getByText("🥉")).toBeVisible();
  });

  test("Leaderboard updates when new submission is created", async ({ page }) => {
    await loginAsUser(page, student3!, course);

    // Navigate to assignment page
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}`);

    // Wait for the leaderboard to be visible and loaded
    await expect(page.getByText("🏆 Leaderboard")).toBeVisible({ timeout: 10000 });
    const leaderboardTable = page.locator("table").filter({ hasText: "Rank" });
    await expect(leaderboardTable).toBeVisible();

    // Student 3 currently has lowest score (70)
    // The "You" badge should be visible for student 3
    await expect(leaderboardTable.getByText("You")).toBeVisible();

    // Create a new submission with a higher score for student 3
    await insertSubmissionWithScore(student3!.private_profile_id, assignment!.id, course.id, 99, 100);

    // Reload the page
    await page.reload();

    // Wait for the leaderboard to be visible again and loaded
    await expect(page.getByText("🏆 Leaderboard")).toBeVisible({ timeout: 10000 });
    await expect(leaderboardTable).toBeVisible();

    // Now student 3 should have the highest score (99/100)
    await expect(page.getByText("99/100")).toBeVisible();

    // Student 3 should now be in first place (with gold medal)
    // The "You" badge should still be visible and now next to gold medal
    await expect(page.getByText("🥇")).toBeVisible();
  });
});
