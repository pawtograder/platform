/**
 * #1248: after saving regression tests, a failed list refresh is reported and Save stays off
 * until the list reloads, so a retry can't insert the same (autograder_id, repository) row twice.
 *
 * refine's hooks are replaced by a small store that behaves like React Query 4: a failed
 * refetch resolves with `isError: true` and keeps the old rows.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import AutograderConfiguration from "@/components/ui/autograder-configuration";
import { toaster } from "@/components/ui/toaster";

type Row = { id: number; autograder_id: number; repository: string };
type ListState = { rows: { data: Row[] }; error: unknown };

const mockList = {
  state: { rows: { data: [] }, error: null } as ListState,
  listeners: new Set<() => void>(),
  set(patch: Partial<ListState>) {
    mockList.state = { ...mockList.state, ...patch };
    mockList.listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void) {
    mockList.listeners.add(listener);
    return () => mockList.listeners.delete(listener);
  },
  snapshot: () => mockList.state
};
const mockRepos = { data: [{ repository: "org/student-a" }] };
const mockCreate = jest.fn();
const mockRefetch = jest.fn();

jest.mock("@refinedev/core", () => {
  const React = jest.requireActual("react");
  return {
    ...jest.requireActual("@refinedev/core"),
    useCreate: () => ({ mutateAsync: mockCreate }),
    useDelete: () => ({ mutateAsync: jest.fn() }),
    useUpdate: () => ({ mutateAsync: jest.fn() }),
    useList: ({ resource }: { resource: string }) => {
      const state: ListState = React.useSyncExternalStore(mockList.subscribe, mockList.snapshot);
      if (resource === "repositories") return { data: mockRepos, isLoading: false };
      return {
        data: state.rows,
        isLoading: false,
        isError: state.error !== null,
        isFetching: false,
        refetch: mockRefetch
      };
    }
  };
});
jest.mock("next/navigation", () => ({ useParams: () => ({ course_id: "1", assignment_id: "5" }) }));
jest.mock("@/hooks/useAssignment", () => ({ useAssignmentController: () => ({ assignment: undefined }) }));
jest.mock("@/lib/edgeFunctions", () => ({ repositoryGetFile: jest.fn() }));
jest.mock("@/utils/supabase/client", () => ({ createClient: () => ({}) }));
jest.mock("@/components/ui/toaster", () => ({ toaster: { error: jest.fn(), success: jest.fn() } }));

const SAVED_ROW: Row = { id: 1, autograder_id: 5, repository: "org/student-a" };
const LOAD_ERROR = { message: "TypeError: Failed to fetch", code: "" };

/** A refetch that fails the way React Query 4 reports it: resolved, isError, old rows kept. */
async function failedRefetch() {
  mockList.set({ error: LOAD_ERROR });
  return { isError: true, error: LOAD_ERROR, data: mockList.state.rows };
}

function refetchReturning(rows: Row[]) {
  return async () => {
    const data = { data: rows };
    mockList.set({ rows: data, error: null });
    return { isError: false, error: null, data };
  };
}

function renderConfig() {
  render(
    <ChakraProvider value={defaultSystem}>
      <AutograderConfiguration graderRepo="" />
    </ChakraProvider>
  );
}

const saveButton = () => screen.getByRole("button", { name: "Save Testing Configuration" });

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

beforeEach(() => {
  mockList.state = { rows: { data: [] }, error: null };
  mockCreate.mockReset().mockResolvedValue({ data: SAVED_ROW });
  mockRefetch.mockReset();
  jest.mocked(toaster.error).mockClear();
});

describe("saving regression tests", () => {
  it("saves and reloads the list", async () => {
    mockRefetch.mockImplementation(refetchReturning([SAVED_ROW]));
    renderConfig();

    await click(screen.getByText("org/student-a"));
    await click(saveButton());

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({ values: { autograder_id: 5, repository: "org/student-a" } });
    expect(toaster.error).not.toHaveBeenCalled();
    expect(saveButton()).toBeEnabled();
  });

  it("reports a failed reload after an insert and blocks a duplicate insert until the list reloads", async () => {
    renderConfig();
    await click(screen.getByText("org/student-a"));

    // The insert succeeds, then the reload fails: the list still shows no saved rows.
    mockRefetch.mockImplementationOnce(failedRefetch);
    await click(saveButton());

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(toaster.error).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't reload the regression test list",
        description: "TypeError: Failed to fetch"
      })
    );
    expect(screen.getByText("The regression test list didn't load")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    // Retrying Save against the stale list does nothing.
    await click(saveButton());
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // A second failed reload keeps Save off.
    mockRefetch.mockImplementationOnce(failedRefetch);
    await click(screen.getByRole("button", { name: "Reload list" }));
    expect(saveButton()).toBeDisabled();

    // A successful reload shows the saved row and turns Save back on.
    mockRefetch.mockImplementation(refetchReturning([SAVED_ROW]));
    await click(screen.getByRole("button", { name: "Reload list" }));
    expect(screen.queryByText("The regression test list didn't load")).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();

    // Saving now finds the row in the list and inserts nothing.
    await click(saveButton());
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps Save off when the list never loaded", async () => {
    mockList.state = { rows: { data: [] }, error: LOAD_ERROR };
    renderConfig();

    expect(screen.getByText("The regression test list didn't load")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });
});
