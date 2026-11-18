/**
 * #1269: instructor-facing exam text says what is true, and differs when the state differs.
 * Named issue-* so CI's e2e-local lane runs it.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { render, screen } from "@testing-library/react";
import { artifactCheckMessage } from "@/lib/artifactCheckMessage";

jest.mock("next/navigation", () => ({ useParams: () => ({ course_id: "7", assignment_id: "9" }) }));
jest.mock("@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/ExamFeatureGate", () => ({
  ExamFeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));
// The exam row as the overview reads it: a template whose status column still says 'draft'.
jest.mock("@/utils/supabase/client", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: { num_pages: 2, status: "draft" }, error: null })
  };
  return { createClient: () => ({ from: () => chain }) };
});

import ExamOverviewPage from "@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/page";

test("the exam overview describes the template without the unused status column", async () => {
  render(
    <ChakraProvider value={defaultSystem}>
      <ExamOverviewPage />
    </ChakraProvider>
  );
  expect(await screen.findByText("Template configured: 2 page(s).")).toBeInTheDocument();
  expect(screen.queryByText(/draft/i)).not.toBeInTheDocument();
});

describe("the line above an artifact that no rubric check can annotate", () => {
  const staff = { ready: true, isStaff: true, hasRubric: true, hasArtifactChecks: false };
  test.each([
    [
      "review without a rubric",
      { ...staff, hasRubric: false, checkCount: 0, isExamArtifact: false },
      "This review has no rubric."
    ],
    [
      "rubric with no checks, exam",
      { ...staff, checkCount: 0, isExamArtifact: true },
      "This review's rubric has no checks yet."
    ],
    [
      "rubric with no checks, other artifact",
      { ...staff, checkCount: 0, isExamArtifact: false },
      "This review's rubric has no checks yet."
    ],
    [
      "exam checks in the sidebar",
      { ...staff, checkCount: 4, isExamArtifact: true },
      "Grade this exam's questions in the rubric panel."
    ],
    [
      "file-only checks, other artifact",
      { ...staff, checkCount: 4, isExamArtifact: false },
      "None of this rubric's checks apply to artifacts."
    ]
  ])("%s", (_label, input, expected) => {
    expect(artifactCheckMessage(input)).toBe(expected);
  });

  test("a rubric with checks never reads like a missing or empty rubric", () => {
    const full = artifactCheckMessage({ ...staff, checkCount: 4, isExamArtifact: true });
    expect(full).not.toBe(artifactCheckMessage({ ...staff, checkCount: 0, isExamArtifact: true }));
    expect(full).not.toBe(artifactCheckMessage({ ...staff, hasRubric: false, checkCount: 0, isExamArtifact: true }));
  });

  test.each([
    ["while loading", { ...staff, ready: false, checkCount: 0, isExamArtifact: true }],
    ["for a student", { ...staff, isStaff: false, checkCount: 0, isExamArtifact: true }],
    ["for a student, exam with checks", { ...staff, isStaff: false, checkCount: 4, isExamArtifact: true }],
    // Artifact checks exist but the popover's options aren't built yet (criteria still loading).
    [
      "while artifact checks wait for their criteria",
      { ...staff, hasArtifactChecks: true, checkCount: 2, isExamArtifact: false }
    ]
  ])("nothing is shown %s", (_label, input) => {
    expect(artifactCheckMessage(input)).toBeNull();
  });
});
