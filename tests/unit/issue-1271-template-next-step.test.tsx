/**
 * Regression test for #1271, second gap.
 *
 * The exam overview offers "1. Template & Regions" and "2. Scan & Match", which promises a
 * sequence, and step 1 had no way to reach step 2: you navigated back out to the overview and
 * clicked through. These tests pin the controls that close that loop, and the warning that fires
 * when someone is about to leave with regions they never saved.
 *
 * The drawing affordance (the first gap) is a cursor, a hover border and an overlay on the
 * template image. That is a visual change on a component that loads pages, questions, regions and
 * signed URLs before it renders anything, so it is left to Argos rather than to a mock of all
 * four.
 */
import { act, render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import ExamTemplatePage from "@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/template/page";

jest.mock("next/navigation", () => ({
  useParams: () => ({ course_id: "150", assignment_id: "92" })
}));

// Set per test: null stands for an assignment whose template has not been uploaded yet.
let examRow: { id: number } | null = { id: 7 };
jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (table === "exams" ? { data: examRow } : { data: { grading_rubric_id: null } })
        })
      })
    })
  })
}));

jest.mock("@/components/ui/toaster", () => ({ toaster: { error: jest.fn(), success: jest.fn() } }));

// Staff error messages pick their wording from useIsInstructor (useStaffErrorRole), which needs a
// ClassProfileProvider; this renders the page without one.
jest.mock("@/hooks/useClassProfiles", () => ({
  ...jest.requireActual("@/hooks/useClassProfiles"),
  useIsInstructor: () => true
}));

// The feature flag has its own tests (#1196); here it must not hide the page under test.
jest.mock("@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/ExamFeatureGate", () => ({
  ExamFeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

// Stubbed for the same reason the comment above gives, plus it is how this test drives the dirty
// state: the page learns about unsaved regions only through this callback.
let reportDirty: ((dirty: boolean) => void) | undefined;
jest.mock("@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/RegionEditor", () => ({
  __esModule: true,
  default: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) => {
    reportDirty = onDirtyChange;
    return <div data-testid="region-editor" />;
  }
}));

const BASE = "/course/150/manage/assignments/92/exam";

async function renderPage() {
  render(
    <ChakraProvider value={defaultSystem}>
      <ExamTemplatePage />
    </ChakraProvider>
  );
  expect(await screen.findByTestId("region-editor")).toBeInTheDocument();
}

describe("step 1 can be walked to step 2 (#1271)", () => {
  beforeEach(() => {
    reportDirty = undefined;
    examRow = { id: 7 };
  });

  it("offers a link onward to Scan & Match", async () => {
    await renderPage();
    expect(screen.getByRole("link", { name: /scan & match/i })).toHaveAttribute("href", `${BASE}/scans`);
  });

  it("still offers the way back to the overview", async () => {
    await renderPage();
    expect(screen.getByRole("link", { name: /exam overview/i })).toHaveAttribute("href", BASE);
  });

  it("says nothing about saving while there is nothing unsaved", async () => {
    await renderPage();
    expect(screen.queryByText(/unsaved region changes/i)).not.toBeInTheDocument();
  });

  it("warns, but does not block, when regions have not been saved", async () => {
    await renderPage();
    act(() => reportDirty?.(true));
    expect(screen.getByText(/unsaved region changes/i)).toBeInTheDocument();
    // Blocking the way out of a page is worse than the mistake it prevents.
    expect(screen.getByRole("link", { name: /scan & match/i })).toHaveAttribute("href", `${BASE}/scans`);
  });

  // `<Button asChild disabled>` renders the Button AS the anchor, and a disabled anchor still
  // navigates: it only looks disabled. With no template there is no exam to scan against, so the
  // control must not be a link at all.
  it("offers no way onward before a template is uploaded", async () => {
    examRow = null;
    render(
      <ChakraProvider value={defaultSystem}>
        <ExamTemplatePage />
      </ChakraProvider>
    );
    expect(await screen.findByText(/upload template/i)).toBeInTheDocument();
    expect(screen.queryByTestId("region-editor")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /scan & match/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /scan & match/i })).toBeDisabled();
  });
});
