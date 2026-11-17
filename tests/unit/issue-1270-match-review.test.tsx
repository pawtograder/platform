/**
 * #1270: match review at roster scale, with a next step for unmatched exams and for an errored batch.
 * The browser flows (search with the real picker, Create and Retry from an errored batch) are in
 * tests/e2e/exam-scan-review-ui.spec.ts. Named issue-* so CI's e2e-local lane runs it.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
const mockResults: Record<string, () => Result> = {};
const mockUpdates: Record<string, unknown>[] = [];

function mockChain(table: string) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "not", "maybeSingle", "limit"]) chain[method] = () => chain;
  chain.update = (payload: Record<string, unknown>) => {
    mockUpdates.push(payload);
    return chain;
  };
  chain.then = (resolve: (r: Result) => unknown) =>
    Promise.resolve(mockResults[table]?.() ?? { data: [] }).then(resolve);
  return chain;
}
jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ from: (table: string) => mockChain(table), rpc: jest.fn() })
}));
jest.mock("@/components/ui/toaster", () => ({ toaster: { success: jest.fn(), error: jest.fn() } }));
jest.mock("next/navigation", () => ({ useParams: () => ({ course_id: "7", assignment_id: "9" }) }));
jest.mock("@/lib/exam/examClient", () => ({ uploadExamScanBatch: jest.fn() }));
jest.mock("@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/ExamFeatureGate", () => ({
  ExamFeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

import ExamScansPage from "@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/scans/page";
import MatchReview from "@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/MatchReview";

const wrap = (ui: React.ReactElement) => <ChakraProvider value={defaultSystem}>{ui}</ChakraProvider>;

// 200 students, listed out of order; Clark Johnson is one of them.
const roster = Array.from({ length: 199 }, (_, i) => ({
  private_profile_id: `p${i}`,
  profiles: {
    name: `Student ${String(199 - i).padStart(3, "0")}`,
    sortable_name: `${String(199 - i).padStart(3, "0")}, Student`
  }
})).concat([{ private_profile_id: "clark", profiles: { name: "Clark Johnson", sortable_name: "Johnson, Clark" } }]);
const unmatchedRow = {
  id: 1,
  exam_id: 3,
  exam_index: 0,
  detected_name: null,
  detected_sis_id: null,
  matched_profile_id: null,
  match_confidence: 0,
  match_status: "unmatched",
  submission_id: null,
  finalized_at: null
};

beforeEach(() => {
  mockUpdates.length = 0;
  mockResults.user_roles = () => ({ data: roster, error: null });
  mockResults.exam_scanned_submissions = () => ({ data: [unmatchedRow], error: null });
});

test("an unmatched exam says what to do, and the picker finds one student among 200 by typing", async () => {
  render(wrap(<MatchReview batchId={5} classId={7} batchStatus="review" onBatchChanged={jest.fn()} />));
  expect(await screen.findByText(/1 exam\(s\) need a student\. Pick one in the Student column/)).toBeInTheDocument();
  expect(screen.getByText("Needs a student")).toBeInTheDocument();

  const picker = screen.getByLabelText("Student for exam #1");
  await waitFor(() => expect(picker).not.toBeDisabled());
  fireEvent.focus(picker);
  fireEvent.change(picker, { target: { value: "cla" } });
  const options = await screen.findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual(["Clark Johnson"]);
  fireEvent.keyDown(picker, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(mockUpdates).toContainEqual(expect.objectContaining({ matched_profile_id: "clark" })));
});

test("the picker lists the roster sorted by sortable name", async () => {
  render(wrap(<MatchReview batchId={5} classId={7} batchStatus="review" onBatchChanged={jest.fn()} />));
  const picker = await screen.findByLabelText("Student for exam #1");
  await waitFor(() => expect(picker).not.toBeDisabled());
  fireEvent.keyDown(picker, { key: "ArrowDown", code: "ArrowDown" });
  const options = await screen.findAllByRole("option");
  expect(options).toHaveLength(200);
  expect(options[0]).toHaveTextContent("Student 001");
  expect(options[199]).toHaveTextContent("Clark Johnson"); // "Johnson, Clark" sorts after "199, Student"
});

test("an errored batch keeps its matches on screen and offers Retry processing", async () => {
  mockResults.exams = () => ({ data: { id: 3, num_pages: 1 }, error: null });
  mockResults.exam_scan_batches = () => ({
    data: [{ id: 5, status: "error", total_pages: 1, pages_per_exam: 1, error: "finalize failed" }],
    error: null
  });
  mockResults.exam_scanned_submissions = () => ({
    data: [{ ...unmatchedRow, matched_profile_id: "clark", match_status: "confirmed", detected_name: "Clark Johnson" }],
    error: null
  });
  render(wrap(<ExamScansPage />));
  expect(await screen.findByRole("button", { name: "Retry processing" })).toBeInTheDocument();
  expect(screen.getByText(/Confirmed matches are kept/)).toBeInTheDocument();
  const table = await screen.findByRole("table");
  expect(within(table).getByText("confirmed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create 1 submission(s)" })).toBeEnabled();
});

test("an errored batch is read-only, and an incomplete upload asks for a new upload instead of Retry", async () => {
  mockResults.exams = () => ({ data: { id: 3, num_pages: 1 }, error: null });
  mockResults.exam_scan_batches = () => ({
    data: [
      { id: 5, status: "error", total_pages: 1, pages_per_exam: 1, error: "finalize failed" },
      { id: 4, status: "error", total_pages: 2, pages_per_exam: 1, error: "incomplete upload: network" }
    ],
    error: null
  });
  mockResults.exam_scanned_submissions = () => ({
    data: [{ ...unmatchedRow, matched_profile_id: "clark", match_status: "confirmed", detected_name: "Clark Johnson" }],
    error: null
  });
  render(wrap(<ExamScansPage />));
  expect(await screen.findAllByRole("button", { name: "Retry processing" })).toHaveLength(1);
  expect(screen.getByText(/Upload the PDF again as a new batch/)).toBeInTheDocument();
  for (const picker of await screen.findAllByLabelText("Student for exam #1")) expect(picker).toBeDisabled();
  for (const b of screen.getAllByRole("button", { name: /^(Confirm|Skip)$/ })) expect(b).toBeDisabled();
});

test("clearing a pick makes the exam unmatched; choosing the same student again changes nothing", async () => {
  mockResults.exam_scanned_submissions = () => ({
    data: [{ ...unmatchedRow, matched_profile_id: "clark", match_status: "confirmed", detected_name: "Clark Johnson" }],
    error: null
  });
  render(wrap(<MatchReview batchId={5} classId={7} batchStatus="review" onBatchChanged={jest.fn()} />));
  const picker = await screen.findByLabelText("Student for exam #1");
  expect((await screen.findAllByText("Clark Johnson")).length).toBeGreaterThan(1); // scanned name + picked value

  fireEvent.focus(picker);
  fireEvent.change(picker, { target: { value: "Clark" } });
  await screen.findAllByRole("option");
  fireEvent.keyDown(picker, { key: "Enter", code: "Enter" });
  await new Promise((r) => setTimeout(r, 50));
  expect(mockUpdates).toEqual([]);

  // Clear with the keyboard: Backspace in the empty search box removes the pick.
  fireEvent.change(picker, { target: { value: "" } });
  fireEvent.keyDown(picker, { key: "Backspace", code: "Backspace" });
  await waitFor(() =>
    expect(mockUpdates).toContainEqual({ matched_profile_id: null, match_status: "unmatched", match_confidence: null })
  );
});

test("a row matched to someone missing from the roster says so instead of looking empty", async () => {
  mockResults.user_roles = () => ({ data: roster.slice(0, 3), error: null });
  mockResults.exam_scanned_submissions = () => ({
    data: [{ ...unmatchedRow, matched_profile_id: "clark", match_status: "suggested" }],
    error: null
  });
  render(wrap(<MatchReview batchId={5} classId={7} batchStatus="review" onBatchChanged={jest.fn()} />));
  expect(await screen.findByText("Student not on the roster")).toBeInTheDocument();
});

test("search matches names only, not the profile ids behind them", async () => {
  // Real profile ids are UUIDs; hex fragments like "ed" or "abe" appear in many of them.
  const uuid = (i: number) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-0000000000ed`;
  mockResults.user_roles = () => ({
    data: Array.from({ length: 199 }, (_, i) => ({
      private_profile_id: uuid(i),
      profiles: { name: `Student ${i}`, sortable_name: `${i}, Student` }
    })).concat([{ private_profile_id: uuid(999), profiles: { name: "Ed Park", sortable_name: "Park, Ed" } }]),
    error: null
  });
  render(wrap(<MatchReview batchId={5} classId={7} batchStatus="review" onBatchChanged={jest.fn()} />));
  const picker = await screen.findByLabelText("Student for exam #1");
  await waitFor(() => expect(picker).not.toBeDisabled());
  fireEvent.focus(picker);
  fireEvent.change(picker, { target: { value: "ed" } });
  const options = await screen.findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual(["Ed Park"]);
});
