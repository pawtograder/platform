import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { expect, test } from "../global-setup";
import { addDays } from "date-fns";
import { createClass, createUsersInClass, insertAssignment, loginAsUser, supabase, TestingUser } from "./TestingUtils";

let course: Course;
let assignment: Assignment;
let student: TestingUser;
let instructor: TestingUser;

test.setTimeout(120_000);

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "Commit History Student",
      public_profile_name: "Commit History Pseudonym Student",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Commit History Instructor",
      public_profile_name: "Commit History Pseudonym Instructor",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Commit History Assignment"
  });
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test("instructors can view commits and request grading for a selected commit", async ({ page }) => {
  const repositoryName = `pawtograder-playground/e2e-ignore-commit-history-${Date.now()}`;
  const recordedSha = "1111111111111111111111111111111111111111";
  const githubOnlySha = "2222222222222222222222222222222222222222";

  const { data: repository, error: repositoryError } = await supabase
    .from("repositories")
    .insert({
      assignment_id: assignment.id,
      repository: repositoryName,
      class_id: course.id,
      profile_id: student.private_profile_id,
      synced_handout_sha: "handout-sha",
      is_github_ready: true
    })
    .select("id")
    .single();
  expect(repositoryError).toBeNull();
  expect(repository?.id).toBeTruthy();

  const { data: checkRun, error: checkRunError } = await supabase
    .from("repository_check_runs")
    .insert({
      class_id: course.id,
      repository_id: repository!.id,
      check_run_id: null,
      status: {
        commit_author: "Recorded Author",
        commit_date: "2026-05-17T18:00:00.000Z",
        workflow_triggered_at: "2026-05-17T18:01:00.000Z"
      },
      sha: recordedSha,
      commit_message: "Recorded webhook commit"
    })
    .select("id")
    .single();
  expect(checkRunError).toBeNull();
  expect(checkRun?.id).toBeTruthy();

  const { data: submission, error: submissionError } = await supabase
    .from("submissions")
    .insert({
      assignment_id: assignment.id,
      profile_id: student.private_profile_id,
      sha: recordedSha,
      repository: repositoryName,
      run_attempt: 1,
      run_number: 1,
      class_id: course.id,
      repository_check_run_id: checkRun!.id,
      repository_id: repository!.id,
      is_active: true
    })
    .select("id")
    .single();
  expect(submissionError).toBeNull();
  expect(submission?.id).toBeTruthy();

  const { error: graderResultError } = await supabase.from("grader_results").insert({
    submission_id: submission!.id,
    score: 8,
    max_score: 10,
    class_id: course.id,
    profile_id: student.private_profile_id,
    lint_passed: true,
    lint_output: "",
    lint_output_format: "text"
  });
  expect(graderResultError).toBeNull();

  await page.route("**/functions/v1/repository-list-commits", async (route) => {
    const body = route.request().postDataJSON() as { course_id: number; repo_name: string; page: number };
    expect(body).toMatchObject({ course_id: course.id, repo_name: repositoryName, page: 1 });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        commits: [
          {
            sha: githubOnlySha,
            html_url: `https://github.com/${repositoryName}/commit/${githubOnlySha}`,
            commit: {
              message: "GitHub-only late work\n\nDetailed body",
              author: { name: "GitHub Author", date: "2026-05-18T18:00:00.000Z" },
              committer: { name: "GitHub Committer", date: "2026-05-18T18:00:00.000Z" }
            }
          }
        ],
        has_more: false
      })
    });
  });

  let triggerPayload: { repository?: string; sha?: string; class_id?: number } | undefined;
  await page.route("**/functions/v1/autograder-trigger-grading-workflow", async (route) => {
    triggerPayload = route.request().postDataJSON() as { repository: string; sha: string; class_id: number };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "Workflow triggered", repository_check_run_id: checkRun!.id })
    });
  });

  await loginAsUser(page, instructor, course);
  await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/repositories`);

  const repositoryRow = page.getByRole("row").filter({ hasText: repositoryName });
  await expect(repositoryRow).toBeVisible();
  await repositoryRow.getByRole("button", { name: "Commit History" }).click();

  const dialog = page.getByRole("dialog", { name: "Commit History" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Commit date/time")).toBeVisible();
  await expect(dialog.getByText("Recorded webhook commit")).toBeVisible();
  await expect(dialog.getByText("Recorded Author")).toBeVisible();
  await expect(dialog.getByText("#")).toBeVisible();
  await expect(dialog.getByText("GitHub-only late work")).toBeVisible();
  await expect(dialog.getByText("GitHub Author")).toBeVisible();

  const githubOnlyRow = dialog.getByRole("row").filter({ hasText: "GitHub-only late work" });
  await githubOnlyRow.getByRole("button", { name: "Trigger grading" }).click();
  await page.getByRole("button", { name: "Confirm action" }).last().click();

  await expect
    .poll(() => triggerPayload, { timeout: 5000 })
    .toMatchObject({ repository: repositoryName, sha: githubOnlySha, class_id: course.id });
  await expect(page.getByText("Grading workflow triggered")).toBeAttached();
});
