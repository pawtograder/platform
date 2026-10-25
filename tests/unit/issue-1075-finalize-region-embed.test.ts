/**
 * Regression for GitHub issue #1075: finalize's answer-region query embeds
 * exam_questions, and two foreign keys connect exam_question_regions to it --
 * the single-column exam_question_regions_exam_question_id_fkey and the
 * composite exam_question_regions_question_exam_fkey. PostgREST cannot choose
 * between them, so the unnamed embed fails with PGRST201 and every scan batch
 * stalls in `finalizing` with nothing reaching a grader.
 *
 * This asserts the shape the worker relies on (supabase/functions/exam-async-worker/index.ts,
 * inside finalize) rather than waiting 60s for the e2e batch poll to time out.
 *
 * Requires local Supabase, SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and
 * RUN_SUPABASE_INTEGRATION_TESTS=true (avoids failures when .env.local points at
 * a stopped local API). Example:
 *   RUN_SUPABASE_INTEGRATION_TESTS=true npx jest tests/unit/issue-1075-finalize-region-embed.test.ts
 *
 * Leaves the created class and related rows in the database (use db reset or manual cleanup).
 */
import { createClass, insertAssignment, supabase } from "@/tests/e2e/TestingUtils";

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config({ path: ".env.local" });
} catch {
  /* optional */
}

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const integrationEnabled = process.env.RUN_SUPABASE_INTEGRATION_TESTS === "true";

const describeIntegration = url && serviceKey && integrationEnabled ? describe : describe.skip;

function throwIfSetError(error: { message: string } | null, context: string): void {
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
}

/** The select string finalize uses. Keep in sync with exam-async-worker/index.ts. */
const FINALIZE_REGION_SELECT =
  "exam_question_id, page_number, x, y, width, height, exam_questions!exam_question_regions_question_exam_fkey(answer_type)";

describeIntegration("issue #1075: finalize's answer-region embed is unambiguous", () => {
  test("the region query returns rows and the question's answer_type, instead of PGRST201", async () => {
    const course = await createClass({ name: `Issue 1075 ${Date.now()}` });
    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Issue 1075 exam",
      assignment_type: "exam",
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      assignment_slug: `issue-1075-${Date.now()}`
    } as Parameters<typeof insertAssignment>[0]);

    const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
      p_assignment_id: assignment.id,
      p_source_type: "pdf",
      p_num_pages: 1
    });
    throwIfSetError(examErr, "exam_create");

    // One question with a known answer_type, and one answer region pointing at it.
    const { error: structErr } = await supabase.rpc("exam_upsert_questions_and_regions", {
      p_exam_id: examId as number,
      p_questions: [{ client_id: "q1", level: 1, ordinal: 1, label: "Q1", answer_type: "numeric", points: 5 }],
      p_regions: [{ question_client_id: "q1", kind: "answer", page_number: 1, x: 0.1, y: 0.3, width: 0.8, height: 0.2 }]
    });
    throwIfSetError(structErr, "exam_upsert_questions_and_regions");

    // The query finalize runs. Without the named foreign key this is PGRST201:
    // "Could not embed because more than one relationship was found".
    const { data: regions, error: regionsErr } = await supabase
      .from("exam_question_regions")
      .select(FINALIZE_REGION_SELECT)
      .eq("exam_id", examId as number)
      .eq("kind", "answer")
      .not("exam_question_id", "is", null);

    expect(regionsErr).toBeNull();
    expect(regions).toHaveLength(1);

    // The embed has to resolve to the question, or finalize can't pick a structuring path.
    const row = regions![0] as unknown as { exam_questions: { answer_type: string } | null };
    expect(row.exam_questions?.answer_type).toBe("numeric");
  });

  test("the unnamed embed still fails, so the named one is load-bearing", async () => {
    // Guards against someone 'simplifying' the select back: if a future migration drops one of
    // the two foreign keys this fails, and the named-FK version above can be reconsidered.
    const { error } = await supabase
      .from("exam_question_regions")
      .select("exam_question_id, exam_questions(answer_type)")
      .limit(1);

    expect(error).not.toBeNull();
    expect(error!.code).toBe("PGRST201");
  });
});
