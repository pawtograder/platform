/**
 * #1010: grading follows grade_submissions, and releasing grades and changing a released grade
 * follow release_grades (20261122150000_grading_and_release_by_capability.sql).
 *
 * The roles under test, all in one class:
 *   - a default grader: holds grade_submissions (every grader could grade before), not release_grades;
 *   - a Head TA: a custom role (a copy of the grader role) with release_grades turned on, as CS2100
 *     wants for redos (#1353);
 *   - a course coordinator: a custom role with grade_submissions turned off;
 *   - an instructor, who holds both;
 *   - a student, whose self-review and own-submission comments use the branches this migration
 *     copies unchanged.
 *
 * Each test makes its own submission, so the release state one test sets doesn't leak into another.
 * PostgREST reports a blocked insert as an error, but an update that RLS hides changes 0 rows
 * without one, so each blocked write is checked and then confirmed through the service client.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { addDays } from "date-fns";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import {
  supabase,
  createClass,
  createUserInClass,
  createAuthenticatedClient,
  insertAssignment,
  insertPreBakedSubmission,
  type TestingUser
} from "./TestingUtils";

type WriteResult = { data: unknown[] | null; error: unknown };
type Client = SupabaseClient<Database>;

function expectBlocked({ data, error }: WriteResult, what: string) {
  expect(error !== null || (data ?? []).length === 0, `${what} must be blocked`).toBe(true);
}

function expectRefused({ error }: { error: unknown }, what: string) {
  expect((error as { code?: string } | null)?.code, `${what} must be refused`).toBe("42501");
}

test.describe("grading and releasing grades follow grade_submissions and release_grades (#1010)", () => {
  let classA: Awaited<ReturnType<typeof createClass>>;
  let classB: Awaited<ReturnType<typeof createClass>>;
  let assignment: Awaited<ReturnType<typeof insertAssignment>>;
  let assignmentB: Awaited<ReturnType<typeof insertAssignment>>;
  let instructor: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let coordinator: TestingUser;
  let instructorB: TestingUser;
  let gradingCheckId: number;
  let selfReviewCheckId: number;
  let instructorClient: Client;
  let graderClient: Client;
  let headTaClient: Client;
  let coordinatorClient: Client;

  async function putOnNewRole(user: TestingUser, name: string, change: { add?: string[]; remove?: string[] }) {
    // Made by the service role, so it copies the default grader role (grade_submissions).
    const { data: role, error } = await supabase
      .from("class_roles")
      .insert({ class_id: classA.id, name })
      .select("id")
      .single();
    expect(error).toBeNull();
    for (const capability of change.add ?? []) {
      expect((await supabase.from("role_capabilities").insert({ role_id: role!.id, capability })).error).toBeNull();
    }
    for (const capability of change.remove ?? []) {
      expect(
        (await supabase.from("role_capabilities").delete().eq("role_id", role!.id).eq("capability", capability)).error
      ).toBeNull();
    }
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", user.user_id)
          .eq("class_id", classA.id)
      ).error
    ).toBeNull();
  }

  test.beforeAll(async () => {
    classA = await createClass({ name: "E2E Grading By Capability A" });
    classB = await createClass({ name: "E2E Grading By Capability B" });
    instructor = await createUserInClass({ role: "instructor", class_id: classA.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classA.id });
    headTa = await createUserInClass({ role: "grader", class_id: classA.id });
    coordinator = await createUserInClass({ role: "grader", class_id: classA.id });
    instructorB = await createUserInClass({ role: "instructor", class_id: classB.id });

    const due = addDays(new Date(), 14).toISOString();
    assignment = await insertAssignment({
      class_id: classA.id,
      due_date: due,
      assignment_slug: `e2e-grading-cap-${Date.now().toString(36)}`
    });
    assignmentB = await insertAssignment({
      class_id: classB.id,
      due_date: due,
      assignment_slug: `e2e-grading-cap-b-${Date.now().toString(36)}`
    });
    gradingCheckId = assignment.rubricChecks.find((c) => c.name === "Grading Review Check 2")!.id;
    selfReviewCheckId = assignment.rubricChecks.find((c) => c.name === "Self Review Check 2")!.id;

    await putOnNewRole(headTa, "Head TA", { add: ["release_grades"] });
    await putOnNewRole(coordinator, "Course coordinator", { remove: ["grade_submissions"] });

    instructorClient = await createAuthenticatedClient(instructor);
    graderClient = await createAuthenticatedClient(plainGrader);
    headTaClient = await createAuthenticatedClient(headTa);
    coordinatorClient = await createAuthenticatedClient(coordinator);
  });

  /** A new student with one submission in the class; returns the ids a test needs. */
  async function newSubmission(class_id = classA.id, assignment_id = assignment.id) {
    const student = await createUserInClass({ role: "student", class_id });
    const submission = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id,
      class_id
    });
    const { data: file, error } = await supabase
      .from("submission_files")
      .select("id")
      .eq("submission_id", submission.submission_id)
      .limit(1)
      .single();
    expect(error).toBeNull();
    return { student, ...submission, file_id: file!.id };
  }

  async function setReview(reviewId: number, fields: { released?: boolean; completed?: boolean }) {
    const update: Database["public"]["Tables"]["submission_reviews"]["Update"] = {};
    if (fields.released !== undefined) update.released = fields.released;
    if (fields.completed !== undefined) {
      update.completed_at = fields.completed ? new Date().toISOString() : null;
      update.completed_by = fields.completed ? instructor.private_profile_id : null;
    }
    expect((await supabase.from("submission_reviews").update(update).eq("id", reviewId)).error).toBeNull();
  }

  async function review(reviewId: number) {
    const { data, error } = await supabase
      .from("submission_reviews")
      .select("released, completed_at, tweak")
      .eq("id", reviewId)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  /** A rubric check applied to the grading review, as the rubric sidebar's "Add Check" does. */
  function rubricCheckRow(
    sub: { submission_id: number; grading_review_id: number },
    author: TestingUser,
    class_id = classA.id
  ) {
    return {
      submission_id: sub.submission_id,
      submission_review_id: sub.grading_review_id,
      class_id,
      author: author.private_profile_id,
      comment: "Applied check",
      rubric_check_id: gradingCheckId,
      points: 10,
      released: false,
      eventually_visible: true
    };
  }

  async function addCheckAsService(sub: { submission_id: number; grading_review_id: number }, author: TestingUser) {
    const { data, error } = await supabase
      .from("submission_comments")
      .insert(rubricCheckRow(sub, author))
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  async function comment(id: number) {
    const { data, error } = await supabase
      .from("submission_comments")
      .select("comment, points, deleted_at")
      .eq("id", id)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function holds(client: Client, capability: string) {
    const { data, error } = await client.rpc("user_class_ids_with_capability", { p_capability: capability });
    expect(error).toBeNull();
    return (data ?? []).includes(classA.id);
  }

  test("each role holds what the migration gives it", async () => {
    expect(await holds(instructorClient, "grade_submissions")).toBe(true);
    expect(await holds(instructorClient, "release_grades")).toBe(true);
    expect(await holds(graderClient, "grade_submissions"), "every grader could grade before").toBe(true);
    expect(await holds(graderClient, "release_grades"), "release_grades is instructor-only by default").toBe(false);
    expect(await holds(headTaClient, "grade_submissions"), "copied from the grader role").toBe(true);
    expect(await holds(headTaClient, "release_grades"), "turned on for the Head TA role").toBe(true);
    expect(await holds(coordinatorClient, "grade_submissions"), "turned off for the coordinator").toBe(false);
  });

  test("a default grader grades an unreleased review: applies a check, edits it, and marks the review complete", async () => {
    const sub = await newSubmission();
    const { data: applied, error } = await graderClient
      .from("submission_comments")
      .insert(rubricCheckRow(sub, plainGrader))
      .select("id")
      .single();
    expect(error).toBeNull();

    const { data: edited, error: editError } = await graderClient
      .from("submission_comments")
      .update({ comment: "Edited by the grader" })
      .eq("id", applied!.id)
      .select("id");
    expect(editError).toBeNull();
    expect(edited).toHaveLength(1);

    const { data: file, error: fileError } = await graderClient
      .from("submission_file_comments")
      .insert({
        submission_id: sub.submission_id,
        submission_file_id: sub.file_id,
        submission_review_id: sub.grading_review_id,
        class_id: classA.id,
        author: plainGrader.private_profile_id,
        comment: "Line comment",
        line: 1,
        released: false,
        eventually_visible: true
      })
      .select("id");
    expect(fileError).toBeNull();
    expect(file).toHaveLength(1);

    const { data: completed, error: completeError } = await graderClient
      .from("submission_reviews")
      .update({ completed_at: new Date().toISOString(), completed_by: plainGrader.private_profile_id })
      .eq("id", sub.grading_review_id)
      .select("id");
    expect(completeError).toBeNull();
    expect(completed).toHaveLength(1);
    expect((await review(sub.grading_review_id)).completed_at).not.toBeNull();
  });

  test("a default grader can't release or unrelease, directly or through the release RPCs", async () => {
    const sub = await newSubmission();
    await setReview(sub.grading_review_id, { completed: true });

    // Before: the policy let a grader release a completed review. Now the trigger refuses it.
    expectRefused(
      await graderClient.from("submission_reviews").update({ released: true }).eq("id", sub.grading_review_id),
      "a grader releasing a completed review"
    );
    expectRefused(
      await graderClient.rpc("release_grading_reviews_for_submissions", {
        p_assignment_id: assignment.id,
        p_submission_ids: [sub.submission_id]
      }),
      "a grader calling release_grading_reviews_for_submissions"
    );
    expectRefused(
      await graderClient.rpc("release_all_grading_reviews_for_assignment", { assignment_id: assignment.id }),
      "a grader calling release_all_grading_reviews_for_assignment"
    );
    expect((await review(sub.grading_review_id)).released).toBe(false);

    // Before: a grader could unrelease a released review that was still incomplete.
    await setReview(sub.grading_review_id, { released: true, completed: false });
    expectRefused(
      await graderClient.from("submission_reviews").update({ released: false }).eq("id", sub.grading_review_id),
      "a grader unreleasing a released, incomplete review"
    );
    expectRefused(
      await graderClient.rpc("unrelease_grading_reviews_for_submissions", {
        p_assignment_id: assignment.id,
        p_submission_ids: [sub.submission_id]
      }),
      "a grader calling unrelease_grading_reviews_for_submissions"
    );
    expect((await review(sub.grading_review_id)).released).toBe(true);
  });

  test("a default grader can still mark a released, incomplete review complete (#843)", async () => {
    const sub = await newSubmission();
    await setReview(sub.grading_review_id, { released: true, completed: false });
    const { data, error } = await graderClient
      .from("submission_reviews")
      .update({ completed_at: new Date().toISOString(), completed_by: plainGrader.private_profile_id })
      .eq("id", sub.grading_review_id)
      .select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(await review(sub.grading_review_id)).toMatchObject({ released: true });
  });

  test("a default grader can't change a released grade", async () => {
    const sub = await newSubmission();
    const ownCheck = await addCheckAsService(sub, plainGrader);
    await setReview(sub.grading_review_id, { released: true, completed: true });

    // Before: the INSERT policy let any grader add a comment or rubric check to a released review.
    expectRefused(
      await graderClient.from("submission_comments").insert(rubricCheckRow(sub, plainGrader)),
      "a grader adding a rubric check to a released review"
    );
    expectRefused(
      await graderClient.from("submission_file_comments").insert({
        submission_id: sub.submission_id,
        submission_file_id: sub.file_id,
        submission_review_id: sub.grading_review_id,
        class_id: classA.id,
        author: plainGrader.private_profile_id,
        comment: "Late line comment",
        line: 1,
        released: true,
        eventually_visible: true
      }),
      "a grader adding a line comment to a released review"
    );
    expectBlocked(
      await graderClient.from("submission_comments").update({ points: 0 }).eq("id", ownCheck).select("id"),
      "a grader editing their own check on a released review"
    );
    expectBlocked(
      await graderClient
        .from("submission_comments")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", ownCheck)
        .select("id"),
      "a grader deleting their own check on a released review"
    );
    expectBlocked(
      await graderClient.from("submission_reviews").update({ tweak: 5 }).eq("id", sub.grading_review_id).select("id"),
      "a grader tweaking a released, complete review"
    );
    expect(await comment(ownCheck)).toMatchObject({ points: 10, deleted_at: null });
    expect((await review(sub.grading_review_id)).tweak).toBe(0);
  });

  test("#1353: a TA with release_grades edits an already released grade", async () => {
    const sub = await newSubmission();
    // The original grader's check, released to the student.
    const gradersCheck = await addCheckAsService(sub, plainGrader);
    await setReview(sub.grading_review_id, { released: true, completed: true });

    // A redo: the Head TA changes the other TA's check, takes it off, adds a new one, and tweaks.
    const { data: edited, error: editError } = await headTaClient
      .from("submission_comments")
      .update({ points: 4, comment: "Redo: partial credit" })
      .eq("id", gradersCheck)
      .select("id");
    expect(editError).toBeNull();
    expect(edited).toHaveLength(1);
    expect(await comment(gradersCheck)).toMatchObject({ points: 4, comment: "Redo: partial credit" });

    const { data: removed, error: removeError } = await headTaClient
      .from("submission_comments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", gradersCheck)
      .select("id");
    expect(removeError).toBeNull();
    expect(removed).toHaveLength(1);

    const { data: added, error: addError } = await headTaClient
      .from("submission_comments")
      .insert({ ...rubricCheckRow(sub, headTa), released: true })
      .select("id");
    expect(addError).toBeNull();
    expect(added).toHaveLength(1);

    const { data: tweaked, error: tweakError } = await headTaClient
      .from("submission_reviews")
      .update({ tweak: 2 })
      .eq("id", sub.grading_review_id)
      .select("id");
    expect(tweakError).toBeNull();
    expect(tweaked).toHaveLength(1);
    expect(await review(sub.grading_review_id)).toMatchObject({ released: true, tweak: 2 });
  });

  test("a TA with release_grades releases and unreleases, directly and through the RPCs", async () => {
    const sub = await newSubmission();
    await setReview(sub.grading_review_id, { completed: true });

    const { data: released, error: releaseError } = await headTaClient.rpc("release_grading_reviews_for_submissions", {
      p_assignment_id: assignment.id,
      p_submission_ids: [sub.submission_id]
    });
    expect(releaseError).toBeNull();
    expect(released).toBe(1);
    expect((await review(sub.grading_review_id)).released).toBe(true);

    const { error: unreleaseError } = await headTaClient
      .from("submission_reviews")
      .update({ released: false })
      .eq("id", sub.grading_review_id);
    expect(unreleaseError).toBeNull();
    expect((await review(sub.grading_review_id)).released).toBe(false);

    // Release all and Unrelease all work for them too (the PR body says so).
    const { error: allError } = await headTaClient.rpc("release_all_grading_reviews_for_assignment", {
      assignment_id: assignment.id
    });
    expect(allError).toBeNull();
    expect((await review(sub.grading_review_id)).released).toBe(true);
    const { error: unreleaseAllError } = await headTaClient.rpc("unrelease_all_grading_reviews_for_assignment", {
      assignment_id: assignment.id
    });
    expect(unreleaseAllError).toBeNull();
    expect((await review(sub.grading_review_id)).released).toBe(false);
  });

  test("release_grades in one class doesn't reach another class", async () => {
    const subB = await newSubmission(classB.id, assignmentB.id);
    await setReview(subB.grading_review_id, { released: true, completed: true });

    expectBlocked(
      await headTaClient
        .from("submission_reviews")
        .update({ released: false, tweak: 9 })
        .eq("id", subB.grading_review_id)
        .select("id"),
      "a class A Head TA changing a class B review"
    );
    const { error } = await headTaClient.from("submission_comments").insert({
      ...rubricCheckRow(subB, headTa, classB.id),
      rubric_check_id: null
    });
    expect(error, "a class A Head TA adding a comment to a class B review").not.toBeNull();
    expect(await review(subB.grading_review_id)).toMatchObject({ released: true, tweak: 0 });

    // A comment that claims class A but points at class B's review is refused too.
    expect(
      (
        await graderClient.from("submission_comments").insert({
          ...rubricCheckRow(subB, plainGrader, classA.id),
          rubric_check_id: null
        })
      ).error,
      "a class A grader attaching a comment to a class B review"
    ).not.toBeNull();

    // Class B's own instructor still can.
    const instructorBClient = await createAuthenticatedClient(instructorB);
    const { error: ownError } = await instructorBClient
      .from("submission_reviews")
      .update({ released: false })
      .eq("id", subB.grading_review_id);
    expect(ownError).toBeNull();
    expect((await review(subB.grading_review_id)).released).toBe(false);
  });

  test("a custom role without grade_submissions can't grade or finalize", async () => {
    const sub = await newSubmission();
    expectRefused(
      await coordinatorClient.from("submission_comments").insert(rubricCheckRow(sub, coordinator)),
      "a coordinator applying a rubric check"
    );
    expectBlocked(
      await coordinatorClient
        .from("submission_reviews")
        .update({ completed_at: new Date().toISOString(), completed_by: coordinator.private_profile_id })
        .eq("id", sub.grading_review_id)
        .select("id"),
      "a coordinator marking a review complete"
    );
    expectRefused(
      await coordinatorClient.rpc("check_grading_completion_eligibility", { p_assignment_id: assignment.id }),
      "a coordinator checking Finalize Grading"
    );
    expectRefused(
      await coordinatorClient.rpc("complete_eligible_grading_reviews", { p_assignment_id: assignment.id }),
      "a coordinator running Finalize Grading"
    );
    expect((await review(sub.grading_review_id)).completed_at).toBeNull();

    // A default grader still can.
    const { error } = await graderClient.rpc("check_grading_completion_eligibility", {
      p_assignment_id: assignment.id
    });
    expect(error).toBeNull();
  });

  test("instructors are unchanged: they release, unrelease and change released grades", async () => {
    const sub = await newSubmission();
    const gradersCheck = await addCheckAsService(sub, plainGrader);
    await setReview(sub.grading_review_id, { completed: true });

    expect(
      (await instructorClient.from("submission_reviews").update({ released: true }).eq("id", sub.grading_review_id))
        .error
    ).toBeNull();
    const { data: edited, error: editError } = await instructorClient
      .from("submission_comments")
      .update({ points: 7 })
      .eq("id", gradersCheck)
      .select("id");
    expect(editError).toBeNull();
    expect(edited).toHaveLength(1);
    expect(
      (
        await instructorClient
          .from("submission_comments")
          .insert({ ...rubricCheckRow(sub, instructor), released: true })
      ).error
    ).toBeNull();
    expect(
      (await instructorClient.from("submission_reviews").update({ released: false }).eq("id", sub.grading_review_id))
        .error
    ).toBeNull();
    expect((await review(sub.grading_review_id)).released).toBe(false);
  });

  test("students are unchanged: a self-review rubric check and a comment on their own submission still work", async () => {
    const sub = await newSubmission();
    const studentClient = await createAuthenticatedClient(sub.student);

    // The student's self-review, assigned to them, as auto_assign_self_reviews does. A trigger may
    // already have made either row, so find it first.
    let selfReviewId: number;
    const { data: existingReview, error: lookupError } = await supabase
      .from("submission_reviews")
      .select("id")
      .eq("submission_id", sub.submission_id)
      .eq("rubric_id", assignment.self_review_rubric_id!)
      .maybeSingle();
    expect(lookupError).toBeNull();
    if (existingReview) {
      selfReviewId = existingReview.id;
    } else {
      const { data: created, error: reviewError } = await supabase
        .from("submission_reviews")
        .insert({
          class_id: classA.id,
          submission_id: sub.submission_id,
          rubric_id: assignment.self_review_rubric_id!,
          name: "Self Review",
          total_score: 0,
          tweak: 0,
          total_autograde_score: 0,
          released: false
        })
        .select("id")
        .single();
      expect(reviewError).toBeNull();
      selfReviewId = created!.id;
    }
    const { data: existingAssignment, error: assignmentLookupError } = await supabase
      .from("review_assignments")
      .select("id")
      .eq("submission_review_id", selfReviewId)
      .eq("assignee_profile_id", sub.student.private_profile_id);
    expect(assignmentLookupError).toBeNull();
    if ((existingAssignment ?? []).length === 0) {
      expect(
        (
          await supabase.from("review_assignments").insert({
            assignee_profile_id: sub.student.private_profile_id,
            class_id: classA.id,
            assignment_id: assignment.id,
            submission_id: sub.submission_id,
            submission_review_id: selfReviewId,
            rubric_id: assignment.self_review_rubric_id!,
            due_date: addDays(new Date(), 3).toISOString()
          })
        ).error
      ).toBeNull();
    }

    // The assignee branch of the INSERT policy, with its hard-deadline check.
    const { data: selfCheck, error: selfCheckError } = await studentClient
      .from("submission_comments")
      .insert({
        submission_id: sub.submission_id,
        submission_review_id: selfReviewId,
        class_id: classA.id,
        author: sub.student.private_profile_id,
        comment: "My self-review",
        rubric_check_id: selfReviewCheckId,
        points: 5,
        released: false,
        eventually_visible: true
      })
      .select("id")
      .single();
    expect(selfCheckError).toBeNull();

    // The student branch of the UPDATE policy: their own row while the review is incomplete.
    const { data: selfEdited, error: selfEditError } = await studentClient
      .from("submission_comments")
      .update({ comment: "My self-review, edited" })
      .eq("id", selfCheck!.id)
      .select("id");
    expect(selfEditError).toBeNull();
    expect(selfEdited).toHaveLength(1);

    // The non-review branch: a comment on their own submission with no review.
    const { error: ownError } = await studentClient.from("submission_comments").insert({
      submission_id: sub.submission_id,
      class_id: classA.id,
      author: sub.student.private_profile_id,
      comment: "A question about my submission",
      released: false,
      eventually_visible: true
    });
    expect(ownError).toBeNull();

    // And a student still can't grade: no rubric check on their own grading review.
    expect(
      (await studentClient.from("submission_comments").insert(rubricCheckRow(sub, sub.student))).error,
      "a student applying a check to their own grading review"
    ).not.toBeNull();
  });
});
