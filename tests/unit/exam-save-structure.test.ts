/**
 * @jest-environment node
 */

import { saveExamStructure } from "@/lib/exam/examClient";

type RpcCall = { fn: string; args: Record<string, unknown> };

function mockSupabase(
  impl: (call: RpcCall) => { data: unknown; error: unknown } = () => ({ data: null, error: null })
) {
  const calls: RpcCall[] = [];
  const rpc = jest.fn(async (fn: string, args: Record<string, unknown>) => {
    const call = { fn, args };
    calls.push(call);
    return impl(call);
  });
  return { client: { rpc } as unknown as Parameters<typeof saveExamStructure>[0], calls };
}

const structure = {
  examId: 7,
  questions: [{ client_id: "c1", parent_client_id: null, level: 1, ordinal: 0, label: "Q1", points: 5 }],
  regions: []
};

describe("saveExamStructure", () => {
  it("builds the rubric after saving the structure", async () => {
    const { client, calls } = mockSupabase();
    const result = await saveExamStructure(client, { ...structure, gradingRubricId: 42 });

    expect(calls.map((c) => c.fn)).toEqual(["exam_upsert_questions_and_regions", "exam_sync_rubric_from_questions"]);
    expect(calls[1].args).toEqual({ p_exam_id: 7, p_rubric_id: 42 });
    expect(result).toEqual({ rubricBuilt: true, rubricError: null });
  });

  it("saves without building when the assignment has no grading rubric", async () => {
    const { client, calls } = mockSupabase();
    const result = await saveExamStructure(client, { ...structure, gradingRubricId: null });

    expect(calls.map((c) => c.fn)).toEqual(["exam_upsert_questions_and_regions"]);
    expect(result).toEqual({ rubricBuilt: false, rubricError: null });
  });

  it("does not build the rubric when the save fails", async () => {
    const { client, calls } = mockSupabase(() => ({ data: null, error: { message: "nope" } }));

    await expect(saveExamStructure(client, { ...structure, gradingRubricId: 42 })).rejects.toMatchObject({
      message: "nope"
    });
    expect(calls).toHaveLength(1);
  });

  it("still counts the save when building the rubric fails", async () => {
    const { client } = mockSupabase(({ fn }) =>
      fn === "exam_sync_rubric_from_questions"
        ? { data: null, error: { message: 'Rubric check "Q1" has lost its exam_question_id' } }
        : { data: null, error: null }
    );
    const result = await saveExamStructure(client, { ...structure, gradingRubricId: 42 });

    expect(result).toEqual({ rubricBuilt: false, rubricError: 'Rubric check "Q1" has lost its exam_question_id' });
  });
});
