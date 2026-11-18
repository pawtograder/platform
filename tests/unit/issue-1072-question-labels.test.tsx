/**
 * Regression test for #1072.
 *
 * The grader view's headings read "Question 38", "Question 39": `exam_question_id`, a database
 * id, because the exam_v1 artifact carried nothing else. The instructor had named them Q1, Q2.
 *
 * Two halves to the fix and both are tested here. The worker has to put the label in the
 * artifact, which means asking for it in the finalize select, and the renderer has to prefer it
 * while still rendering the artifacts that were finalized before it existed.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import ExamSubmissionRenderer, { questionHeading } from "@/components/ui/exam-submission-renderer";
import { FINALIZE_ANSWER_REGION_SELECT } from "../../supabase/functions/exam-async-worker/finalizeQueries";
import type { SubmissionArtifact } from "@/utils/supabase/DatabaseTypes";

jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: "https://example.test/page1.png" } })
      })
    }
  })
}));

const PAGE = { page_number: 1, storage_key: "class/1/page1.png", width: 1224, height: 1584 };
const REGION = { x: 0.1, y: 0.1, width: 0.6, height: 0.1 };

function artifact(questions: Record<string, unknown>[]): SubmissionArtifact {
  return {
    data: { format: "exam_v1", pages: [PAGE], questions }
  } as unknown as SubmissionArtifact;
}

function q(id: number, label?: string | null) {
  return { exam_question_id: id, label, page_number: 1, region: REGION, ocr_text: "x", structured_value: "x" };
}

describe("questionHeading (#1072)", () => {
  it("uses the instructor's label", () => {
    expect(questionHeading(q(38, "Q1"))).toBe("Q1");
  });

  it("falls back to the id when the question was never named", () => {
    // exam_questions.label is nullable, so this is reachable going forward, not only for old data.
    expect(questionHeading(q(38, null))).toBe("Question 38");
    expect(questionHeading(q(38, undefined))).toBe("Question 38");
  });

  it("treats a whitespace-only label as unnamed rather than rendering a blank heading", () => {
    expect(questionHeading(q(38, "   "))).toBe("Question 38");
  });
});

describe("the exam artifact carries the label (#1072)", () => {
  it("finalize asks exam_questions for it", () => {
    // Without this the renderer's fallback is all anyone ever sees, and the bug is still there
    // while every test above passes. Asserted on the exported constant the worker actually uses
    // (see finalizeQueries.ts on why the two are not allowed to drift).
    expect(FINALIZE_ANSWER_REGION_SELECT).toMatch(/exam_questions![a-z_]+\([^)]*\blabel\b[^)]*\)/);
  });
});

describe("the grader view (#1072)", () => {
  it("shows the names the instructor gave, not the ids", async () => {
    render(
      <ChakraProvider value={defaultSystem}>
        <ExamSubmissionRenderer artifact={artifact([q(38, "Q1"), q(39, "Q2")])} />
      </ChakraProvider>
    );
    await waitFor(() => expect(screen.getByText("Q1")).toBeInTheDocument());
    expect(screen.getByText("Q2")).toBeInTheDocument();
    expect(screen.queryByText("Question 38")).not.toBeInTheDocument();
    expect(screen.queryByText("Question 39")).not.toBeInTheDocument();
  });

  it("still renders an artifact finalized before the label existed", async () => {
    render(
      <ChakraProvider value={defaultSystem}>
        <ExamSubmissionRenderer artifact={artifact([{ ...q(38), label: undefined }])} />
      </ChakraProvider>
    );
    await waitFor(() => expect(screen.getByText("Question 38")).toBeInTheDocument());
  });
});
