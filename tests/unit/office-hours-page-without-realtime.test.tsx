/**
 * Regression test for issue #1065.
 *
 * The office-hours page used to wait for every realtime channel to join before it
 * rendered. When a browser couldn't open the realtime WebSocket, the page stayed on
 * "Loading help queues..." forever, even though the rows had already arrived over
 * HTTP. The page now waits for the HTTP fetch of each table it reads and leaves the
 * realtime warning to the layout.
 */
import { render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import OfficeHoursPage from "@/app/course/[course_id]/office-hours/page";

type MockQueue = { id: number; name: string; available: boolean; ordinal: number; description: string | null };
type MockTable = { ready: boolean; readyPromise: Promise<void> };
type TableName = "helpQueues" | "helpQueueAssignments" | "helpRequests" | "helpRequestStudents";

const TABLES: TableName[] = ["helpQueues", "helpQueueAssignments", "helpRequests", "helpRequestStudents"];

const mockReplace = jest.fn();
let mockQueues: MockQueue[] = [];
let mockTables: Record<TableName, MockTable>;
let mockRealtime = {
  connectionStatus: { overall: "connected" },
  connectionError: null as string | null,
  connectionFailed: false,
  isLoading: false
};

jest.mock("next/navigation", () => ({
  useParams: () => ({ course_id: "5" }),
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), refresh: jest.fn() })
}));

jest.mock("@/hooks/useOfficeHoursRealtime", () => ({
  useHelpQueues: () => mockQueues,
  useHelpQueueAssignments: () => [],
  useStudentVisibleHelpRequests: () => [],
  useHelpRequestStudents: () => [],
  useOfficeHoursController: () => mockTables,
  useConnectionStatus: () => mockRealtime
}));

jest.mock("@/hooks/useClassProfiles", () => ({
  useClassProfiles: () => ({ private_profile_id: "priv-1", public_profile_id: "pub-1" })
}));

jest.mock("@/hooks/useCalendarEvents", () => ({ useOfficeHoursSchedule: () => [] }));

jest.mock("@/components/help-queue/queue-card", () => ({ QueueCard: () => <div data-testid="queue-card" /> }));
jest.mock("@/components/help-queue/request-row", () => ({ RequestRow: () => <div data-testid="request-row" /> }));
jest.mock("@/components/ui/markdown", () => ({ __esModule: true, default: () => <div /> }));
jest.mock("@/components/calendar/queue-weekly-schedule", () => ({ __esModule: true, default: () => <div /> }));

function queue(id: number, name: string): MockQueue {
  return { id, name, available: true, ordinal: 0, description: null };
}

function loaded(): MockTable {
  return { ready: true, readyPromise: Promise.resolve() };
}

function stillLoading(): MockTable {
  return { ready: false, readyPromise: new Promise<void>(() => {}) };
}

function failed(): MockTable {
  const readyPromise = Promise.reject(new Error("PostgREST error"));
  readyPromise.catch(() => {});
  return { ready: false, readyPromise };
}

function renderPage() {
  return render(
    <ChakraProvider value={defaultSystem}>
      <OfficeHoursPage />
    </ChakraProvider>
  );
}

describe("office-hours page without realtime (issue #1065)", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockQueues = [queue(7, "office-hours"), queue(8, "lab")];
    mockTables = {
      helpQueues: loaded(),
      helpQueueAssignments: loaded(),
      helpRequests: loaded(),
      helpRequestStudents: loaded()
    };
    mockRealtime = {
      connectionStatus: { overall: "connected" },
      connectionError: null,
      connectionFailed: false,
      isLoading: false
    };
  });

  it("shows the queues when the data has loaded but the realtime channels never joined", () => {
    mockRealtime = {
      connectionStatus: { overall: "disconnected" },
      connectionError: null,
      connectionFailed: true,
      isLoading: true
    };

    renderPage();

    expect(screen.queryByText("Loading help queues...")).not.toBeInTheDocument();
    expect(screen.queryByText(/Connection error/)).not.toBeInTheDocument();
    expect(screen.getAllByTestId("queue-card")).toHaveLength(2);
  });

  it.each(TABLES)("waits for %s, and does not redirect on the data it has so far", (table) => {
    mockQueues = [queue(7, "office-hours")];
    mockTables[table] = stillLoading();

    renderPage();

    expect(screen.getByText("Loading help queues...")).toBeInTheDocument();
    expect(screen.queryByText("Opening the help queue…")).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("says the queues couldn't load when a fetch fails, instead of loading forever", async () => {
    mockTables.helpRequests = failed();

    renderPage();

    expect(await screen.findByText(/Couldn't load the help queues/)).toBeInTheDocument();
    expect(screen.queryByText("Loading help queues...")).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
