/**
 * #1265 / #1270: a match decision is written only against what the reviewer was shown.
 *
 * The worker can rewrite an unconfirmed row's detected name and SIS id (a redelivered or late match),
 * and another staff member can confirm or change the same exam. Confirm, pick and Skip therefore
 * carry the shown values as conditions, and a write that matched nothing is reported instead of
 * looking like success. Also: a confirm that settles late does not pull focus out of another row's
 * open prompt. Named issue-* so CI's e2e-local lane runs it.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Op = [string, ...unknown[]];
type Result = { data?: unknown; error?: { message: string } | null };
const mockWrites: Op[][] = [];
let mockWriteResult: () => Promise<Result> = async () => ({ data: [{ id: 1 }], error: null });
let mockRows: Record<string, unknown>[] = [];

function mockChain(table: string) {
  const ops: Op[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "order", "not", "maybeSingle", "update", "single", "limit"])
    chain[method] = (...args: unknown[]) => {
      ops.push([method, ...args]);
      return chain;
    };
  chain.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => {
    let result: Promise<Result>;
    if (ops.some(([m]) => m === "update")) {
      mockWrites.push(ops);
      result = mockWriteResult();
    } else if (table === "user_roles") {
      result = Promise.resolve({
        data: [
          { private_profile_id: "p1", profiles: { name: "Clark Johnson" } },
          { private_profile_id: "p2", profiles: { name: "Dana Lee" } },
          { private_profile_id: "p3", profiles: { name: "Alpha Tester" } }
        ],
        error: null
      });
    } else {
      result = Promise.resolve({ data: mockRows, error: null });
    }
    return result.then(resolve, reject);
  };
  return chain;
}

jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ from: (table: string) => mockChain(table), rpc: jest.fn() })
}));
const mockToastError = jest.fn();
jest.mock("@/components/ui/toaster", () => ({
  toaster: { success: jest.fn(), error: (...a: unknown[]) => mockToastError(...a) }
}));

import MatchReview from "@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/MatchReview";

const wrap = (ui: React.ReactElement) => <ChakraProvider value={defaultSystem}>{ui}</ChakraProvider>;
function row(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    exam_index: id,
    detected_name: "ALPHA TESTER",
    detected_sis_id: null,
    matched_profile_id: "p1",
    match_confidence: null,
    match_status: "suggested",
    submission_id: null,
    finalized_at: null,
    ...overrides
  };
}
const review = () =>
  render(wrap(<MatchReview batchId={5} classId={7} batchStatus="review" onBatchChanged={jest.fn()} />));

beforeEach(() => {
  mockWrites.length = 0;
  mockToastError.mockReset();
  mockWriteResult = async () => ({ data: [{ id: 1 }], error: null });
  mockRows = [row(1)];
});

test("Confirm anyway is conditional on the student, name and SIS id that were shown", async () => {
  mockRows = [row(1, { detected_sis_id: "001234" })];
  review();
  await screen.findByText(/Scan: “ALPHA TESTER”/);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Confirm anyway" })));
  await waitFor(() => expect(mockWrites).toHaveLength(1));
  expect(mockWrites[0]).toEqual(
    expect.arrayContaining([
      ["update", { match_status: "confirmed" }],
      ["eq", "id", 1],
      ["eq", "matched_profile_id", "p1"],
      ["eq", "detected_name", "ALPHA TESTER"],
      ["eq", "detected_sis_id", "001234"]
    ])
  );
});

test("a one-click confirm also requires the shown name; a name that changed underneath is reported", async () => {
  // Equivalent names: no acknowledgment needed, so one click writes.
  mockRows = [row(1, { matched_profile_id: "p3", detected_name: null })];
  mockRows[0].detected_name = "Tester, Alpha";
  review();
  await screen.findByText("Tester, Alpha");
  mockWriteResult = async () => ({ data: [], error: null });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm" })));
  await waitFor(() => expect(mockWrites).toHaveLength(1));
  expect(mockWrites[0]).toEqual(
    expect.arrayContaining([
      ["eq", "detected_name", "Tester, Alpha"],
      ["is", "detected_sis_id", null]
    ])
  );
  await waitFor(() =>
    expect(mockToastError).toHaveBeenCalledWith({
      title: "This exam's match changed. Check it again before confirming."
    })
  );
});

test("picking a student and skipping apply only to the exam as shown, and a miss is reported", async () => {
  mockRows = [row(1, { matched_profile_id: null, match_status: "unmatched", detected_name: "Dana Lee" })];
  review();
  await screen.findByText("Dana Lee", { selector: "p" });
  mockWriteResult = async () => ({ data: [], error: null });
  await act(async () => fireEvent.change(screen.getByRole("combobox"), { target: { value: "p2" } }));
  await waitFor(() => expect(mockWrites).toHaveLength(1));
  expect(mockWrites[0]).toEqual(
    expect.arrayContaining([
      ["eq", "id", 1],
      ["eq", "match_status", "unmatched"],
      ["is", "matched_profile_id", null]
    ])
  );
  await waitFor(() =>
    expect(mockToastError).toHaveBeenCalledWith({
      title: "This exam changed while you were choosing. Check it again."
    })
  );

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Skip" })));
  await waitFor(() => expect(mockWrites).toHaveLength(2));
  expect(mockWrites[1]).toEqual(
    expect.arrayContaining([
      ["update", { match_status: "skipped" }],
      ["eq", "match_status", "unmatched"],
      ["is", "matched_profile_id", null]
    ])
  );
  await waitFor(() =>
    expect(mockToastError).toHaveBeenCalledWith({ title: "This exam changed before it was skipped. Check it again." })
  );
});

test("a confirm that settles after another row's prompt opened leaves focus in that prompt", async () => {
  mockRows = [row(1), row(2, { detected_name: "BRAVO TESTER" })];
  review();
  await screen.findByText(/Scan: “BRAVO TESTER”/);
  // Row 1: acknowledge, and hold the write open.
  let settle: (r: Result) => void = () => {};
  mockWriteResult = () => new Promise((resolve) => (settle = resolve));
  fireEvent.click(screen.getAllByRole("button", { name: "Confirm" })[0]);
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Confirm anyway" })));
  await waitFor(() => expect(mockWrites).toHaveLength(1));
  // Row 2's prompt opens while row 1's write is still out.
  fireEvent.click(screen.getAllByRole("button", { name: "Confirm" }).at(-1)!);
  const prompt = await screen.findByRole("alert");
  expect(prompt).toHaveTextContent("BRAVO TESTER");
  const cancel = within(prompt).getByRole("button", { name: "Cancel" });
  cancel.focus();
  await act(async () => settle({ data: [{ id: 1 }], error: null }));
  await act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
  expect(screen.getByRole("alert")).toHaveTextContent("BRAVO TESTER");
  expect(document.activeElement).toBe(cancel);
});
