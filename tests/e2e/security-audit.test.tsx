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

/**
 * Test data representing suspicious code patterns we want to detect.
 * 
 * The security audit dashboard is designed to catch students who might be
 * using prohibited libraries or attempting to access the file system in
 * ways that violate assignment rules. Many CS courses prohibit direct
 * file I/O operations to prevent students from:
 * 1. Reading test cases or expected outputs from the grading environment
 * 2. Writing to files to persist data between test runs
 * 3. Accessing system files or other students' submissions
 */

// Student 1: Blatant use of java.io for file system access
const FILE_SYSTEM_ACCESS_CODE = `package com.student.homework;

import java.io.File;
import java.io.FileReader;
import java.io.BufferedReader;
import java.io.FileWriter;
import java.io.IOException;

/**
 * Assignment 1: Data Processing
 * 
 * Note to self: The instructor said we can't use file I/O but I found
 * a way to read the expected output file from the grading directory.
 * This should guarantee me a 100%!
 */
public class DataProcessor {
    
    public static void main(String[] args) {
        try {
            // "Accidentally" reading the grading rubric
            File secretFile = new File("/autograder/expected_output.txt");
            BufferedReader reader = new BufferedReader(new FileReader(secretFile));
            String expectedAnswer = reader.readLine();
            reader.close();
            
            // Now I know what to output!
            System.out.println(expectedAnswer);
            
            // Also saving my "work" for later
            FileWriter writer = new FileWriter("my_cheating_log.txt");
            writer.write("Got the answer: " + expectedAnswer);
            writer.close();
            
        } catch (IOException e) {
            // If file access fails, fall back to actual work (ugh)
            System.out.println("42");
        }
    }
}`;

// Student 2: More subtle java.io usage with FileInputStream
const SNEAKY_FILE_ACCESS_CODE = `package com.student.assignment;

import java.io.FileInputStream;
import java.io.ObjectInputStream;
import java.util.Properties;

/**
 * Assignment 2: Configuration Reader
 * 
 * I'm just reading "configuration" files, totally normal...
 */
public class ConfigReader {
    
    private Properties config;
    
    public ConfigReader() {
        config = new Properties();
        try {
            // Trying to read grader configuration
            FileInputStream fis = new FileInputStream("/autograder/config.properties");
            config.load(fis);
            fis.close();
        } catch (Exception e) {
            // Silently fail and hope no one notices
        }
    }
    
    public String getTestAnswers() {
        return config.getProperty("expected.answers", "unknown");
    }
    
    public static void main(String[] args) {
        ConfigReader reader = new ConfigReader();
        System.out.println(reader.getTestAnswers());
    }
}`;

// Student 3: Legitimate code that doesn't use file I/O
const LEGITIMATE_CODE = `package com.student.clean;

import java.util.ArrayList;
import java.util.List;
import java.util.Scanner;

/**
 * Assignment 3: Number Statistics
 * 
 * A clean implementation that only uses standard input/output
 * as specified in the assignment requirements.
 */
public class NumberStats {
    
    private List<Integer> numbers;
    
    public NumberStats() {
        numbers = new ArrayList<>();
    }
    
    public void addNumber(int n) {
        numbers.add(n);
    }
    
    public double calculateAverage() {
        if (numbers.isEmpty()) return 0.0;
        int sum = 0;
        for (int n : numbers) {
            sum += n;
        }
        return (double) sum / numbers.size();
    }
    
    public static void main(String[] args) {
        NumberStats stats = new NumberStats();
        Scanner scanner = new Scanner(System.in);
        
        System.out.println("Enter numbers (type 'done' to finish):");
        while (scanner.hasNextInt()) {
            stats.addNumber(scanner.nextInt());
        }
        
        System.out.println("Average: " + stats.calculateAverage());
        scanner.close();
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
  // Student 1 (Claude McCheaterson) - failed, blatant java.io file access
  await createSubmissionWithFile(
    student1.private_profile_id,
    FILE_SYSTEM_ACCESS_CODE,
    "DataProcessor.java",
    {
      score: 0,
      maxScore: 100,
      instructorOutput: `SECURITY VIOLATION: Prohibited file system access detected!

Static analysis found the following violations:
- import java.io.File
- import java.io.FileReader
- import java.io.BufferedReader
- import java.io.FileWriter

The code attempts to:
1. Read from /autograder/expected_output.txt (grading files)
2. Write to my_cheating_log.txt (unauthorized file creation)

This is a clear violation of the assignment policy prohibiting
direct file I/O operations. The student appears to be attempting
to read expected outputs from the autograder environment.

ACTION REQUIRED: Academic integrity review recommended.`
    }
  );
  
  // Student 2 (Backdoor Bobby) - partially passed, sneaky FileInputStream usage
  await createSubmissionWithFile(
    student2.private_profile_id,
    SNEAKY_FILE_ACCESS_CODE,
    "ConfigReader.java",
    {
      score: 30,
      maxScore: 100,
      instructorOutput: `WARNING: Prohibited java.io usage detected!

Found imports:
- java.io.FileInputStream
- java.io.ObjectInputStream

The code attempts to read /autograder/config.properties which
suggests the student is trying to access grader configuration.

The silent exception handling (empty catch block) indicates
intentional concealment of file access failures.

Tests passed: 3/10
Tests failed: 7/10 (file access denied in sandbox)`
    }
  );
  
  // Student 3 (Honest Hannah) - passed, clean code without file I/O
  await createSubmissionWithFile(
    student3.private_profile_id,
    LEGITIMATE_CODE,
    "NumberStats.java",
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
  
  test("Search finds java.io.File usage in submissions", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for java.io.File - a prohibited import
    await page.getByTestId("security-search-input").fill("java.io.File");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Verify we found the match in Claude McCheaterson's submission
    await expect(page.getByText("Claude McCheaterson")).toBeVisible();
    await expect(page.getByText("claude-user@pawtograder.net")).toBeVisible();
    await expect(page.getByText("DataProcessor.java")).toBeVisible();
    
    // Verify the matched content preview shows the import
    const matchedContent = page.getByTestId("result-matched-content-0");
    await expect(matchedContent).toContainText("java.io.File");
    
    await argosScreenshot(page, "Security audit found java.io.File usage");
  });
  
  test("Search finds FileInputStream across multiple students", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for FileInputStream - used by student2
    await page.getByTestId("security-search-input").fill("FileInputStream");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Should find Backdoor Bobby's submission
    await expect(page.getByText("Backdoor Bobby")).toBeVisible();
    await expect(page.getByText("ConfigReader.java")).toBeVisible();
    
    await argosScreenshot(page, "Security audit found FileInputStream usage");
  });
  
  test("Search for FileReader finds only the violating student", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for FileReader - only in student1's code
    await page.getByTestId("security-search-input").fill("FileReader");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Should only find Claude McCheaterson, not the others
    await expect(page.getByText("Claude McCheaterson")).toBeVisible();
    await expect(page.getByText("Backdoor Bobby")).not.toBeVisible();
    await expect(page.getByText("Honest Hannah")).not.toBeVisible();
    
    await argosScreenshot(page, "Security audit FileReader single match");
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
    
    // Search for java.io imports
    await page.getByTestId("security-search-input").fill("java.io");
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
  
  test("Search for autograder path finds file system snooping attempts", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for attempts to access the autograder directory
    await page.getByTestId("security-search-input").fill("/autograder/");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Should find both cheating students who tried to access autograder files
    await expect(page.getByText("Claude McCheaterson")).toBeVisible();
    await expect(page.getByText("Backdoor Bobby")).toBeVisible();
    
    // Verify the file link goes to GitHub
    const fileLink = page.getByTestId("result-file-link-0");
    await expect(fileLink).toHaveAttribute("href", /github\.com/);
    
    await argosScreenshot(page, "Security audit found autograder access attempts");
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
    
    // Search for java.io.File (matches student1 who has both sections assigned)
    await page.getByTestId("security-search-input").fill("java.io.File");
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
    
    // Search for FileWriter (Claude McCheaterson's submission with 0/100)
    await page.getByTestId("security-search-input").fill("FileWriter");
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
    
    // Search for BufferedReader (student1's file access violation)
    await page.getByTestId("security-search-input").fill("BufferedReader");
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
    await expect(page.getByTestId("grader-output-content")).toContainText("SECURITY VIOLATION");
    await expect(page.getByTestId("grader-output-content")).toContainText("file system access detected");
    
    // Verify the View Full Grader Results button is present
    await expect(page.getByTestId("view-full-results-button")).toBeVisible();
    
    await argosScreenshot(page, "Security audit grader output modal");
  });
  
  test("Modal shows 'no instructor output' message when submission has none", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/security`);
    
    // Search for ArrayList (Honest Hannah's legitimate code - no instructor output)
    await page.getByTestId("security-search-input").fill("ArrayList");
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
    
    // Search for ObjectInputStream (Backdoor Bobby's submission with 30/100)
    await page.getByTestId("security-search-input").fill("ObjectInputStream");
    await page.getByTestId("security-search-button").click();
    
    // Wait for results
    await expect(page.getByTestId("security-results-table")).toBeVisible({ timeout: 10000 });
    
    // Verify Bobby's submission shows 30/100
    await expect(page.getByText("Backdoor Bobby")).toBeVisible();
    const scoreCell = page.getByTestId("result-score-0");
    await expect(scoreCell).toContainText("30/100");
    
    // Click to view the output
    await page.getByTestId("result-view-output-0").click();
    
    // Verify the instructor output contains the warning
    await expect(page.getByTestId("grader-output-content")).toContainText("WARNING: Prohibited java.io usage");
    await expect(page.getByTestId("grader-output-content")).toContainText("Tests passed: 3/10");
    
    await argosScreenshot(page, "Security audit partial score with instructor output");
  });
});
