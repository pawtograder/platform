import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import { argosScreenshot } from "@argos-ci/playwright";
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

type AssignmentWithRubric = Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] };

async function addComment({
  submission_id,
  review_id,
  check_id,
  class_id,
  author_id,
  points,
  target_student_profile_id
}: {
  submission_id: number;
  review_id: number;
  check_id: number;
  class_id: number;
  author_id: string;
  points: number;
  target_student_profile_id?: string;
}) {
  const { data, error } = await supabase
    .from("submission_comments")
    .insert({
      submission_id,
      submission_review_id: review_id,
      rubric_check_id: check_id,
      class_id,
      author: author_id,
      comment: `Grading comment for check ${check_id}`,
      points,
      released: false,
      eventually_visible: true,
      regrade_request_id: null,
      target_student_profile_id: target_student_profile_id ?? null
    })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to add comment: ${error.message}`);
  return data;
}

async function updateCommentPoints(comment_id: number, new_points: number) {
  const { error } = await supabase.from("submission_comments").update({ points: new_points }).eq("id", comment_id);
  if (error) throw new Error(`Failed to update comment: ${error.message}`);
}

async function getReviewScore(review_id: number) {
  const { data, error } = await supabase
    .from("submission_reviews")
    .select("total_score, individual_scores, per_student_grading_totals")
    .eq("id", review_id)
    .single();
  if (error) throw new Error(`Failed to get review: ${error.message}`);
  return data;
}

async function releaseReview(review_id: number) {
  const { error } = await supabase.from("submission_reviews").update({ released: true }).eq("id", review_id);
  if (error) throw new Error(`Failed to release review: ${error.message}`);
}

async function loginAndGoto(page: import("@playwright/test").Page, user: TestingUser, course: Course, url: string) {
  await loginAsUser(page, user, course);
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
}

async function releaseSubmission(submission_id: number) {
  const { error } = await supabase
    .from("submissions")
    .update({ released: new Date().toISOString() })
    .eq("id", submission_id);
  if (error) throw new Error(`Failed to release submission: ${error.message}`);
}

async function createGroupSubmission({
  student_profiles,
  assignment,
  course,
  instructor
}: {
  student_profiles: TestingUser[];
  assignment: AssignmentWithRubric;
  course: Course;
  instructor: TestingUser;
}) {
  const { data: groupData, error: groupError } = await supabase
    .from("assignment_groups")
    .insert({
      name: `Test Group ${Date.now()}`,
      class_id: course.id,
      assignment_id: assignment.id
    })
    .select("id")
    .single();
  if (groupError) throw new Error(`Failed to create group: ${groupError.message}`);

  for (const student of student_profiles) {
    const { error } = await supabase.from("assignment_groups_members").insert({
      assignment_group_id: groupData.id,
      profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id,
      added_by: instructor.private_profile_id
    });
    if (error) throw new Error(`Failed to add group member: ${error.message}`);
  }

  const submission = await insertPreBakedSubmission({
    assignment_group_id: groupData.id,
    assignment_id: assignment.id,
    class_id: course.id
  });

  return { ...submission, group_id: groupData.id };
}

// ────────────────────────────────────────────────────────────
// Test suite
// ────────────────────────────────────────────────────────────

test.describe("Manual grading score calculation", () => {
  let course: Course;
  let instructor: TestingUser;
  let studentA: TestingUser;
  let studentB: TestingUser;
  let studentC: TestingUser;

  test.beforeAll(async () => {
    course = await createClass({ name: "Manual Grading Score Test" });
    [instructor, studentA, studentB, studentC] = await createUsersInClass([
      {
        name: "Score Instructor",
        email: "score-instructor@pawtograder.net",
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Score Student A",
        email: "score-student-a@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Score Student B",
        email: "score-student-b@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Score Student C",
        email: "score-student-c@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
  });

  // ──────────────── Individual assignment grading ────────────────

  test.describe("Individual assignment grading", () => {
    test.describe.configure({ mode: "serial" });

    let assignment: AssignmentWithRubric;
    let submissionId: number;
    let reviewId: number;
    let commentId: number;

    test("setup: create individual assignment and submission", async () => {
      assignment = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        class_id: course.id,
        name: "Individual Score Test"
      });
      const sub = await insertPreBakedSubmission({
        student_profile_id: studentA.private_profile_id,
        assignment_id: assignment.id,
        class_id: course.id
      });
      submissionId = sub.submission_id;
      reviewId = sub.grading_review_id;
    });

    test("adding a comment with points updates total_score", async () => {
      const gradingCheck = assignment.rubricChecks.find((c) => c.name === "Grading Review Check 2")!;
      const comment = await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: gradingCheck.id,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 8
      });
      commentId = comment.id;

      // Wait for trigger to compute
      await new Promise((r) => setTimeout(r, 500));
      const review = await getReviewScore(reviewId);
      // Additive criteria with total_points=20, one check giving 8 => score includes 8
      expect(review.total_score).toBeGreaterThanOrEqual(8);
    });

    test("updating comment points recalculates total_score", async () => {
      await updateCommentPoints(commentId, 15);
      await new Promise((r) => setTimeout(r, 500));
      const review = await getReviewScore(reviewId);
      expect(review.total_score).toBeGreaterThanOrEqual(15);
    });

    test("adding a second comment increases total_score further", async () => {
      const check3 = assignment.rubricChecks.find((c) => c.name === "Grading Review Check 3")!;
      await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: check3.id,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 5
      });

      await new Promise((r) => setTimeout(r, 500));
      const review = await getReviewScore(reviewId);
      // 15 from first check + 5 from second check + autograde (10)
      expect(review.total_score).toBeGreaterThanOrEqual(20);
    });

    test("individual_scores should be null for individual assignments", async () => {
      const review = await getReviewScore(reviewId);
      expect(review.individual_scores).toBeNull();
    });

    test("student sees their individual score after release", async ({ page }) => {
      await releaseSubmission(submissionId);
      await releaseReview(reviewId);

      await loginAndGoto(
        page,
        studentA,
        course,
        `/course/${course.id}/assignments/${assignment.id}/submissions/${submissionId}/files`
      );

      const scoreHeading = page.getByRole("heading", { name: /Overall Score/ });
      await expect(scoreHeading).toBeVisible({ timeout: 15000 });
      await argosScreenshot(page, "Individual grading - student view with score");
    });
  });

  // ──────────────── Group assignment grading (shared) ────────────────

  test.describe("Group assignment grading (shared score)", () => {
    test.describe.configure({ mode: "serial" });

    let assignment: AssignmentWithRubric;
    let submissionId: number;
    let reviewId: number;
    let commentId: number;

    test("setup: create group assignment and group submission", async () => {
      assignment = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        class_id: course.id,
        name: "Group Score Test"
      });

      // Override to group config
      await supabase.from("assignments").update({ group_config: "groups" }).eq("id", assignment.id);

      const sub = await createGroupSubmission({
        student_profiles: [studentA, studentB],
        assignment,
        course,
        instructor
      });
      submissionId = sub.submission_id;
      reviewId = sub.grading_review_id;
    });

    test("adding a comment for group submission updates total_score", async () => {
      const gradingCheck = assignment.rubricChecks.find((c) => c.name === "Grading Review Check 2")!;
      const comment = await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: gradingCheck.id,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 12
      });
      commentId = comment.id;

      await new Promise((r) => setTimeout(r, 500));
      const review = await getReviewScore(reviewId);
      expect(review.total_score).toBeGreaterThanOrEqual(12);
    });

    test("updating group comment points recalculates total_score", async () => {
      await updateCommentPoints(commentId, 18);
      await new Promise((r) => setTimeout(r, 500));
      const review = await getReviewScore(reviewId);
      expect(review.total_score).toBeGreaterThanOrEqual(18);
    });

    test("group submissions without individual grading have null individual_scores", async () => {
      const review = await getReviewScore(reviewId);
      expect(review.individual_scores).toBeNull();
    });

    test("group student sees shared score after release", async ({ page }) => {
      await releaseSubmission(submissionId);
      await releaseReview(reviewId);

      await loginAndGoto(
        page,
        studentA,
        course,
        `/course/${course.id}/assignments/${assignment.id}/submissions/${submissionId}/files`
      );

      const scoreHeading = page.getByRole("heading", { name: /Overall Score/ });
      await expect(scoreHeading).toBeVisible({ timeout: 15000 });
      await argosScreenshot(page, "Group grading shared - student view with score");
    });
  });

  // ──────────────── Group individual grading ────────────────

  test.describe("Group individual grading (per-student scores)", () => {
    test.describe.configure({ mode: "serial" });

    let assignment: AssignmentWithRubric;
    let submissionId: number;
    let reviewId: number;
    let individualPartId: number;
    let individualCriteriaId: number;
    let individualCheckId: number;
    let commentStudentA: number;
    let commentStudentB: number;

    test("setup: create group assignment with individual grading part", async () => {
      assignment = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        class_id: course.id,
        name: "Group Individual Score Test"
      });

      await supabase.from("assignments").update({ group_config: "groups" }).eq("id", assignment.id);

      // Add an individual grading rubric part
      const { data: partData, error: partError } = await supabase
        .from("rubric_parts")
        .insert({
          class_id: course.id,
          name: "Individual Contribution",
          description: "Graded per student",
          ordinal: 10,
          rubric_id: assignment.grading_rubric_id!,
          assignment_id: assignment.id,
          is_individual_grading: true
        })
        .select("id")
        .single();
      if (partError) throw new Error(`Failed to create individual part: ${partError.message}`);
      individualPartId = partData.id;

      const { data: criteriaData, error: criteriaError } = await supabase
        .from("rubric_criteria")
        .insert({
          class_id: course.id,
          name: "Individual Criteria",
          description: "Per-student scoring",
          ordinal: 0,
          total_points: 30,
          is_additive: true,
          rubric_part_id: individualPartId,
          rubric_id: assignment.grading_rubric_id!,
          assignment_id: assignment.id
        })
        .select("id")
        .single();
      if (criteriaError) throw new Error(`Failed to create individual criteria: ${criteriaError.message}`);
      individualCriteriaId = criteriaData.id;

      const { data: checkData, error: checkError } = await supabase
        .from("rubric_checks")
        .insert({
          rubric_criteria_id: individualCriteriaId,
          name: "Individual Check",
          description: "Per-student check",
          ordinal: 0,
          points: 30,
          is_annotation: false,
          is_comment_required: false,
          class_id: course.id,
          is_required: false,
          assignment_id: assignment.id,
          rubric_id: assignment.grading_rubric_id!
        })
        .select("id")
        .single();
      if (checkError) throw new Error(`Failed to create individual check: ${checkError.message}`);
      individualCheckId = checkData.id;

      const sub = await createGroupSubmission({
        student_profiles: [studentA, studentB, studentC],
        assignment,
        course,
        instructor
      });
      submissionId = sub.submission_id;
      reviewId = sub.grading_review_id;
    });

    test("adding per-student comments populates individual_scores", async () => {
      const cA = await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: individualCheckId,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 25,
        target_student_profile_id: studentA.private_profile_id
      });
      commentStudentA = cA.id;

      const cB = await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: individualCheckId,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 18,
        target_student_profile_id: studentB.private_profile_id
      });
      commentStudentB = cB.id;

      await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: individualCheckId,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 10,
        target_student_profile_id: studentC.private_profile_id
      });

      await new Promise((r) => setTimeout(r, 1000));
      const review = await getReviewScore(reviewId);

      expect(review.individual_scores).not.toBeNull();
      const scores = review.individual_scores as Record<string, number>;
      expect(scores[studentA.private_profile_id]).toBe(25);
      expect(scores[studentB.private_profile_id]).toBe(18);
      expect(scores[studentC.private_profile_id]).toBe(10);
    });

    test("updating per-student comment points recalculates individual_scores", async () => {
      await updateCommentPoints(commentStudentA, 30);

      await new Promise((r) => setTimeout(r, 1000));
      const review = await getReviewScore(reviewId);

      const scores = review.individual_scores as Record<string, number>;
      expect(scores[studentA.private_profile_id]).toBe(30);
      expect(scores[studentB.private_profile_id]).toBe(18);
      expect(scores[studentC.private_profile_id]).toBe(10);
    });

    test("individual_scores respects criteria caps", async () => {
      // Student A already at 30 which is the cap (total_points=30, additive)
      // Try to give student B more than the cap
      await updateCommentPoints(commentStudentB, 50);

      await new Promise((r) => setTimeout(r, 1000));
      const review = await getReviewScore(reviewId);

      const scores = review.individual_scores as Record<string, number>;
      // Should be capped at 30 (criteria total_points)
      expect(scores[studentB.private_profile_id]).toBe(30);
    });

    test("shared rubric parts still contribute to total_score alongside individual parts", async () => {
      const sharedCheck = assignment.rubricChecks.find((c) => c.name === "Grading Review Check 2")!;
      await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: sharedCheck.id,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 7
      });

      await new Promise((r) => setTimeout(r, 500));
      const review = await getReviewScore(reviewId);
      // total_score should include shared part points + autograde
      expect(review.total_score).toBeGreaterThanOrEqual(7);

      // individual_scores should still track only individual grading parts
      const scores = review.individual_scores as Record<string, number>;
      expect(scores[studentA.private_profile_id]).toBe(30);
      expect(scores[studentC.private_profile_id]).toBe(10);
    });

    test("student sees their own individual score after release", async ({ page }) => {
      await releaseSubmission(submissionId);
      await releaseReview(reviewId);

      await loginAndGoto(
        page,
        studentA,
        course,
        `/course/${course.id}/assignments/${assignment.id}/submissions/${submissionId}/files`
      );

      await expect(page.getByText("Scores by student")).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole("heading", { name: /Overall Score/ })).not.toBeVisible();
      await expect(page.getByText("(You)")).toBeVisible();
      await argosScreenshot(page, "Group individual grading - student view with individual score");
    });

    test("instructor sees all individual scores", async ({ page }) => {
      await loginAndGoto(
        page,
        instructor,
        course,
        `/course/${course.id}/assignments/${assignment.id}/submissions/${submissionId}/files`
      );

      await expect(page.getByText("Scores by student")).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole("heading", { name: /Overall Score/ })).not.toBeVisible();
      await expect(page.getByText("Score Student A")).toBeVisible();
      await expect(page.getByText("Score Student B")).toBeVisible();
      await expect(page.getByText("Score Student C")).toBeVisible();
      await argosScreenshot(page, "Group individual grading - instructor view with all scores");
    });

    test("removing individual grading comments clears individual_scores", async () => {
      // Soft-delete all individual comments
      await supabase
        .from("submission_comments")
        .update({ deleted_at: new Date().toISOString() })
        .eq("submission_review_id", reviewId)
        .eq("rubric_check_id", individualCheckId);

      // Trigger needs a new event to recompute — update an existing non-deleted comment
      const sharedCheck = assignment.rubricChecks.find((c) => c.name === "Grading Review Check 2")!;
      await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: sharedCheck.id,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 1
      });

      await new Promise((r) => setTimeout(r, 1000));
      const review = await getReviewScore(reviewId);
      expect(review.individual_scores).toBeNull();
      // Split rubric still produces per-student totals (shared hand + autograde + tweak; individual slice zero).
      expect(review.per_student_grading_totals).not.toBeNull();
    });
  });

  // ──────────────── Assign-to-student grading ────────────────

  test.describe("Assign-to-student grading mode", () => {
    test.describe.configure({ mode: "serial" });

    let assignment: AssignmentWithRubric;
    let submissionId: number;
    let reviewId: number;
    let assignPart1Id: number;
    let assignPart2Id: number;
    let assignCheck1Id: number;
    let assignCheck2Id: number;

    test("setup: create group assignment with assign-to-student parts", async () => {
      assignment = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        class_id: course.id,
        name: "Assign-to-Student Test"
      });

      await supabase.from("assignments").update({ group_config: "groups" }).eq("id", assignment.id);

      const rubricId = assignment.grading_rubric_id!;

      const { data: parts } = await supabase
        .from("rubric_parts")
        .insert([
          {
            class_id: course.id,
            name: "Task A",
            description: "Assigned to one student",
            ordinal: 10,
            rubric_id: rubricId,
            assignment_id: assignment.id,
            is_assign_to_student: true
          },
          {
            class_id: course.id,
            name: "Task B",
            description: "Assigned to another student",
            ordinal: 11,
            rubric_id: rubricId,
            assignment_id: assignment.id,
            is_assign_to_student: true
          }
        ])
        .select("id, name");

      assignPart1Id = parts!.find((p) => p.name === "Task A")!.id;
      assignPart2Id = parts!.find((p) => p.name === "Task B")!.id;

      for (const [partId, idx] of [
        [assignPart1Id, 1],
        [assignPart2Id, 2]
      ] as const) {
        const { data: criteria } = await supabase
          .from("rubric_criteria")
          .insert({
            class_id: course.id,
            name: `Task ${idx} Criteria`,
            ordinal: 0,
            total_points: 20,
            is_additive: true,
            rubric_part_id: partId,
            rubric_id: rubricId,
            assignment_id: assignment.id
          })
          .select("id")
          .single();

        const { data: check } = await supabase
          .from("rubric_checks")
          .insert({
            rubric_criteria_id: criteria!.id,
            name: `Task ${idx} Check`,
            ordinal: 0,
            points: 20,
            is_annotation: false,
            is_comment_required: false,
            class_id: course.id,
            is_required: false,
            assignment_id: assignment.id,
            rubric_id: rubricId
          })
          .select("id")
          .single();

        if (idx === 1) assignCheck1Id = check!.id;
        else assignCheck2Id = check!.id;
      }

      const sub = await createGroupSubmission({
        student_profiles: [studentA, studentB],
        assignment,
        course,
        instructor
      });
      submissionId = sub.submission_id;
      reviewId = sub.grading_review_id;
    });

    test("assigning parts to students and grading produces individual_scores", async () => {
      // Assign Task A to Student A, Task B to Student B
      await supabase
        .from("submission_reviews")
        .update({
          rubric_part_student_assignments: {
            [String(assignPart1Id)]: studentA.private_profile_id,
            [String(assignPart2Id)]: studentB.private_profile_id
          }
        })
        .eq("id", reviewId);

      // Grade Task A check (assigned to Student A)
      await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: assignCheck1Id,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 15
      });

      // Grade Task B check (assigned to Student B)
      await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: assignCheck2Id,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 12
      });

      await new Promise((r) => setTimeout(r, 1000));
      const review = await getReviewScore(reviewId);

      expect(review.individual_scores).not.toBeNull();
      const scores = review.individual_scores as Record<string, number>;
      expect(scores[studentA.private_profile_id]).toBe(15);
      expect(scores[studentB.private_profile_id]).toBe(12);
    });

    test("skipping a part (null assignment) excludes it from individual_scores", async () => {
      // Skip Task B (set to null)
      await supabase
        .from("submission_reviews")
        .update({
          rubric_part_student_assignments: {
            [String(assignPart1Id)]: studentA.private_profile_id,
            [String(assignPart2Id)]: null
          }
        })
        .eq("id", reviewId);

      // Trigger recompute by touching a comment
      await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: assignCheck1Id,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 1
      });

      await new Promise((r) => setTimeout(r, 1000));
      const review = await getReviewScore(reviewId);

      const scores = review.individual_scores as Record<string, number>;
      // Student A: 15 (original) + 1 (new) = 16, capped at 20
      expect(scores[studentA.private_profile_id]).toBe(16);
      // Student B should not be in individual_scores since their part is skipped
      expect(scores[studentB.private_profile_id]).toBeUndefined();
    });

    test("reassigning a part to a different student moves the score", async () => {
      // Reassign Task A from Student A to Student B
      await supabase
        .from("submission_reviews")
        .update({
          rubric_part_student_assignments: {
            [String(assignPart1Id)]: studentB.private_profile_id,
            [String(assignPart2Id)]: null
          }
        })
        .eq("id", reviewId);

      // Trigger recompute
      await addComment({
        submission_id: submissionId,
        review_id: reviewId,
        check_id: assignCheck2Id,
        class_id: course.id,
        author_id: instructor.private_profile_id,
        points: 1
      });

      await new Promise((r) => setTimeout(r, 1000));
      const review = await getReviewScore(reviewId);

      const scores = review.individual_scores as Record<string, number>;
      // Task A's score now goes to Student B
      expect(scores[studentB.private_profile_id]).toBe(16);
      // Student A should have no individual score
      expect(scores[studentA.private_profile_id]).toBeUndefined();
    });
  });
});
