/**
 * @jest-environment node
 */

import { saveExamStructure } from "@/lib/exam/examClient";

type RpcCall = { fn: string; args: Record<string, unknown> };

function mockSupabase({
  rpc: rpcImpl = () => ({ data: null, error: null }),
  examParts = 0
}: { rpc?: (call: RpcCall) => { data: unknown; error: unknown }; examParts?: number } = {}) {
  const calls: RpcCall[] = [];
  const rpc = jest.fn(async (fn: string, args: Record<string, unknown>) => {
    const call = { fn, args };
    calls.push(call);
    return rpcImpl(call);
  });
  // Stands in for the count of rubric_parts the sync generated for this exam.
  const query = {
    select: () => query,
    eq: () => query,
    not: () => query,
    then: (resolve: (r: { count: number; error: null }) => void) => resolve({ count: examParts, error: null })
  };
  const from = jest.fn(() => query);
  return { client: { rpc, from } as unknown as Parameters<typeof saveExamStructure>[0], calls };
}

const structure = {
  examId: 7,
  questions: [{ client_id: "c1", parent_client_id: null, level: 1, ordinal: 0, label: "Q1", points: 5 }],
  regions: []
};

describe("saveExamStructure", () => {
  it("builds the rubric on the first save", async () => {
    const { client, calls } = mockSupabase({ examParts: 0 });
    const result = await saveExamStructure(client, { ...structure, gradingRubricId: 42 });

    expect(calls.map((c) => c.fn)).toEqual(["exam_upsert_questions_and_regions", "exam_sync_rubric_from_questions"]);
    expect(calls[1].args).toEqual({ p_exam_id: 7, p_rubric_id: 42 });
    expect(result).toEqual({ rubric: "built", rubricError: null });
  });

  it("leaves a rubric that was already built alone", async () => {
    const { client, calls } = mockSupabase({ examParts: 1 });
    const result = await saveExamStructure(client, { ...structure, gradingRubricId: 42 });

    expect(calls.map((c) => c.fn)).toEqual(["exam_upsert_questions_and_regions"]);
    expect(result).toEqual({ rubric: "existing", rubricError: null });
  });

  it("saves without building when the assignment has no grading rubric", async () => {
    const { client, calls } = mockSupabase();
    const result = await saveExamStructure(client, { ...structure, gradingRubricId: null });

    expect(calls.map((c) => c.fn)).toEqual(["exam_upsert_questions_and_regions"]);
    expect(result).toEqual({ rubric: "no-rubric", rubricError: null });
  });

  it("does not build the rubric when the save fails", async () => {
    const { client, calls } = mockSupabase({ rpc: () => ({ data: null, error: { message: "nope" } }) });

    await expect(saveExamStructure(client, { ...structure, gradingRubricId: 42 })).rejects.toMatchObject({
      message: "nope"
    });
    expect(calls).toHaveLength(1);
  });

  it("still counts the save when the first build fails", async () => {
    const { client } = mockSupabase({
      rpc: ({ fn }) =>
        fn === "exam_sync_rubric_from_questions"
          ? { data: null, error: { message: "Rubric 42 does not belong to assignment 8" } }
          : { data: null, error: null }
    });
    const result = await saveExamStructure(client, { ...structure, gradingRubricId: 42 });

    expect(result).toEqual({ rubric: "failed", rubricError: "Rubric 42 does not belong to assignment 8" });
  });
});
