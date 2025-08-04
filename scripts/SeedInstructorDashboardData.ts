import { addDays, subDays } from "date-fns";
import dotenv from "dotenv";
import { all, ConstantNode, create, FunctionNode } from "mathjs";
import { minimatch } from "minimatch";
import Bottleneck from "bottleneck";

import {
  createClass,
  createDueDateException,
  createRegradeRequest,
  createUserInClass,
  supabase,
  TEST_HANDOUT_REPO,
  type TestingUser
} from "../tests/e2e/TestingUtils";

dotenv.config({ path: ".env.local" });

const limiter = new Bottleneck({
  maxConcurrent: 200
});

const smallLimiter = new Bottleneck({
  maxConcurrent: 10 // Smaller limit for grading operations
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
  const BATCH_SIZE = 500;

  // Chunk submissions into batches of 500
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
            isRecentlyDue: chunk[index].isRecentlyDue
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
      total_score: number;
      released: boolean;
      completed_by: string | null;
      completed_at: string | null;
      total_autograde_score: number;
    }
  >();

  for (const review of reviewInfo || []) {
    const isCompleted = Math.random() < 0.95; // 95% chance review is completed
    const grader = graders[Math.floor(Math.random() * graders.length)];
    const rubricChecks = rubricChecksMap.get(review.rubric_id) || [];
    const files = submissionFilesMap.get(review.submission_id) || [];

    if (isCompleted) {
      // Create comments for each rubric check
      for (const check of rubricChecks) {
        const applyChance = 0.8;
        const shouldApply = check.is_required || Math.random() < applyChance;

        if (shouldApply) {
          const pointsAwarded = Math.floor(Math.random() * (check.points + 1));

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
    }

    // Prepare review update
    const totalScore = isCompleted ? Math.floor(Math.random() * 100) : 0;
    const totalAutogradeScore = Math.floor(Math.random() * 100);

    reviewUpdates.set(review.id, {
      grader: grader.private_profile_id,
      total_score: totalScore,
      released: isCompleted,
      completed_by: isCompleted ? grader.private_profile_id : null,
      completed_at: isCompleted ? new Date().toISOString() : null,
      total_autograde_score: totalAutogradeScore
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
        throw new Error(`Failed to update ${updateErrors.length} submission reviews in batch ${chunkIndex + 1}`);
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
    console.log(flattenedDependencies);
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

  console.log(validAssignments, validColumns);
  // Extract dependencies from score expression if not provided
  let finalDependencies = dependencies;
  if (score_expression && !dependencies) {
    const extractedDeps = extractDependenciesFromExpression(score_expression, validAssignments, validColumns);
    if (extractedDeps) {
      finalDependencies = extractedDeps;
    }
  }

  console.log(`Creating gradebook column ${name} with dependencies ${finalDependencies}`);
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
      dependencies: finalDependencies ? JSON.stringify(finalDependencies) : null,
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

// Helper function to set scores for students in a gradebook column using normal distribution
async function setGradebookColumnScores({
  class_id,
  gradebook_column_id,
  students,
  averageScore,
  standardDeviation = 15,
  maxScore = 100
}: {
  class_id: number;
  gradebook_column_id: number;
  students: TestingUser[];
  averageScore: number;
  standardDeviation?: number;
  maxScore?: number;
}): Promise<{
  updatedCount: number;
  averageActual: number;
  minScore: number;
  maxScore: number;
}> {
  // Generate scores using normal distribution
  const scores = students.map(() => {
    // Generate normal distribution using Box-Muller transform
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

    // Apply to our distribution
    let score = averageScore + z0 * standardDeviation;

    // Clamp to valid range (0 to maxScore)
    score = Math.max(0, Math.min(maxScore, score));

    return Math.round(score * 100) / 100; // Round to 2 decimal places
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

    const { error: updateError } = await supabase
      .from("gradebook_column_students")
      .update({ score: scores[index] })
      .eq("id", existingRecord.id);

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

        // Randomly select points from the available options
        const criteriaPoints = criteriaTemplate.points[Math.floor(Math.random() * criteriaTemplate.points.length)];

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

// Enhanced assignment creation function that generates diverse rubrics
async function insertEnhancedAssignment({
  due_date,
  lab_due_date_offset,
  allow_not_graded_submissions,
  class_id,
  rubricConfig,
  groupConfig
}: {
  due_date: string;
  lab_due_date_offset?: number;
  allow_not_graded_submissions?: boolean;
  class_id: number;
  rubricConfig: NonNullable<SeedingOptions["rubricConfig"]>;
  groupConfig?: "individual" | "groups" | "both";
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
  const assignmentIdx = Math.floor(Math.random() * 100000) + 1;
  const title =
    (lab_due_date_offset ? `Enhanced Assignment ${assignmentIdx}` : `Enhanced Lab ${assignmentIdx}`) +
    (groupConfig && groupConfig !== "individual" ? ` (Group)` : "");

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

  // Create assignment
  const { data: insertedAssignmentData, error: assignmentError } = await supabase
    .from("assignments")
    .insert({
      title: title,
      description: "This is an enhanced test assignment with diverse rubric structure",
      due_date: due_date,
      minutes_due_after_lab: lab_due_date_offset,
      template_repo: TEST_HANDOUT_REPO,
      autograder_points: 100,
      total_points: 100,
      max_late_tokens: 10,
      release_date: addDays(new Date(), -1).toUTCString(),
      class_id: class_id,
      slug: lab_due_date_offset ? `lab-${assignmentIdx}` : `assignment-${assignmentIdx}`,
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

// Helper function to create lab sections
async function createLabSections(class_id: number, numSections: number, instructorId: string) {
  const daysOfWeek = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;
  const times = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];

  // Bulk insert all lab sections at once
  const sectionsData = Array.from({ length: numSections }, (_, i) => {
    const dayIndex = i % daysOfWeek.length;
    const timeIndex = Math.floor(i / daysOfWeek.length) % times.length;
    const startTime = times[timeIndex];
    const endTime = `${String(parseInt(startTime.split(":")[0]) + 1).padStart(2, "0")}:${startTime.split(":")[1]}`;

    return {
      class_id: class_id,
      name: `Lab ${String.fromCharCode(65 + i)}`, // Lab A, Lab B, etc.
      day_of_week: daysOfWeek[dayIndex],
      start_time: startTime,
      end_time: endTime,
      lab_leader_id: instructorId,
      description: `Lab section ${String.fromCharCode(65 + i)} - ${daysOfWeek[dayIndex]} ${startTime}-${endTime}`
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
  numAssignments: number;
  firstAssignmentDate: Date;
  lastAssignmentDate: Date;
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
}

async function seedInstructorDashboardData(options: SeedingOptions) {
  const {
    numStudents,
    numGraders,
    numAssignments,
    firstAssignmentDate,
    lastAssignmentDate,
    rubricConfig,
    sectionsAndTagsConfig,
    labAssignmentConfig,
    groupAssignmentConfig,
    helpRequestConfig
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

  console.log("🌱 Starting instructor dashboard data seeding...\n");
  console.log(`📊 Configuration:`);
  console.log(`   Students: ${numStudents}`);
  console.log(`   Graders: ${numGraders}`);
  console.log(`   Assignments: ${numAssignments}`);
  console.log(`   Lab Assignments: ${effectiveLabAssignmentConfig.numLabAssignments}`);
  console.log(`   Group Assignments: ${effectiveGroupAssignmentConfig.numGroupAssignments}`);
  console.log(`   Lab Group Assignments: ${effectiveGroupAssignmentConfig.numLabGroupAssignments}`);
  console.log(`   Minutes Due After Lab: ${effectiveLabAssignmentConfig.minutesDueAfterLab}`);
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
  console.log("");

  try {
    // Create test class using TestingUtils
    const testClass = await createClass();
    const class_id = testClass.id;
    console.log(`✓ Created test class: ${testClass.name} (ID: ${class_id})`);

    // Create users using TestingUtils
    console.log("\n👥 Creating test users...");
    const instructor = await createUserInClass({ role: "instructor", class_id });

    console.log(`  Creating ${numGraders} graders`);
    const graderItems = Array.from({ length: numGraders }, (_, i) => ({ index: i }));
    const graders = await Promise.all(
      graderItems.map(async () => limiter.schedule(() => createUserInClass({ role: "grader", class_id })))
    );
    console.log(`✓ Created ${graders.length} graders`);

    console.log(`  Creating ${numStudents} students`);
    const studentItems = Array.from({ length: numStudents }, (_, i) => ({ index: i }));
    const students = await Promise.all(
      studentItems.map(async () => limiter.schedule(() => createUserInClass({ role: "student", class_id })))
    );
    console.log(`✓ Created ${students.length} students, 1 instructor, ${graders.length} graders`);

    // Create sections and tags
    console.log("\n🏫 Creating class and lab sections...");
    const classSections = await createClassSections(class_id, effectiveSectionsAndTagsConfig.numClassSections);
    console.log(`✓ Created ${classSections.length} class sections`);

    const labSections = await createLabSections(
      class_id,
      effectiveSectionsAndTagsConfig.numLabSections,
      instructor.private_profile_id
    );
    console.log(`✓ Created ${labSections.length} lab sections`);

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
        instructor.user_id
      ),
      assignUsersToSectionsAndTags(
        graders,
        classSections,
        labSections,
        graderTagTypes,
        class_id,
        "grader",
        instructor.user_id
      )
    ]);
    console.log(`✓ Assigned ${students.length} students and ${graders.length} graders to sections and tags`);

    // Create grader conflicts based on specified patterns
    console.log("\n⚔️ Creating grader conflicts based on specified patterns...");
    await insertGraderConflicts(graders, students, class_id, instructor.private_profile_id);

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

    // Create all assignments in parallel
    const assignmentPromises = Array.from({ length: numAssignments }, async (_, i) => {
      const assignmentDate = new Date(firstAssignmentDate.getTime() + timeStep * i);
      const isLabAssignment = i < effectiveLabAssignmentConfig.numLabAssignments;
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

      const assignment = await insertEnhancedAssignment({
        due_date: assignmentDate.toISOString(),
        lab_due_date_offset: isLabAssignment ? effectiveLabAssignmentConfig.minutesDueAfterLab : undefined,
        class_id,
        allow_not_graded_submissions: false,
        rubricConfig: effectiveRubricConfig,
        groupConfig
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

    await Promise.all(regradePromises);
    console.log(`✓ Created ${regradePromises.length} regrade requests`);

    // Create gradebook columns after all other operations are complete

    //Wait for 10 seconds to make sure all other operations are complete
    await new Promise((resolve) => setTimeout(resolve, 10000));
    // Create simple columns first (without expressions)
    console.log("\n📊 Creating gradebook columns...");
    const participationColumn = await createGradebookColumn({
      class_id,
      name: "Participation",
      description: "Overall class participation score",
      slug: "participation",
      max_score: 100,
      sort_order: 1000
    });

    // // Wait a moment for triggers to settle
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const averageAssignmentsColumn = await createGradebookColumn({
      class_id,
      name: "Average Assignments",
      description: "Average of all assignments",
      slug: "average-assignments",
      max_score: 100,
      sort_order: 2
    });

    // Wait a moment for triggers to settle
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const averageLabAssignmentsColumn = await createGradebookColumn({
      class_id,
      name: "Average Lab Assignments",
      description: "Average of all lab assignments",
      slug: "average-lab-assignments",
      max_score: 100,
      sort_order: 3
    });

    // Wait a moment for triggers to settle
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const finalGradeColumn = await createGradebookColumn({
      class_id,
      name: "Final Grade",
      description: "Calculated final grade",
      slug: "final-grade",
      max_score: 100,
      sort_order: 999
    });

    console.log(`✓ Created ${4} gradebook columns without expressions`);

    // Now update the columns with score expressions one by one
    console.log("📊 Adding score expressions to gradebook columns...");

    // Update average assignments column with expression
    const { error: avgAssignError } = await supabase
      .from("gradebook_columns")
      .update({ score_expression: "mean(gradebook_columns('assignment-assignment-*'))" })
      .eq("id", averageAssignmentsColumn.id);

    if (avgAssignError) {
      console.warn(`Failed to update average assignments expression: ${avgAssignError.message}`);
    }

    // Wait for triggers to settle
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Update average lab assignments column with expression
    const { error: avgLabError } = await supabase
      .from("gradebook_columns")
      .update({ score_expression: "mean(gradebook_columns('assignment-lab-*'))" })
      .eq("id", averageLabAssignmentsColumn.id);

    if (avgLabError) {
      console.warn(`Failed to update average lab assignments expression: ${avgLabError.message}`);
    }

    // Wait for triggers to settle
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Update final grade column with complex expression
    const { error: finalGradeError } = await supabase
      .from("gradebook_columns")
      .update({
        score_expression:
          "gradebook_columns('average-lab-assignments') * 0.4 + gradebook_columns('average-assignments') * 0.5 + gradebook_columns('participation') * 0.1"
      })
      .eq("id", finalGradeColumn.id);

    if (finalGradeError) {
      console.warn(`Failed to update final grade expression: ${finalGradeError.message}`);
    }

    console.log(`✓ Updated gradebook columns with score expressions`);

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

    // Create help requests if configured
    if (helpRequestConfig && helpRequestConfig.numHelpRequests > 0) {
      console.log("\n🆘 Creating help requests...");
      await createHelpRequests({
        class_id,
        students,
        instructors: [instructor, ...graders],
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
    console.log(`   Students: ${students.length}`);
    console.log(`   Graders: ${graders.length}`);
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

    console.log(`\n🏫 Section Details:`);
    classSections.forEach((section) => console.log(`   Class: ${section.name}`));
    labSections.forEach((section) => console.log(`   Lab: ${section.name}`));

    console.log(`\n🏷️ Tag Type Details:`);
    studentTagTypes.forEach((tagType) => console.log(`   Student: ${tagType.name} (${tagType.color})`));
    graderTagTypes.forEach((tagType) => console.log(`   Grader: ${tagType.name} (${tagType.color})`));

    console.log(`\n🔐 Login Credentials:`);
    console.log(`\n   Instructor:`);
    console.log(`     Email: ${instructor.email}`);
    console.log(`     Password: ${instructor.password}`);

    console.log(`\n   Graders (${graders.length} total):`);
    if (graders.length > 0) {
      console.log(`     Email Template: ${graders[0].email.replace(/#\d+/, "#N")}`);
      console.log(`     Password: ${graders[0].password}`);
      console.log(`     Available Numbers: 1-${graders.length} `);
    }

    console.log(`\n   Students (${students.length} total):`);
    if (students.length > 0) {
      console.log(`     Email Template: ${students[0].email.replace(/#\d+/, "#N")}`);
      console.log(`     Password: ${students[0].password}`);
      console.log(`     Available Numbers: 1-${students.length}`);
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
    numStudents: 500,
    numGraders: 50,
    numAssignments: 20,
    firstAssignmentDate: subDays(now, 60), // 60 days in the past
    lastAssignmentDate: addDays(now, 50), // 50 days in the future
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
    }
  });
}

// Small-scale example for testing
async function runSmallScale() {
  const now = new Date();

  await seedInstructorDashboardData({
    numStudents: 50,
    numGraders: 5,
    numAssignments: 20,
    firstAssignmentDate: subDays(now, 5), // 30 days in the past
    lastAssignmentDate: addDays(now, 30), // 30 days in the future
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
      numLabAssignments: 2, // 40% of 5 assignments
      minutesDueAfterLab: 60 // 1 hour
    },
    groupAssignmentConfig: {
      numGroupAssignments: 5, // 40% of regular assignments (3 * 0.4 ≈ 1)
      numLabGroupAssignments: 2 // 50% of lab assignments (2 * 0.5 = 1)
    },
    helpRequestConfig: {
      numHelpRequests: 40,
      minRepliesPerRequest: 0,
      maxRepliesPerRequest: 70,
      maxMembersPerRequest: 6
    }
  });
}

async function runMicro() {
  const now = new Date();

  await seedInstructorDashboardData({
    numStudents: 2,
    numGraders: 1,
    numAssignments: 5,
    firstAssignmentDate: addDays(now, 5),
    lastAssignmentDate: addDays(now, 10),
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
      numLabAssignments: 1, // 40% of 5 assignments
      minutesDueAfterLab: 10 // 1 hour
    },
    groupAssignmentConfig: {
      numGroupAssignments: 1, // 40% of regular assignments (3 * 0.4 ≈ 1)
      numLabGroupAssignments: 1 // 50% of lab assignments (2 * 0.5 = 1)
    }
  });
}

// Run the large-scale example by default
// To run small-scale instead, change this to: runSmallScale()
async function main() {
  // await runLargeScale();
  // Uncomment below and comment above to run small scale:
  // await runSmallScale();
  await runMicro();
}

main();
