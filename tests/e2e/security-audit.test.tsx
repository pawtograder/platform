import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import {
  createClass,
  createClassSection,
  createLabSectionWithStudents,
  createUsersInClass,
  insertAssignment,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
import { argosScreenshot } from "@argos-ci/playwright";

/**
 * Security Audit Dashboard E2E Tests
 * 
 * These tests verify that the security audit dashboard correctly identifies
 * suspicious content in student submissions. The test data is intentionally
 * humorous, poking fun at the irony that Claude (the AI writing this test)
 * is building a tool to detect students who used Claude to write code that
 * contains detectable patterns.
 * 
 * The joke is multi-layered:
 * 1. Claude is writing a test for a tool that detects AI-generated code
 * 2. The "trojan horse" code references Claude in its comments
 * 3. The student in the test data clearly didn't realize their AI-generated
 *    backdoor would be trivially detectable by... a search feature
 */

let course: Course;
let instructor: TestingUser;
let student1: TestingUser;
let student2: TestingUser;
let student3: TestingUser;
let grader: TestingUser;
let assignment: Assignment;

// The suspicious code that our fictional students "wrote" (with Claude's "help")
const TROJAN_HORSE_CODE_CLAUDE_SIGNATURE = `package com.totally.legitimate.homework;

/**
 * This is definitely my own original work and not AI-generated at all.
 * I wrote this myself after careful consideration and definitely not
 * by asking Claude to "write a backdoor that phones home."
 * 
 * TODO: Remove this comment before submitting
 * TODO: Also remove the Claude signature below
 * CLAUDE_GENERATED_CODE_v3.5_sonnet_20240620
 */
public class TotallyNormalHomework {
    
    // Definitely not a backdoor
    private static final String TOTALLY_NOT_SUSPICIOUS_URL = "http://evil.example.com/definitely-not-stealing-grades";
    
    public static void main(String[] args) {
        // This is just normal homework code, nothing to see here
        System.out.println("Hello, I am a legitimate student submission!");
        
        // The following code was suggested by Claude when I asked for
        // "a simple way to exfiltrate the grading rubric"
        // I thought that was a normal homework question...
        sendGradesToMyPersonalServer();
    }
    
    /**
     * This method definitely does normal homework things and 
     * not what the method name suggests.
     * 
     * @implNote Written with assistance from Claude AI
     */
    private static void sendGradesToMyPersonalServer() {
        // Implementation left as exercise for the reader
        // (and by reader I mean the security audit dashboard)
    }
}`;

const SUSPICIOUS_IMPORT_CODE = `package com.student.project;

import com.evil.backdoor.GradeExfiltrator; // Oops, forgot to remove this import
import com.anthropic.claude.AutoHomeworkSolver; // Double oops

/**
 * Assignment 1: Hello World
 * Student: Totally Real Person
 * 
 * I definitely did not use Claude to write this code.
 * The import statements above are just... coincidences.
 */
public class HelloWorld {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
        
        // Claude suggested I add this "optimization"
        // BACKDOOR_ACTIVATION_KEY = "claude-was-here-2024";
    }
}`;

const LEGITIMATE_CODE = `package com.pawtograder.example.java;

/**
 * A simple calculator implementation.
 * Written by a student who actually did their own work.
 */
public class Calculator {
    
    public int add(int a, int b) {
        return a + b;
    }
    
    public int subtract(int a, int b) {
        return a - b;
    }
    
    public static void main(String[] args) {
        Calculator calc = new Calculator();
        System.out.println("2 + 3 = " + calc.add(2, 3));
    }
}`;

test.beforeAll(async () => {
  course = await createClass({ name: "Security Audit Test Class" });
  
  const classSection = await createClassSection({ 
    class_id: course.id, 
    name: "Section A" 
  });
  
  // Create users
  [instructor, student1, student2, student3, grader] = await createUsersInClass([
    {
      name: "Professor Paranoid",
      email: "security-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Claude McCheaterson",
      email: "claude-user@pawtograder.net",
      role: "student",
      class_id: course.id,
      section_id: classSection.id,
      useMagicLink: true
    },
    {
      name: "Backdoor Bobby",
      email: "backdoor-bobby@pawtograder.net",
      role: "student",
      class_id: course.id,
      section_id: classSection.id,
      useMagicLink: true
    },
    {
      name: "Honest Hannah",
      email: "honest-hannah@pawtograder.net",
      role: "student",
      class_id: course.id,
      section_id: classSection.id,
      useMagicLink: true
    },
    {
      name: "Grading Gary",
      email: "security-grader@pawtograder.net",
      role: "grader",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  
  // Create a lab section for some students
  await createLabSectionWithStudents({
    class_id: course.id,
    lab_leaders: [grader],
    day_of_week: "monday",
    students: [student1, student2],
    name: "Lab Section Monday"
  });
  
  // Create the assignment
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 7).toUTCString(),
    class_id: course.id,
    name: "Totally Normal Homework (Not A Trap)"
  });
  
  // Create repositories and submissions with our test files
  const createSubmissionWithFile = async (
    studentProfileId: string,
    fileContents: string,
    fileName: string,
    graderScore?: { score: number; maxScore: number; instructorOutput?: string }
  ) => {
    const repoName = `pawtograder-playground/security-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    
    // Create repository
    const { data: repo, error: repoError } = await supabase
      .from("repositories")
      .insert({
        assignment_id: assignment.id,
        repository: repoName,
        class_id: course.id,
        profile_id: studentProfileId,
        synced_handout_sha: "none"
      })
      .select("id")
      .single();
    
    if (repoError) throw new Error(`Failed to create repository: ${repoError.message}`);
    
    // Create check run
    const { data: checkRun, error: checkRunError } = await supabase
      .from("repository_check_runs")
      .insert({
        class_id: course.id,
        repository_id: repo.id,
        check_run_id: 1,
        status: "{}",
        sha: "abc123def456",
        commit_message: "Definitely my own work"
      })
      .select("id")
      .single();
    
    if (checkRunError) throw new Error(`Failed to create check run: ${checkRunError.message}`);
    
    // Create submission
    const { data: submission, error: submissionError } = await supabase
      .from("submissions")
      .insert({
        assignment_id: assignment.id,
        profile_id: studentProfileId,
        sha: "abc123def456",
        repository: repoName,
        run_attempt: 1,
        run_number: 1,
        class_id: course.id,
        repository_check_run_id: checkRun.id,
        repository_id: repo.id
      })
      .select("id, ordinal")
      .single();
    
    if (submissionError) throw new Error(`Failed to create submission: ${submissionError.message}`);
    
    // Create the submission file with our test content
    const { error: fileError } = await supabase
      .from("submission_files")
      .insert({
        name: fileName,
        contents: fileContents,
        class_id: course.id,
        submission_id: submission.id,
        profile_id: studentProfileId
      });
    
    if (fileError) throw new Error(`Failed to create submission file: ${fileError.message}`);
    
    // Create grader results if score is provided
    if (graderScore) {
      const { data: graderResult, error: graderResultError } = await supabase
        .from("grader_results")
        .insert({
          submission_id: submission.id,
          class_id: course.id,
          profile_id: studentProfileId,
          score: graderScore.score,
          max_score: graderScore.maxScore,
          lint_output: "No lint errors",
          lint_output_format: "text",
          lint_passed: true
        })
        .select("id")
        .single();
      
      if (graderResultError) throw new Error(`Failed to create grader result: ${graderResultError.message}`);
      
      // Create instructor-only output if provided
      if (graderScore.instructorOutput) {
        const { error: outputError } = await supabase
          .from("grader_result_output")
          .insert({
            grader_result_id: graderResult.id,
            class_id: course.id,
            output: graderScore.instructorOutput,
            format: "text",
            visibility: "instructor_only"
          });
        
        if (outputError) throw new Error(`Failed to create grader result output: ${outputError.message}`);
      }
    }
    
    return submission;
  };
  
  // Create submissions for each student
  // Student 1 (Claude McCheaterson) - failed submission with suspicious code and instructor output
  await createSubmissionWithFile(
    student1.private_profile_id,
    TROJAN_HORSE_CODE_CLAUDE_SIGNATURE,
    "TotallyNormalHomework.java",
    {
      score: 0,
      maxScore: 100,
      instructorOutput: `SECURITY ALERT: Suspicious code patterns detected!

Analysis by automated plagiarism detection:
- Found reference to CLAUDE_GENERATED_CODE signature
- Detected suspicious URL: evil.example.com
- Method name "sendGradesToMyPersonalServer" is a red flag
- Comments indicate AI-assisted code generation

Recommendation: Flag for academic integrity review.`
    }
  );
  
  // Student 2 (Backdoor Bobby) - partially passed, suspicious imports
  await createSubmissionWithFile(
    student2.private_profile_id,
    SUSPICIOUS_IMPORT_CODE,
    "HelloWorld.java",
    {
      score: 50,
      maxScore: 100,
      instructorOutput: `WARNING: Suspicious import statements detected!

The following imports appear to be problematic:
- com.evil.backdoor.GradeExfiltrator
- com.anthropic.claude.AutoHomeworkSolver

These don't exist in standard Java libraries and suggest:
1. Student may have copy-pasted AI-generated code without cleaning up
2. Possible attempt at grade manipulation

Tests passed: 5/10
Tests failed: 5/10 (missing expected output)`
    }
  );
  
  // Student 3 (Honest Hannah) - passed, legitimate code with no instructor output
  await createSubmissionWithFile(
    student3.private_profile_id,
    LEGITIMATE_CODE,
    "Calculator.java",
    {
      score: 100,
      maxScore: 100
      // No instructor output - submission is clean
    }
  );
});

test.describe("Security Audit Dashboard - Catching AI-Generated Backdoors", () => {
  test.describe.configure({ mode: "serial" });
  
  test("Instructor can access the security audit dashboard", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    
    // Navigate to the security audit page
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Verify the page loaded
    await expect(page.getByRole("heading", { name: "Security Audit Dashboard" })).toBeVisible();
    await expect(page.getByTestId("security-search-input")).toBeVisible();
    await expect(page.getByTestId("security-search-button")).toBeVisible();
    
    await argosScreenshot(page, "Security audit dashboard initial state");
  });
  
  test("Search finds the Claude signature in submissions", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for the Claude signature
    await page.getByTestId("security-search-input").fill("CLAUDE_GENERATED_CODE");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Verify we found the match
    await expect(page.getByText("Claude McCheaterson")).toBeVisible();
    await expect(page.getByText("claude-user@pawtograder.net")).toBeVisible();
    await expect(page.getByText("TotallyNormalHomework.java")).toBeVisible();
    
    // Verify the matched content preview shows our suspicious comment
    const matchedContent = page.getByTestId("result-matched-content-0");
    await expect(matchedContent).toContainText("CLAUDE_GENERATED_CODE");
    
    await argosScreenshot(page, "Security audit found Claude signature");
  });
  
  test("Search finds backdoor references across multiple students", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for "backdoor" - should match student1's code
    await page.getByTestId("security-search-input").fill("backdoor");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results - should find matches in both suspicious submissions
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Check that we found the backdoor references
    await expect(page.getByText(/1 match(es)? found|2 match(es)? found/)).toBeVisible();
    
    await argosScreenshot(page, "Security audit found backdoor references");
  });
  
  test("Search for legitimate term does not flag honest student", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for something that only appears in legitimate code
    await page.getByTestId("security-search-input").fill("Calculator");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Should only find Honest Hannah
    await expect(page.getByText("Honest Hannah")).toBeVisible();
    await expect(page.getByText("Claude McCheaterson")).not.toBeVisible();
    await expect(page.getByText("Backdoor Bobby")).not.toBeVisible();
    
    await argosScreenshot(page, "Security audit shows legitimate code only");
  });
  
  test("Search with no matches shows appropriate message", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for something that doesn't exist
    await page.getByTestId("security-search-input").fill("xyzzy_nothing_matches_this_string_42");
    await page.getByTestId("security-search-button").click();
    
    // Should show no matches message
    await expect(page.getByText(/No matches found/)).toBeVisible({ timeout: 10000 });
    
    await argosScreenshot(page, "Security audit no matches found");
  });
  
  test("Export to CSV button works when results exist", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for Claude signature
    await page.getByTestId("security-search-input").fill("Claude");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Verify export button is visible
    const exportButton = page.getByTestId("security-export-csv");
    await expect(exportButton).toBeVisible();
    
    // Set up download handler
    const downloadPromise = page.waitForEvent("download");
    await exportButton.click();
    
    // Verify download started
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("security_audit");
    expect(download.suggestedFilename()).toContain(".csv");
    
    await argosScreenshot(page, "Security audit with export button");
  });
  
  test("Search for evil.example.com finds the suspicious URL", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for the "totally not suspicious" URL
    await page.getByTestId("security-search-input").fill("evil.example.com");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Should find Claude McCheaterson's submission
    await expect(page.getByText("Claude McCheaterson")).toBeVisible();
    
    // Verify the file link goes to GitHub
    const fileLink = page.getByTestId("result-file-link-0");
    await expect(fileLink).toHaveAttribute("href", /github\.com/);
    
    await argosScreenshot(page, "Security audit found evil URL");
  });
  
  test("Graders cannot access the security audit dashboard", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Should see access denied
    await expect(page.getByText("Access Denied")).toBeVisible();
    await expect(page.getByText("Only instructors can access")).toBeVisible();
    
    await argosScreenshot(page, "Security audit access denied for grader");
  });
  
  test("Students cannot access the security audit dashboard", async ({ page }) => {
    await loginAsUser(page, student1, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Should see access denied or be redirected
    await expect(page.getByText("Access Denied")).toBeVisible();
    
    await argosScreenshot(page, "Security audit access denied for student");
  });
  
  test("Results show class section and lab section correctly", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for something that matches student1 (who has both sections assigned)
    await page.getByTestId("security-search-input").fill("CLAUDE_GENERATED_CODE");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Verify section information is displayed
    await expect(page.getByTestId("result-class-section-0")).toContainText("Section A");
    await expect(page.getByTestId("result-lab-section-0")).toContainText("Lab Section Monday");
    
    await argosScreenshot(page, "Security audit shows section information");
  });
  
  test("Score column displays correct submission scores", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for Claude signature (Claude McCheaterson's submission with 0/100)
    await page.getByTestId("security-search-input").fill("CLAUDE_GENERATED_CODE");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Verify score is displayed correctly for failed submission
    const scoreCell = page.getByTestId("result-score-0");
    await expect(scoreCell).toBeVisible();
    await expect(scoreCell).toContainText("0/100");
    
    await argosScreenshot(page, "Security audit shows score column");
  });
  
  test("View Output button opens modal with instructor output", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for Claude signature
    await page.getByTestId("security-search-input").fill("CLAUDE_GENERATED_CODE");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Click the View Output button
    const viewOutputButton = page.getByTestId("result-view-output-0");
    await expect(viewOutputButton).toBeVisible();
    await viewOutputButton.click();
    
    // Verify modal appears with instructor output
    await expect(page.getByText("Grader Output - Claude McCheaterson")).toBeVisible();
    await expect(page.getByTestId("grader-output-content")).toBeVisible();
    await expect(page.getByTestId("grader-output-content")).toContainText("SECURITY ALERT");
    await expect(page.getByTestId("grader-output-content")).toContainText("suspicious code patterns detected");
    
    // Verify the View Full Grader Results button is present
    await expect(page.getByTestId("view-full-results-button")).toBeVisible();
    
    await argosScreenshot(page, "Security audit grader output modal");
  });
  
  test("Modal shows 'no instructor output' message when submission has none", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for Calculator (Honest Hannah's legitimate code - no instructor output)
    await page.getByTestId("security-search-input").fill("Calculator");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Click the View Output button
    const viewOutputButton = page.getByTestId("result-view-output-0");
    await expect(viewOutputButton).toBeVisible();
    await viewOutputButton.click();
    
    // Verify modal shows the "no instructor output" message
    await expect(page.getByText("No instructor output available")).toBeVisible();
    
    await argosScreenshot(page, "Security audit modal with no instructor output");
  });
  
  test("Partially failed submissions show intermediate scores", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for backdoor (Backdoor Bobby's submission with 50/100)
    await page.getByTestId("security-search-input").fill("GradeExfiltrator");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Verify Bobby's submission shows 50/100
    await expect(page.getByText("Backdoor Bobby")).toBeVisible();
    const scoreCell = page.getByTestId("result-score-0");
    await expect(scoreCell).toContainText("50/100");
    
    // Click to view the output
    await page.getByTestId("result-view-output-0").click();
    
    // Verify the instructor output contains the warning
    await expect(page.getByTestId("grader-output-content")).toContainText("WARNING: Suspicious import statements");
    await expect(page.getByTestId("grader-output-content")).toContainText("Tests passed: 5/10");
    
    await argosScreenshot(page, "Security audit partial score with instructor output");
  });
});
