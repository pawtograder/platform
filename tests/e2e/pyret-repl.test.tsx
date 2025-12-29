import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  loginAsUser,
  supabase,
  TestingUser,
  getTestRunPrefix
} from "./TestingUtils";

let course: Course;
let student: TestingUser;
let instructor: TestingUser;
let assignment: Assignment;
let submission_id: number;

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "Pyret REPL Student",
      email: "pyret-repl-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Pyret REPL Instructor",
      email: "pyret-repl-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Pyret REPL Assignment"
  });

  submission_id = await insertPyretSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id
  });
});

async function insertPyretSubmission({
  student_profile_id,
  assignment_id,
  class_id
}: {
  student_profile_id: string;
  assignment_id: number;
  class_id: number;
}): Promise<number> {
  const test_run_prefix = getTestRunPrefix();
  const repository = `not-actually/pyret-repository-${test_run_prefix}`;

  const { data: repositoryData, error: repositoryError } = await supabase
    .from("repositories")
    .insert({
      assignment_id: assignment_id,
      repository: repository,
      class_id: class_id,
      profile_id: student_profile_id,
      synced_handout_sha: "none"
    })
    .select("id")
    .single();

  if (repositoryError) {
    throw new Error(`Failed to create repository: ${repositoryError.message}`);
  }
  if (!repositoryData?.id) {
    throw new Error("Failed to create repository: No repository ID returned");
  }
  const repository_id = repositoryData.id;

  const { data: checkRunData, error: checkRunError } = await supabase
    .from("repository_check_runs")
    .insert({
      class_id: class_id,
      repository_id: repository_id,
      check_run_id: 1,
      status: "{}",
      sha: "abc123",
      commit_message: "Test pyret submission"
    })
    .select("id")
    .single();

  if (checkRunError) {
    throw new Error("Failed to create check run");
  }
  if (!checkRunData?.id) {
    throw new Error("Failed to create check run: No check run ID returned");
  }
  const check_run_id = checkRunData.id;

  const { data: submissionData, error: submissionError } = await supabase
    .from("submissions")
    .insert({
      assignment_id: assignment_id,
      profile_id: student_profile_id,
      sha: "abc123",
      repository: repository,
      run_attempt: 1,
      run_number: 1,
      class_id: class_id,
      repository_check_run_id: check_run_id,
      repository_id: repository_id
    })
    .select("*")
    .single();

  if (submissionError) {
    throw new Error("Failed to create submission");
  }
  if (!submissionData?.id) {
    throw new Error("Failed to create submission: No submission ID returned");
  }
  const submission_id = submissionData.id;

  const { data: submissionFileData, error: submissionFileError } = await supabase.from("submission_files").insert({
    name: "submission.arr",
    contents: `use context dcic2024
fun double(n):
  n * 2
where:
  double(5) is 10
  double(0) is 0
  double(-3) is -6
end`,
    class_id: class_id,
    submission_id: submission_id,
    profile_id: student_profile_id
  });

  if (submissionFileError) {
    throw new Error(
      `Failed to create submission file for submission ${submission_id} in class ${class_id}: ${submissionFileError.message}`
    );
  }

  const { data: graderResultData, error: graderResultError } = await supabase
    .from("grader_results")
    .insert({
      submission_id: submission_id,
      score: 8,
      class_id: class_id,
      profile_id: student_profile_id,
      lint_passed: true,
      lint_output: "All style checks passed!",
      lint_output_format: "text",
      max_score: 10
    })
    .select("id")
    .single();

  if (graderResultError) {
    throw new Error("Failed to create grader result");
  }
  if (!graderResultData?.id) {
    throw new Error("Failed to create grader result: No grader result ID returned");
  }

  await supabase.from("grader_result_tests").insert([
    {
      score: 5,
      max_score: 5,
      name: "Basic Function Test",
      name_format: "text",
      output: "All tests passed! Your `double` function works correctly.",
      output_format: "markdown",
      class_id: class_id,
      student_id: student_profile_id,
      grader_result_id: graderResultData.id,
      is_released: true,
      extra_data: {
        pyret_repl: {
          initial_code:
            "use context dcic2024\n# Test your double function here\nfun double(n):\n  n * 2\nwhere:\n  double(5) is 10\n  double(0) is 0\nend",
          initial_interactions: ["double(5)", "double(10)", "double(-3)"],
          repl_contents: "Ready to test your code!"
        }
      }
    },
    {
      score: 3,
      max_score: 5,
      name: "Advanced Challenge",
      name_format: "text",
      output: "Partial credit: Your solution works for some cases but needs improvement for edge cases.",
      output_format: "markdown",
      class_id: class_id,
      student_id: student_profile_id,
      grader_result_id: graderResultData.id,
      is_released: true,
      extra_data: {
        pyret_repl: {
          initial_code:
            "use context dcic2024\n# Advanced challenge code\nfun process-list(lst):\n  # Your implementation here\n  lst\nwhere:\n  process-list([list: 1, 2, 3]) is [list: 1, 2, 3]\n  process-list([list:]) is [list:]\nend",
          initial_interactions: ["process-list([list: 1, 2, 3])", "process-list([list:])"]
        }
      }
    },
    {
      score: 0,
      max_score: 3,
      name: "Hidden Test (Instructor Only)",
      name_format: "text",
      output: "This test checks internal implementation details.",
      output_format: "text",
      class_id: class_id,
      student_id: student_profile_id,
      grader_result_id: graderResultData.id,
      is_released: false
    }
  ]);

  const { data: hiddenTestData } = await supabase
    .from("grader_result_tests")
    .select("id")
    .eq("grader_result_id", graderResultData.id)
    .eq("is_released", false)
    .single();

  if (hiddenTestData) {
    await supabase.from("grader_result_test_output").insert({
      grader_result_test_id: hiddenTestData.id,
      output: "Debug information: Function calls traced successfully. Memory usage within limits.",
      output_format: "text",
      class_id: class_id,
      student_id: student_profile_id,
      extra_data: {
        pyret_repl: {
          initial_code:
            "use context dcic2024\n# Debug REPL for instructors\n# This contains sensitive test information\nfun debug-trace(f):\n  # Debug implementation\n  f\nwhere:\n  debug-trace(double) is double\nend",
          initial_interactions: ["debug-trace(double)", "# Check memory usage"],
          repl_contents: "Instructor debug session ready"
        }
      }
    });
  }

  return submission_id;
}

test.describe("Pyret REPL Integration", () => {
  test("Student can view and interact with Pyret REPL in test results", async ({ page }) => {
    await loginAsUser(page, student, course);

    const resultsPage = `/course/${course.id}/assignments/${assignment.id}/submissions/${submission_id}/results`;
    await page.goto(resultsPage);

    await expect(page.getByRole("tab", { name: "Test Results" })).toBeVisible();
    await expect(page.getByRole("tabpanel").getByRole("link", { name: "Basic Function Test" })).toBeVisible();
    await expect(page.getByRole("tabpanel").getByRole("link", { name: "Advanced Challenge" })).toBeVisible();
    await expect(
      page.getByRole("tabpanel").getByRole("link", { name: "Hidden Test (Instructor Only)" })
    ).not.toBeVisible();

    await page.waitForLoadState("networkidle");

    const replToggle = page.getByRole("button", { name: /Interactive Pyret REPL/i }).first();
    await expect(replToggle).toBeVisible();
    await replToggle.click();

    await expect(page.getByText("Initializing REPL...")).toBeVisible();
    await page.waitForTimeout(3000);

    const replContainer = page.locator('[id^="pyret-repl-region-"]');
    await expect(replContainer).toBeVisible();

    await page.waitForFunction(() => {
      const replElement = document.querySelector('[id^="pyret-repl-region-"]');
      return replElement && replElement.children.length > 0;
    });

    await expect(
      page.getByText("Partial credit: Your solution works for some cases but needs improvement for edge cases.")
    ).toBeVisible();

    await replToggle.click();
    await expect(replContainer).not.toBeVisible();

    const secondReplToggle = page.getByRole("button", { name: /Interactive Pyret REPL/i }).nth(1);
    await secondReplToggle.click();
    await page.waitForTimeout(3000);

    const newReplContainer = page.locator('[id^="pyret-repl-region-"]').first();
    await expect(newReplContainer).toBeVisible();

    await page.waitForFunction(() => {
      const replElement = document.querySelector('[id^="pyret-repl-region-"]');
      return replElement && replElement.children.length > 0;
    });

  });

  test("Instructor can view both student and instructor-only Pyret REPLs", async ({ page }) => {
    await loginAsUser(page, instructor, course);

    const resultsPage = `/course/${course.id}/assignments/${assignment.id}/submissions/${submission_id}/results`;
    await page.goto(resultsPage);

    await expect(page.getByRole("tab", { name: "Test Results" })).toBeVisible();

    const instructorSwitch = page.getByRole("switch", { name: "Instructor View" });
    if (await instructorSwitch.isVisible()) {
      await instructorSwitch.click();
    }

    await expect(page.getByRole("tabpanel").getByRole("link", { name: "Hidden Test (Instructor Only)" })).toBeVisible();
    await page.waitForLoadState("networkidle");

    const instructorReplToggle = page.getByRole("button", { name: /Instructor-Only.*Interactive Pyret REPL/i });

    if ((await instructorReplToggle.count()) > 0) {
      await instructorReplToggle.first().click();
      await page.waitForTimeout(3000);

      await page.waitForFunction(() => {
        const replElement = document.querySelector('[id^="pyret-repl-region-"]');
        return replElement && replElement.children.length > 0;
      });

    }

    const studentReplToggles = page
      .getByRole("button", { name: /Interactive Pyret REPL/i })
      .and(page.locator(':not(:has-text("Instructor-Only"))'));
    await expect(studentReplToggles.first()).toBeVisible();
  });

  test("Pyret REPL handles loading errors gracefully", async ({ page }) => {
    await loginAsUser(page, student, course);

    const resultsPage = `/course/${course.id}/assignments/${assignment.id}/submissions/${submission_id}/results`;
    await page.goto(resultsPage);

    const replToggle = page.getByRole("button", { name: /Interactive Pyret REPL/i }).first();
    await replToggle.click();

    await page.waitForTimeout(10000);

    const hasLoadedSuccessfully = await page.locator('[id^="pyret-repl-region-"]').isVisible();
    const hasErrorMessage = await page.getByText(/Failed to load REPL|Error loading/i).isVisible();

    expect(hasLoadedSuccessfully || hasErrorMessage).toBeTruthy();

    if (hasErrorMessage) {
      await replToggle.click();
      await replToggle.click();
      await page.waitForTimeout(5000);
      await page.waitForLoadState("networkidle");
    }
  });

  test("Multiple Pyret REPLs can be opened simultaneously", async ({ page }) => {
    await loginAsUser(page, student, course);

    const resultsPage = `/course/${course.id}/assignments/${assignment.id}/submissions/${submission_id}/results`;
    await page.goto(resultsPage);

    const replToggles = page.getByRole("button", { name: /Interactive Pyret REPL/i });
    const toggleCount = await replToggles.count();
    const expectedOpenReplCount = Math.min(toggleCount, 2);

    const replContainers = page.locator('[id^="pyret-repl-region-"]');

    for (let i = 0; i < expectedOpenReplCount; i++) {
      await replToggles.nth(i).click();
      await expect(replContainers.nth(i)).toBeVisible();
    }

    await expect(replContainers.filter({ hasText: /./ }).or(replContainers)).toHaveCount(expectedOpenReplCount);

    const visibleCount = await replContainers.count();
    expect(visibleCount).toBeGreaterThanOrEqual(expectedOpenReplCount);

    await page.waitForFunction((expectedCount) => {
      const replElements = document.querySelectorAll('[id^="pyret-repl-region-"]');
      let loadedCount = 0;
      for (let i = 0; i < Math.min(replElements.length, expectedCount); i++) {
        if (replElements[i].children.length > 0) {
          loadedCount++;
        }
      }
      return loadedCount >= expectedCount;
    }, expectedOpenReplCount);

  });
});
