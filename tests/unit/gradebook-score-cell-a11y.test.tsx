/**
 * Regression tests for issue #915.
 *
 * The student gradebook renders a score cell as `{value}{"/" + max_score}`. The
 * suffix was appended unconditionally, so it also landed on the *status* words
 * the cell falls back to when there is no released score — a submitted but
 * ungraded item rendered "Submitted/100", which a screen reader voices as
 * "Submitted slash 100". Even with a real score, "45/100" announces as
 * "45 slash 100", which is not what a student is listening for.
 *
 * The fix splits the two cases: only a numeric score takes the "/max" suffix,
 * and the cell exposes a spoken phrasing through <SpokenValue> so AT hears
 * "45 of 100 points" / "Submitted, worth 100 points" while the compact visual
 * rendering is hidden from it.
 *
 * NOTE on the original bug report: it claimed the score was present but hidden
 * from AT. It was not — the seeded submission's grading review was never
 * released, so no score was rendered for anyone. `tests/e2e/a11yAgentSeeding.ts`
 * now releases one; these tests cover both the scored and the status paths.
 */
import { render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { WhatIf } from "@/app/course/[course_id]/gradebook/whatIf";
import type { GradebookColumn } from "@/utils/supabase/DatabaseTypes";

const STUDENT_ID = "student-profile-1";

type StudentGrade = {
  score: number | null;
  score_override: number | null;
  released: boolean;
  is_missing: boolean;
  is_excused: boolean;
  incomplete_values: null;
};

// Mutable fixtures the mocked hooks read, so each test can pose one cell state.
//
// Every one of these must be a STABLE reference for the lifetime of a render.
// `WhatIf` memoizes `sortedColumns` on the array `useGradebookColumns()` returns
// and re-runs a `setCollapsedGroups` effect whenever the derived `groupedColumns`
// changes identity — so a mock that returns a fresh `[column]` literal on every
// call spins forever and OOMs the worker rather than failing.
let column: GradebookColumn;
let columns: GradebookColumn[];
let studentGrade: StudentGrade | undefined;
let submissionStatus: { status: string };
let controller: { columns: GradebookColumn[]; getRendererForColumn: () => (...args: unknown[]) => string };
let whatIfController: {
  setWhatIfGrade: () => void;
  clearGrade: () => void;
  getIncompleteValues: () => undefined;
};

jest.mock("@/hooks/useGradebook", () => ({
  useGradebookColumns: () => columns,
  useGradebookColumn: () => column,
  useGradebookColumnStudent: () => studentGrade,
  useGradebookController: () => controller,
  useLinkToAssignment: () => null,
  useSubmissionIDForColumn: () => submissionStatus
}));

jest.mock("@/hooks/useGradebookWhatIf", () => ({
  GradebookWhatIfProvider: ({ children }: { children: React.ReactNode }) => children,
  useGradebookWhatIf: () => whatIfController,
  useWhatIfGrade: () => undefined
}));

// `<Markdown>` pulls in the full remark pipeline for a one-line description.
jest.mock("@/components/ui/markdown", () => ({
  __esModule: true,
  default: ({ children }: { children?: string }) => <span>{children ?? ""}</span>
}));

function makeColumn(overrides: Partial<GradebookColumn> = {}): GradebookColumn {
  return {
    id: 1,
    name: "Agent Assignment",
    slug: "assignment-agent",
    sort_order: 1,
    max_score: 100,
    render_expression: null,
    description: "",
    dependencies: { assignments: [7] },
    released: true,
    ...overrides
  } as unknown as GradebookColumn;
}

function makeGrade(overrides: Partial<StudentGrade> = {}): StudentGrade {
  return {
    score: null,
    score_override: null,
    released: false,
    is_missing: false,
    is_excused: false,
    incomplete_values: null,
    ...overrides
  };
}

function renderGradebook() {
  return render(
    <ChakraProvider value={defaultSystem}>
      <WhatIf private_profile_id={STUDENT_ID} whatIfEnabled={false} />
    </ChakraProvider>
  );
}

/** Point the mocked hooks at `column`. Call after any reassignment of it. */
function useColumn(next: GradebookColumn) {
  column = next;
  columns = [next];
  controller = { columns, getRendererForColumn: () => () => "A-" };
}

beforeEach(() => {
  useColumn(makeColumn());
  studentGrade = makeGrade();
  submissionStatus = { status: "not-an-assignment" };
  whatIfController = {
    setWhatIfGrade: () => {},
    clearGrade: () => {},
    getIncompleteValues: () => undefined
  };
});

describe("gradebook score cell", () => {
  describe("a released numeric score", () => {
    beforeEach(() => {
      studentGrade = makeGrade({ score: 45, released: true });
      submissionStatus = { status: "found" };
    });

    it("announces the score as a phrase, not as a fraction", () => {
      renderGradebook();
      expect(screen.getByText("45 of 100 points")).toBeInTheDocument();
    });

    it("still renders the compact 45/100 visually, hidden from assistive tech", () => {
      const { container } = renderGradebook();
      const visual = container.querySelector('[aria-hidden="true"]');
      expect(visual).not.toBeNull();
      expect(visual!.textContent).toBe("45/100");
    });
  });

  describe("submitted but not yet graded", () => {
    beforeEach(() => {
      submissionStatus = { status: "found" };
    });

    it("does not append the max score to the status word", () => {
      const { container } = renderGradebook();
      // The defect: "Submitted/100", spoken as "Submitted slash 100".
      expect(container.textContent).not.toContain("Submitted/100");
    });

    it("keeps the point value available as a separate clause", () => {
      renderGradebook();
      expect(screen.getByText("Submitted, worth 100 points")).toBeInTheDocument();
    });
  });

  describe("other status fallbacks", () => {
    it.each([
      ["no-submission", "Not Submitted"],
      ["not-an-assignment", "In Progress"]
    ])("does not fraction-ise the %s status", (status, expected) => {
      submissionStatus = { status };
      const { container } = renderGradebook();
      expect(container.textContent).not.toContain(`${expected}/100`);
      expect(screen.getByText(`${expected}, worth 100 points`)).toBeInTheDocument();
    });
  });

  describe("a column with no max score", () => {
    it("speaks a bare point count without inventing a maximum", () => {
      useColumn(makeColumn({ max_score: null } as Partial<GradebookColumn>));
      studentGrade = makeGrade({ score: 12, released: true });
      renderGradebook();
      expect(screen.getByText("12 points")).toBeInTheDocument();
    });
  });

  describe("a column that renders an expression", () => {
    beforeEach(() => {
      useColumn(makeColumn({ render_expression: "letter_grade(score)" } as Partial<GradebookColumn>));
      studentGrade = makeGrade({ score: 45, released: true });
    });

    it("hides the grouping parentheses from assistive tech", () => {
      renderGradebook();
      // Spoken, bare "(" and ")" text nodes become "left paren" / "right paren".
      const parens = Array.from(document.querySelectorAll('[aria-hidden="true"]')).map((el) => el.textContent);
      expect(parens).toContain("(");
      expect(parens).toContain(")");
    });

    it("still announces the score itself", () => {
      renderGradebook();
      expect(screen.getByText("45 of 100 points")).toBeInTheDocument();
    });
  });
});
