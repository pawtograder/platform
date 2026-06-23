import { addDays } from "date-fns";
import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  type TestingUser
} from "@/tests/e2e/TestingUtils";

type ReviewState = {
  id: number;
  released: boolean;
  completed_at: string | null;
  completed_by: string | null;
};

test.describe("submission_reviews completion policy (issue 843)", () => {
  test.describe.configure({ mode: "serial" });

  let reviewId: number;
  let grader: TestingUser;
  let instructor: TestingUser;
  let graderClient: SupabaseClient<Database>;
  let instructorClient: SupabaseClient<Database>;

  async function getReviewState(): Promise<ReviewState> {
    const { data, error } = await supabase
      .from("submission_reviews")
      .select("id, released, completed_at, completed_by")
      .eq("id", reviewId)
      .single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    return data as ReviewState;
  }

  async function setReviewState(state: {
    released: boolean;
    completed_at: string | null;
    completed_by: string | null;
  }) {
    const { error } = await supabase
      .from("submission_reviews")
      .update({
        released: state.released,
        completed_at: state.completed_at,
        completed_by: state.completed_by
      })
      .eq("id", reviewId);
    expect(error).toBeNull();
  }

  test.beforeAll(async () => {
    const course = await createClass({ name: "Issue 843 Postgres policy e2e" });
    [grader, instructor] = await createUsersInClass([
      {
        name: "Issue 843 Grader",
        email: `issue843-grader-${Date.now()}@pawtograder.net`,
        role: "grader",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Issue 843 Instructor",
        email: `issue843-instructor-${Date.now()}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    const [student] = await createUsersInClass([
      {
        name: "Issue 843 Student",
        email: `issue843-student-${Date.now()}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Issue 843 policy assignment",
      due_date: addDays(new Date(), 3).toUTCString(),
      release_date: addDays(new Date(), -3).toUTCString()
    });

    const submission = await insertPreBakedSubmission({
      assignment_id: assignment.id,
      class_id: course.id,
      student_profile_id: student.private_profile_id
    });

    reviewId = submission.grading_review_id;
    graderClient = await createAuthenticatedClient(grader);
    instructorClient = await createAuthenticatedClient(instructor);
  });

  test("grader can mark complete when review is released but currently incomplete", async () => {
    await setReviewState({
      released: true,
      completed_at: null,
      completed_by: null
    });

    const completedAt = new Date().toISOString();
    const { data, error } = await graderClient
      .from("submission_reviews")
      .update({
        completed_at: completedAt,
        completed_by: grader.private_profile_id
      })
      .eq("id", reviewId)
      .select("id")
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBe(reviewId);

    const state = await getReviewState();
    expect(state.released).toBe(true);
    expect(state.completed_by).toBe(grader.private_profile_id);
    expect(state.completed_at).not.toBeNull();
  });

  test("grader cannot mark incomplete when review is released and complete", async () => {
    const lockedCompletedAt = new Date().toISOString();
    const lockedCompletedAtMs = new Date(lockedCompletedAt).getTime();
    await setReviewState({
      released: true,
      completed_at: lockedCompletedAt,
      completed_by: instructor.private_profile_id
    });

    const { data, error } = await graderClient
      .from("submission_reviews")
      .update({
        completed_at: null,
        completed_by: null
      })
      .eq("id", reviewId)
      .select("id, completed_at, completed_by")
      .maybeSingle();

    // RLS denial returns no row for the update target.
    expect(error).toBeNull();
    expect(data).toBeNull();

    const state = await getReviewState();
    expect(state.released).toBe(true);
    expect(state.completed_by).toBe(instructor.private_profile_id);
    expect(new Date(state.completed_at ?? "").getTime()).toBe(lockedCompletedAtMs);
  });

  test("instructor can mark incomplete even when review is released and complete", async () => {
    await setReviewState({
      released: true,
      completed_at: new Date().toISOString(),
      completed_by: grader.private_profile_id
    });

    const { data, error } = await instructorClient
      .from("submission_reviews")
      .update({
        completed_at: null,
        completed_by: null
      })
      .eq("id", reviewId)
      .select("id")
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBe(reviewId);

    const state = await getReviewState();
    expect(state.released).toBe(true);
    expect(state.completed_at).toBeNull();
    expect(state.completed_by).toBeNull();
  });

  test("instructor can mark complete even when review is released", async () => {
    await setReviewState({
      released: true,
      completed_at: null,
      completed_by: null
    });

    const { data, error } = await instructorClient
      .from("submission_reviews")
      .update({
        completed_at: new Date().toISOString(),
        completed_by: instructor.private_profile_id
      })
      .eq("id", reviewId)
      .select("id")
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBe(reviewId);

    const state = await getReviewState();
    expect(state.released).toBe(true);
    expect(state.completed_at).not.toBeNull();
    expect(state.completed_by).toBe(instructor.private_profile_id);
  });
});
