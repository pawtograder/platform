/**
 * Heading structure of the student gradebook (WCAG 1.3.1 Info and Relationships).
 *
 * When gradebook columns share a slug prefix the page collapses them under a
 * group control ("3 Labs..."). That control was a bare <button> inside a Card,
 * so heading navigation skipped the group name entirely: a screen-reader user
 * moving by heading went from the page's h1 straight to individual column
 * names, with nothing telling them the columns were grouped or which group they
 * were in.
 *
 * The group name is now an <h2> wrapping the disclosure button (the standard
 * pattern — heading carries structure, button carries operability), and columns
 * inside a group drop to <h3> so the nesting is honest. An ungrouped column
 * stays an <h2> rather than skipping a level.
 *
 * These cases are invisible to the real-AT lane: `seedAgentPages()` seeds a
 * single assignment column, so no group header is ever rendered there.
 */
import { render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { WhatIf } from "@/app/course/[course_id]/gradebook/whatIf";
import type { GradebookColumn } from "@/utils/supabase/DatabaseTypes";

const STUDENT_ID = "student-profile-1";

// Stable references — see the note in gradebook-score-cell-a11y.test.tsx: an
// unstable `useGradebookColumns()` return spins `WhatIf`'s grouping effect.
let columns: GradebookColumn[];
let byId: Map<number, GradebookColumn>;
let controller: { columns: GradebookColumn[]; getRendererForColumn: () => (...args: unknown[]) => string };
let whatIfController: { setWhatIfGrade: () => void; clearGrade: () => void; getIncompleteValues: () => undefined };

jest.mock("@/hooks/useGradebook", () => ({
  useGradebookColumns: () => columns,
  useGradebookColumn: (id: number) => byId.get(id),
  useGradebookColumnStudent: () => ({
    score: 50,
    score_override: null,
    released: true,
    is_missing: false,
    is_excused: false,
    incomplete_values: null
  }),
  useGradebookController: () => controller,
  useLinkToAssignment: () => null,
  useSubmissionIDForColumn: () => ({ status: "found" })
}));

jest.mock("@/hooks/useGradebookWhatIf", () => ({
  GradebookWhatIfProvider: ({ children }: { children: React.ReactNode }) => children,
  useGradebookWhatIf: () => whatIfController,
  useWhatIfGrade: () => undefined
}));

jest.mock("@/components/ui/markdown", () => ({
  __esModule: true,
  default: ({ children }: { children?: string }) => <span>{children ?? ""}</span>
}));

function makeColumn(id: number, name: string, slug: string, sortOrder: number): GradebookColumn {
  return {
    id,
    name,
    slug,
    sort_order: sortOrder,
    max_score: 100,
    render_expression: null,
    description: "",
    dependencies: {},
    released: true
  } as unknown as GradebookColumn;
}

function useColumns(next: GradebookColumn[]) {
  columns = next;
  byId = new Map(next.map((c) => [c.id, c]));
  controller = { columns, getRendererForColumn: () => () => "A-" };
}

function renderGradebook() {
  return render(
    <ChakraProvider value={defaultSystem}>
      <WhatIf private_profile_id={STUDENT_ID} whatIfEnabled={false} />
    </ChakraProvider>
  );
}

beforeEach(() => {
  whatIfController = { setWhatIfGrade: () => {}, clearGrade: () => {}, getIncompleteValues: () => undefined };
});

describe("gradebook heading structure", () => {
  describe("a group of columns sharing a slug prefix", () => {
    beforeEach(() => {
      // Contiguous sort_order + shared "assignment-lab" prefix => one group.
      useColumns([
        makeColumn(1, "Lab 1", "assignment-lab-1", 1),
        makeColumn(2, "Lab 2", "assignment-lab-2", 2),
        makeColumn(3, "Lab 3", "assignment-lab-3", 3)
      ]);
    });

    it("exposes the group name as a heading, not just a button", () => {
      renderGradebook();
      const groupHeading = screen.getByRole("heading", { level: 2, name: /Labs/ });
      expect(groupHeading).toBeInTheDocument();
    });

    it("keeps the group name operable as a disclosure button", () => {
      renderGradebook();
      const button = screen.getByRole("button", { name: /Labs/ });
      expect(button).toHaveAttribute("aria-expanded");
    });

    it("nests the column heading under the group heading as an h3", () => {
      renderGradebook();
      // Groups collapse by default, so one representative column is shown.
      const columnHeadings = screen.getAllByRole("heading", { level: 3 });
      expect(columnHeadings.length).toBeGreaterThan(0);
      expect(columnHeadings.map((h) => h.textContent)).toEqual(
        expect.arrayContaining([expect.stringMatching(/Lab \d/)])
      );
    });

    it("does not leave any column name at h2 alongside the group heading", () => {
      renderGradebook();
      const h2s = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
      expect(h2s.some((t) => /^Lab \d$/.test(t))).toBe(false);
    });
  });

  describe("a single ungrouped column", () => {
    beforeEach(() => {
      useColumns([makeColumn(1, "Final Exam", "exam-final", 1)]);
    });

    it("stays an h2 rather than skipping a level", () => {
      renderGradebook();
      expect(screen.getByRole("heading", { level: 2, name: "Final Exam" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    });

    it("renders no group heading when there is nothing to group", () => {
      renderGradebook();
      expect(screen.queryByRole("button", { name: /\.\.\./ })).not.toBeInTheDocument();
    });
  });
});
