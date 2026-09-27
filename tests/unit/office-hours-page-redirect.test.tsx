/**
 * Regression test for issue #881 finding 4.
 *
 * The office-hours page used to call `redirect()` from the render phase of a
 * client component when the class had exactly one help queue:
 *
 *     if (availableQueues.length === 1) {
 *       redirect(`/course/${course_id}/office-hours/${availableQueues[0].id}`);
 *     }
 *
 * That throws NEXT_REDIRECT out of a client component while rendering. The App
 * Router root (`Router` in next/dist/client/components/app-router.tsx) can
 * itself suspend mid-render via `use()` in useActionQueue, and a render-phase
 * throw interleaved with that suspend/replay leaves the root's hook list
 * inconsistent between render attempts. React then aborts with error #310
 * ("Rendered more hooks than during the previous render") — thrown above every
 * app error boundary, so app/global-error.tsx never renders and the user gets
 * Next's built-in "Application error: a client-side exception has occurred"
 * page. The real-VoiceOver lane caught exactly that page on the office-hours
 * route and read it aloud 60 times.
 *
 * Navigation now happens in an effect. These tests pin that down, plus the
 * second defect the same block caused: the redirect fired before the view
 * check, so "My Requests" (reached via ?view=my-requests on this same route)
 * was unreachable in a single-queue class.
 */
import { render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import OfficeHoursPage from "@/app/course/[course_id]/office-hours/page";

type MockQueue = { id: number; name: string; available: boolean; ordinal: number; description: string | null };

const mockReplace = jest.fn();
const mockRedirect = jest.fn();
let mockQueues: MockQueue[] = [];
let mockSearchParams = new URLSearchParams("");

jest.mock("next/navigation", () => ({
  useParams: () => ({ course_id: "5" }),
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), refresh: jest.fn() }),
  redirect: (...args: unknown[]) => mockRedirect(...args)
}));

jest.mock("@/hooks/useOfficeHoursRealtime", () => ({
  useHelpQueues: () => mockQueues,
  useHelpQueueAssignments: () => [],
  useStudentVisibleHelpRequests: () => [],
  useHelpRequestStudents: () => [],
  useConnectionStatus: () => ({
    connectionStatus: { overall: "connected" },
    connectionError: null,
    isLoading: false
  })
}));

jest.mock("@/hooks/useClassProfiles", () => ({
  useClassProfiles: () => ({ private_profile_id: "priv-1", public_profile_id: "pub-1" })
}));

jest.mock("@/hooks/useCalendarEvents", () => ({ useOfficeHoursSchedule: () => [] }));

// Heavy presentational children — not what these tests are about.
jest.mock("@/components/help-queue/queue-card", () => ({ QueueCard: () => <div data-testid="queue-card" /> }));
jest.mock("@/components/help-queue/request-row", () => ({ RequestRow: () => <div data-testid="request-row" /> }));
jest.mock("@/components/ui/markdown", () => ({ __esModule: true, default: () => <div /> }));
jest.mock("@/components/calendar/queue-weekly-schedule", () => ({ __esModule: true, default: () => <div /> }));

function queue(id: number, name: string): MockQueue {
  return { id, name, available: true, ordinal: 0, description: null };
}

function renderPage() {
  return render(
    <ChakraProvider value={defaultSystem}>
      <OfficeHoursPage />
    </ChakraProvider>
  );
}

describe("office-hours page navigation (issue #881 finding 4)", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockRedirect.mockClear();
    mockSearchParams = new URLSearchParams("");
    mockQueues = [];
  });

  it("never calls redirect() during render when the class has one queue", () => {
    mockQueues = [queue(7, "office-hours")];

    renderPage();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith("/course/5/office-hours/7");
  });

  it("navigates to the sole queue exactly once across re-renders", () => {
    mockQueues = [queue(7, "office-hours")];

    const { rerender } = renderPage();
    for (let i = 0; i < 5; i++) {
      rerender(
        <ChakraProvider value={defaultSystem}>
          <OfficeHoursPage />
        </ChakraProvider>
      );
    }

    // The old render-time redirect re-threw on every render; Next's
    // RedirectBoundary answered by re-running the navigation and clearing its
    // own state, so the page rendered and threw again.
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it("does not bounce away from My Requests in a single-queue class", () => {
    mockQueues = [queue(7, "office-hours")];
    mockSearchParams = new URLSearchParams("view=my-requests");

    renderPage();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalledWith("/course/5/office-hours/7");
    expect(screen.getByRole("heading", { name: "My Requests" })).toBeInTheDocument();
  });

  it("auto-selects the first queue instead of redirecting when several exist", () => {
    mockQueues = [queue(7, "office-hours"), queue(8, "lab")];

    renderPage();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith("/course/5/office-hours?view=browse&queue=7", { scroll: false });
  });
});
