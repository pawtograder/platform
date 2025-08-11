import { addDays, subDays } from "date-fns";
import dotenv from "dotenv";
import { all, ConstantNode, create, FunctionNode } from "mathjs";
import { minimatch } from "minimatch";
import Bottleneck from "bottleneck";
import { faker } from "@faker-js/faker";

import {
  createClass,
  createDueDateException,
  createRegradeRequest,
  createUserInClass,
  supabase,
  TEST_HANDOUT_REPO,
  type TestingUser
} from "../tests/e2e/TestingUtils";
import { Database } from "@/utils/supabase/SupabaseTypes";

dotenv.config({ path: ".env.local" });

export const RANDOM_SEED = 100;
const RECYCLE_USERS_KEY = process.env.RECYCLE_USERS_KEY || "demo";
faker.seed(RANDOM_SEED);

const limiter = new Bottleneck({
  maxConcurrent: 200
});

//Auth does not use pgbouncer!
const authLimiter = new Bottleneck({
  maxConcurrent: 30
});

const smallLimiter = new Bottleneck({
  maxConcurrent: 3 // Smaller limit for grading operations
});

// Global counter for repository naming
let repoCounter = 0;

// Get a unique test run prefix for repositories
function getTestRunPrefix(randomSuffix?: string) {
  const suffix = randomSuffix ?? Math.random().toString(36).substring(2, 6);
  const test_run_batch = new Date().toISOString().split("T")[0] + "#" + suffix;
  const workerIndex = process.env.TEST_WORKER_INDEX || "";
  return `e2e-${test_run_batch}-${workerIndex}`;
}

// Helper function to chunk arrays into smaller batches
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// Batch version of insertPreBakedSubmission
async function batchCreateSubmissions(
  submissionsToCreate: Array<{
    assignment: { id: number; due_date: string } & Record<string, unknown>;
    student?: TestingUser;
    group?: { id: number; name: string; memberCount: number; members: string[] };
    isRecentlyDue: boolean;
  }>,
  class_id: number
): Promise<
  Array<{
    submission_id: number;
    assignment: { id: number; due_date: string } & Record<string, unknown>;
    student?: TestingUser;
    group?: { id: number; name: string; memberCount: number; members: string[] };
    isRecentlyDue: boolean;
  }>
> {
  if (submissionsToCreate.length === 0) return [];

  const test_run_prefix = getTestRunPrefix();
  const BATCH_SIZE = 100;

  // Chunk submissions into batches of 100
  const submissionChunks = chunkArray(submissionsToCreate, BATCH_SIZE);

  console.log(`Processing ${submissionChunks.length} batches in parallel...`);

  // Process all chunks in parallel
  const chunkResults = await Promise.all(
    submissionChunks.map(
      async (chunk, chunkIndex) =>
        smallLimiter.schedule(async () => {
          console.log(`Starting batch ${chunkIndex + 1}/${submissionChunks.length} (${chunk.length} submissions)`);

          // Calculate unique repo counter base for this chunk to avoid conflicts
          const chunkRepoCounterBase = repoCounter + chunkIndex * BATCH_SIZE;

          // Prepare repository data for this chunk
          const repositoryInserts = chunk.map((item, index) => ({
            assignment_id: item.assignment.id,
            repository: `not-actually/repository-${test_run_prefix}-${chunkRepoCounterBase + index}`,
            class_id: class_id,
            profile_id: item.student?.private_profile_id,
            assignment_group_id: item.group?.id,
            synced_handout_sha: "none"
          }));

          // Batch insert repositories for this chunk
          const { data: repositoryData, error: repositoryError } = await supabase
            .from("repositories")
            .insert(repositoryInserts)
            .select("id");

          if (repositoryError) {
            throw new Error(
              `Failed to batch create repositories (chunk ${chunkIndex + 1}): ${repositoryError.message}`
            );
          }

          // Prepare repository check runs for this chunk
          const checkRunInserts = repositoryData.map((repo) => ({
            class_id: class_id,
            repository_id: repo.id,
            check_run_id: 1,
            status: "{}",
            sha: "none",
            commit_message: "none"
          }));

          // Batch insert repository check runs for this chunk
          const { data: checkRunData, error: checkRunError } = await supabase
            .from("repository_check_runs")
            .insert(checkRunInserts)
            .select("id");

          if (checkRunError) {
            throw new Error(`Failed to batch create check runs (chunk ${chunkIndex + 1}): ${checkRunError.message}`);
          }

          // Prepare submissions for this chunk
          const submissionInserts = chunk.map((item, index) => ({
            assignment_id: item.assignment.id,
            profile_id: item.student?.private_profile_id,
            assignment_group_id: item.group?.id,
            sha: "none",
            repository: repositoryInserts[index].repository,
            run_attempt: 1,
            run_number: 1,
            class_id: class_id,
            repository_check_run_id: checkRunData[index].id,
            repository_id: repositoryData[index].id
          }));

          // Batch insert submissions for this chunk
          const { data: submissionData, error: submissionError } = await supabase
            .from("submissions")
            .insert(submissionInserts)
            .select("id");

          if (submissionError) {
            throw new Error(`Failed to batch create submissions (chunk ${chunkIndex + 1}): ${submissionError.message}`);
          }

          // Prepare submission files for this chunk
          const sampleJavaCode = `package com.pawtograder.example.java;

public class Entrypoint {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }

  /*
   * This method takes two integers and returns their sum.
   * 
   * @param a the first integer
   * @param b the second integer
   * @return the sum of a and b
   */
  public int doMath(int a, int b) {
      return a+b;
  }

  /**
   * This method returns a message, "Hello, World!"
   * @return
   */
  public String getMessage() {
      
      return "Hello, World!";
  }
}`;

          const submissionFileInserts = submissionData.map((submission, index) => ({
            name: "sample.java",
            contents: sampleJavaCode,
            class_id: class_id,
            submission_id: submission.id,
            profile_id: chunk[index].student?.private_profile_id,
            assignment_group_id: chunk[index].group?.id
          }));

          // Batch insert submission files for this chunk
          const { error: submissionFileError } = await supabase.from("submission_files").insert(submissionFileInserts);

          if (submissionFileError) {
            throw new Error(
              `Failed to batch create submission files (chunk ${chunkIndex + 1}): ${submissionFileError.message}`
            );
          }

          // Prepare grader results for this chunk
          const graderResultInserts = submissionData.map((submission, index) => ({
            submission_id: submission.id,
            score: 5,
            class_id: class_id,
            profile_id: chunk[index].student?.private_profile_id,
            assignment_group_id: chunk[index].group?.id,
            lint_passed: true,
            lint_output: "no lint output",
            lint_output_format: "markdown",
            max_score: 10
          }));

          // Batch insert grader results for this chunk
          const { data: graderResultData, error: graderResultError } = await supabase
            .from("grader_results")
            .insert(graderResultInserts)
            .select("id");

          if (graderResultError) {
            throw new Error(
              `Failed to batch create grader results (chunk ${chunkIndex + 1}): ${graderResultError.message}`
            );
          }

          // Prepare grader result tests (2 per submission) for this chunk
          const graderResultTestInserts = graderResultData.flatMap((graderResult, index) => [
            {
              score: 5,
              max_score: 5,
              name: "test 1",
              name_format: "text",
              output: "here is a bunch of output\n**wow**",
              output_format: "markdown",
              class_id: class_id,
              student_id: chunk[index].student?.private_profile_id,
              assignment_group_id: chunk[index].group?.id,
              grader_result_id: graderResult.id,
              is_released: true
            },
            {
              score: 5,
              max_score: 5,
              name: "test 2",
              name_format: "text",
              output: "here is a bunch of output\n**wow**",
              output_format: "markdown",
              class_id: class_id,
              student_id: chunk[index].student?.private_profile_id,
              assignment_group_id: chunk[index].group?.id,
              grader_result_id: graderResult.id,
              is_released: true
            }
          ]);

          // Batch insert grader result tests for this chunk
          const { error: graderResultTestError } = await supabase
            .from("grader_result_tests")
            .insert(graderResultTestInserts);

          if (graderResultTestError) {
            throw new Error(
              `Failed to batch create grader result tests (chunk ${chunkIndex + 1}): ${graderResultTestError.message}`
            );
          }

          console.log(`Completed batch ${chunkIndex + 1}/${submissionChunks.length} (${chunk.length} submissions)`);

          // Return the results from this chunk
          return submissionData.map((submission, index) => ({
            submission_id: submission.id,
            assignment: chunk[index].assignment,
            student: chunk[index].student,
            group: chunk[index].group,
            isRecentlyDue: chunk[index].isRecentlyDue,
            repository_id: repositoryData[index].id
          }));
        }),
      { concurrency: 10 }
    )
  );

  // Update the global repo counter after all chunks complete
  repoCounter += submissionsToCreate.length;

  // Flatten all chunk results
  const allResults = chunkResults.flat();
  return allResults;
}

// Batch version of gradeSubmission
async function batchGradeSubmissions(
  submissionsToGrade: Array<{
    submission_id: number;
    assignment: { id: number; due_date: string } & Record<string, unknown>;
    student?: TestingUser;
    group?: { id: number; name: string; memberCount: number; members: string[] };
    isRecentlyDue: boolean;
  }>,
  graders: TestingUser[]
): Promise<void> {
  if (submissionsToGrade.length === 0) return;

  // Get all submission review IDs
  const submissionIds = submissionsToGrade.map((s) => s.submission_id);
  const { data: submissionReviews, error: reviewError } = await supabase
    .from("submissions")
    .select("id, grading_review_id")
    .in("id", submissionIds);

  if (reviewError) {
    throw new Error(`Failed to get submission reviews: ${reviewError.message}`);
  }

  const reviewsToProcess = submissionReviews?.filter((s) => s.grading_review_id) || [];
  if (reviewsToProcess.length === 0) return;

  // Get all submission review details
  const reviewIds = reviewsToProcess.map((s) => s.grading_review_id).filter((id): id is number => id !== null);
  const { data: reviewInfo, error: reviewInfoError } = await supabase
    .from("submission_reviews")
    .select("id, submission_id, rubric_id, class_id")
    .in("id", reviewIds);

  if (reviewInfoError) {
    throw new Error(`Failed to get submission review info: ${reviewInfoError.message}`);
  }

  // Group reviews by rubric_id to batch fetch rubric checks
  const reviewsByRubric = new Map<
    number,
    Array<{ id: number; submission_id: number; rubric_id: number; class_id: number }>
  >();
  reviewInfo?.forEach((review) => {
    if (!reviewsByRubric.has(review.rubric_id)) {
      reviewsByRubric.set(review.rubric_id, []);
    }
    reviewsByRubric.get(review.rubric_id)!.push(review);
  });

  // Get all rubric checks for all rubrics in parallel
  const rubricCheckQueries = Array.from(reviewsByRubric.keys()).map((rubricId) =>
    supabase
      .from("rubric_checks")
      .select(
        `
        id, name, is_annotation, points, is_required, file,
        rubric_criteria!inner(id, rubric_id)
      `
      )
      .eq("rubric_criteria.rubric_id", rubricId)
  );

  const rubricCheckResults = await Promise.all(rubricCheckQueries);
  const rubricChecksMap = new Map<
    number,
    Array<{
      id: number;
      name: string;
      is_annotation: boolean;
      points: number;
      is_required: boolean;
      file?: string | null;
    }>
  >();

  rubricCheckResults.forEach((result, index) => {
    const rubricId = Array.from(reviewsByRubric.keys())[index];
    if (result.data) {
      rubricChecksMap.set(rubricId, result.data);
    }
  });

  // Get all submission files for annotations
  const { data: submissionFiles } = await supabase
    .from("submission_files")
    .select("id, name, submission_id")
    .in("submission_id", submissionIds);

  const submissionFilesMap = new Map<number, Array<{ id: number; name: string; submission_id: number }>>();
  submissionFiles?.forEach((file) => {
    if (!submissionFilesMap.has(file.submission_id)) {
      submissionFilesMap.set(file.submission_id, []);
    }
    submissionFilesMap.get(file.submission_id)!.push(file);
  });

  // Prepare all grading data
  const submissionComments: Array<{
    submission_id: number;
    author: string;
    comment: string;
    points: number;
    class_id: number;
    released: boolean;
    rubric_check_id: number;
    submission_review_id: number;
  }> = [];
  const submissionFileComments: Array<{
    submission_id: number;
    submission_file_id: number;
    author: string;
    comment: string;
    points: number;
    line: number;
    class_id: number;
    released: boolean;
    rubric_check_id: number;
    submission_review_id: number;
  }> = [];
  const reviewUpdates = new Map<
    number,
    {
      grader: string;
      released: boolean;
      completed_by: string | null;
      completed_at: string | null;
    }
  >();

  for (const review of reviewInfo || []) {
    const isCompleted = Math.random() < 0.95; // 95% chance review is completed
    const grader = graders[Math.floor(Math.random() * graders.length)];
    const rubricChecks = rubricChecksMap.get(review.rubric_id) || [];
    const files = submissionFilesMap.get(review.submission_id) || [];

    if (isCompleted) {
      // Calculate maximum possible points for this rubric
      const maxPossiblePoints = 90; // TODO: When we finalize the design of max points for hand vs auto grade, update here...
      console.log(`Max possible points: ${maxPossiblePoints} from ${rubricChecks.length} checks`);

      const targetPercentage = Math.max(0.75, Math.min(1, 0.9 + (Math.random() * 0.1 - 0.05)));
      const targetTotalPoints = 90; //Math.floor(maxPossiblePoints * targetPercentage);
      console.log(`Target total points: ${targetTotalPoints} (${Math.round(targetPercentage * 100)}% of max)`);

      // Filter checks that will be applied
      const applicableChecks = rubricChecks.filter((check) => {
        const applyChance = 0.8;
        return check.is_required || Math.random() < applyChance;
      });

      // Distribute target points among applicable checks (ignore individual check.points limits)
      const checkPointAllocations = new Map<number, number>();

      // Distribute points roughly equally among checks with some randomness
      let remainingPoints = targetTotalPoints;

      for (let i = 0; i < applicableChecks.length; i++) {
        const check = applicableChecks[i];

        if (i === applicableChecks.length - 1) {
          // Last check gets all remaining points
          checkPointAllocations.set(check.id, remainingPoints);
          remainingPoints = 0;
        } else {
          // Allocate roughly equal portion with some randomness
          const baseAllocation = Math.floor(targetTotalPoints / applicableChecks.length);
          const randomBonus = Math.floor(Math.random() * 10) - 5; // ±5 points variance
          const allocation = Math.max(1, baseAllocation + randomBonus); // At least 1 point

          // Don't allocate more than what's remaining
          const finalAllocation = Math.min(allocation, remainingPoints - (applicableChecks.length - i - 1));

          checkPointAllocations.set(check.id, finalAllocation);
          remainingPoints -= finalAllocation;
        }
      }

      const totalPointsAwarded = Array.from(checkPointAllocations.values()).reduce((sum, points) => sum + points, 0);
      if (totalPointsAwarded !== targetTotalPoints) {
        console.log(`Total points awarded: ${totalPointsAwarded} !== target total points: ${targetTotalPoints}`);
      }
      // Create comments for applicable checks with allocated points
      for (const check of applicableChecks) {
        const pointsAwarded = checkPointAllocations.get(check.id) || 0;

        if (check.is_annotation && files.length > 0) {
          // Create submission file comment (annotation)
          const file = files[Math.floor(Math.random() * files.length)];
          const lineNumber = Math.floor(Math.random() * 5) + 1;

          submissionFileComments.push({
            submission_id: review.submission_id,
            submission_file_id: file.id,
            author: grader.private_profile_id,
            comment: `${check.name}: Grading comment for this check`,
            points: pointsAwarded,
            line: lineNumber,
            class_id: review.class_id,
            released: true,
            rubric_check_id: check.id,
            submission_review_id: review.id
          });
        } else {
          // Create submission comment (general comment)
          submissionComments.push({
            submission_id: review.submission_id,
            author: grader.private_profile_id,
            comment: `${check.name}: ${pointsAwarded}/${check.points} points - ${check.name.includes("quality") ? "Good work on this aspect!" : "Applied this grading criteria"}`,
            points: pointsAwarded,
            class_id: review.class_id,
            released: true,
            rubric_check_id: check.id,
            submission_review_id: review.id
          });
        }
      }
    }

    reviewUpdates.set(review.id, {
      grader: grader.private_profile_id,
      released: isCompleted,
      completed_by: isCompleted ? grader.private_profile_id : null,
      completed_at: isCompleted ? new Date().toISOString() : null
    });
  }

  // Batch insert comments in parallel chunks of 500
  const COMMENT_BATCH_SIZE = 500;

  if (submissionComments.length > 0) {
    const commentChunks = chunkArray(submissionComments, COMMENT_BATCH_SIZE);

    await Promise.all(
      commentChunks.map(async (chunk, index) => {
        const { error: commentsError } = await supabase.from("submission_comments").insert(chunk);

        if (commentsError) {
          throw new Error(`Failed to batch create submission comments (batch ${index + 1}): ${commentsError.message}`);
        }
      })
    );
  }

  if (submissionFileComments.length > 0) {
    const fileCommentChunks = chunkArray(submissionFileComments, COMMENT_BATCH_SIZE);

    await Promise.all(
      fileCommentChunks.map(async (chunk, index) => {
        const { error: fileCommentsError } = await supabase.from("submission_file_comments").insert(chunk);

        if (fileCommentsError) {
          throw new Error(
            `Failed to batch create submission file comments (batch ${index + 1}): ${fileCommentsError.message}`
          );
        }
      })
    );
  }

  // Batch update reviews in parallel chunks (Supabase doesn't support bulk updates)
  const UPDATE_BATCH_SIZE = 100; // Smaller batch size for concurrent operations
  const reviewUpdateEntries = Array.from(reviewUpdates.entries());
  const updateChunks = chunkArray(reviewUpdateEntries, UPDATE_BATCH_SIZE);

  await Promise.all(
    updateChunks.map(async (chunk, chunkIndex) => {
      const updatePromises = chunk.map(([reviewId, updateData]) =>
        supabase.from("submission_reviews").update(updateData).eq("id", reviewId)
      );

      const updateResults = await Promise.all(updatePromises);
      const updateErrors = updateResults.filter((result) => result.error);

      if (updateErrors.length > 0) {
        console.error(
          "Update errors:",
          updateErrors.map((e) => ({ error: e.error, data: e.data }))
        );
        console.error("Sample update data:", chunk[0][1]);
        throw new Error(
          `Failed to update ${updateErrors.length} submission reviews in batch ${chunkIndex + 1}: ${updateErrors[0].error?.message}`
        );
      }
    })
  );
}

// Helper function to extract dependencies from score expressions (simplified version of GradebookController logic)
function extractDependenciesFromExpression(
  expr: string,
  availableAssignments: Array<{ id: number; slug: string }>,
  availableColumns: Array<{ id: number; slug: string }>
): { assignments?: number[]; gradebook_columns?: number[] } | null {
  if (!expr) return null;

  const math = create(all);
  const dependencies: Record<string, Set<number>> = {};
  const errors: string[] = [];

  try {
    const exprNode = math.parse(expr);
    const availableDependencies = {
      assignments: availableAssignments,
      gradebook_columns: availableColumns
    };

    exprNode.traverse((node) => {
      if (node.type === "FunctionNode") {
        const functionName = (node as FunctionNode).fn.name;
        if (functionName in availableDependencies) {
          const args = (node as FunctionNode).args;
          const argType = args[0].type;
          if (argType === "ConstantNode") {
            const argName = (args[0] as ConstantNode).value;
            if (typeof argName === "string") {
              const matching = availableDependencies[functionName as keyof typeof availableDependencies].filter((d) =>
                minimatch(d.slug!, argName)
              );
              if (matching.length > 0) {
                if (!(functionName in dependencies)) {
                  dependencies[functionName] = new Set();
                }
                matching.forEach((d) => dependencies[functionName].add(d.id));
              } else {
                errors.push(`Invalid dependency: ${argName} for function ${functionName}`);
              }
            }
          }
        }
      }
    });

    if (errors.length > 0) {
      console.warn(`Dependency extraction warnings for expression "${expr}": ${errors.join(", ")}`);
    }

    // Flatten the dependencies
    const flattenedDependencies: Record<string, number[]> = {};
    for (const [functionName, ids] of Object.entries(dependencies)) {
      flattenedDependencies[functionName] = Array.from(ids);
    }

    if (Object.keys(flattenedDependencies).length === 0) {
      return null;
    }
    return flattenedDependencies;
  } catch (error) {
    console.warn(`Failed to parse expression "${expr}": ${error}`);
    throw error;
  }
}

// Helper function to create gradebook columns
async function createGradebookColumn({
  class_id,
  name,
  description,
  slug,
  max_score,
  score_expression,
  dependencies,
  released = false,
  sort_order
}: {
  class_id: number;
  name: string;
  description?: string;
  slug: string;
  max_score?: number;
  score_expression?: string;
  dependencies?: { assignments?: number[]; gradebook_columns?: number[] };
  released?: boolean;
  sort_order?: number;
}): Promise<{
  id: number;
  name: string;
  slug: string;
  max_score: number | null;
  score_expression: string | null;
}> {
  // Get the gradebook for this class
  const { data: gradebook, error: gradebookError } = await supabase
    .from("gradebooks")
    .select("id")
    .eq("class_id", class_id)
    .single();

  if (gradebookError || !gradebook) {
    throw new Error(`Failed to find gradebook for class ${class_id}: ${gradebookError?.message}`);
  }

  // Get available assignments and columns for dependency extraction
  const { data: assignments } = await supabase.from("assignments").select("id, slug").eq("class_id", class_id);

  const { data: existingColumns } = await supabase
    .from("gradebook_columns")
    .select("id, slug")
    .eq("class_id", class_id);

  // Filter out items with null slugs and cast to proper types
  const validAssignments = (assignments || []).filter((a) => a.slug !== null) as Array<{ id: number; slug: string }>;
  const validColumns = (existingColumns || []).filter((c) => c.slug !== null) as Array<{ id: number; slug: string }>;

  // Extract dependencies from score expression if not provided
  let finalDependencies = dependencies;
  if (score_expression && !dependencies) {
    const extractedDeps = extractDependenciesFromExpression(score_expression, validAssignments, validColumns);
    if (extractedDeps) {
      finalDependencies = extractedDeps;
    }
  }

  // Create the gradebook column
  const { data: column, error: columnError } = await supabase
    .from("gradebook_columns")
    .insert({
      class_id,
      gradebook_id: gradebook.id,
      name,
      description,
      slug,
      max_score,
      score_expression,
      dependencies: finalDependencies,
      released,
      sort_order
    })
    .select("id, name, slug, max_score, score_expression")
    .single();

  if (columnError) {
    throw new Error(`Failed to create gradebook column ${name}: ${columnError.message}`);
  }

  return column;
}

// Helper function to find existing users with @pawtograder.net emails
async function findExistingPawtograderUsers(): Promise<{
  instructors: TestingUser[];
  graders: TestingUser[];
  students: TestingUser[];
}> {
  // Query public.users for existing @pawtograder.net users
  const { data: existingUsers, error: usersError } = await supabase
    .from("users")
    .select(
      "*, user_roles(role, private_profile_id, public_profile_id, profiles_private:profiles!private_profile_id(name), profiles_public:profiles!public_profile_id(name))"
    )
    .like("email", `%${RECYCLE_USERS_KEY}-demo@pawtograder.net`);

  if (usersError) {
    console.error(`Failed to fetch existing users: ${usersError.message}`);
    throw new Error(`Failed to fetch existing users: ${usersError.message}`);
  }

  const pawtograderUsers = existingUsers;

  if (pawtograderUsers.length === 0) {
    console.log("No existing *demo@pawtograder.net users found");
    return { instructors: [], graders: [], students: [] };
  }

  console.log(`Found ${pawtograderUsers.length} existing *demo@pawtograder.net users`);

  // Convert to TestingUser format
  const convertToTestingUser = (
    user: { user_id: string; email?: string | null },
    userRole: {
      profiles_private?: { name: string | null };
      profiles_public?: { name: string | null };
      private_profile_id: string;
      public_profile_id: string;
    }
  ): TestingUser => ({
    private_profile_name: userRole.profiles_private?.name || "Unknown",
    public_profile_name: userRole.profiles_public?.name || "Unknown",
    email: user.email || "",
    password: process.env.TEST_PASSWORD || "change-it",
    user_id: user.user_id,
    private_profile_id: userRole.private_profile_id,
    public_profile_id: userRole.public_profile_id,
    class_id: -1 // Will be updated when enrolled in class
  });

  const result = { instructors: [] as TestingUser[], graders: [] as TestingUser[], students: [] as TestingUser[] };

  for (const user of pawtograderUsers) {
    if (!user.user_roles || user.user_roles.length === 0) continue;

    const testingUser = convertToTestingUser(user, user.user_roles[0]);

    // Categorize by email pattern (instructor-, grader-, student-)
    if (user.email && user.email.startsWith("instructor-")) {
      result.instructors.push(testingUser);
    } else if (user.email && user.email.startsWith("grader-")) {
      result.graders.push(testingUser);
    } else if (user.email && user.email.startsWith("student-")) {
      result.students.push(testingUser);
    }
  }

  return result;
}

// Helper function to enroll existing users in a class
async function enrollExistingUserInClass(user: TestingUser, class_id: number): Promise<TestingUser> {
  // Create new private profile
  const { data: privateProfile, error: privateProfileError } = await supabase
    .from("profiles")
    .insert({
      name: user.private_profile_name,
      class_id: class_id,
      is_private_profile: true
    })
    .select("id")
    .single();

  if (privateProfileError) {
    throw new Error(`Failed to create private profile: ${privateProfileError.message}`);
  }

  // Create new public profile
  const { data: publicProfile, error: publicProfileError } = await supabase
    .from("profiles")
    .insert({
      name: user.public_profile_name,
      class_id: class_id,
      is_private_profile: false
    })
    .select("id")
    .single();

  if (publicProfileError) {
    throw new Error(`Failed to create public profile: ${publicProfileError.message}`);
  }

  // Determine role based on email pattern
  const role = user.email.startsWith("instructor-")
    ? "instructor"
    : user.email.startsWith("grader-")
      ? "grader"
      : "student";

  // Insert user role with new profiles
  const { error: userRoleError } = await supabase.from("user_roles").insert({
    user_id: user.user_id,
    role: role,
    class_id: class_id,
    private_profile_id: privateProfile.id,
    public_profile_id: publicProfile.id
  });

  if (userRoleError) {
    throw new Error(`Failed to create user role: ${userRoleError.message}`);
  }

  // Return updated user with new profile IDs and class_id
  return {
    ...user,
    class_id,
    private_profile_id: privateProfile.id,
    public_profile_id: publicProfile.id
  };
}

// Helper function to create specification grading scheme columns
async function createSpecificationGradingColumns(
  class_id: number,
  students: TestingUser[],
  assignments: { id: number }[],
  _labAssignments: { id: number }[]
): Promise<void> {
  console.log("\n📊 Creating specification grading scheme columns...");

  // Create skill columns (12 skills)
  const skillColumns = [];
  for (let i = 1; i <= 12; i++) {
    const skillColumn = await createGradebookColumn({
      class_id,
      name: `Skill #${i}`,
      description: `Score for skill #${i}`,
      slug: `skill-${i}`,
      max_score: 2,
      sort_order: 1 + i
    });

    // Update render expression separately
    await supabase
      .from("gradebook_columns")
      .update({ render_expression: 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])' })
      .eq("id", skillColumn.id);
    skillColumns.push(skillColumn);
  }

  // Create expectation level columns
  const skillColumnIds = skillColumns.map((col) => col.id);
  await createGradebookColumn({
    class_id,
    name: "Skills Meeting Expectations",
    description: "Total number of skills at meets expectations level",
    slug: "meets-expectations",
    score_expression: 'countif(gradebook_columns("skill-*"), f(x) = x.score == 2)',
    max_score: 12,
    dependencies: { gradebook_columns: skillColumnIds },
    sort_order: 14
  });

  await createGradebookColumn({
    class_id,
    name: "Skills Approaching Expectations",
    description: "Total number of skills at approaching expectations level",
    slug: "approaching-expectations",
    score_expression: 'countif(gradebook_columns("skill-*"), f(x) = x.score == 1)',
    max_score: 12,
    dependencies: { gradebook_columns: skillColumnIds },
    sort_order: 15
  });

  await createGradebookColumn({
    class_id,
    name: "Skills Not Meeting Expectations",
    description: "Total number of skills at does not meet expectations level",
    slug: "does-not-meet-expectations",
    score_expression: 'countif(gradebook_columns("skill-*"), f(x) = not x.is_missing and x.score == 0)',
    max_score: 12,
    dependencies: { gradebook_columns: skillColumnIds },
    sort_order: 16
  });

  // Find and rename assignment columns to HW #X or Lab #X
  // Note: assignment_id column may not exist in current schema, so we'll handle it differently
  const { data: existingColumns, error: columnsError } = await supabase
    .from("gradebook_columns")
    .select("id, name, slug")
    .eq("class_id", class_id)
    .like("slug", "assignment-%");

  if (columnsError) {
    console.warn(`Warning: Could not fetch existing assignment columns: ${columnsError.message}`);
  } else if (existingColumns) {
    const hwColumnIds = [];
    const labColumnIds = [];

    for (let i = 0; i < existingColumns.length; i++) {
      const column = existingColumns[i];
      // Since we don't have assignment_id, determine type by index and total counts
      const isLab = column.slug.includes("lab-") || i >= assignments.length;
      const assignmentIndex = isLab ? i - assignments.length + 1 : i + 1;

      const newName = isLab ? `Lab #${assignmentIndex}` : `HW #${assignmentIndex}`;
      const newSlug = isLab ? `lab-${assignmentIndex}` : `hw-${assignmentIndex}`;

      await supabase
        .from("gradebook_columns")
        .update({
          name: newName,
          slug: newSlug,
          description: isLab ? `Participation in ${newName}` : `Score for ${newName}`,
          max_score: isLab ? 1 : 100
        })
        .eq("id", column.id);

      // Update render expression separately for labs
      if (isLab) {
        labColumnIds.push(column.id);
      } else {
        hwColumnIds.push(column.id);
      }
    }

    // Create aggregate columns
    if (hwColumnIds.length > 0) {
      await createGradebookColumn({
        class_id,
        name: "Avg HW",
        description: "Average of all homework assignments",
        slug: "average.hw",
        score_expression: 'mean(gradebook_columns("assignment-assignment-*"))',
        max_score: 100,
        dependencies: { gradebook_columns: hwColumnIds },
        sort_order: 22
      });
    }

    if (labColumnIds.length > 0) {
      await createGradebookColumn({
        class_id,
        name: "Total Labs",
        description: "Total number of labs participated in",
        slug: "total-labs",
        score_expression: 'countif(gradebook_columns("assignment-lab-*"), f(x) = not x.is_missing and x.score>0)',
        max_score: labColumnIds.length,
        dependencies: { gradebook_columns: labColumnIds },
        sort_order: 33
      });
    }
  }

  // Create final grade column
  const finalColumn = await createGradebookColumn({
    class_id,
    name: "Final Score",
    description: `Grades will be primarily assigned by achievement levels of the course Skills, with required grade thresholds on HW for each letter grade, and + (other than A) given for participation in 8 or more out of 10 labs, - given for participating in fewer than 6 out of ten labs.
Grade | Skills Needed | HW Needed 
-- | -- | --
A | Meets expectations on 10+/12, Approaching expectations on remainder | 85% or better
B | Meets expectations on 8+/12, Approaching expectations on remainder | 75% or better
C | Meets expectations on 5+/12, Approaching expectations on remainder | 65% or better
D | Approaching expectations or better on 9+/12 | 55% or better`,
    slug: "final",
    score_expression: `CriteriaA = gradebook_columns("meets-expectations") >= 10 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 85
CriteriaB = gradebook_columns("meets-expectations") >= 8 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 75
CriteriaC = gradebook_columns("meets-expectations") >= 5 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 65
CriteriaD = gradebook_columns("approaching-expectations") >= 9 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 55
CriteriaPlus = gradebook_columns("total-labs") >= 8
CriteriaMinus = gradebook_columns("total-labs") < 6
letter = case_when([CriteriaA, 95;
CriteriaB, 85;
CriteriaC, 75;
CriteriaD, 65;
true, 0])
mod = case_when([CriteriaPlus, 3;
CriteriaMinus, -3;
true, 0])
final = max(letter + mod, 0)
final;`,
    max_score: 100,
    sort_order: 34
  });

  // Update render expression separately
  await supabase.from("gradebook_columns").update({ render_expression: "letter(score)" }).eq("id", finalColumn.id);

  // Set scores for skill columns using specified distribution
  // 90% of students: 10+ skills at 2, none at 0
  // 5% of students: 8-9 skills at 2, none at 0
  // 5% of students: random distribution

  // Categorize students
  const shuffledStudents = [...students].sort(() => Math.random() - 0.5);
  const excellent = shuffledStudents.slice(0, Math.floor(students.length * 0.9)); // 90%
  const good = shuffledStudents.slice(Math.floor(students.length * 0.9), Math.floor(students.length * 0.95)); // 5%
  const random = shuffledStudents.slice(Math.floor(students.length * 0.95)); // 5%

  console.log(
    `Skills distribution: ${excellent.length} excellent, ${good.length} good, ${random.length} random students`
  );

  for (let i = 0; i < skillColumns.length; i++) {
    const skillColumn = skillColumns[i];

    // Create custom score distribution for this skill
    const customScores = students.map((student, index) => {
      const studentCategory =
        index < excellent.length ? "excellent" : index < excellent.length + good.length ? "good" : "random";

      if (studentCategory === "excellent") {
        // 90% of students: 10+ skills at 2, none at 0
        if (i < 10) {
          return Math.random() < 0.9 ? 2 : 1; // First 10 skills: mostly 2s, some 1s
        } else {
          return Math.random() < 0.7 ? 2 : 1; // Remaining 2 skills: mix of 1s and 2s
        }
      } else if (studentCategory === "good") {
        // 5% of students: 8-9 skills at 2, none at 0
        if (i < 8) {
          return Math.random() < 0.85 ? 2 : 1; // First 8 skills: mostly 2s, some 1s
        } else if (i < 10) {
          return Math.random() < 0.5 ? 2 : 1; // Skills 9-10: mix of 1s and 2s
        } else {
          return Math.random() < 0.3 ? 2 : 1; // Remaining skills: mostly 1s
        }
      } else {
        // 5% of students: completely random distribution
        return [0, 1, 2][Math.floor(Math.random() * 3)];
      }
    });

    // Use the existing setGradebookColumnScores function with custom scores
    await setCustomGradebookColumnScores({
      class_id,
      gradebook_column_id: skillColumn.id,
      students,
      customScores
    });

    const avgScore = customScores.reduce((sum, s) => sum + s, 0) / customScores.length;
    console.log(`✓ Set ${skillColumn.name} scores: avg=${avgScore.toFixed(2)}`);
  }

  // Call auto layout RPC to organize columns properly
  const { data: gradebook } = await supabase.from("gradebooks").select("id").eq("class_id", class_id).single();

  if (gradebook) {
    const { error: layoutError } = await supabase.rpc("gradebook_auto_layout", {
      p_gradebook_id: gradebook.id
    });

    if (layoutError) {
      console.error("Failed to auto-layout gradebook:", layoutError);
    } else {
      console.log("✓ Applied auto-layout to gradebook columns");
    }
  }

  console.log(`✓ Created specification grading scheme with ${skillColumns.length} skills and aggregate columns`);
}

// Helper function to create current grading scheme columns
async function createCurrentGradingColumns(
  class_id: number,
  students: TestingUser[],
  effectiveNumManualGradedColumns: number
): Promise<{ id: number; name: string; slug: string; max_score: number | null; score_expression: string | null }[]> {
  console.log("\n📊 Creating current grading scheme columns...");

  // Create manual graded columns if specified
  const manualGradedColumns: Array<{
    id: number;
    name: string;
    slug: string;
    max_score: number | null;
    score_expression: string | null;
  }> = [];

  if (effectiveNumManualGradedColumns > 0) {
    console.log(`\n📊 Creating ${effectiveNumManualGradedColumns} manual graded columns...`);

    for (let i = 1; i <= effectiveNumManualGradedColumns; i++) {
      const columnName = `Manual Grade ${i}`;
      const columnSlug = `manual-grade-${i}`;

      const manualColumn = await createGradebookColumn({
        class_id,
        name: columnName,
        description: `Manual grading column ${i}`,
        slug: columnSlug,
        max_score: 100,
        sort_order: 1000 + i
      });

      manualGradedColumns.push(manualColumn);
    }

    console.log(`✓ Created ${manualGradedColumns.length} manual graded columns`);
  }

  const participationColumn = await createGradebookColumn({
    class_id,
    name: "Participation",
    description: "Overall class participation score",
    slug: "participation",
    max_score: 100,
    sort_order: 1000
  });

  await createGradebookColumn({
    class_id,
    name: "Average Assignments",
    description: "Average of all assignments",
    slug: "average-assignments",
    score_expression: "mean(gradebook_columns('assignment-assignment-*'))",
    max_score: 100,
    sort_order: 2
  });

  await createGradebookColumn({
    class_id,
    name: "Average Lab Assignments",
    description: "Average of all lab assignments",
    slug: "average-lab-assignments",
    score_expression: "mean(gradebook_columns('assignment-lab-*'))",
    max_score: 100,
    sort_order: 3
  });

  await createGradebookColumn({
    class_id,
    name: "Final Grade",
    description: "Calculated final grade",
    slug: "final-grade",
    score_expression:
      "gradebook_columns('average-lab-assignments') * 0.4 + gradebook_columns('average-assignments') * 0.5 + gradebook_columns('participation') * 0.1",
    max_score: 100,
    sort_order: 999
  });

  console.log(
    `✓ Created ${4 + manualGradedColumns.length} gradebook columns (${4} standard + ${manualGradedColumns.length} manual)`
  );

  // Set scores for the participation column using normal distribution
  console.log("\n📊 Setting scores for gradebook columns...");
  const participationStats = await setGradebookColumnScores({
    class_id,
    gradebook_column_id: participationColumn.id,
    students,
    averageScore: 85,
    standardDeviation: 12,
    maxScore: 100
  });
  console.log(
    `✓ Set participation scores: avg=${participationStats.averageActual}, min=${participationStats.minScore}, max=${participationStats.maxScore}`
  );

  // Set scores for manual graded columns using normal distribution
  if (manualGradedColumns.length > 0) {
    console.log("\n📊 Setting scores for manual graded columns...");
    for (const manualColumn of manualGradedColumns) {
      const manualStats = await setGradebookColumnScores({
        class_id,
        gradebook_column_id: manualColumn.id,
        students,
        averageScore: 80 + Math.random() * 20, // Random average between 80-100
        standardDeviation: 10 + Math.random() * 10, // Random deviation between 10-20
        maxScore: 100
      });
      console.log(
        `✓ Set ${manualColumn.name} scores: avg=${manualStats.averageActual}, min=${manualStats.minScore}, max=${manualStats.maxScore}`
      );
    }
  }

  return manualGradedColumns;
}

// Helper function to set custom scores for students in a gradebook column
async function setCustomGradebookColumnScores({
  class_id,
  gradebook_column_id,
  students,
  customScores
}: {
  class_id: number;
  gradebook_column_id: number;
  students: TestingUser[];
  customScores: number[];
}): Promise<void> {
  const limiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 100
  });

  // Get the gradebook_id for this class
  const { data: gradebook, error: gradebookError } = await supabase
    .from("gradebooks")
    .select("id")
    .eq("class_id", class_id)
    .single();

  if (gradebookError || !gradebook) {
    throw new Error(`Failed to find gradebook for class ${class_id}: ${gradebookError?.message}`);
  }

  // Get existing gradebook column student records
  const { data: existingRecords, error: fetchError } = await supabase
    .from("gradebook_column_students")
    .select("id, student_id")
    .eq("gradebook_column_id", gradebook_column_id)
    .eq("is_private", true);

  if (fetchError) {
    throw new Error(`Failed to fetch existing gradebook column students: ${fetchError.message}`);
  }

  if (!existingRecords || existingRecords.length === 0) {
    throw new Error(`No existing gradebook column student records found for column ${gradebook_column_id}`);
  }

  const updatePromises = students.map(async (student, index) => {
    const existingRecord = existingRecords.find((record) => record.student_id === student.private_profile_id);
    if (!existingRecord) {
      console.warn(`No gradebook column student record found for student ${student.email}`);
      return;
    }

    const { error: updateError } = await limiter.schedule(() =>
      supabase.from("gradebook_column_students").update({ score: customScores[index] }).eq("id", existingRecord.id)
    );

    if (updateError) {
      throw new Error(`Failed to update score for student ${student.email}: ${updateError.message}`);
    }
  });

  await Promise.all(updatePromises);
}

// Helper function to set scores for students in a gradebook column using normal distribution
async function setGradebookColumnScores({
  class_id,
  gradebook_column_id,
  students,
  averageScore,
  standardDeviation = 15,
  maxScore = 100,
  useDiscreteValues
}: {
  class_id: number;
  gradebook_column_id: number;
  students: TestingUser[];
  averageScore: number;
  standardDeviation?: number;
  maxScore?: number;
  useDiscreteValues?: number[];
}): Promise<{
  updatedCount: number;
  averageActual: number;
  minScore: number;
  maxScore: number;
}> {
  // Generate scores using normal distribution
  const scores = students.map(() => {
    if (useDiscreteValues) {
      // For discrete values, use weighted random selection based on desired average
      const weights = useDiscreteValues.map((value) => {
        // Weight based on distance from average, with some randomness
        const distance = Math.abs(value - averageScore);
        return Math.exp(-distance * 2) + Math.random() * 0.3;
      });

      const totalWeight = weights.reduce((sum, w) => sum + w, 0);
      const normalizedWeights = weights.map((w) => w / totalWeight);

      let random = Math.random();
      for (let i = 0; i < useDiscreteValues.length; i++) {
        random -= normalizedWeights[i];
        if (random <= 0) {
          return useDiscreteValues[i];
        }
      }
      return useDiscreteValues[useDiscreteValues.length - 1];
    } else {
      // Generate normal distribution using Box-Muller transform
      const u1 = Math.random();
      const u2 = Math.random();
      const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

      // Apply to our distribution
      let score = averageScore + z0 * standardDeviation;

      // Clamp to valid range (0 to maxScore)
      score = Math.max(0, Math.min(maxScore, score));

      return Math.round(score * 100) / 100; // Round to 2 decimal places
    }
  });

  // Get the gradebook_id for this class
  const { data: gradebook, error: gradebookError } = await supabase
    .from("gradebooks")
    .select("id")
    .eq("class_id", class_id)
    .single();

  if (gradebookError || !gradebook) {
    throw new Error(`Failed to find gradebook for class ${class_id}: ${gradebookError?.message}`);
  }

  // Get existing gradebook column student records
  const { data: existingRecords, error: fetchError } = await supabase
    .from("gradebook_column_students")
    .select("id, student_id")
    .eq("gradebook_column_id", gradebook_column_id)
    .eq("is_private", true);

  if (fetchError) {
    throw new Error(`Failed to fetch existing gradebook column students: ${fetchError.message}`);
  }

  if (!existingRecords || existingRecords.length === 0) {
    throw new Error(`No existing gradebook column student records found for column ${gradebook_column_id}`);
  }

  // Update scores for each student individually
  const updatePromises = students.map(async (student, index) => {
    const existingRecord = existingRecords.find((record) => record.student_id === student.private_profile_id);
    if (!existingRecord) {
      console.warn(`No gradebook column student record found for student ${student.email}`);
      return;
    }

    const { error: updateError } = await limiter.schedule(() =>
      supabase.from("gradebook_column_students").update({ score: scores[index] }).eq("id", existingRecord.id)
    );

    if (updateError) {
      throw new Error(`Failed to update score for student ${student.email}: ${updateError.message}`);
    }
  });

  await Promise.all(updatePromises);

  // Calculate statistics
  const actualAverage = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const minScore = Math.min(...scores);
  const maxActualScore = Math.max(...scores);

  return {
    updatedCount: students.length,
    averageActual: Math.round(actualAverage * 100) / 100,
    minScore: Math.round(minScore * 100) / 100,
    maxScore: Math.round(maxActualScore * 100) / 100
  };
}

// Rubric part templates for generating diverse rubrics
const RUBRIC_PART_TEMPLATES = [
  {
    name: "Code Quality",
    description: "Assessment of code structure, style, and best practices",
    criteria: [
      {
        name: "Code Style & Formatting",
        description: "Proper indentation, naming conventions, and formatting",
        points: [3, 5, 8],
        checks: [
          { name: "Consistent Indentation", points: [1, 2], isAnnotation: true },
          { name: "Meaningful Variable Names", points: [2, 3], isAnnotation: true },
          { name: "Proper Code Comments", points: [1, 2, 3], isAnnotation: false }
        ]
      },
      {
        name: "Code Organization",
        description: "Logical structure and separation of concerns",
        points: [5, 8, 10],
        checks: [
          { name: "Function Decomposition", points: [2, 3, 4], isAnnotation: true },
          { name: "Class Structure", points: [2, 3], isAnnotation: true },
          { name: "Code Modularity", points: [1, 2, 3], isAnnotation: false }
        ]
      }
    ]
  },
  {
    name: "Algorithm Implementation",
    description: "Correctness and efficiency of algorithmic solutions",
    criteria: [
      {
        name: "Correctness",
        description: "Implementation correctly solves the problem",
        points: [15, 20, 25],
        checks: [
          { name: "Handles Base Cases", points: [3, 5], isAnnotation: true },
          { name: "Correct Logic Flow", points: [5, 8, 10], isAnnotation: true },
          { name: "Edge Case Handling", points: [2, 4, 5], isAnnotation: false }
        ]
      },
      {
        name: "Efficiency",
        description: "Time and space complexity considerations",
        points: [8, 12, 15],
        checks: [
          { name: "Optimal Time Complexity", points: [3, 5, 7], isAnnotation: false },
          { name: "Memory Usage", points: [2, 3, 4], isAnnotation: true },
          { name: "Algorithm Choice", points: [2, 3, 4], isAnnotation: false }
        ]
      }
    ]
  },
  {
    name: "Testing & Documentation",
    description: "Quality of tests and documentation provided",
    criteria: [
      {
        name: "Test Coverage",
        description: "Comprehensive testing of functionality",
        points: [10, 15],
        checks: [
          { name: "Unit Tests Present", points: [3, 5], isAnnotation: false },
          { name: "Test Edge Cases", points: [2, 4], isAnnotation: true },
          { name: "Test Documentation", points: [2, 3], isAnnotation: false }
        ]
      },
      {
        name: "Documentation Quality",
        description: "Clear and comprehensive documentation",
        points: [8, 12],
        checks: [
          { name: "README Completeness", points: [2, 4], isAnnotation: false },
          { name: "API Documentation", points: [2, 3, 4], isAnnotation: true },
          { name: "Usage Examples", points: [1, 2, 3], isAnnotation: false }
        ]
      }
    ]
  },
  {
    name: "Problem Solving",
    description: "Approach to understanding and solving the problem",
    criteria: [
      {
        name: "Problem Analysis",
        description: "Understanding and breakdown of the problem",
        points: [8, 12],
        checks: [
          { name: "Requirements Understanding", points: [2, 4], isAnnotation: false },
          { name: "Problem Decomposition", points: [3, 4], isAnnotation: true },
          { name: "Solution Planning", points: [2, 3, 4], isAnnotation: false }
        ]
      },
      {
        name: "Implementation Strategy",
        description: "Approach to implementing the solution",
        points: [10, 15],
        checks: [
          { name: "Design Patterns Usage", points: [3, 5], isAnnotation: true },
          { name: "Error Handling", points: [2, 4], isAnnotation: true },
          { name: "Code Reusability", points: [2, 3, 4], isAnnotation: false }
        ]
      }
    ]
  },
  {
    name: "User Experience",
    description: "Quality of user interface and interaction design",
    criteria: [
      {
        name: "Interface Design",
        description: "Visual design and layout quality",
        points: [8, 12, 15],
        checks: [
          { name: "Visual Hierarchy", points: [2, 3, 4], isAnnotation: true },
          { name: "Color Scheme", points: [1, 2, 3], isAnnotation: true },
          { name: "Layout Consistency", points: [2, 4], isAnnotation: false }
        ]
      },
      {
        name: "Usability",
        description: "Ease of use and user interaction quality",
        points: [10, 15],
        checks: [
          { name: "Navigation Clarity", points: [3, 5], isAnnotation: false },
          { name: "User Feedback", points: [2, 3, 4], isAnnotation: true },
          { name: "Accessibility Features", points: [2, 4], isAnnotation: false }
        ]
      }
    ]
  },
  {
    name: "Security & Performance",
    description: "Security considerations and performance optimization",
    criteria: [
      {
        name: "Security Practices",
        description: "Implementation of security best practices",
        points: [12, 18],
        checks: [
          { name: "Input Validation", points: [3, 5], isAnnotation: true },
          { name: "Authentication Handling", points: [4, 6], isAnnotation: true },
          { name: "Data Protection", points: [2, 4], isAnnotation: false }
        ]
      },
      {
        name: "Performance Optimization",
        description: "Code efficiency and optimization techniques",
        points: [8, 12],
        checks: [
          { name: "Resource Management", points: [2, 4], isAnnotation: true },
          { name: "Caching Strategy", points: [2, 3, 4], isAnnotation: false },
          { name: "Load Time Optimization", points: [2, 3], isAnnotation: false }
        ]
      }
    ]
  }
];

// Helper function to generate random rubric structure
function generateRubricStructure(config: NonNullable<SeedingOptions["rubricConfig"]>) {
  const numParts =
    Math.floor(Math.random() * (config.maxPartsPerAssignment - config.minPartsPerAssignment + 1)) +
    config.minPartsPerAssignment;

  // Shuffle and select random rubric parts
  const shuffledTemplates = [...RUBRIC_PART_TEMPLATES].sort(() => Math.random() - 0.5);
  const selectedParts = shuffledTemplates.slice(0, Math.min(numParts, RUBRIC_PART_TEMPLATES.length));

  return selectedParts.map((partTemplate, partIndex) => {
    const numCriteria =
      Math.floor(Math.random() * (config.maxCriteriaPerPart - config.minCriteriaPerPart + 1)) +
      config.minCriteriaPerPart;
    const selectedCriteria = partTemplate.criteria.slice(0, Math.min(numCriteria, partTemplate.criteria.length));

    return {
      ...partTemplate,
      ordinal: partIndex,
      criteria: selectedCriteria.map((criteriaTemplate, criteriaIndex) => {
        const numChecks =
          Math.floor(Math.random() * (config.maxChecksPerCriteria - config.minChecksPerCriteria + 1)) +
          config.minChecksPerCriteria;
        const selectedChecks = criteriaTemplate.checks.slice(0, Math.min(numChecks, criteriaTemplate.checks.length));

        // Will be set later to ensure total sums to 90
        const criteriaPoints = 10; // Temporary value

        return {
          ...criteriaTemplate,
          ordinal: criteriaIndex,
          total_points: criteriaPoints,
          checks: selectedChecks.map((checkTemplate, checkIndex) => {
            const checkPoints = checkTemplate.points[Math.floor(Math.random() * checkTemplate.points.length)];
            return {
              ...checkTemplate,
              ordinal: checkIndex,
              points: checkPoints,
              is_annotation: checkTemplate.isAnnotation,
              is_comment_required: Math.random() < 0.3, // 30% chance of requiring comments
              is_required: Math.random() < 0.7 // 70% chance of being required
            };
          })
        };
      })
    };
  });
}
let assignmentIdx = 1;
let labAssignmentIdx = 1;
// Enhanced assignment creation function that generates diverse rubrics
async function insertEnhancedAssignment({
  due_date,
  lab_due_date_offset,
  allow_not_graded_submissions,
  class_id,
  rubricConfig,
  groupConfig,
  name
}: {
  due_date: string;
  lab_due_date_offset?: number;
  allow_not_graded_submissions?: boolean;
  class_id: number;
  rubricConfig: NonNullable<SeedingOptions["rubricConfig"]>;
  groupConfig?: "individual" | "groups" | "both";
  name?: string;
}): Promise<{
  id: number;
  title: string;
  rubricChecks: Array<{
    id: number;
    name: string;
    points: number;
    [key: string]: unknown;
  }>;
  rubricParts: Array<{
    id: number;
    name: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}> {
  const title =
    (name || (lab_due_date_offset ? `Lab ${labAssignmentIdx}` : `Assignment ${assignmentIdx}`)) +
    (groupConfig && groupConfig !== "individual" ? ` (Group)` : "");
  let ourAssignmentIdx;
  if (lab_due_date_offset) {
    ourAssignmentIdx = labAssignmentIdx;
    labAssignmentIdx++;
  } else {
    ourAssignmentIdx = assignmentIdx;
    assignmentIdx++;
  }

  // Create self review setting
  const { data: selfReviewSettingData, error: selfReviewSettingError } = await supabase
    .from("assignment_self_review_settings")
    .insert({
      class_id: class_id,
      enabled: true,
      deadline_offset: 2,
      allow_early: true
    })
    .select("id")
    .single();

  if (selfReviewSettingError) {
    throw new Error(`Failed to create self review setting: ${selfReviewSettingError.message}`);
  }

  const self_review_setting_id = selfReviewSettingData.id;

  console.log(`Creating assignment ${title}`);
  // Create assignment
  const { data: insertedAssignmentData, error: assignmentError } = await supabase
    .from("assignments")
    .insert({
      title: title,
      description: "This is an enhanced test assignment with diverse rubric structure",
      due_date: due_date,
      minutes_due_after_lab: lab_due_date_offset,
      template_repo: TEST_HANDOUT_REPO,
      autograder_points: 20,
      total_points: 100,
      max_late_tokens: 10,
      release_date: addDays(new Date(), -1).toUTCString(),
      class_id: class_id,
      slug: lab_due_date_offset ? `lab-${ourAssignmentIdx}` : `assignment-${ourAssignmentIdx}`,
      group_config: groupConfig || "individual",
      allow_not_graded_submissions: allow_not_graded_submissions || false,
      self_review_setting_id: self_review_setting_id,
      max_group_size: 6,
      group_formation_deadline: addDays(new Date(), -1).toUTCString()
    })
    .select("id")
    .single();

  if (assignmentError) {
    throw new Error(`Failed to create assignment: ${assignmentError.message}`);
  }

  // Get assignment data
  const { data: assignmentData } = await supabase
    .from("assignments")
    .select("*")
    .eq("id", insertedAssignmentData.id)
    .single();

  if (!assignmentData) {
    throw new Error("Failed to get assignment");
  }

  // Update autograder config
  await supabase
    .from("autograder")
    .update({
      grader_repo: "pawtograder-playground/test-e2e-java-solution",
      grader_commit_sha: "76ece6af6a251346596fcc71181a86599faf0fe3be0f85c532ff20c2f0939177", // Avoid races :)
      config: { submissionFiles: { files: ["**/*.java", "**/*.py", "**/*.arr", "**/*.ts"], testFiles: [] } }
    })
    .eq("id", assignmentData.id);

  // Generate diverse rubric structure
  const rubricStructure = generateRubricStructure(rubricConfig);

  // Create self-review rubric parts (always include basic self-review)
  const selfReviewPart = {
    name: "Self Review",
    description: "Student self-assessment of their work",
    ordinal: 0,
    criteria: [
      {
        name: "Self Reflection",
        description: "Quality of self-assessment and reflection",
        ordinal: 0,
        total_points: 10,
        checks: [
          {
            name: "Completeness of Self Review",
            ordinal: 0,
            points: 5,
            is_annotation: false,
            is_comment_required: false,
            is_required: true
          },
          {
            name: "Depth of Reflection",
            ordinal: 1,
            points: 5,
            is_annotation: false,
            is_comment_required: true,
            is_required: true
          }
        ]
      }
    ]
  };

  // Combine self-review with generated structure for grading rubric
  const allParts = [selfReviewPart, ...rubricStructure.map((part) => ({ ...part, ordinal: part.ordinal + 1 }))];

  // CRITICAL FIX: Ensure all criteria total_points sum to exactly 90
  const targetTotal = 90;
  const selfReviewPoints = 10; // Fixed self-review points
  const remainingPoints = targetTotal - selfReviewPoints; // 80 points to distribute

  // Collect all non-self-review criteria
  const allCriteria = allParts.slice(1).flatMap((part) => part.criteria);
  console.log(
    `🎯 Distributing ${remainingPoints} points among ${allCriteria.length} criteria (${selfReviewPoints} for self-review)`
  );

  // Distribute remaining points among criteria to ensure exact total
  let pointsLeft = remainingPoints;
  for (let i = 0; i < allCriteria.length; i++) {
    const criteria = allCriteria[i];
    if (i === allCriteria.length - 1) {
      // Last criteria gets all remaining points
      criteria.total_points = pointsLeft;
      console.log(`  Final criteria "${criteria.name}": ${pointsLeft} points`);
    } else {
      // Distribute roughly equally with some variance
      const basePoints = Math.floor(remainingPoints / allCriteria.length);
      const variance = Math.floor(Math.random() * 6) - 3; // ±3 points
      const allocatedPoints = Math.max(
        5,
        Math.min(pointsLeft - (allCriteria.length - i - 1) * 5, basePoints + variance)
      );
      criteria.total_points = allocatedPoints;
      pointsLeft -= allocatedPoints;
      console.log(`  Criteria "${criteria.name}": ${allocatedPoints} points`);
    }
  }

  const actualTotal = allParts.flatMap((part) => part.criteria).reduce((sum, c) => sum + c.total_points, 0);
  console.log(`✅ Criteria total_points sum: ${actualTotal} (target: ${targetTotal})`);

  if (actualTotal !== targetTotal) {
    throw new Error(`Criteria total_points sum (${actualTotal}) doesn't match target (${targetTotal})`);
  }

  // Create rubric parts
  const createdParts = [];
  const allRubricChecks = [];

  for (const partTemplate of allParts) {
    const isGradingPart = partTemplate.name !== "Self Review";
    const rubricId = isGradingPart ? assignmentData.grading_rubric_id : assignmentData.self_review_rubric_id;

    const { data: partData, error: partError } = await supabase
      .from("rubric_parts")
      .insert({
        class_id: class_id,
        name: partTemplate.name,
        description: partTemplate.description,
        ordinal: partTemplate.ordinal,
        rubric_id: rubricId || 0
      })
      .select("id")
      .single();

    if (partError) {
      throw new Error(`Failed to create rubric part: ${partError.message}`);
    }

    createdParts.push({ ...partTemplate, id: partData.id, rubric_id: rubricId });

    // Create criteria for this part
    for (const criteriaTemplate of partTemplate.criteria) {
      const { data: criteriaData, error: criteriaError } = await supabase
        .from("rubric_criteria")
        .insert({
          class_id: class_id,
          name: criteriaTemplate.name,
          description: criteriaTemplate.description,
          ordinal: criteriaTemplate.ordinal,
          total_points: criteriaTemplate.total_points,
          is_additive: true,
          rubric_part_id: partData.id,
          rubric_id: rubricId || 0
        })
        .select("id")
        .single();

      if (criteriaError) {
        throw new Error(`Failed to create rubric criteria: ${criteriaError.message}`);
      }

      // Create checks for this criteria
      for (const checkTemplate of criteriaTemplate.checks) {
        const { data: checkData, error: checkError } = await supabase
          .from("rubric_checks")
          .insert({
            rubric_criteria_id: criteriaData.id,
            name: checkTemplate.name,
            description: `${checkTemplate.name} evaluation`,
            ordinal: checkTemplate.ordinal,
            points: checkTemplate.points,
            is_annotation: checkTemplate.is_annotation,
            is_comment_required: checkTemplate.is_comment_required,
            class_id: class_id,
            is_required: checkTemplate.is_required
          })
          .select("*")
          .single();

        if (checkError) {
          throw new Error(`Failed to create rubric check: ${checkError.message}`);
        }

        allRubricChecks.push(checkData);
      }
    }
  }

  return {
    ...assignmentData,
    rubricChecks: allRubricChecks,
    rubricParts: createdParts,
    due_date: assignmentData.due_date
  };
}

// Helper function to create class sections
async function createClassSections(class_id: number, numSections: number) {
  // Bulk insert all sections at once
  const sectionsData = Array.from({ length: numSections }, (_, i) => ({
    class_id: class_id,
    name: `Section ${String(i + 1).padStart(2, "0")}`
  }));

  const { data: sections, error: sectionsError } = await supabase
    .from("class_sections")
    .insert(sectionsData)
    .select("id, name");

  if (sectionsError) {
    throw new Error(`Failed to create class sections: ${sectionsError.message}`);
  }

  return sections || [];
}

// Helper function to create lab sections with distributed instructors
async function createLabSections(class_id: number, numSections: number, instructors: TestingUser[]) {
  const daysOfWeek = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;
  const times = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];

  // Bulk insert all lab sections at once
  const sectionsData = Array.from({ length: numSections }, (_, i) => {
    const dayIndex = i % daysOfWeek.length;
    const timeIndex = Math.floor(i / daysOfWeek.length) % times.length;
    const startTime = times[timeIndex];
    const endTime = `${String(parseInt(startTime.split(":")[0]) + 1).padStart(2, "0")}:${startTime.split(":")[1]}`;

    // Distribute instructors among lab sections
    const instructorIndex = i % instructors.length;
    const instructorId = instructors[instructorIndex].private_profile_id;

    return {
      class_id: class_id,
      name: `Lab ${String.fromCharCode(65 + i)}`, // Lab A, Lab B, etc.
      day_of_week: daysOfWeek[dayIndex],
      start_time: startTime,
      end_time: endTime,
      lab_leader_id: instructorId,
      description: `Lab section ${String.fromCharCode(65 + i)} - ${daysOfWeek[dayIndex]} ${startTime}-${endTime} (led by ${instructors[instructorIndex].private_profile_name})`
    };
  });

  const { data: sections, error: sectionsError } = await supabase
    .from("lab_sections")
    .insert(sectionsData)
    .select("id, name");

  if (sectionsError) {
    throw new Error(`Failed to create lab sections: ${sectionsError.message}`);
  }

  return sections || [];
}

// Helper function to define tag types (name/color combinations)
function defineTagTypes(prefix: string, numTagTypes: number) {
  const tagTypes = [];
  const colors = [
    "#ef4444",
    "#f97316",
    "#eab308",
    "#22c55e",
    "#06b6d4",
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
    "#6b7280",
    "#f59e0b"
  ];

  for (let i = 1; i <= numTagTypes; i++) {
    const colorIndex = (i - 1) % colors.length;
    tagTypes.push({
      name: `${prefix} ${String(i).padStart(2, "0")}`,
      color: colors[colorIndex]
    });
  }

  return tagTypes;
}

// Helper function to determine optimal group size for number of students
function calculateGroupSize(numStudents: number): number {
  // Try to find the best group size that divides evenly
  const possibleSizes = [2, 3, 4, 5];

  for (const size of possibleSizes) {
    if (numStudents % size === 0) {
      return size;
    }
  }

  // If no perfect division, use the size that leaves the smallest remainder
  let bestSize = 2;
  let smallestRemainder = numStudents % 2;

  for (const size of possibleSizes) {
    const remainder = numStudents % size;
    if (remainder < smallestRemainder) {
      smallestRemainder = remainder;
      bestSize = size;
    }
  }

  return bestSize;
}

// Helper function to create assignment groups and assign students
async function createAssignmentGroups(
  assignment_id: number,
  class_id: number,
  students: TestingUser[],
  groupSize: number
) {
  const numGroups = Math.ceil(students.length / groupSize);

  // Bulk insert all assignment groups at once
  const groupsData = Array.from({ length: numGroups }, (_, i) => ({
    name: `Group ${String(i + 1).padStart(2, "0")}`,
    assignment_id: assignment_id,
    class_id: class_id
  }));

  const { data: groups, error: groupsError } = await supabase
    .from("assignment_groups")
    .insert(groupsData)
    .select("id, name");

  if (groupsError) {
    throw new Error(`Failed to create assignment groups: ${groupsError.message}`);
  }

  if (!groups) return [];

  // Bulk insert all group members at once
  const membersData: Array<{
    assignment_group_id: number;
    profile_id: string;
    assignment_id: number;
    class_id: number;
    added_by: string;
  }> = [];

  for (let i = 0; i < numGroups; i++) {
    const startIndex = i * groupSize;
    const endIndex = Math.min(startIndex + groupSize, students.length);
    const groupStudents = students.slice(startIndex, endIndex);

    groupStudents.forEach((student) => {
      membersData.push({
        assignment_group_id: groups[i].id,
        profile_id: student.private_profile_id,
        assignment_id: assignment_id,
        class_id: class_id,
        added_by: student.private_profile_id
      });
    });
  }

  const { error: membersError } = await supabase.from("assignment_groups_members").insert(membersData);

  if (membersError) {
    throw new Error(`Failed to add students to groups: ${membersError.message}`);
  }

  return groups.map((group, i) => {
    const startIndex = i * groupSize;
    const endIndex = Math.min(startIndex + groupSize, students.length);
    const groupStudents = students.slice(startIndex, endIndex);

    return {
      ...group,
      memberCount: groupStudents.length,
      members: groupStudents.map((s) => s.private_profile_id)
    };
  });
}

// Helper function to randomly assign users to sections and tags (in parallel batches)
async function assignUsersToSectionsAndTags(
  users: TestingUser[],
  classSections: Array<{ id: number; name: string }>,
  labSections: Array<{ id: number; name: string }>,
  tagTypes: Array<{ name: string; color: string }>,
  class_id: number,
  userType: "student" | "grader",
  creatorId: string
) {
  const batchSize = 100;
  const assignments = [];

  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    console.log(`    Processing ${userType}s ${i + 1}-${Math.min(i + batchSize, users.length)} of ${users.length}...`);

    // Process this batch of users in parallel
    const batchPromises = batch.map(async (user) => {
      // Randomly assign to class section (all users get one)
      const classSection = classSections[Math.floor(Math.random() * classSections.length)];

      // Randomly assign to lab section (students only, ~80% chance)
      let labSection = null;
      if (userType === "student" && Math.random() < 0.8) {
        labSection = labSections[Math.floor(Math.random() * labSections.length)];
      }

      // Update user role with section assignments
      const { error: updateError } = await supabase
        .from("user_roles")
        .update({
          class_section_id: classSection.id,
          lab_section_id: labSection?.id || null
        })
        .eq("class_id", class_id)
        .eq("private_profile_id", user.private_profile_id);

      if (updateError) {
        throw new Error(`Failed to assign sections to user: ${updateError.message}`);
      }

      // Randomly assign tags (30-60% chance per tag type)
      const userTags = [];
      for (const tagType of tagTypes) {
        if (Math.random() < 0.3 + Math.random() * 0.3) {
          // 30-60% chance
          // Create a tag record for this user
          const { data: tagData, error: tagError } = await supabase
            .from("tags")
            .insert({
              class_id: class_id,
              name: tagType.name,
              color: tagType.color,
              visible: true,
              profile_id: user.private_profile_id,
              creator_id: creatorId
            })
            .select("id, name, color")
            .single();

          if (tagError) {
            console.warn(`Failed to create tag ${tagType.name} for user: ${tagError.message}`);
          } else {
            userTags.push(tagData);
          }
        }
      }

      return {
        user: user.email,
        classSection: classSection.name,
        labSection: labSection?.name || null,
        tags: userTags.map((t) => t.name)
      };
    });

    // Wait for all users in this batch to complete
    const batchResults = await Promise.all(batchPromises);
    assignments.push(...batchResults);
  }

  return assignments;
}

// Helper function to create grader conflicts based on specified patterns
async function insertGraderConflicts(
  graders: TestingUser[],
  students: TestingUser[],
  class_id: number,
  createdByProfileId: string
): Promise<void> {
  const conflictPatterns = [2, 3]; // Grader numbers to create conflicts for
  const conflictsToInsert: Array<{
    grader_profile_id: string;
    student_profile_id: string;
    class_id: number;
    reason: string;
    created_by_profile_id: string;
  }> = [];

  // Helper function to extract the number from a user's name
  function extractUserNumber(user: TestingUser): number | null {
    // Extract from private_profile_name which follows pattern: "Student #1Test", "Grader #2Test", etc.
    const match = user.private_profile_name.match(/#(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  // For each conflict pattern (grader numbers 2, 3, 5)
  for (const graderNumber of conflictPatterns) {
    // Find the grader with this number
    const targetGrader = graders.find((grader) => {
      const graderNum = extractUserNumber(grader);
      return graderNum === graderNumber;
    });

    if (!targetGrader) {
      console.warn(`⚠️ Could not find grader #${graderNumber}, skipping conflicts for this grader`);
      continue;
    }

    // Find all students whose numbers are divisible by the grader number
    const conflictedStudents = students.filter((student) => {
      const studentNum = extractUserNumber(student);
      return studentNum !== null && studentNum % graderNumber === 0;
    });

    console.log(
      `   Grader #${graderNumber} conflicts with ${conflictedStudents.length} students (divisible by ${graderNumber})`
    );

    // Create conflict records for each conflicted student
    conflictedStudents.forEach((student) => {
      const studentNum = extractUserNumber(student);
      conflictsToInsert.push({
        grader_profile_id: targetGrader.private_profile_id,
        student_profile_id: student.private_profile_id,
        class_id: class_id,
        reason: `Automated conflict: Grader #${graderNumber} conflicts with Student #${studentNum} (${studentNum} is divisible by ${graderNumber})`,
        created_by_profile_id: createdByProfileId
      });
    });
  }

  if (conflictsToInsert.length === 0) {
    console.log("   No conflicts to insert");
    return;
  }

  // Batch insert all conflicts
  const CONFLICT_BATCH_SIZE = 100;
  const conflictChunks = chunkArray(conflictsToInsert, CONFLICT_BATCH_SIZE);

  console.log(`   Inserting ${conflictsToInsert.length} grader conflicts in ${conflictChunks.length} batches...`);

  await Promise.all(
    conflictChunks.map(async (chunk, index) => {
      const { error: conflictError } = await supabase.from("grading_conflicts").insert(chunk);

      if (conflictError) {
        throw new Error(`Failed to insert grader conflicts (batch ${index + 1}): ${conflictError.message}`);
      }
    })
  );

  console.log(`✓ Created ${conflictsToInsert.length} grader conflicts`);

  // Log summary of conflicts created
  const conflictSummary = conflictPatterns
    .map((graderNum) => {
      const conflicts = conflictsToInsert.filter((c) => c.reason.includes(`Grader #${graderNum}`));
      return `Grader #${graderNum}: ${conflicts.length} conflicts`;
    })
    .join(", ");

  console.log(`   Summary: ${conflictSummary}`);
}

// Helper function to create workflow events for submissions (for statistics)
async function createWorkflowEvents(
  submissions: Array<{
    submission_id: number;
    assignment: { id: number; due_date: string } & Record<string, unknown>;
    student?: TestingUser;
    group?: { id: number; name: string; memberCount: number; members: string[] };
    repository_id?: number;
  }>,
  class_id: number
): Promise<void> {
  if (submissions.length === 0) {
    console.log("   No submissions to create workflow events for");
    return;
  }

  console.log(`   Creating workflow events for ${submissions.length} submissions`);

  const workflowEventsToCreate: Database["public"]["Tables"]["workflow_events"]["Insert"][] = [];
  const now = new Date();

  for (const submission of submissions) {
    if (!submission.repository_id) {
      console.warn(`Skipping submission ${submission.submission_id} - no repository_id`);
      continue;
    }

    // Create 1-3 workflow runs per submission (representing multiple attempts)
    const numRuns = Math.floor(Math.random() * 3) + 1;

    for (let runIndex = 0; runIndex < numRuns; runIndex++) {
      const workflowRunId = 1000000 + submission.submission_id * 10 + runIndex;
      const runNumber = runIndex + 1;
      const runAttempt = 1;

      // Generate realistic repository name based on submission
      const repositoryName = `student-repo-${submission.submission_id}`;
      const headSha = `abc123${submission.submission_id.toString().padStart(6, "0")}${runIndex.toString()}ef`;
      const actorLogin = submission.student?.email.split("@")[0] || `group-${submission.group?.id}`;

      // Create realistic timing patterns
      // Recent submissions have faster queue times, older ones have varied patterns
      const submissionAge =
        Math.abs(now.getTime() - new Date(submission.assignment.due_date).getTime()) / (1000 * 60 * 60 * 24); // days

      let baseQueueTime: number;
      let baseRunTime: number;

      if (submissionAge < 1) {
        // Very recent - fast processing (last 24 hours)
        baseQueueTime = 15 + Math.random() * 45; // 15-60 seconds
        baseRunTime = 45 + Math.random() * 75; // 45-120 seconds
      } else if (submissionAge < 7) {
        // Recent week - moderate processing
        baseQueueTime = 30 + Math.random() * 120; // 30-150 seconds
        baseRunTime = 60 + Math.random() * 120; // 60-180 seconds
      } else if (submissionAge < 30) {
        // Last month - varied processing
        baseQueueTime = 60 + Math.random() * 300; // 1-6 minutes
        baseRunTime = 90 + Math.random() * 210; // 90-300 seconds
      } else {
        // Older - potentially slower processing
        baseQueueTime = 120 + Math.random() * 600; // 2-12 minutes
        baseRunTime = 120 + Math.random() * 480; // 2-10 minutes
      }

      // Add some variance for retry attempts
      if (runIndex > 0) {
        baseQueueTime *= 1 + runIndex * 0.3; // Subsequent runs take longer to queue
        baseRunTime *= 0.8 + Math.random() * 0.4; // But might run faster/slower
      }

      const queueTimeSeconds = Math.round(baseQueueTime);
      const runTimeSeconds = Math.round(baseRunTime);

      // Calculate realistic timestamps
      const dueDate = new Date(submission.assignment.due_date);
      const submissionTime = new Date(dueDate.getTime() - Math.random() * 24 * 60 * 60 * 1000); // Up to 24h before due
      const requestedAt = new Date(submissionTime.getTime() + runIndex * 10 * 60 * 1000); // 10 minutes between attempts
      const inProgressAt = new Date(requestedAt.getTime() + queueTimeSeconds * 1000);
      const completedAt = new Date(inProgressAt.getTime() + runTimeSeconds * 1000);

      // Determine final outcome based on patterns
      const isCompleted = Math.random() < 0.95; // 95% completion rate
      const isSuccess = isCompleted && Math.random() < 0.85; // 85% success rate when completed

      // Create base workflow event data
      const baseWorkflowEvent = {
        workflow_run_id: workflowRunId,
        repository_name: repositoryName,
        class_id: class_id,
        workflow_name: "Grade Assignment",
        workflow_path: ".github/workflows/grade.yml",
        head_sha: headSha,
        head_branch: "main",
        run_number: runNumber,
        repository_id: submission.repository_id || null,
        run_attempt: runAttempt,
        actor_login: actorLogin,
        triggering_actor_login: actorLogin,
        pull_requests: null
      };

      // ALWAYS create events in chronological order: queued → in_progress → completed (if completed)

      // 1. QUEUED/REQUESTED event
      workflowEventsToCreate.push({
        ...baseWorkflowEvent,
        event_type: "requested",
        status: "queued",
        conclusion: null,
        created_at: requestedAt.toISOString(),
        started_at: requestedAt.toISOString(),
        updated_at: requestedAt.toISOString(),
        run_started_at: requestedAt.toISOString(),
        run_updated_at: requestedAt.toISOString(),
        payload: {
          action: "requested",
          workflow_run: {
            id: workflowRunId,
            status: "queued",
            conclusion: null
          }
        }
      });

      // 2. IN_PROGRESS event
      workflowEventsToCreate.push({
        ...baseWorkflowEvent,
        event_type: "in_progress",
        status: "in_progress",
        conclusion: null,
        created_at: requestedAt.toISOString(),
        started_at: inProgressAt.toISOString(),
        updated_at: inProgressAt.toISOString(),
        run_started_at: inProgressAt.toISOString(),
        run_updated_at: inProgressAt.toISOString(),
        payload: {
          action: "in_progress",
          workflow_run: {
            id: workflowRunId,
            status: "in_progress",
            conclusion: null
          }
        }
      });

      // 3. COMPLETED event (if the workflow completed)
      if (isCompleted) {
        const finalConclusion = isSuccess ? "success" : "failure";
        workflowEventsToCreate.push({
          ...baseWorkflowEvent,
          event_type: "completed",
          status: "completed",
          conclusion: finalConclusion,
          created_at: requestedAt.toISOString(),
          started_at: inProgressAt.toISOString(),
          updated_at: completedAt.toISOString(),
          run_started_at: inProgressAt.toISOString(),
          run_updated_at: completedAt.toISOString(),
          payload: {
            action: "completed",
            workflow_run: {
              id: workflowRunId,
              status: "completed",
              conclusion: finalConclusion
            }
          }
        });
      }
    }
  }

  // Batch insert workflow events
  if (workflowEventsToCreate.length > 0) {
    const BATCH_SIZE = 500;
    const chunks = chunkArray(workflowEventsToCreate, BATCH_SIZE);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const { error: workflowEventsError } = await supabase.from("workflow_events").insert(chunk);

      if (workflowEventsError) {
        throw new Error(`Failed to create workflow events (batch ${i + 1}): ${workflowEventsError.message}`);
      }

      console.log(`   ✓ Created batch ${i + 1}/${chunks.length} (${chunk.length} events)`);
    }

    console.log(`   ✓ Created ${workflowEventsToCreate.length} workflow events total`);

    // Log statistics
    const completedEvents = workflowEventsToCreate.filter((e) => e.status === "completed");
    const successRate = completedEvents.filter((e) => e.conclusion === "success").length / completedEvents.length;

    console.log(`   Statistics: ${completedEvents.length} completed, success: ${Math.round(successRate * 100)}%`);
  }
}

// Helper function to create workflow errors for submissions
async function createWorkflowErrors(
  submissions: Array<{
    submission_id: number;
    assignment: { id: number; due_date: string } & Record<string, unknown>;
    student?: TestingUser;
    group?: { id: number; name: string; memberCount: number; members: string[] };
    repository_id?: number;
  }>,
  class_id: number
): Promise<void> {
  // Select 20% of submissions to have errors
  const submissionsWithErrors = submissions
    .filter(() => Math.random() < 0.2)
    .slice(0, Math.floor(submissions.length * 0.2));

  if (submissionsWithErrors.length === 0) {
    console.log("   No submissions selected for workflow errors");
    return;
  }

  console.log(`   Creating errors for ${submissionsWithErrors.length} submissions (20% of ${submissions.length})`);

  // Define clever and deterministic error messages
  const userVisibleErrors = [
    "Submission is late by 2 hours - late penalty applied",
    "Missing required file: README.md - please add documentation",
    "File size exceeds limit: main.java is 15MB, max allowed is 10MB",
    "Invalid file format: .docx files not allowed, use .txt or .md",
    "Compilation failed: syntax error on line 42 in Calculator.java",
    "Missing dependencies: package.json not found in submission",
    "Test timeout: unit tests took longer than 30 seconds to complete",
    "Memory limit exceeded: program used 2GB, limit is 1GB",
    "Duplicate submission detected: previous submission at 14:32 will be used",
    "Branch mismatch: submitted from 'develop' branch, expected 'main'",
    "Commit message too short: minimum 10 characters required",
    "Binary files detected: .exe files are not allowed in submissions",
    "Plagiarism check failed: 85% similarity with another submission",
    "Missing unit tests: no test files found in src/test/ directory",
    "Code quality issue: cyclomatic complexity exceeds threshold",
    "Forbidden keyword usage: 'System.exit()' not allowed in submissions",
    "File encoding error: non-UTF-8 characters detected in source code",
    "Missing required method: 'main()' method not found in entry class",
    "Import restrictions violated: java.io.File package not permitted",
    "Submission format error: expected .zip file, received .rar"
  ];

  const securityErrors = [
    "Security scan failed: potential SQL injection vulnerability detected",
    "Unsafe file operations: direct file system access not permitted",
    "Network access violation: HTTP requests blocked in sandbox environment",
    "Privilege escalation attempt: sudo commands detected in script",
    "Malicious pattern found: base64 encoded payload in comments",
    "Cryptographic weakness: hardcoded encryption keys discovered",
    "Path traversal vulnerability: '../' sequences found in file operations",
    "Command injection risk: user input directly passed to shell",
    "Buffer overflow potential: unsafe string operations detected",
    "Cross-site scripting vector: unescaped user data in HTML output",
    "Deserialization vulnerability: unsafe object deserialization found",
    "Information disclosure: database credentials exposed in code",
    "Insecure random generation: predictable seed values used",
    "Authentication bypass: hardcoded admin credentials detected",
    "Race condition vulnerability: unsynchronized shared resource access"
  ];

  const instructorConfigErrors = [
    "Instructor action required: update autograder timeout to 45 seconds",
    "Configuration mismatch: expected Java 11, but runner uses Java 8",
    "Grading rubric incomplete: missing criteria for code style section",
    "Test suite outdated: unit tests need update for new requirements",
    "Resource allocation error: increase memory limit to 2GB for this assignment",
    "Docker image misconfigured: missing required build tools in container",
    "Assignment template error: starter code has compilation errors",
    "Deadline configuration issue: due date conflicts with university holiday",
    "GitHub webhook failure: repository permissions need instructor review",
    "Plagiarism detector offline: manual review required for submissions",
    "Grade export blocked: Canvas integration credentials expired",
    "Autograder script error: contact TA to fix grading pipeline issue",
    "Class repository locked: instructor needs to update access permissions",
    "Feedback template missing: add comment templates for common issues",
    "Extension policy undefined: set clear rules for late submission handling"
  ];

  // Create workflow errors using repository_id reference
  const workflowErrorsToCreate = [];

  for (const submission of submissionsWithErrors) {
    // Skip submissions without repository_id
    if (!submission.repository_id) {
      console.warn(`Skipping submission ${submission.submission_id} - no repository_id`);
      continue;
    }

    const runAttempt = 1;
    const runNumber = Math.floor(Math.random() * 100) + 1;

    // Generate 1-5 errors per submission
    const numErrors = Math.floor(Math.random() * 5) + 1;

    for (let i = 0; i < numErrors; i++) {
      // Use submission ID and error index to deterministically select error type
      const errorTypeIndex = (submission.submission_id + i) % 3;
      let errorMessage: string;
      let isPrivate: boolean;
      let errorType: string;

      if (errorTypeIndex === 0) {
        // User visible error
        const messageIndex = (submission.submission_id + i) % userVisibleErrors.length;
        errorMessage = userVisibleErrors[messageIndex];
        isPrivate = Math.random() < 0.3; // 30% chance to be private
        errorType = "user_visible_error";
      } else if (errorTypeIndex === 1) {
        // Security error (always private)
        const messageIndex = (submission.submission_id + i) % securityErrors.length;
        errorMessage = securityErrors[messageIndex];
        isPrivate = true;
        errorType = "security_error";
      } else {
        // Instructor config error
        const messageIndex = (submission.submission_id + i) % instructorConfigErrors.length;
        errorMessage = instructorConfigErrors[messageIndex];
        isPrivate = Math.random() < 0.5; // 50% chance to be private
        errorType = "config_error";
      }

      workflowErrorsToCreate.push({
        submission_id: submission.submission_id,
        class_id: class_id,
        repository_id: submission.repository_id,
        run_number: runNumber,
        run_attempt: runAttempt,
        name: errorMessage,
        data: { type: errorType },
        is_private: isPrivate,
        created_at: new Date(Date.now() - Math.random() * 86400000 * 7).toISOString()
      });
    }
  }

  // Batch insert workflow errors
  if (workflowErrorsToCreate.length > 0) {
    const { error: workflowErrorsError } = await supabase.from("workflow_run_error").insert(workflowErrorsToCreate);

    if (workflowErrorsError) {
      throw new Error(`Failed to create workflow errors: ${workflowErrorsError.message}`);
    }

    console.log(`   ✓ Created ${workflowErrorsToCreate.length} workflow errors`);

    // Log breakdown by type
    const userVisibleCount = workflowErrorsToCreate.filter((e) => e.data.type === "user_visible_error").length;
    const securityCount = workflowErrorsToCreate.filter((e) => e.data.type === "security_error").length;
    const configCount = workflowErrorsToCreate.filter((e) => e.data.type === "config_error").length;
    const privateCount = workflowErrorsToCreate.filter((e) => e.is_private).length;

    console.log(
      `   Error breakdown: ${userVisibleCount} user-visible, ${securityCount} security, ${configCount} config`
    );
    console.log(
      `   Privacy breakdown: ${privateCount} private, ${workflowErrorsToCreate.length - privateCount} public`
    );
  }
}

// Sample help request messages for realistic data
const HELP_REQUEST_TEMPLATES = [
  "My algorithm keeps timing out on large datasets - any optimization tips?",
  "Having trouble with memory management in my implementation",
  "Getting a stack overflow error when recursion depth gets too high",
  "My sorting algorithm works but seems inefficient - suggestions for improvement?",
  "Struggling with edge cases in my binary search implementation",
  "Need help debugging this segmentation fault in my C++ code",
  "My program compiles but gives wrong output for certain test cases",
  "Having issues with concurrent programming - thread safety concerns",
  "My database query is running too slowly, need performance optimization",
  "Getting unexpected behavior with pointer arithmetic",
  "My neural network isn't converging - what hyperparameters should I adjust?",
  "Need help understanding the requirements for the dynamic programming solution",
  "My unit tests are failing intermittently - not sure why",
  "Having trouble with the graph traversal algorithm implementation",
  "My web app crashes under high load - need scalability advice",
  "Getting strange compiler errors that I can't figure out",
  "Need help with debugging this race condition",
  "My machine learning model is overfitting - how to regularize?",
  "Having issues with API integration and error handling",
  "My algorithm works for small inputs but fails for large ones"
];

const HELP_REQUEST_REPLIES = [
  "Have you tried using memoization to optimize your recursive calls?",
  "Consider using a different data structure - maybe a hash table would help?",
  "Try profiling your code to identify the bottleneck",
  "You might want to implement tail recursion optimization",
  "Check if you're creating unnecessary objects in your loop",
  "Have you considered using a more efficient sorting algorithm?",
  "Try adding some debug prints to trace the execution flow",
  "Make sure you're handling boundary conditions correctly",
  "Consider using parallel processing for large datasets",
  "You might need to increase the stack size for deep recursion",
  "Try breaking down the problem into smaller subproblems",
  "Check your loop invariants and termination conditions",
  "Consider using a different approach - maybe iterative instead of recursive?",
  "Make sure you're not accessing memory out of bounds",
  "Try using a debugger to step through your code line by line",
  "Have you tested with edge cases like empty input or single elements?",
  "Consider optimizing your space complexity if time complexity is already good",
  "You might want to use a more appropriate design pattern here",
  "Try caching expensive computations to avoid redundant work",
  "Make sure your algorithm has the correct time complexity"
];

// Helper function to create help requests with replies and members
async function createHelpRequests({
  class_id,
  students,
  instructors,
  numHelpRequests,
  minRepliesPerRequest,
  maxRepliesPerRequest,
  maxMembersPerRequest
}: {
  class_id: number;
  students: TestingUser[];
  instructors: TestingUser[];
  numHelpRequests: number;
  minRepliesPerRequest: number;
  maxRepliesPerRequest: number;
  maxMembersPerRequest: number;
}): Promise<void> {
  console.log(`\n🆘 Creating ${numHelpRequests} help requests...`);

  // First, create a help queue if it doesn't exist
  const { data: existingQueue } = await supabase.from("help_queues").select("id").eq("class_id", class_id).single();

  let queueId: number;
  if (existingQueue) {
    queueId = existingQueue.id;
  } else {
    const { data: queueData, error: queueError } = await supabase
      .from("help_queues")
      .insert({
        class_id: class_id,
        name: "Office Hours",
        description: "General office hours help queue",
        depth: 1,
        queue_type: "video"
      })
      .select("id")
      .single();

    if (queueError) {
      throw new Error(`Failed to create help queue: ${queueError.message}`);
    }
    queueId = queueData.id;
  }

  // Create help requests in batches
  const BATCH_SIZE = 50;
  const helpRequestBatches = chunkArray(
    Array.from({ length: numHelpRequests }, (_, i) => i),
    BATCH_SIZE
  );

  let totalCreated = 0;
  let totalResolved = 0;

  for (const batch of helpRequestBatches) {
    console.log(
      `  Creating help requests batch ${helpRequestBatches.indexOf(batch) + 1}/${helpRequestBatches.length}...`
    );

    const batchPromises = batch.map(async () => {
      // Select a random student as the creator
      const creator = students[Math.floor(Math.random() * students.length)];
      const isPrivate = Math.random() < 0.3; // 30% chance of being private
      const isResolved = Math.random() < 0.8; // 80% chance of being resolved
      const status = isResolved ? (Math.random() < 0.5 ? "resolved" : "closed") : "open";

      // Select a random help request template
      const messageTemplate = HELP_REQUEST_TEMPLATES[Math.floor(Math.random() * HELP_REQUEST_TEMPLATES.length)];

      // Create the help request
      const { data: helpRequestData, error: helpRequestError } = await supabase
        .from("help_requests")
        .insert({
          class_id: class_id,
          help_queue: queueId,
          request: messageTemplate,
          is_private: isPrivate,
          status: status,
          created_by: creator.private_profile_id,
          assignee: isResolved ? instructors[Math.floor(Math.random() * instructors.length)].private_profile_id : null,
          resolved_at: isResolved ? new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString() : null // Random time in last 7 days
        })
        .select("id")
        .single();

      if (helpRequestError) {
        throw new Error(`Failed to create help request: ${helpRequestError.message}`);
      }

      const helpRequestId = helpRequestData.id;

      // Add the creator as a member
      await supabase.from("help_request_students").insert({
        help_request_id: helpRequestId,
        profile_id: creator.private_profile_id,
        class_id: class_id
      });

      // Add additional members (1 to maxMembersPerRequest total members)
      const numMembers = Math.floor(Math.random() * maxMembersPerRequest) + 1;
      const additionalMembers = Math.min(numMembers - 1, students.length - 1); // -1 because creator is already added

      if (additionalMembers > 0) {
        const availableStudents = students.filter((s) => s.private_profile_id !== creator.private_profile_id);
        const selectedMembers = availableStudents.sort(() => Math.random() - 0.5).slice(0, additionalMembers);

        const memberInserts = selectedMembers.map((student) => ({
          help_request_id: helpRequestId,
          profile_id: student.private_profile_id,
          class_id: class_id
        }));

        if (memberInserts.length > 0) {
          await supabase.from("help_request_students").insert(memberInserts);
        }
      }

      // Create replies (messages)
      const numReplies =
        Math.floor(Math.random() * (maxRepliesPerRequest - minRepliesPerRequest + 1)) + minRepliesPerRequest;

      if (numReplies > 0) {
        const allParticipants = [creator, ...instructors];
        const messageInserts = [];

        for (let i = 0; i < numReplies; i++) {
          const isFromInstructor = Math.random() < 0.4; // 40% chance message is from instructor
          const sender = isFromInstructor
            ? instructors[Math.floor(Math.random() * instructors.length)]
            : allParticipants[Math.floor(Math.random() * allParticipants.length)];

          const replyTemplate = HELP_REQUEST_REPLIES[Math.floor(Math.random() * HELP_REQUEST_REPLIES.length)];
          const messageTime = new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000); // Random time in last 7 days

          messageInserts.push({
            help_request_id: helpRequestId,
            author: sender.private_profile_id,
            message: replyTemplate,
            class_id: class_id,
            instructors_only: isPrivate && Math.random() < 0.2, // 20% of private request messages are instructor-only
            created_at: messageTime.toISOString()
          });
        }

        if (messageInserts.length > 0) {
          await supabase.from("help_request_messages").insert(messageInserts);
        }
      }

      if (isResolved) {
        totalResolved++;
      }
      totalCreated++;
    });

    await Promise.all(batchPromises);
  }

  console.log(
    `✓ Created ${totalCreated} help requests (${totalResolved} resolved/closed, ${totalCreated - totalResolved} open)`
  );
}
interface SeedingOptions {
  numStudents: number;
  numGraders: number;
  numInstructors: number;
  numAssignments: number;
  firstAssignmentDate: Date;
  lastAssignmentDate: Date;
  numManualGradedColumns?: number;
  rubricConfig?: {
    minPartsPerAssignment: number;
    maxPartsPerAssignment: number;
    minCriteriaPerPart: number;
    maxCriteriaPerPart: number;
    minChecksPerCriteria: number;
    maxChecksPerCriteria: number;
  };
  sectionsAndTagsConfig?: {
    numClassSections: number;
    numLabSections: number;
    numStudentTags: number;
    numGraderTags: number;
  };
  labAssignmentConfig?: {
    numLabAssignments: number;
    minutesDueAfterLab: number;
  };
  groupAssignmentConfig?: {
    numGroupAssignments: number;
    numLabGroupAssignments: number;
  };
  helpRequestConfig?: {
    numHelpRequests: number;
    minRepliesPerRequest: number;
    maxRepliesPerRequest: number;
    maxMembersPerRequest: number;
  };
  discussionConfig?: {
    postsPerTopic: number;
    maxRepliesPerPost: number;
  };
  gradingScheme?: "current" | "specification";
}

// Helper function to seed discussion threads
async function seedDiscussionThreads({
  class_id,
  students,
  instructors,
  graders,
  postsPerTopic,
  maxRepliesPerPost
}: {
  class_id: number;
  students: TestingUser[];
  instructors: TestingUser[];
  graders: TestingUser[];
  postsPerTopic: number;
  maxRepliesPerPost: number;
}) {
  console.log(`\n💬 Creating discussion threads...`);
  console.log(`   Posts per topic: ${postsPerTopic}`);
  console.log(`   Max replies per post: ${maxRepliesPerPost}`);

  // Get the discussion topics for this class (auto-created by triggers)
  const { data: discussionTopics, error: topicsError } = await supabase
    .from("discussion_topics")
    .select("*")
    .eq("class_id", class_id)
    .order("ordinal");

  if (topicsError) {
    console.error("Error fetching discussion topics:", topicsError);
    throw topicsError;
  }

  if (!discussionTopics || discussionTopics.length === 0) {
    console.log("No discussion topics found - they should be auto-created by triggers");
    return;
  }

  console.log(`Found ${discussionTopics.length} discussion topics: ${discussionTopics.map((t) => t.topic).join(", ")}`);

  // All users who can post (students, instructors, graders)
  const allUsers = [...students, ...instructors, ...graders];

  // Question subjects for different topics
  const topicSubjects = {
    Assignments: [
      "Homework 1 clarification needed",
      "Project submission format?",
      "Due date extension request",
      "Grading rubric question",
      "Partner work allowed?",
      "Late submission policy",
      "Assignment requirements unclear",
      "Help with problem 3",
      "Resubmission allowed?",
      "Group work guidelines"
    ],
    Logistics: [
      "Office hours schedule",
      "Exam dates confirmed?",
      "Class cancelled today?",
      "Final exam format",
      "Missing lecture notes",
      "Room change notification",
      "Midterm review session",
      "Course syllabus update",
      "Grade distribution",
      "Contact TA question"
    ],
    Readings: [
      "Chapter 5 discussion",
      "Required vs optional readings",
      "Paper analysis help",
      "Research methodology question",
      "Citation format clarification",
      "Additional resources?",
      "Textbook alternatives",
      "Reading comprehension check",
      "Key concepts summary",
      "Follow-up questions"
    ],
    Memes: [
      "When you finally understand recursion",
      "Debugging at 3am be like...",
      "That feeling when code compiles",
      "Coffee addiction level: programmer",
      "Stack overflow saves the day again",
      "When the semester starts vs ends",
      "Professor vs student expectations",
      "Group project dynamics",
      "Finals week survival guide",
      "Coding bootcamp vs reality"
    ]
  };

  // Bodies for different types of posts
  const questionBodies = [
    "Can someone help me understand this concept? I've been struggling with it for hours.",
    "I'm not sure I understand the requirements correctly. Could someone clarify?",
    "Has anyone else encountered this issue? Looking for advice.",
    "What's the best approach for solving this type of problem?",
    "Can someone point me to relevant resources on this topic?",
    "I'm getting confused by the instructions. Any help would be appreciated.",
    "Quick question about the implementation details...",
    "Not sure if my understanding is correct. Can someone verify?",
    "Looking for study group partners for this topic.",
    "What are the common pitfalls to avoid here?"
  ];

  const replyBodies = [
    "Thanks for asking this! I had the same question.",
    "Great point! I hadn't considered that perspective.",
    "Here's what worked for me in a similar situation...",
    "I think the key is to focus on the fundamentals first.",
    "Actually, I believe there might be another way to approach this.",
    "This helped clarify things for me too!",
    "Good catch - that's an important detail to remember.",
    "I found this resource helpful: [example link]",
    "Building on what others have said...",
    "That makes perfect sense now, thank you!",
    "I had a similar issue and solved it by...",
    "Totally agree with the previous responses.",
    "Just to add to this discussion...",
    "This is exactly what I needed to know!",
    "Another thing to consider is..."
  ];

  // Track created threads for replies
  const createdThreads: Array<{ id: number; topic_id: number; is_question: boolean }> = [];

  // Create root posts for each topic
  for (const topic of discussionTopics) {
    const subjectsForTopic = topicSubjects[topic.topic as keyof typeof topicSubjects] || ["General discussion"];

    for (let i = 0; i < postsPerTopic; i++) {
      const user = faker.helpers.arrayElement(allUsers);
      const isAnonymous = faker.datatype.boolean(0.3); // 30% chance of anonymous posting
      const isQuestion = faker.datatype.boolean(0.6); // 60% chance of being a question
      const authorId = isAnonymous ? user.public_profile_id : user.private_profile_id;

      const subject = faker.helpers.arrayElement(subjectsForTopic);
      const body = isQuestion
        ? faker.helpers.arrayElement(questionBodies)
        : faker.lorem.paragraphs(faker.number.int({ min: 2, max: 10 }));

      const { data: thread, error: threadError } = await supabase
        .from("discussion_threads")
        .insert({
          author: authorId,
          subject,
          body,
          class_id,
          topic_id: topic.id,
          is_question: isQuestion,
          instructors_only: false,
          draft: false,
          root_class_id: class_id // Set for root threads
        })
        .select("id")
        .single();

      if (threadError) {
        console.error(`Error creating discussion thread for topic ${topic.topic}:`, threadError);
        throw new Error(`Failed to create discussion thread for topic ${topic.topic}: ${threadError.message}`);
      }

      if (thread) {
        createdThreads.push({
          id: thread.id,
          topic_id: topic.id,
          is_question: isQuestion
        });
      }
    }
  }

  console.log(`✓ Created ${createdThreads.length} root discussion threads`);

  // Create replies to the root posts
  let totalReplies = 0;
  for (const rootThread of createdThreads) {
    const numReplies = faker.number.int({ min: 1, max: maxRepliesPerPost });

    for (let i = 0; i < numReplies; i++) {
      const user = faker.helpers.arrayElement(allUsers);
      const isAnonymous = faker.datatype.boolean(0.25); // 25% chance of anonymous replies
      const authorId = isAnonymous ? user.public_profile_id : user.private_profile_id;

      const body = faker.helpers.arrayElement(replyBodies);

      const { data: reply, error: replyError } = await supabase
        .from("discussion_threads")
        .insert({
          author: authorId,
          subject: "Re: Discussion Reply",
          body,
          class_id,
          topic_id: rootThread.topic_id,
          parent: rootThread.id,
          root: rootThread.id,
          is_question: false, // Replies are typically not questions
          instructors_only: false,
          draft: false
          // root_class_id stays null for non-root threads
        })
        .select("id")
        .single();

      if (replyError) {
        console.error(`Error creating reply to thread ${rootThread.id}:`, replyError);
        throw new Error(`Failed to create reply to thread ${rootThread.id}: ${replyError.message}`);
      }

      totalReplies++;

      // Sometimes mark a reply as an answer if the root post was a question
      if (reply && rootThread.is_question && faker.datatype.boolean(0.3)) {
        // 30% chance
        await supabase.from("discussion_threads").update({ answer: reply.id }).eq("id", rootThread.id);
      }
    }
  }

  console.log(`✓ Created ${totalReplies} replies to discussion threads`);
  console.log(`✓ Discussion threads seeding completed`);
}

async function seedInstructorDashboardData(options: SeedingOptions) {
  const {
    numStudents,
    numGraders,
    numInstructors,
    numAssignments,
    firstAssignmentDate,
    lastAssignmentDate,
    numManualGradedColumns,
    rubricConfig,
    sectionsAndTagsConfig,
    labAssignmentConfig,
    groupAssignmentConfig,
    helpRequestConfig,
    discussionConfig,
    gradingScheme = "current"
  } = options;

  // Default rubric configuration if not provided
  const defaultRubricConfig = {
    minPartsPerAssignment: 2,
    maxPartsPerAssignment: 4,
    minCriteriaPerPart: 1,
    maxCriteriaPerPart: 2,
    minChecksPerCriteria: 2,
    maxChecksPerCriteria: 3
  };

  const effectiveRubricConfig = rubricConfig || defaultRubricConfig;

  // Default sections and tags configuration if not provided
  const defaultSectionsAndTagsConfig = {
    numClassSections: 2,
    numLabSections: 2,
    numStudentTags: 2,
    numGraderTags: 4
  };

  const effectiveSectionsAndTagsConfig = sectionsAndTagsConfig || defaultSectionsAndTagsConfig;

  // Default lab assignment configuration if not provided
  const defaultLabAssignmentConfig = {
    numLabAssignments: Math.floor(numAssignments * 0.3), // 30% of assignments are lab assignments
    minutesDueAfterLab: 1440 // 24 hours (1440 minutes)
  };

  const effectiveLabAssignmentConfig = labAssignmentConfig || defaultLabAssignmentConfig;

  // Default group assignment configuration if not provided
  const defaultGroupAssignmentConfig = {
    numGroupAssignments: Math.floor((numAssignments - effectiveLabAssignmentConfig.numLabAssignments) * 0.4), // 40% of regular assignments
    numLabGroupAssignments: Math.floor(effectiveLabAssignmentConfig.numLabAssignments * 0.5) // 50% of lab assignments
  };

  const effectiveGroupAssignmentConfig = groupAssignmentConfig || defaultGroupAssignmentConfig;

  // Default manual graded columns configuration if not provided
  const effectiveNumManualGradedColumns = numManualGradedColumns || 0;

  console.log("🌱 Starting instructor dashboard data seeding...\n");
  console.log(`📊 Configuration:`);
  console.log(`   Students: ${numStudents}`);
  console.log(`   Graders: ${numGraders}`);
  console.log(`   Instructors: ${numInstructors}`);
  console.log(`   Assignments: ${numAssignments}`);
  console.log(`   Lab Assignments: ${effectiveLabAssignmentConfig.numLabAssignments}`);
  console.log(`   Group Assignments: ${effectiveGroupAssignmentConfig.numGroupAssignments}`);
  console.log(`   Lab Group Assignments: ${effectiveGroupAssignmentConfig.numLabGroupAssignments}`);
  console.log(`   Minutes Due After Lab: ${effectiveLabAssignmentConfig.minutesDueAfterLab}`);
  console.log(`   Manual Graded Columns: ${effectiveNumManualGradedColumns}`);
  console.log(`   First Assignment: ${firstAssignmentDate.toISOString().split("T")[0]}`);
  console.log(`   Last Assignment: ${lastAssignmentDate.toISOString().split("T")[0]}`);
  console.log(
    `   Rubric Parts Range: ${effectiveRubricConfig.minPartsPerAssignment}-${effectiveRubricConfig.maxPartsPerAssignment}`
  );
  console.log(
    `   Criteria per Part: ${effectiveRubricConfig.minCriteriaPerPart}-${effectiveRubricConfig.maxCriteriaPerPart}`
  );
  console.log(
    `   Checks per Criteria: ${effectiveRubricConfig.minChecksPerCriteria}-${effectiveRubricConfig.maxChecksPerCriteria}`
  );
  console.log(`   Class Sections: ${effectiveSectionsAndTagsConfig.numClassSections}`);
  console.log(`   Lab Sections: ${effectiveSectionsAndTagsConfig.numLabSections}`);
  console.log(`   Student Tags: ${effectiveSectionsAndTagsConfig.numStudentTags}`);
  console.log(`   Grader Tags: ${effectiveSectionsAndTagsConfig.numGraderTags}`);
  if (helpRequestConfig) {
    console.log(`   Help Requests: ${helpRequestConfig.numHelpRequests}`);
    console.log(
      `   Replies per Request: ${helpRequestConfig.minRepliesPerRequest}-${helpRequestConfig.maxRepliesPerRequest}`
    );
    console.log(`   Max Members per Request: ${helpRequestConfig.maxMembersPerRequest}`);
  }
  if (discussionConfig) {
    console.log(`   Discussion Posts per Topic: ${discussionConfig.postsPerTopic}`);
    console.log(`   Max Replies per Post: ${discussionConfig.maxRepliesPerPost}`);
  }
  console.log("");

  try {
    // Create test class using TestingUtils
    const testClass = await createClass({ name: process.env.CLASS_NAME || "Test Class" });
    const class_id = testClass.id;
    console.log(`✓ Created test class: ${testClass.name} (ID: ${class_id})`);

    // Find existing users first, then create new ones as needed
    console.log("\n👥 Finding existing @pawtograder.net users and creating test users...");

    const existingUsers = await findExistingPawtograderUsers();
    console.log(
      `Found ${existingUsers.instructors.length} existing instructors, ${existingUsers.graders.length} existing graders, ${existingUsers.students.length} existing students`
    );

    // Enroll existing users in the class and create additional users as needed
    console.log(
      `  Processing ${numInstructors} instructors (${existingUsers.instructors.length} existing + ${Math.max(0, numInstructors - existingUsers.instructors.length)} new)`
    );
    const existingInstructors = await Promise.all(
      existingUsers.instructors
        .slice(0, numInstructors)
        .map((user) => limiter.schedule(() => enrollExistingUserInClass(user, class_id)))
    );

    const newInstructorsNeeded = Math.max(0, numInstructors - existingInstructors.length);
    const newInstructors = await Promise.all(
      Array.from({ length: newInstructorsNeeded }).map(() =>
        authLimiter.schedule(async () => {
          const name = faker.person.fullName();
          const uuid = crypto.randomUUID();
          return createUserInClass({
            role: "instructor",
            class_id,
            name,
            email: `instructor-${uuid}-${RECYCLE_USERS_KEY}-demo@pawtograder.net`
          });
        })
      )
    );
    const instructors = [...existingInstructors, ...newInstructors];
    console.log(
      `✓ Using ${existingInstructors.length} existing + created ${newInstructors.length} new instructors = ${instructors.length} total`
    );

    console.log(
      `  Processing ${numGraders} graders (${existingUsers.graders.length} existing + ${Math.max(0, numGraders - existingUsers.graders.length)} new)`
    );
    const existingGraders = await Promise.all(
      existingUsers.graders
        .slice(0, numGraders)
        .map((user) => limiter.schedule(() => enrollExistingUserInClass(user, class_id)))
    );

    const newGradersNeeded = Math.max(0, numGraders - existingGraders.length);
    const newGraders = await Promise.all(
      Array.from({ length: newGradersNeeded }).map(() =>
        authLimiter.schedule(async () => {
          const name = faker.person.fullName();
          const uuid = crypto.randomUUID();
          return createUserInClass({
            role: "grader",
            class_id,
            name,
            email: `grader-${uuid}-${RECYCLE_USERS_KEY}-demo@pawtograder.net`
          });
        })
      )
    );
    const graders = [...existingGraders, ...newGraders];
    console.log(
      `✓ Using ${existingGraders.length} existing + created ${newGraders.length} new graders = ${graders.length} total`
    );

    console.log(
      `  Processing ${numStudents} students (${existingUsers.students.length} existing + ${Math.max(0, numStudents - existingUsers.students.length)} new)`
    );
    const existingStudents = await Promise.all(
      existingUsers.students
        .slice(0, numStudents)
        .map((user) => limiter.schedule(() => enrollExistingUserInClass(user, class_id)))
    );

    const newStudentsNeeded = Math.max(0, numStudents - existingStudents.length);
    const newStudents = await Promise.all(
      Array.from({ length: newStudentsNeeded }).map(() =>
        authLimiter.schedule(async () => {
          const name = faker.person.fullName();
          const uuid = crypto.randomUUID();
          return createUserInClass({
            role: "student",
            class_id,
            name,
            email: `student-${uuid}-${RECYCLE_USERS_KEY}-demo@pawtograder.net`
          });
        })
      )
    );
    const students = [...existingStudents, ...newStudents];
    console.log(
      `✓ Using ${existingStudents.length} existing + created ${newStudents.length} new students = ${students.length} total`
    );

    // Create sections and tags
    console.log("\n🏫 Creating class and lab sections...");
    const classSections = await createClassSections(class_id, effectiveSectionsAndTagsConfig.numClassSections);
    console.log(`✓ Created ${classSections.length} class sections`);

    // Create lab sections and distribute instructors among them
    const labSections = await createLabSections(class_id, effectiveSectionsAndTagsConfig.numLabSections, instructors);
    console.log(`✓ Created ${labSections.length} lab sections`);

    // Log instructor distribution among lab sections
    console.log("\n👨‍🏫 Instructor Distribution:");
    const instructorLabCounts = new Map<string, number>();
    labSections.forEach((section, index) => {
      const instructorIndex = index % instructors.length;
      const instructorName = instructors[instructorIndex].private_profile_name;
      instructorLabCounts.set(instructorName, (instructorLabCounts.get(instructorName) || 0) + 1);
    });
    instructorLabCounts.forEach((count, name) => {
      console.log(`   ${name}: ${count} lab section(s)`);
    });

    console.log("\n🏷️ Defining tag types...");
    const studentTagTypes = defineTagTypes("Student", effectiveSectionsAndTagsConfig.numStudentTags);
    console.log(`✓ Defined ${studentTagTypes.length} student tag types`);

    const graderTagTypes = defineTagTypes("Grader", effectiveSectionsAndTagsConfig.numGraderTags);
    console.log(`✓ Defined ${graderTagTypes.length} grader tag types`);

    // Assign users to sections and tags in parallel
    console.log("\n🎯 Assigning users to sections and tags in parallel...");
    await Promise.all([
      assignUsersToSectionsAndTags(
        students,
        classSections,
        labSections,
        studentTagTypes,
        class_id,
        "student",
        instructors[0].user_id
      ),
      assignUsersToSectionsAndTags(
        graders,
        classSections,
        labSections,
        graderTagTypes,
        class_id,
        "grader",
        instructors[0].user_id
      )
    ]);
    console.log(`✓ Assigned ${students.length} students and ${graders.length} graders to sections and tags`);

    // Create grader conflicts based on specified patterns
    console.log("\n⚔️ Creating grader conflicts based on specified patterns...");
    await insertGraderConflicts(graders, students, class_id, instructors[0].private_profile_id);

    // Create discussion threads first (before assignments)
    if (discussionConfig) {
      await seedDiscussionThreads({
        class_id,
        students,
        instructors,
        graders,
        postsPerTopic: discussionConfig.postsPerTopic,
        maxRepliesPerPost: discussionConfig.maxRepliesPerPost
      });
    }

    // Create assignments with enhanced rubric generation
    console.log("\n📚 Creating test assignments with diverse rubrics...");
    const now = new Date();

    // Calculate evenly spaced dates between first and last assignment
    const timeDiff = lastAssignmentDate.getTime() - firstAssignmentDate.getTime();
    const timeStep = timeDiff / (numAssignments - 1);

    const assignments: Array<{
      id: number;
      title: string;
      rubricChecks: Array<{ id: number; name: string; points: number; [key: string]: unknown }>;
      rubricParts: Array<{ id: number; name: string; [key: string]: unknown }>;
      groups: Array<{ id: number; name: string; memberCount: number; members: string[] }>;
      [key: string]: unknown;
    }> = [];
    const assignmentRubricSummaries: Array<{
      title: string;
      parts: number;
      totalChecks: number;
      partNames: string;
      isLabAssignment: boolean;
      isGroupAssignment: boolean;
    }> = [];
    const labAssignments: Array<{
      id: number;
      title: string;
      [key: string]: unknown;
    }> = [];
    const groupAssignments: Array<{
      id: number;
      title: string;
      [key: string]: unknown;
    }> = [];
    const labGroupAssignments: Array<{
      id: number;
      title: string;
      [key: string]: unknown;
    }> = [];

    // Calculate group size for this number of students
    const groupSize = calculateGroupSize(students.length);
    console.log(`   Group size: ${groupSize} students per group`);

    // Test the alternating pattern logic
    console.log(
      `\n🧪 Testing alternating pattern with ${numAssignments} total assignments, ${effectiveLabAssignmentConfig.numLabAssignments} labs:`
    );
    const testPattern: string[] = [];
    let testLabsCreated = 0;
    let testRegularAssignmentsCreated = 0;
    for (let i = 0; i < numAssignments; i++) {
      const shouldCreateLab = i % 2 === 0;
      const canCreateLab = testLabsCreated < effectiveLabAssignmentConfig.numLabAssignments;
      const canCreateRegularAssignment =
        testRegularAssignmentsCreated < numAssignments - effectiveLabAssignmentConfig.numLabAssignments;

      let isLabAssignment: boolean;
      if (shouldCreateLab && canCreateLab) {
        isLabAssignment = true;
        testLabsCreated++;
      } else if (!shouldCreateLab && canCreateRegularAssignment) {
        isLabAssignment = false;
        testRegularAssignmentsCreated++;
      } else if (canCreateLab) {
        isLabAssignment = true;
        testLabsCreated++;
      } else {
        isLabAssignment = false;
        testRegularAssignmentsCreated++;
      }
      testPattern.push(isLabAssignment ? "L" : "A");
    }
    console.log(`   Pattern: ${testPattern.join("-")} (L=Lab, A=Assignment)`);
    console.log(`   Labs created: ${testLabsCreated}, Regular assignments: ${testRegularAssignmentsCreated}`);

    // Create all assignments in parallel with alternating lab/assignment pattern
    let labAssignmentIdx = 1;
    let assignmentIdx = 1;
    let labsCreated = 0;
    let regularAssignmentsCreated = 0;
    const assignmentPromises = Array.from({ length: numAssignments }, async (_, i) => {
      const assignmentDate = new Date(firstAssignmentDate.getTime() + timeStep * i);

      // Alternate between lab and regular assignments
      // Pattern: Lab, Assignment, Lab, Assignment, etc.
      // But stop creating labs once we've reached the limit, and stop creating regular assignments once we've reached the limit
      const shouldCreateLab = i % 2 === 0; // Even indices (0, 2, 4, ...) for labs
      const canCreateLab = labsCreated < effectiveLabAssignmentConfig.numLabAssignments;
      const canCreateRegularAssignment =
        regularAssignmentsCreated < numAssignments - effectiveLabAssignmentConfig.numLabAssignments;

      let isLabAssignment: boolean;
      if (shouldCreateLab && canCreateLab) {
        isLabAssignment = true;
        labsCreated++;
      } else if (!shouldCreateLab && canCreateRegularAssignment) {
        isLabAssignment = false;
        regularAssignmentsCreated++;
      } else if (canCreateLab) {
        // If we can't create the preferred type, create a lab if possible
        isLabAssignment = true;
        labsCreated++;
      } else {
        // Otherwise create a regular assignment
        isLabAssignment = false;
        regularAssignmentsCreated++;
      }
      const isGroupAssignment = i < effectiveGroupAssignmentConfig.numGroupAssignments;
      const isLabGroupAssignment =
        isLabAssignment &&
        i <
          effectiveLabAssignmentConfig.numLabAssignments -
            effectiveLabAssignmentConfig.numLabAssignments +
            effectiveGroupAssignmentConfig.numLabGroupAssignments;

      // Determine assignment type and configuration
      let groupConfig: "individual" | "groups" | "both" = "individual";
      if (isGroupAssignment || isLabGroupAssignment) {
        groupConfig = "groups";
      }
      const name = isLabAssignment ? `Lab ${labAssignmentIdx}` : `Assignment ${assignmentIdx}`;
      if (isLabAssignment) {
        labAssignmentIdx++;
      } else {
        assignmentIdx++;
      }

      const assignment = await insertEnhancedAssignment({
        due_date: assignmentDate.toISOString(),
        lab_due_date_offset: isLabAssignment ? effectiveLabAssignmentConfig.minutesDueAfterLab : undefined,
        class_id,
        allow_not_graded_submissions: false,
        rubricConfig: effectiveRubricConfig,
        groupConfig,
        name
      });

      // Create assignment groups for group assignments
      let groups: Array<{
        id: number;
        name: string;
        memberCount: number;
        members: string[];
      }> = [];
      if (isGroupAssignment || isLabGroupAssignment) {
        groups = await createAssignmentGroups(assignment.id, class_id, students, groupSize);
      }

      return {
        assignment,
        isLabAssignment,
        isGroupAssignment,
        isLabGroupAssignment,
        groups,
        rubricSummary: {
          title: assignment.title,
          parts: assignment.rubricParts?.length || 0,
          totalChecks: assignment.rubricChecks?.length || 0,
          partNames: assignment.rubricParts?.map((p: { name: string }) => p.name).join(", ") || "Unknown",
          isLabAssignment,
          isGroupAssignment: isGroupAssignment || isLabGroupAssignment
        }
      };
    });

    const assignmentResults = await Promise.all(assignmentPromises);

    // Process results
    assignmentResults.forEach((result) => {
      assignments.push({ ...result.assignment, groups: result.groups });
      assignmentRubricSummaries.push(result.rubricSummary);

      if (result.isLabAssignment) {
        labAssignments.push(result.assignment);
      }

      if (result.isGroupAssignment) {
        groupAssignments.push(result.assignment);
      }

      if (result.isLabGroupAssignment) {
        labGroupAssignments.push(result.assignment);
      }

      if (result.groups.length > 0) {
        console.log(`  ✓ Created ${result.groups.length} groups for ${result.assignment.title}`);
      }
    });

    console.log(`✓ Created ${assignments.length} assignments with diverse rubric structures`);
    console.log(`✓ Created ${labAssignments.length} lab assignments with due dates after lab meetings`);
    console.log(`✓ Created ${groupAssignments.length} group assignments`);
    console.log(`✓ Created ${labGroupAssignments.length} lab group assignments`);

    // Log rubric diversity summary
    console.log("\n📋 Rubric Structure Summary:");
    const uniquePartCombinations = new Set(assignmentRubricSummaries.map((s) => s.partNames));
    console.log(`   Unique rubric part combinations: ${uniquePartCombinations.size}`);
    console.log(
      `   Total rubric checks created: ${assignmentRubricSummaries.reduce((sum, s) => sum + s.totalChecks, 0)}`
    );
    console.log(
      `   Average checks per assignment: ${Math.round(assignmentRubricSummaries.reduce((sum, s) => sum + s.totalChecks, 0) / assignments.length)}`
    );

    // Show lab assignment details
    console.log("\n🧪 Lab Assignment Details:");
    labAssignments.forEach((assignment, idx) => {
      console.log(
        `   ${idx + 1}. ${assignment.title}: Due ${effectiveLabAssignmentConfig.minutesDueAfterLab} minutes after lab`
      );
    });

    // Show group assignment details
    console.log("\n👥 Group Assignment Details:");
    groupAssignments.forEach((assignment, idx) => {
      console.log(`   ${idx + 1}. ${assignment.title}: Group assignment (${groupSize} students per group)`);
    });

    // Show lab group assignment details
    console.log("\n🧪👥 Lab Group Assignment Details:");
    labGroupAssignments.forEach((assignment, idx) => {
      console.log(
        `   ${idx + 1}. ${assignment.title}: Lab group assignment (${groupSize} students per group, due after lab)`
      );
    });

    // Show sample rubric structures
    console.log("\n📝 Sample Rubric Structures:");
    assignmentRubricSummaries.slice(0, 3).forEach((summary, idx) => {
      const labIndicator = summary.isLabAssignment ? " (Lab)" : "";
      const groupIndicator = summary.isGroupAssignment ? " (Group)" : "";
      console.log(
        `   ${idx + 1}. ${summary.title}${labIndicator}${groupIndicator}: ${summary.parts} parts, ${summary.totalChecks} checks`
      );
      console.log(`      Parts: ${summary.partNames}`);
    });

    // Create submissions using TestingUtils
    console.log("\n📝 Creating submissions and reviews...");
    const submissionData: Array<{
      submission_id: number;
      assignment: (typeof assignments)[0];
      student?: TestingUser;
      group?: { id: number; name: string; memberCount: number; members: string[] };
    }> = [];

    // Pick students who will get extensions (10% of students)
    console.log("\n⏰ Selecting students for extensions...");
    const studentsWithExtensions = new Set<string>();
    const numStudentsForExtensions = Math.floor(students.length * 0.1); // 10% of students get extensions
    const shuffledStudents = [...students].sort(() => Math.random() - 0.5);
    for (let i = 0; i < Math.min(numStudentsForExtensions, shuffledStudents.length); i++) {
      studentsWithExtensions.add(shuffledStudents[i].private_profile_id);
    }
    console.log(`✓ Selected ${studentsWithExtensions.size} students for extensions`);

    // Prepare batch submission data
    const submissionsToCreate: Array<{
      assignment: { id: number; due_date: string } & Record<string, unknown>;
      student?: TestingUser;
      group?: { id: number; name: string; memberCount: number; members: string[] };
      isRecentlyDue: boolean;
    }> = [];

    assignments.forEach((assignment) => {
      const isRecentlyDue = new Date(assignment.due_date as string) < now;
      if (assignment.group_config !== "individual") {
        // 75% chance to create a group submission
        if (Math.random() < 0.75) {
          assignment.groups.forEach((group) => {
            // Create a group submission
            submissionsToCreate.push({
              assignment: { ...assignment, due_date: assignment.due_date as string },
              group,
              isRecentlyDue
            });
          });
        }
      } else {
        students.forEach((student) => {
          // 95% chance student submitted
          if (Math.random() < 0.95) {
            submissionsToCreate.push({
              assignment: { ...assignment, due_date: assignment.due_date as string },
              student,
              isRecentlyDue
            });
          }
        });
      }
    });

    console.log(`Prepared ${submissionsToCreate.length} submissions for batch creation`);

    // Batch create all submissions
    const createdSubmissions = await batchCreateSubmissions(submissionsToCreate, class_id);
    console.log(`✓ Created ${createdSubmissions.length} submissions`);

    // Add to submissionData for later use
    submissionData.push(
      ...createdSubmissions.map((s) => ({
        submission_id: s.submission_id,
        assignment: s.assignment as unknown as (typeof assignments)[0],
        student: s.student,
        group: s.group
      }))
    );

    // Create workflow events for submissions (for statistics)
    console.log("\n⚡ Creating workflow events...");
    await createWorkflowEvents(createdSubmissions, class_id);

    // Create workflow errors for 20% of submissions
    console.log("\n🚨 Creating workflow errors...");
    await createWorkflowErrors(createdSubmissions, class_id);

    // Batch grade recently due submissions
    const submissionsToGrade = createdSubmissions.filter(
      ({ isRecentlyDue, student, group }) =>
        isRecentlyDue &&
        (!student || !studentsWithExtensions.has(student.private_profile_id)) &&
        (!group || !studentsWithExtensions.has(group.members[0]))
    );

    if (submissionsToGrade.length > 0) {
      console.log(`Grading ${submissionsToGrade.length} recently due submissions...`);

      // Break into batches of 50 and schedule with smallLimiter
      const GRADING_BATCH_SIZE = 50;
      const gradingBatches = chunkArray(submissionsToGrade, GRADING_BATCH_SIZE);
      console.log(
        `Processing grading in ${gradingBatches.length} batches of ${GRADING_BATCH_SIZE} with rate limiting...`
      );

      await Promise.all(
        gradingBatches.map((batch, index) =>
          smallLimiter.schedule(async () => {
            console.log(`Starting grading batch ${index + 1}/${gradingBatches.length} (${batch.length} submissions)`);
            await batchGradeSubmissions(batch, graders);
            console.log(`Completed grading batch ${index + 1}/${gradingBatches.length}`);
          })
        )
      );

      console.log(
        `✓ Graded ${submissionsToGrade.length} submissions across ${gradingBatches.length} rate-limited batches`
      );
    }

    // Create due date exceptions (extensions) for selected students in parallel
    console.log("\n⏰ Creating due date extensions...");
    //TODO also do extensions for groups?
    const extensionPromises = submissionData
      .filter(({ student }) => student && studentsWithExtensions.has(student.private_profile_id))
      .map(({ assignment, student }) =>
        createDueDateException(assignment.id, student?.private_profile_id || "", class_id, 5000)
      );

    await Promise.all(extensionPromises);
    console.log(`✓ Created ${extensionPromises.length} due date extensions`);

    // Create regrade requests in parallel
    console.log("\n🔄 Creating regrade requests...");
    const statuses: Array<"opened" | "resolved" | "closed"> = ["opened", "resolved", "closed"];

    // Create regrade requests for 20% of submissions at random
    const numRegradeRequests = Math.max(1, Math.floor(submissionData.length * 0.2));
    // Shuffle the submissionData array
    const shuffledSubmissions = submissionData
      .map((value) => ({ value, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ value }) => value)
      .slice(0, numRegradeRequests);

    const regradePromises = shuffledSubmissions.map(({ submission_id, assignment, student, group }) => {
      const status = statuses[Math.floor(Math.random() * statuses.length)];
      const grader = graders[Math.floor(Math.random() * graders.length)];
      const rubric_check_id = assignment.rubricChecks[Math.random() < 0.5 ? 2 : 3].id;
      if (!student && !group) {
        console.log("No student or group found for submission", submission_id);
        return;
      }
      return limiter.schedule(async () =>
        createRegradeRequest(
          submission_id,
          assignment.id,
          student ? student.private_profile_id : group ? group.members[0] : "",
          grader.private_profile_id,
          rubric_check_id,
          class_id,
          status
        )
      );
    });

    // await Promise.all(regradePromises);
    // console.log(`✓ Created ${regradePromises.length} regrade requests`);

    // // Create gradebook columns after all other operations are complete

    // Create gradebook columns based on selected scheme
    console.log(`\n📊 Creating gradebook columns using ${gradingScheme} scheme...`);

    if (gradingScheme === "specification") {
      await createSpecificationGradingColumns(class_id, students, assignments, labAssignments);
    } else {
      await createCurrentGradingColumns(class_id, students, effectiveNumManualGradedColumns);
    }

    // Create help requests if configured
    if (helpRequestConfig && helpRequestConfig.numHelpRequests > 0) {
      console.log("\n🆘 Creating help requests...");
      await createHelpRequests({
        class_id,
        students,
        instructors: [instructors[0], ...graders],
        numHelpRequests: helpRequestConfig.numHelpRequests,
        minRepliesPerRequest: helpRequestConfig.minRepliesPerRequest,
        maxRepliesPerRequest: helpRequestConfig.maxRepliesPerRequest,
        maxMembersPerRequest: helpRequestConfig.maxMembersPerRequest
      });
      console.log(`✓ Help request generation completed`);
    }

    console.log("\n🎉 Database seeding completed successfully!");
    console.log(`\n📊 Summary:`);
    console.log(`   Class ID: ${class_id}`);
    console.log(`   Class Name: ${testClass.name}`);
    console.log(`   Assignments: ${assignments.length}`);
    console.log(`   Lab Assignments: ${labAssignments.length}`);
    console.log(`   Group Assignments: ${groupAssignments.length}`);
    console.log(`   Lab Group Assignments: ${labGroupAssignments.length}`);
    console.log(`   Grading Scheme: ${gradingScheme}`);
    console.log(`   Students: ${students.length}`);
    console.log(`   Graders: ${graders.length}`);
    console.log(`   Instructors: ${instructors.length}`);
    console.log(`   Class Sections: ${classSections.length}`);
    console.log(`   Lab Sections: ${labSections.length}`);
    console.log(`   Student Tag Types: ${studentTagTypes.length}`);
    console.log(`   Grader Tag Types: ${graderTagTypes.length}`);
    console.log(`   Submissions: ${submissionData.length}`);
    console.log(`   Extensions: ${extensionPromises.length}`);
    console.log(`   Regrade Requests: ${regradePromises.length}`);
    console.log(`   Total Rubric Checks: ${assignmentRubricSummaries.reduce((sum, s) => sum + s.totalChecks, 0)}`);
    console.log(`   Unique Rubric Combinations: ${uniquePartCombinations.size}`);
    console.log(
      `   Grader Conflicts: Created conflicts for graders #2, #3, #5 with students divisible by their numbers`
    );
    if (helpRequestConfig) {
      console.log(`   Help Requests: ${helpRequestConfig.numHelpRequests} (80% resolved/closed)`);
    }
    if (discussionConfig) {
      console.log(
        `   Discussion Threads: ${discussionConfig.postsPerTopic} posts per topic, up to ${discussionConfig.maxRepliesPerPost} replies each`
      );
    }

    console.log(`\n🏫 Section Details:`);
    classSections.forEach((section) => console.log(`   Class: ${section.name}`));
    labSections.forEach((section) => console.log(`   Lab: ${section.name}`));

    console.log(`\n🏷️ Tag Type Details:`);
    studentTagTypes.forEach((tagType) => console.log(`   Student: ${tagType.name} (${tagType.color})`));
    graderTagTypes.forEach((tagType) => console.log(`   Grader: ${tagType.name} (${tagType.color})`));

    console.log(`\n🔐 Login Credentials:`);
    console.log(`\n   Instructor:`);
    console.log(`     Sample email: ${instructors[0].email}`);
    console.log(`     Password: ${instructors[0].password}`);

    console.log(`\n   Graders (${graders.length} total):`);
    if (graders.length > 0) {
      console.log(`     Sample email: ${graders[0].email}`);
      console.log(`     Password: ${graders[0].password}`);
    }

    console.log(`\n   Students (${students.length} total):`);
    if (students.length > 0) {
      console.log(`     Sample email: ${students[0].email}`);
      console.log(`     Password: ${students[0].password}`);
    }

    console.log(`\n🔗 View the instructor dashboard at: /course/${class_id}`);
  } catch (error) {
    console.error("❌ Error seeding database:", error);
    process.exit(1);
  }
}

// Examples of different invocation patterns:

// Large-scale example (default)
export async function runLargeScale() {
  const now = new Date();

  await seedInstructorDashboardData({
    numStudents: 900,
    numGraders: 80,
    numInstructors: 10,
    numAssignments: 20,
    firstAssignmentDate: subDays(now, 60), // 60 days in the past
    lastAssignmentDate: addDays(now, 50), // 50 days in the future
    numManualGradedColumns: 20, // 20 manual graded columns for large scale
    rubricConfig: {
      minPartsPerAssignment: 3,
      maxPartsPerAssignment: 5,
      minCriteriaPerPart: 1,
      maxCriteriaPerPart: 2,
      minChecksPerCriteria: 2,
      maxChecksPerCriteria: 4
    },
    sectionsAndTagsConfig: {
      numClassSections: 10,
      numLabSections: 10,
      numStudentTags: 10,
      numGraderTags: 20
    },
    labAssignmentConfig: {
      numLabAssignments: 12, // 30% of 40 assignments
      minutesDueAfterLab: 1440 // 24 hours
    },
    groupAssignmentConfig: {
      numGroupAssignments: 11, // 40% of regular assignments (28 * 0.4 ≈ 11)
      numLabGroupAssignments: 6 // 50% of lab assignments (12 * 0.5 = 6)
    },
    helpRequestConfig: {
      numHelpRequests: 100,
      minRepliesPerRequest: 0,
      maxRepliesPerRequest: 300,
      maxMembersPerRequest: 5
    },
    discussionConfig: {
      postsPerTopic: faker.number.int({ min: 50, max: 100 }), // 50-100 posts per topic
      maxRepliesPerPost: 100 // up to 100 replies per root post
    }
  });
}

// Small-scale example for testing
async function runSmallScale() {
  const now = new Date();

  await seedInstructorDashboardData({
    numStudents: 50,
    numGraders: 5,
    numInstructors: 2,
    numAssignments: 20,
    firstAssignmentDate: subDays(now, 30), // 30 days in the past
    lastAssignmentDate: addDays(now, 30), // 30 days in the future
    numManualGradedColumns: 5, // 5 manual graded columns for small scale
    gradingScheme: "current", // Use current grading scheme
    rubricConfig: {
      minPartsPerAssignment: 2,
      maxPartsPerAssignment: 4,
      minCriteriaPerPart: 1,
      maxCriteriaPerPart: 2,
      minChecksPerCriteria: 2,
      maxChecksPerCriteria: 3
    },
    sectionsAndTagsConfig: {
      numClassSections: 2,
      numLabSections: 2,
      numStudentTags: 2,
      numGraderTags: 4
    },
    labAssignmentConfig: {
      numLabAssignments: 10,
      minutesDueAfterLab: 60 // 1 hour
    },
    groupAssignmentConfig: {
      numGroupAssignments: 5,
      numLabGroupAssignments: 10
    },
    helpRequestConfig: {
      numHelpRequests: 40,
      minRepliesPerRequest: 0,
      maxRepliesPerRequest: 70,
      maxMembersPerRequest: 6
    },
    discussionConfig: {
      postsPerTopic: faker.number.int({ min: 5, max: 16 }), // 5-16 posts per topic
      maxRepliesPerPost: 16 // up to 16 replies per root post
    }
  });
}

async function runMicro() {
  const now = new Date();

  await seedInstructorDashboardData({
    numStudents: 2,
    numGraders: 1,
    numInstructors: 1,
    numAssignments: 10,
    firstAssignmentDate: addDays(now, -65),
    lastAssignmentDate: addDays(now, -2),
    gradingScheme: "specification",
    rubricConfig: {
      minPartsPerAssignment: 2,
      maxPartsPerAssignment: 4,
      minCriteriaPerPart: 1,
      maxCriteriaPerPart: 2,
      minChecksPerCriteria: 2,
      maxChecksPerCriteria: 3
    },
    sectionsAndTagsConfig: {
      numClassSections: 1,
      numLabSections: 1,
      numStudentTags: 1,
      numGraderTags: 1
    },
    labAssignmentConfig: {
      numLabAssignments: 10,
      minutesDueAfterLab: 10 // 1 hour
    },
    groupAssignmentConfig: {
      numGroupAssignments: 1,
      numLabGroupAssignments: 1
    },
    discussionConfig: {
      postsPerTopic: 2, // 2 posts per topic
      maxRepliesPerPost: 4 // up to 4 replies per root post
    }
  });
}

// Run the large-scale example by default
// To run small-scale instead, change this to: runSmallScale()
async function main() {
  // await runLargeScale();
  // Uncomment below and comment above to run small scale:
  await runSmallScale();
  // await runMicro();
}
main();
