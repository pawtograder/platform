/**
 * #1265: confirming a student the scan does not name needs a deliberate second step. The e2e spec
 * covers this against the real database; these pin down focus and the conditional write, which a
 * browser run would only catch by luck. Named issue-* so CI's e2e-local lane runs it.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Op = [string, ...unknown[]];
type Result = { data?: unknown; error?: { message: string } | null };
const mockResults: Record<string, (ops: Op[]) => Result> = {};
const mockWrites: Op[][] = [];

function mockChain(table: string) {
  const ops: Op[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "not", "maybeSingle", "update", "single"])
    chain[method] = (...args: unknown[]) => {
      ops.push([method, ...args]);
      return chain;
    };
  chain.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => {
    if (ops.some(([m]) => m === "update")) mockWrites.push(ops);
    return Promise.resolve(mockResults[table](ops)).then(resolve, reject);
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
let matched = "p1";
function row() {
  return {
    id: 1,
    exam_index: 1,
    detected_name: "ALPHA TESTER",
    detected_sis_id: null,
    matched_profile_id: matched,
    match_confidence: null,
    match_status: "suggested",
    submission_id: null,
    finalized_at: null
  };
}

beforeEach(() => {
  matched = "p1";
  mockWrites.length = 0;
  mockToastError.mockReset();
  mockResults.exam_scanned_submissions = (ops) =>
    ops.some(([m]) => m === "update") ? { data: [], error: null } : { data: [row()], error: null };
  mockResults.user_roles = () => ({
    data: [
      { private_profile_id: "p1", profiles: { name: "Clark Johnson" } },
      { private_profile_id: "p2", profiles: { name: "Dana Lee" } }
    ],
    error: null
  });
});

async function openPrompt() {
  render(wrap(<MatchReview batchId={5} classId={7} batchStatus="review" onBatchChanged={jest.fn()} />));
  await screen.findByText(/Scan: “ALPHA TESTER”/);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  return screen.findByRole("alert");
}

test("the prompt puts Cancel first and focuses it, and writes nothing", async () => {
  const prompt = await openPrompt();
  const buttons = within(prompt).getAllByRole("button");
  expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Confirm anyway"]);
  expect(document.activeElement).toBe(buttons[0]);
  expect(mockWrites).toHaveLength(0);
});

test("when the row changed under an open prompt, asking again moves focus back to Cancel", async () => {
  await openPrompt();
  matched = "p2";
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
  await screen.findByText(/Selected: “Dana Lee”/);
  const confirmAnyway = screen.getByRole("button", { name: "Confirm anyway" });
  confirmAnyway.focus();
  await act(async () => fireEvent.click(confirmAnyway));
  const prompt = await screen.findByRole("alert");
  expect(prompt).toHaveTextContent("not “Dana Lee”");
  await waitFor(() => expect(document.activeElement).toBe(within(prompt).getByRole("button", { name: "Cancel" })));
  expect(mockWrites).toHaveLength(0);
});

test("the confirm write is conditional on the student the instructor saw, and a miss is reported", async () => {
  await openPrompt();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm anyway" })));
  await waitFor(() => expect(mockWrites).toHaveLength(1));
  expect(mockWrites[0]).toEqual(
    expect.arrayContaining([
      ["update", { match_status: "confirmed" }],
      ["eq", "id", 1],
      ["eq", "matched_profile_id", "p1"]
    ])
  );
  await waitFor(() =>
    expect(mockToastError).toHaveBeenCalledWith({
      title: "This exam's match changed. Check it again before confirming."
    })
  );
});
