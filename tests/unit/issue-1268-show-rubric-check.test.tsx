/**
 * Regression test for #1268.
 *
 * A grader reads an answer crop in the middle column and grades it in the sidebar, which scrolls on
 * its own, and nothing connected the two: every answer meant hunting for its check by hand. Each crop
 * now has a button that asks the sidebar to bring that question's check into view.
 *
 * The renderer only offers the button. Which questions have a check, and what showing one does, come
 * from the files page, so the renderer still renders on its own here and in the #1072 and #1073 tests.
 * The sidebar half (scrolling to the check and marking it) is covered by
 * tests/e2e/exam-grader-default-view.spec.ts, since it needs the real grading layout.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import ExamSubmissionRenderer from "@/components/ui/exam-submission-renderer";
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

function q(id: number, label: string) {
  return { exam_question_id: id, label, page_number: 1, region: REGION, ocr_text: "x", structured_value: "x" };
}

function renderExam(props: { checkedQuestionIds?: ReadonlySet<number>; onShowRubricCheck?: (id: number) => void }) {
  render(
    <ChakraProvider value={defaultSystem}>
      <ExamSubmissionRenderer artifact={artifact([q(38, "Q1"), q(39, "Q2")])} {...props} />
    </ChakraProvider>
  );
}

describe("the grader view's link from an answer to its check (#1268)", () => {
  it("asks for the check of the question whose button was clicked", async () => {
    // Catches the button reporting the wrong question, e.g. the crop's position in the list rather
    // than its exam_question_id, which is what the sidebar's checks are tagged with.
    const onShowRubricCheck = jest.fn();
    renderExam({ checkedQuestionIds: new Set([38, 39]), onShowRubricCheck });
    fireEvent.click(await screen.findByRole("button", { name: "Show rubric check for Q2" }));
    expect(onShowRubricCheck).toHaveBeenCalledWith(39);
  });

  it("offers no button for a question with no rubric check", async () => {
    // An auto-scored question gets no check from the rubric build, so a button there would scroll to
    // nothing. Catches offering the button on every crop.
    renderExam({ checkedQuestionIds: new Set([38]), onShowRubricCheck: jest.fn() });
    expect(await screen.findByRole("button", { name: "Show rubric check for Q1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show rubric check for Q2" })).not.toBeInTheDocument();
  });

  it("offers no button when nothing can show a check", async () => {
    // Without a handler the button would do nothing when clicked. Catches it being rendered anyway.
    renderExam({ checkedQuestionIds: new Set([38, 39]) });
    await waitFor(() => expect(screen.getByText("Q1")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Show rubric check/ })).not.toBeInTheDocument();
  });
});
