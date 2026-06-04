import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createAuthenticatedClient,
  createClass,
  createClassSection,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

/**
 * End-to-end coverage for get_rubric_check_application_stats. Builds a real graded
 * scenario (two students in two class sections, a choice rubric check + a plain
 * check, applied differently per student) and asserts the RPC's counts, per-option
 * breakdown, boolean/section filtering, validation, and instructor-only authorization.
 */
type StatsResult = {
  cohort_total: number;
  checks: { rubric_check_id: number; applied_count: number; options: { option_index: number; count: number }[] }[];
};

const findCheck = (res: StatsResult, id: number) => res.checks.find((c) => c.rubric_check_id === id);
const optionCount = (res: StatsResult, id: number, index: number) =>
  findCheck(res, id)?.options.find((o) => o.option_index === index)?.count;

test.describe("get_rubric_check_application_stats RPC", () => {
  let assignmentId: number;
  let choiceCheckId: number;
  let plainCheckId: number;
  let secAName: string;
  let studentA: TestingUser;
  let instructorClient: SupabaseClient<Database>;

  test.beforeAll(async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const cls = await createClass({ name: "Rubric Report E2E" });
    const classId = cls.id;

    const secA = await createClassSection({ class_id: classId, name: `RR-SecA-${suffix}` });
    const secB = await createClassSection({ class_id: classId, name: `RR-SecB-${suffix}` });
    secAName = secA.name;

    const instructor = await createUserInClass({ role: "instructor", class_id: classId });
    studentA = await createUserInClass({ role: "student", class_id: classId, section_id: secA.id });
    const studentB = await createUserInClass({ role: "student", class_id: classId, section_id: secB.id });

    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), -1).toISOString(),
      release_date: addDays(new Date(), -7).toISOString(),
      group_config: "individual"
    });
    assignmentId = assignment.id;

    // Locate the assignment's grading-review rubric and one criterion to attach checks to.
    const { data: rubric, error: rubricErr } = await supabase
      .from("rubrics")
      .select("id")
      .eq("assignment_id", assignmentId)
      .eq("review_round", "grading-review")
      .limit(1)
      .single();
    if (rubricErr || !rubric) throw new Error(`No grading rubric: ${rubricErr?.message}`);
    const gradingRubricId = rubric.id;

    const { data: criterion, error: critErr } = await supabase
      .from("rubric_criteria")
      .select("id")
      .eq("rubric_id", gradingRubricId)
      .limit(1)
      .single();
    if (critErr || !criterion) throw new Error(`No grading criterion: ${critErr?.message}`);

    // A choice check (options) and a plain check (no options), both in the grading rubric.
    const { data: inserted, error: checksErr } = await supabase
      .from("rubric_checks")
      .insert([
        {
          rubric_criteria_id: criterion.id,
          name: `RR Choice ${suffix}`,
          ordinal: 100,
          points: 10,
          is_annotation: false,
          is_comment_required: false,
          class_id: classId,
          is_required: false,
          assignment_id: assignmentId,
          rubric_id: gradingRubricId,
          data: {
            options: [
              { label: "Excellent", points: 10 },
              { label: "OK", points: 5 },
              { label: "Poor", points: 0 }
            ]
          }
        },
        {
          rubric_criteria_id: criterion.id,
          name: `RR Plain ${suffix}`,
          ordinal: 101,
          points: 3,
          is_annotation: false,
          is_comment_required: false,
          class_id: classId,
          is_required: false,
          assignment_id: assignmentId,
          rubric_id: gradingRubricId
        }
      ])
      .select("id, name");
    if (checksErr || !inserted) throw new Error(`Failed to insert checks: ${checksErr?.message}`);
    choiceCheckId = inserted.find((c) => c.name.startsWith("RR Choice"))!.id;
    plainCheckId = inserted.find((c) => c.name.startsWith("RR Plain"))!.id;

    const subA = await insertPreBakedSubmission({
      student_profile_id: studentA.private_profile_id,
      assignment_id: assignmentId,
      class_id: classId
    });
    const subB = await insertPreBakedSubmission({
      student_profile_id: studentB.private_profile_id,
      assignment_id: assignmentId,
      class_id: classId
    });
    // The cohort = students with an ACTIVE submission.
    await supabase.from("submissions").update({ is_active: true }).in("id", [subA.submission_id, subB.submission_id]);

    // Apply checks: studentA -> choice "OK" (option 1) + plain; studentB -> choice "Excellent" (option 0).
    const { error: commentsErr } = await supabase.from("submission_comments").insert([
      {
        submission_id: subA.submission_id,
        author: instructor.private_profile_id,
        comment: "OK",
        points: 5,
        class_id: classId,
        released: true,
        rubric_check_id: choiceCheckId,
        submission_review_id: subA.grading_review_id
      },
      {
        submission_id: subA.submission_id,
        author: instructor.private_profile_id,
        comment: "plain applied",
        points: 3,
        class_id: classId,
        released: true,
        rubric_check_id: plainCheckId,
        submission_review_id: subA.grading_review_id
      },
      {
        submission_id: subB.submission_id,
        author: instructor.private_profile_id,
        comment: "Excellent",
        points: 10,
        class_id: classId,
        released: true,
        rubric_check_id: choiceCheckId,
        submission_review_id: subB.grading_review_id
      }
    ]);
    if (commentsErr) throw new Error(`Failed to apply checks: ${commentsErr.message}`);

    instructorClient = await createAuthenticatedClient(instructor);
  });

  test("aggregates application counts and per-option breakdown (no filter)", async () => {
    const { data, error } = await instructorClient.rpc("get_rubric_check_application_stats", {
      p_assignment_id: assignmentId
    });
    expect(error).toBeNull();
    const res = data as unknown as StatsResult;

    expect(res.cohort_total).toBe(2);
    expect(findCheck(res, choiceCheckId)?.applied_count).toBe(2);
    expect(optionCount(res, choiceCheckId, 0)).toBe(1); // Excellent -> studentB
    expect(optionCount(res, choiceCheckId, 1)).toBe(1); // OK -> studentA
    expect(findCheck(res, plainCheckId)?.applied_count).toBe(1); // studentA only
    expect(findCheck(res, plainCheckId)?.options).toEqual([]);
  });

  test("filters the cohort by class section", async () => {
    const { data, error } = await instructorClient.rpc("get_rubric_check_application_stats", {
      p_assignment_id: assignmentId,
      p_filter: { section: secAName }
    });
    expect(error).toBeNull();
    const res = data as unknown as StatsResult;

    expect(res.cohort_total).toBe(1); // studentA only
    expect(findCheck(res, plainCheckId)?.applied_count).toBe(1);
    expect(findCheck(res, choiceCheckId)?.applied_count).toBe(1);
    expect(optionCount(res, choiceCheckId, 1)).toBe(1); // OK
  });

  test("supports nested NOT / checkApplied / optionSelected filters", async () => {
    const notSecA = await instructorClient.rpc("get_rubric_check_application_stats", {
      p_assignment_id: assignmentId,
      p_filter: { op: "not", args: [{ section: secAName }] }
    });
    expect(notSecA.error).toBeNull();
    expect((notSecA.data as unknown as StatsResult).cohort_total).toBe(1); // studentB
    expect(findCheck(notSecA.data as unknown as StatsResult, plainCheckId)?.applied_count).toBe(0);

    const hasPlain = await instructorClient.rpc("get_rubric_check_application_stats", {
      p_assignment_id: assignmentId,
      p_filter: { checkApplied: plainCheckId }
    });
    expect(hasPlain.error).toBeNull();
    expect((hasPlain.data as unknown as StatsResult).cohort_total).toBe(1); // studentA

    const excellent = await instructorClient.rpc("get_rubric_check_application_stats", {
      p_assignment_id: assignmentId,
      p_filter: { optionSelected: { checkId: choiceCheckId, optionIndex: 0 } }
    });
    expect(excellent.error).toBeNull();
    expect((excellent.data as unknown as StatsResult).cohort_total).toBe(1); // studentB
  });

  test("rejects an invalid filter (closed predicate set)", async () => {
    const { error } = await instructorClient.rpc("get_rubric_check_application_stats", {
      p_assignment_id: assignmentId,
      p_filter: { op: "xor", args: [] }
    });
    expect(error).not.toBeNull();
  });

  test("treats injection-style section values as inert text", async () => {
    const { data, error } = await instructorClient.rpc("get_rubric_check_application_stats", {
      p_assignment_id: assignmentId,
      p_filter: { section: "'); DROP TABLE public.assignments;--" }
    });
    expect(error).toBeNull();
    expect((data as unknown as StatsResult).cohort_total).toBe(0); // matches no section, table untouched
    // Sanity: assignments table still exists / is queryable.
    const { error: stillThere } = await supabase.from("assignments").select("id").eq("id", assignmentId).single();
    expect(stillThere).toBeNull();
  });

  test("denies non-instructors", async () => {
    const studentClient = await createAuthenticatedClient(studentA);
    const { error } = await studentClient.rpc("get_rubric_check_application_stats", { p_assignment_id: assignmentId });
    expect(error).not.toBeNull();
  });
});
