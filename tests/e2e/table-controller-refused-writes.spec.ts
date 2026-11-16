/**
 * TableController against real RLS, as a default grader (#983, Jon's review on #1159).
 *
 * RLS doesn't fail an UPDATE or DELETE it refuses: the statement matches 0 rows and PostgREST
 * answers without an error. TableController's update used to surface that as PGRST116, and its
 * delete (soft) and hardDelete as success, with the row gone from the UI until the next refetch.
 * They now throw the same refusedWriteError as the refine data provider.
 *
 * Each refusal below is one the grader really gets, on a row the grader can still read:
 * - update: `assignments`, which only manage_assignments holders may UPDATE.
 * - delete (soft): an instructor's `submission_comments` row. Graders may only change their own.
 * - hardDelete: a `review_assignments` row assigned to the grader. Only manage_review_assignments
 *   holders may DELETE; the grader reads it as its assignee.
 * The last test is the control: the grader soft-deletes their own comment, which RLS allows.
 *
 * tests/unit/table-controller-refused-writes.test.ts covers the same logic with stubbed responses.
 */
import TableController from "@/lib/TableController";
import { isRefusedWriteError } from "@/lib/refusedWriteError";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "date-fns";
import { expect, test } from "../global-setup";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  type TestingUser
} from "./TestingUtils";

type Table = "assignments" | "submission_comments" | "review_assignments";

/** A controller over one row the grader can read, loaded through the grader's own session. */
async function controllerFor<T extends Table>(client: SupabaseClient<Database>, table: T, id: number) {
  const { data, error } = await client.from(table).select("*").eq("id", id);
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
  return new TableController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: client.from(table).select("*").eq("id", id) as any,
    client,
    table,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialData: data as any,
    loadEntireTable: true
  });
}

test.describe("TableController reports writes RLS refused", () => {
  test.describe.configure({ mode: "serial" });

  let grader: TestingUser;
  let graderClient: SupabaseClient<Database>;
  let assignmentId: number;
  let assignmentTitle: string;
  let instructorCommentId: number;
  let graderCommentId: number;
  let reviewAssignmentId: number;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E TableController Refusals ${suffix}` });
    const instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    const student = await createUserInClass({ role: "student", class_id: course.id });
    graderClient = await createAuthenticatedClient(grader);

    const assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 14).toISOString(),
      name: `E2E TableController Refusals ${suffix}`,
      assignment_slug: `e2e-tc-${suffix}`,
      repo_mode: "none"
    });
    assignmentId = assignment.id;
    assignmentTitle = assignment.title;

    const submission = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    const { data: comments, error: commentError } = await supabase
      .from("submission_comments")
      .insert(
        [instructor, grader].map((author) => ({
          submission_id: submission.submission_id,
          submission_review_id: submission.grading_review_id,
          class_id: course.id,
          author: author.private_profile_id,
          comment: `TableController refusal test comment by ${author.email}`,
          released: false
        }))
      )
      .select("id, author");
    expect(commentError).toBeNull();
    instructorCommentId = comments!.find((c) => c.author === instructor.private_profile_id)!.id;
    graderCommentId = comments!.find((c) => c.author === grader.private_profile_id)!.id;

    const { data: reviewAssignment, error: reviewAssignmentError } = await supabase
      .from("review_assignments")
      .insert({
        assignee_profile_id: grader.private_profile_id,
        class_id: course.id,
        assignment_id: assignment.id,
        submission_id: submission.submission_id,
        submission_review_id: submission.grading_review_id,
        rubric_id: assignment.grading_rubric_id!,
        due_date: addDays(new Date(), 1).toUTCString()
      })
      .select("id")
      .single();
    expect(reviewAssignmentError).toBeNull();
    reviewAssignmentId = reviewAssignment!.id;
  });

  test("update of an assignment the grader can't edit throws a refusal and changes nothing", async () => {
    const controller = await controllerFor(graderClient, "assignments", assignmentId);
    try {
      const error = await controller
        .update(assignmentId, { title: "Changed by a grader" } as never)
        .catch((e: unknown) => e);

      expect(isRefusedWriteError(error)).toBe(true);
      expect((error as Error).message).toContain(
        "You don't have permission to change this, or it no longer exists. Nothing was changed."
      );
      // The optimistic edit is rolled back in the controller...
      expect(controller.rows.find((r) => r.id === assignmentId)?.title).toBe(assignmentTitle);
    } finally {
      controller.close();
    }
    // ...and the database never changed.
    const { data } = await supabase.from("assignments").select("title").eq("id", assignmentId).single();
    expect(data?.title).toBe(assignmentTitle);
  });

  test("soft delete of an instructor's comment throws a refusal and keeps the row", async () => {
    const controller = await controllerFor(graderClient, "submission_comments", instructorCommentId);
    try {
      const error = await controller.delete(instructorCommentId).catch((e: unknown) => e);

      expect(isRefusedWriteError(error)).toBe(true);
      expect((error as Error).message).toContain("You don't have permission to delete this. Nothing was changed.");
      // The row the controller removed optimistically is back.
      expect(controller.rows.map((r) => r.id)).toEqual([instructorCommentId]);
    } finally {
      controller.close();
    }
    const { data } = await supabase
      .from("submission_comments")
      .select("deleted_at")
      .eq("id", instructorCommentId)
      .single();
    expect(data?.deleted_at).toBeNull();
  });

  test("hardDelete of the grader's own review assignment throws a refusal and keeps the row", async () => {
    const controller = await controllerFor(graderClient, "review_assignments", reviewAssignmentId);
    try {
      const error = await controller.hardDelete(reviewAssignmentId).catch((e: unknown) => e);

      expect(isRefusedWriteError(error)).toBe(true);
      expect((error as Error).message).toContain("You don't have permission to delete this. Nothing was changed.");
      expect(controller.rows.map((r) => r.id)).toEqual([reviewAssignmentId]);
    } finally {
      controller.close();
    }
    const { data } = await supabase.from("review_assignments").select("id").eq("id", reviewAssignmentId);
    expect(data).toEqual([{ id: reviewAssignmentId }]);
  });

  test("soft delete the grader is allowed to make still succeeds", async () => {
    const controller = await controllerFor(graderClient, "submission_comments", graderCommentId);
    try {
      await expect(controller.delete(graderCommentId)).resolves.toBeUndefined();
      expect(controller.rows).toEqual([]);
    } finally {
      controller.close();
    }
    const { data } = await supabase.from("submission_comments").select("deleted_at").eq("id", graderCommentId).single();
    expect(data?.deleted_at).not.toBeNull();
  });
});
