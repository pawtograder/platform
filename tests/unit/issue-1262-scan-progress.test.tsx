/**
 * #1262: the Scan & Match page shows work in progress and follows it without a reload.
 *
 * tests/e2e/exam-scan-review-ui.spec.ts covers the user-visible flow against the real worker. These
 * cover what a browser run cannot pin down: a double click on Process, polling while the tab is
 * hidden, timers after unmount, and a refresh that fails. Named issue-* so CI's e2e-local lane runs it.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
const mockResults: Record<string, () => Result | Promise<Result>> = {};
const mockQueries: string[] = [];
const mockRpc = jest.fn();

function mockChain(table: string) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "order", "not", "maybeSingle", "update"]) chain[method] = () => chain;
  chain.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => {
    mockQueries.push(table);
    return Promise.resolve(mockResults[table]()).then(resolve, reject);
  };
  return chain;
}

jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ from: (table: string) => mockChain(table), rpc: (...args: unknown[]) => mockRpc(...args) })
}));
jest.mock("@/components/ui/toaster", () => ({ toaster: { success: jest.fn(), error: jest.fn() } }));
jest.mock("next/navigation", () => ({ useParams: () => ({ course_id: "7", assignment_id: "9" }) }));
jest.mock("@/lib/exam/examClient", () => ({ uploadExamScanBatch: jest.fn() }));
jest.mock("@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/ExamFeatureGate", () => ({
  ExamFeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

import ExamScansPage from "@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/scans/page";
import MatchReview from "@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/MatchReview";

const count = (table: string) => mockQueries.filter((t) => t === table).length;
let visibility: DocumentVisibilityState = "visible";

function batch(status: string) {
  return { id: 5, status, total_pages: 3, pages_per_exam: 1, error: null };
}
function scanned(id: number, finalized: boolean) {
  return {
    id,
    exam_index: id,
    detected_name: `Student ${id}`,
    detected_sis_id: null,
    matched_profile_id: `p${id}`,
    match_confidence: 1,
    match_status: "confirmed",
    submission_id: finalized ? 100 + id : null,
    finalized_at: finalized ? "2026-11-16T00:00:00Z" : null
  };
}
const wrap = (ui: React.ReactElement) => <ChakraProvider value={defaultSystem}>{ui}</ChakraProvider>;

beforeAll(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
beforeEach(() => {
  jest.useFakeTimers();
  visibility = "visible";
  mockQueries.length = 0;
  mockRpc.mockReset();
  mockResults.exams = () => ({ data: { id: 1, num_pages: 1 }, error: null });
  mockResults.exam_scan_batches = () => ({ data: [batch("uploaded")], error: null });
  mockResults.exam_scan_pages = () => ({ count: 1, error: null });
  mockResults.exam_scanned_submissions = () => ({ data: [], error: null });
  mockResults.user_roles = () => ({ data: [], error: null });
});
afterEach(() => jest.useRealTimers());

test("a double click on Process sends one request", async () => {
  // Hold every request open until both clicks are in, then settle all of them, so nothing is left
  // pending for the next test even when the guard is missing.
  const pending: ((r: Result) => void)[] = [];
  mockRpc.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  render(wrap(<ExamScansPage />));
  const process = await screen.findByRole("button", { name: "Process (OCR + match)" });
  fireEvent.click(process);
  fireEvent.click(process);
  const calls = mockRpc.mock.calls.length;
  await act(async () => pending.forEach((resolve) => resolve({ error: null })));
  expect(calls).toBe(1);
  expect(mockRpc).toHaveBeenCalledWith("enqueue_exam_process_batch", { p_batch_id: 5 });
});

test("a batch reading pages shows its progress, polls only while visible, and stops on unmount", async () => {
  mockResults.exam_scan_batches = () => ({ data: [batch("ocr")], error: null });
  const { unmount } = render(wrap(<ExamScansPage />));
  expect(await screen.findByRole("status")).toHaveTextContent("Reading pages: 1 of 3");
  const afterFirstLoad = count("exam_scan_batches");

  await act(async () => jest.advanceTimersByTime(4000));
  expect(count("exam_scan_batches")).toBe(afterFirstLoad + 1);

  visibility = "hidden";
  await act(async () => jest.advanceTimersByTime(8000));
  expect(count("exam_scan_batches")).toBe(afterFirstLoad + 1);

  // Shown again: refresh at once instead of waiting for the next tick.
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(count("exam_scan_batches")).toBe(afterFirstLoad + 2);

  unmount();
  await act(async () => jest.advanceTimersByTime(12000));
  expect(count("exam_scan_batches")).toBe(afterFirstLoad + 2);
});

test("a refresh that fails keeps the batches on screen and says they may be stale", async () => {
  mockResults.exam_scan_batches = () => ({ data: [batch("ocr")], error: null });
  render(wrap(<ExamScansPage />));
  await screen.findByText("Batch #5");
  mockResults.exam_scan_batches = () => ({ data: null, error: { message: "network down" } });
  await act(async () => jest.advanceTimersByTime(4000));
  expect(await screen.findByText(/Couldn.t refresh the batches \(network down\)/)).toBeInTheDocument();
  expect(screen.getByText("Batch #5")).toBeInTheDocument();
});

test("Create submissions reloads the rows and asks the page to reload the batch", async () => {
  mockResults.exam_scanned_submissions = () => ({ data: [scanned(1, false)], error: null });
  mockRpc.mockResolvedValue({ data: 1, error: null });
  const onBatchChanged = jest.fn();
  render(wrap(<MatchReview batchId={5} classId={7} batchStatus="review" onBatchChanged={onBatchChanged} />));
  const create = await screen.findByRole("button", { name: "Create 1 submission(s)" });
  const before = count("exam_scanned_submissions");
  fireEvent.click(create);
  await waitFor(() => expect(onBatchChanged).toHaveBeenCalledTimes(1));
  expect(mockRpc).toHaveBeenCalledWith("enqueue_exam_finalize", { p_batch_id: 5 });
  expect(count("exam_scanned_submissions")).toBe(before + 1);
});

test("while finalizing, nothing can be changed and rows are followed until the batch completes", async () => {
  mockResults.exam_scanned_submissions = () => ({ data: [scanned(1, true), scanned(2, false)], error: null });
  const props = { batchId: 5, classId: 7, onBatchChanged: jest.fn() };
  const { rerender } = render(wrap(<MatchReview {...props} batchStatus="finalizing" />));
  expect(await screen.findByText("Creating submissions: 1 of 2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create 1 submission(s)" })).toBeDisabled();
  for (const b of screen.getAllByRole("button", { name: /^(Confirm|Skip)$/ })) expect(b).toBeDisabled();
  // One student picker per row, all disabled (found by label: a disabled picker is not exposed by role).
  const pickers = screen.getAllByLabelText(/^Student for exam #/);
  expect(pickers).toHaveLength(2);
  for (const s of pickers) expect(s).toBeDisabled();

  const before = count("exam_scanned_submissions");
  await act(async () => jest.advanceTimersByTime(4000));
  expect(count("exam_scanned_submissions")).toBe(before + 1);

  // The page sees 'completed': one reload for the new state, then no more polling.
  rerender(wrap(<MatchReview {...props} batchStatus="completed" />));
  await waitFor(() => expect(count("exam_scanned_submissions")).toBe(before + 2));
  await act(async () => jest.advanceTimersByTime(12000));
  expect(count("exam_scanned_submissions")).toBe(before + 2);
  // The roster is loaded once, not on every poll.
  expect(count("user_roles")).toBe(1);
});

test("a failed refresh of the matches keeps the rows on screen and says so", async () => {
  mockResults.exam_scanned_submissions = () => ({ data: [scanned(1, false)], error: null });
  render(wrap(<MatchReview batchId={5} classId={7} batchStatus="finalizing" onBatchChanged={jest.fn()} />));
  expect(await screen.findByText("Student 1")).toBeInTheDocument();
  mockResults.exam_scanned_submissions = () => ({ data: null, error: { message: "timeout" } });
  await act(async () => jest.advanceTimersByTime(4000));
  expect(await screen.findByText(/Couldn.t refresh the matches \(timeout\)/)).toBeInTheDocument();
  expect(screen.getByText("Student 1")).toBeInTheDocument();
});

test("a page count that fails keeps the last count instead of showing 0", async () => {
  mockResults.exam_scan_batches = () => ({ data: [batch("ocr")], error: null });
  mockResults.exam_scan_pages = () => ({ count: 2, error: null });
  render(wrap(<ExamScansPage />));
  expect(await screen.findByText("Reading pages: 2 of 3")).toBeInTheDocument();
  mockResults.exam_scan_pages = () => ({ count: null, error: { message: "count failed" } });
  await act(async () => jest.advanceTimersByTime(4000));
  expect(await screen.findByText(/Couldn.t refresh the batches \(count failed\)/)).toBeInTheDocument();
  expect(screen.getByText("Reading pages: 2 of 3")).toBeInTheDocument();
});

test("Create stays disabled until the page has reloaded the batch", async () => {
  mockResults.exam_scanned_submissions = () => ({ data: [scanned(1, false)], error: null });
  mockRpc.mockResolvedValue({ data: 1, error: null });
  // The parent's batch reload is still out: its batchStatus prop still says 'review'.
  let finishBatchReload: () => void = () => {};
  const onBatchChanged = jest.fn(() => new Promise<void>((resolve) => (finishBatchReload = resolve)));
  render(wrap(<MatchReview batchId={5} classId={7} batchStatus="review" onBatchChanged={onBatchChanged} />));
  const create = await screen.findByRole("button", { name: "Create 1 submission(s)" });
  fireEvent.click(create);
  await waitFor(() => expect(onBatchChanged).toHaveBeenCalledTimes(1));
  expect(create).toBeDisabled();
  fireEvent.click(create);
  expect(mockRpc).toHaveBeenCalledTimes(1);
  await act(async () => finishBatchReload());
});

test("Refresh reloads the batch as well as the rows", async () => {
  mockResults.exam_scanned_submissions = () => ({ data: [scanned(1, false)], error: null });
  const onBatchChanged = jest.fn();
  render(wrap(<MatchReview batchId={5} classId={7} batchStatus="review" onBatchChanged={onBatchChanged} />));
  await screen.findByText("Student 1");
  const before = count("exam_scanned_submissions");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
  expect(onBatchChanged).toHaveBeenCalledTimes(1);
  expect(count("exam_scanned_submissions")).toBe(before + 1);
});

test("progress still updates when each poll takes longer than the poll interval", async () => {
  // Every batch request takes 5 s, longer than the 4 s interval.
  let read = 1;
  mockResults.exam_scan_batches = () =>
    new Promise((resolve) => setTimeout(() => resolve({ data: [batch("ocr")], error: null }), 5000));
  mockResults.exam_scan_pages = () => ({ count: read, error: null });
  render(wrap(<ExamScansPage />));
  for (let i = 0; i < 12; i++) await act(async () => jest.advanceTimersByTime(500));
  expect(screen.getByRole("status")).toHaveTextContent("Reading pages: 1 of 3");
  read = 3;
  for (let i = 0; i < 40; i++) await act(async () => jest.advanceTimersByTime(500));
  expect(screen.getByRole("status")).toHaveTextContent("Reading pages: 3 of 3");
});

test("Create stays disabled when the page's batch reload fails, until the batch status changes", async () => {
  mockResults.exam_scanned_submissions = () => ({ data: [scanned(1, false)], error: null });
  mockRpc.mockResolvedValue({ data: 1, error: null });
  // The reload settles but changes nothing: batchStatus stays 'review'.
  const props = { batchId: 5, classId: 7, onBatchChanged: jest.fn() };
  const { rerender } = render(wrap(<MatchReview {...props} batchStatus="review" />));
  const create = await screen.findByRole("button", { name: "Create 1 submission(s)" });
  fireEvent.click(create);
  await waitFor(() => expect(props.onBatchChanged).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(create).toBeDisabled());
  fireEvent.click(create);
  expect(mockRpc).toHaveBeenCalledTimes(1);
  // Once the page sees the batch move on (and, after an error and Retry, come back), Create returns.
  rerender(wrap(<MatchReview {...props} batchStatus="error" />));
  rerender(wrap(<MatchReview {...props} batchStatus="review" />));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create 1 submission(s)" })).not.toBeDisabled());
});

// A failed load must not leave the page on stale state with nothing scheduled to replace it: the
// server keeps moving the batch on whether or not this page's last request succeeded.
describe("recovery after a failed load", () => {
  test("a failed reload when the batch completes is retried until it succeeds, then polling stops", async () => {
    mockResults.exam_scanned_submissions = () => ({ data: [scanned(1, false)], error: null });
    const props = { batchId: 5, classId: 7, onBatchChanged: jest.fn() };
    const { rerender } = render(wrap(<MatchReview {...props} batchStatus="finalizing" />));
    expect(await screen.findByText("Creating submissions: 0 of 1")).toBeInTheDocument();

    // The page sees 'completed', but the reload for it fails.
    mockResults.exam_scanned_submissions = () => ({ data: null, error: { message: "timeout" } });
    rerender(wrap(<MatchReview {...props} batchStatus="completed" />));
    expect(await screen.findByText(/Couldn.t refresh the matches \(timeout\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create 1 submission(s)" })).toBeInTheDocument();

    // No click: the next tick retries and the finalized row arrives.
    mockResults.exam_scanned_submissions = () => ({ data: [scanned(1, true)], error: null });
    await act(async () => jest.advanceTimersByTime(4000));
    expect(await screen.findByRole("button", { name: "Create 0 submission(s)" })).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t refresh the matches/)).not.toBeInTheDocument();

    const settled = count("exam_scanned_submissions");
    await act(async () => jest.advanceTimersByTime(12000));
    expect(count("exam_scanned_submissions")).toBe(settled);
  });

  test("a failed roster load is reported, not shown as an empty roster, and is retried until it loads", async () => {
    mockResults.exam_scanned_submissions = () => ({
      data: [{ ...scanned(1, false), match_status: "unmatched", matched_profile_id: null }],
      error: null
    });
    mockResults.user_roles = () => ({ data: null, error: { message: "roster timeout" } });
    render(wrap(<MatchReview batchId={5} classId={7} batchStatus="review" onBatchChanged={jest.fn()} />));
    expect(await screen.findByText(/Couldn.t load the student list \(roster timeout\)/)).toBeInTheDocument();
    const picker = screen.getAllByRole("combobox")[0];
    fireEvent.focus(picker);
    fireEvent.keyDown(picker, { key: "ArrowDown", code: "ArrowDown" });
    expect(screen.queryByRole("option", { name: "Ada Lovelace" })).not.toBeInTheDocument();

    mockResults.user_roles = () => ({
      data: [{ private_profile_id: "p-ada", profiles: { name: "Ada Lovelace" } }],
      error: null
    });
    await act(async () => jest.advanceTimersByTime(4000));
    fireEvent.keyDown(screen.getAllByRole("combobox")[0], { key: "ArrowDown", code: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "Ada Lovelace" })).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t load the student list/)).not.toBeInTheDocument();

    // Loaded once successfully: not refetched by later ticks or by Refresh.
    const loaded = count("user_roles");
    await act(async () => jest.advanceTimersByTime(12000));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
    expect(count("user_roles")).toBe(loaded);
  });

  test("Create queues the work and the batch reload fails: the page keeps polling until it sees finalizing", async () => {
    mockResults.exam_scan_batches = () => ({ data: [batch("review")], error: null });
    mockResults.exam_scanned_submissions = () => ({ data: [scanned(1, false)], error: null });
    mockRpc.mockResolvedValue({ data: 1, error: null });
    render(wrap(<ExamScansPage />));
    const create = await screen.findByRole("button", { name: "Create 1 submission(s)" });

    // The RPC commits 'finalizing', but the page's reload after it fails.
    mockResults.exam_scan_batches = () => ({ data: null, error: { message: "network down" } });
    fireEvent.click(create);
    expect(await screen.findByText(/Couldn.t refresh the batches \(network down\)/)).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledTimes(1);

    mockResults.exam_scan_batches = () => ({ data: [batch("finalizing")], error: null });
    await act(async () => jest.advanceTimersByTime(4000));
    expect(await screen.findByText("Creating submissions: 0 of 1")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t refresh the batches/)).not.toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});
