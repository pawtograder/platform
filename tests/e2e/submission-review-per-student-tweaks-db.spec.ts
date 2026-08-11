/**
 * DB-level coverage for per_student_tweaks in public._submission_review_recompute_scores.
 *
 * The function is defined by three migrations. The most recent one before this suite was written
 * (20260604000000, which added the zero floors) states in its own header that it diffs against
 * 20260322130000 — a revision that PREDATES 20260329120001, the migration that added
 * per_student_tweaks. So the June 4 redefinition silently reverted the feature.
 *
 * The failure was invisible in exactly the way that makes it dangerous: the column is still written
 * by the UI, and the submission_reviews_recompute_split_metadata trigger still fires an
 * AFTER UPDATE OF ... per_student_tweaks recompute. A recompute really does run. It just computes a
 * total that omits the tweak, so the page stays responsive and the grade looks settled.
 *
 * These tests pin the restored arithmetic, including the ordering decision that the zero floor is
 * applied AFTER the per-student tweak (flooring first would let a negative tweak store a negative
 * line again — the exact crash 20260604000000 existed to fix).
 *
 * Lives at tests/e2e/ root, NOT in a subdirectory, so playwright.config.ts's testIgnore does not
 * skip it.
 */
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  TestingUser
} from "./TestingUtils";
import type { Assignment, Course } from "@/utils/supabase/DatabaseTypes";

/** Read the recompute's outputs for one review. */
async function readReview(reviewId: number) {
  const { data, error } = await supabase
    .from("submission_reviews")
    .select("total_score, total_autograde_score, per_student_grading_totals, per_student_grading_shared_base")
    .eq("id", reviewId)
    .single();
  if (error) throw new Error(`readReview failed: ${error.message}`);
  return data;
}

/** Write per_student_tweaks and let the AFTER UPDATE trigger drive the recompute. */
async function setPerStudentTweaks(reviewId: number, tweaks: Record<string, number | string> | null) {
  const { error } = await supabase.from("submission_reviews").update({ per_student_tweaks: tweaks }).eq("id", reviewId);
  if (error) throw new Error(`setPerStudentTweaks failed: ${error.message}`);
}

test.describe("_submission_review_recompute_scores — per_student_tweaks", () => {
  test.describe.configure({ mode: "serial" });

  let course: Course;
  let student: TestingUser;
  let assignment: Assignment;
  let reviewId: number;

  /**
   * Set the map, then read the resulting total.
   *
   * Assertions below compare totals from two such calls rather than against a baseline captured
   * during setup: a freshly prebaked submission still has autograder/recompute work settling, so a
   * baseline read early in the suite can be stale by the time the tweak is applied. Comparing two
   * adjacent reads isolates the tweak's contribution, which is the thing under test.
   */
  async function totalWithTweaks(tweaks: Record<string, number | string> | null): Promise<number> {
    await setPerStudentTweaks(reviewId, tweaks);
    return Number((await readReview(reviewId)).total_score ?? 0);
  }

  test("setup: a graded submission", async () => {
    course = await createClass();
    const users = await createUsersInClass([{ class_id: course.id, role: "student", useMagicLink: false }]);
    student = users[0];

    assignment = await insertAssignment({
      due_date: addDays(new Date(), 7).toUTCString(),
      class_id: course.id,
      name: "Per-student tweak recompute"
    });

    const submission = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });
    reviewId = submission.grading_review_id;
    expect(reviewId).toBeGreaterThan(0);
  });

  test("a positive tweak raises total_score by exactly its value", async () => {
    // The regression: from 2026-06-04 until the fix, the tweak was stored, displayed, and fired a
    // recompute that ignored it — so both reads returned the same number.
    const without = await totalWithTweaks(null);
    const withTweak = await totalWithTweaks({ [student.private_profile_id]: 3 });
    expect(withTweak - without).toBe(3);
  });

  test("every entry in the map is summed, not just the grade targets", async () => {
    const one = await totalWithTweaks({ [student.private_profile_id]: 3 });
    const two = await totalWithTweaks({
      [student.private_profile_id]: 3,
      "00000000-0000-0000-0000-000000000001": 2
    });
    expect(two - one).toBe(2);
  });

  test("string-valued tweaks are honored", async () => {
    // The UI writes numbers, but hand-edited rows have shipped strings.
    const without = await totalWithTweaks(null);
    const withTweak = await totalWithTweaks({ [student.private_profile_id]: "2.5" });
    expect(withTweak - without).toBe(2.5);
  });

  test("an un-castable value is skipped rather than aborting the whole recompute", async () => {
    // One bad map entry must not leave every score on the submission stale.
    const without = await totalWithTweaks(null);
    const withJunk = await totalWithTweaks({
      [student.private_profile_id]: "not-a-number",
      "00000000-0000-0000-0000-000000000002": 4
    });
    expect(withJunk - without).toBe(4);
  });

  test("a negative tweak lowers the total, and the floor keeps it at zero", async () => {
    const without = await totalWithTweaks(null);
    expect(without).toBeGreaterThan(0);

    const lowered = await totalWithTweaks({ [student.private_profile_id]: -1 });
    expect(lowered).toBe(without - 1);

    // Floor applied AFTER the tweak. Flooring first would store a negative total again — the exact
    // crash the floor migration existed to fix.
    const floored = await totalWithTweaks({ [student.private_profile_id]: -(without + 500) });
    expect(floored).toBe(0);
  });

  test("clearing the map returns the total to its untweaked value", async () => {
    const withTweak = await totalWithTweaks({ [student.private_profile_id]: 5 });
    const emptied = await totalWithTweaks({});
    const nulled = await totalWithTweaks(null);
    expect(emptied).toBe(withTweak - 5);
    expect(nulled).toBe(emptied);
  });
});
