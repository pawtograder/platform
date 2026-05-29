import { expect, testFunctional as test } from "../global-setup";
import { addDays } from "date-fns";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

test.describe("active submission gradebook recalculation", () => {
  test.describe.configure({ timeout: 180_000 });

  let classId: number;
  let assignmentId: number;
  let assignmentSlug: string;
  let gradebookId: number;
  let gradebookColumnId: number;
  let instructor: TestingUser;
  let student: TestingUser;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Active Submission Gradebook ${suffix}` });
    classId = course.id;

    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `E2E Active Submission Instructor ${suffix}`,
      email: `e2e-active-submission-instructor-${suffix}@pawtograder.net`
    });
    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Active Submission Student ${suffix}`,
      email: `e2e-active-submission-student-${suffix}@pawtograder.net`
    });

    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), -1).toISOString(),
      name: `E2E Active Submission Assignment ${suffix}`,
      assignment_slug: `e2e-active-submission-${suffix}`
    });
    assignmentId = assignment.id;
    assignmentSlug = assignment.slug;

    const gradebookColumn = await getAssignmentGradebookColumn(classId, assignmentSlug);
    gradebookId = gradebookColumn.gradebook_id;
    gradebookColumnId = gradebookColumn.id;
  });

  test("reactivating a completed latest submission refreshes the assignment gradebook cell", async () => {
    const oldSubmission = await insertPreBakedSubmission({
      assignment_id: assignmentId,
      class_id: classId,
      student_profile_id: student.private_profile_id,
      repositorySuffix: `active-submission-old-${classId}`
    });
    await completeGrading(oldSubmission.grading_review_id, 21, instructor.private_profile_id);
    await waitForAssignmentScore(21);

    const latestSubmission = await insertPreBakedSubmission({
      assignment_id: assignmentId,
      class_id: classId,
      student_profile_id: student.private_profile_id,
      repositorySuffix: `active-submission-latest-${classId}`
    });
    await completeGrading(latestSubmission.grading_review_id, 86, instructor.private_profile_id);
    await waitForAssignmentScore(86);

    const instructorClient = await createAuthenticatedClient(instructor);

    const versionBeforeOldActivation = await getRecalcVersion();
    await setActiveSubmission(instructorClient, oldSubmission.submission_id);
    await waitForRecalcVersionGreaterThan(versionBeforeOldActivation);
    await waitForAssignmentScore(21);

    const versionBeforeLatestActivation = await getRecalcVersion();
    await setActiveSubmission(instructorClient, latestSubmission.submission_id);
    await waitForRecalcVersionGreaterThan(versionBeforeLatestActivation);
    await waitForAssignmentScore(86);
  });

  async function completeGrading(gradingReviewId: number, score: number, completedBy: string) {
    const { error } = await supabase
      .from("submission_reviews")
      .update({
        completed_at: new Date().toISOString(),
        completed_by: completedBy,
        released: true,
        total_score: score
      })
      .eq("id", gradingReviewId);

    if (error) {
      throw new Error(`Failed to complete grading review ${gradingReviewId}: ${error.message}`);
    }
  }

  async function getAssignmentGradebookColumn(class_id: number, slug: string) {
    const { data, error } = await supabase
      .from("gradebook_columns")
      .select("id, gradebook_id")
      .eq("class_id", class_id)
      .eq("slug", `assignment-${slug}`)
      .single();

    if (error || !data) {
      throw new Error(`Failed to load assignment gradebook column: ${error?.message ?? "missing row"}`);
    }

    return data;
  }

  async function setActiveSubmission(
    instructorClient: Awaited<ReturnType<typeof createAuthenticatedClient>>,
    submissionId: number
  ) {
    const { data, error } = await instructorClient.rpc("submission_set_active", {
      _submission_id: submissionId
    });

    if (error) {
      throw new Error(`Failed to activate submission ${submissionId}: ${error.message}`);
    }
    expect(data).toBe(true);
  }

  async function kickGradebookWorker() {
    try {
      await supabase.rpc("invoke_gradebook_recalculation_background_task");
    } catch (error) {
      // The direct edge-function kick below is the reliable local fallback.
      console.warn("Failed to invoke gradebook recalculation background RPC:", error);
    }

    const edgeSecret = process.env.EDGE_FUNCTION_SECRET || process.env.EDGE_FUNCTION_SECRET_OVERRIDE;
    if (edgeSecret) {
      await supabase.functions
        .invoke("gradebook-column-recalculate", {
          headers: { "x-edge-function-secret": edgeSecret }
        })
        .catch((error) => {
          console.warn("Failed to invoke gradebook recalculation edge function:", error);
        });
    }
  }

  async function getAssignmentScore() {
    const { data, error } = await supabase
      .from("gradebook_column_students")
      .select("score, score_override")
      .eq("gradebook_column_id", gradebookColumnId)
      .eq("student_id", student.private_profile_id)
      .eq("is_private", true)
      .single();

    if (error) {
      throw new Error(`Failed to load gradebook score: ${error.message}`);
    }

    return data.score_override ?? data.score;
  }

  async function waitForAssignmentScore(expected: number) {
    await expect(async () => {
      await kickGradebookWorker();
      expect(await getAssignmentScore()).toBe(expected);
    }).toPass({ timeout: 90_000 });
  }

  async function getRecalcVersion() {
    const { data, error } = await supabase
      .from("gradebook_row_recalc_state")
      .select("version")
      .eq("class_id", classId)
      .eq("gradebook_id", gradebookId)
      .eq("student_id", student.private_profile_id)
      .eq("is_private", true)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load recalculation state: ${error.message}`);
    }

    return data?.version ?? 0;
  }

  async function waitForRecalcVersionGreaterThan(version: number) {
    await expect(async () => {
      await kickGradebookWorker();
      const nextVersion = await getRecalcVersion();
      expect(nextVersion).toBeGreaterThan(version);
    }).toPass({ timeout: 30_000 });
  }
});
