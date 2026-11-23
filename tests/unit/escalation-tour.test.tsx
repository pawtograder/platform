/**
 * "What's new" walkthrough for ticket escalation (components/help-queue/escalation-tour.tsx).
 *
 * - Staff only: students get neither the automatic prompt nor the header button.
 * - The prompt opens on its own the first time staff visit, and not again once dismissed, whether
 *   by Close (no tutorial) or by finishing the tour. "Seen" is a per-user row in
 *   public.user_whats_new_seen, so it holds across browsers and devices. The header button
 *   reopens it at the prompt.
 * - Once dismissed, it stays closed for the rest of the page load even if the component remounts
 *   before the row is saved, but only for the user who dismissed it.
 * - Show me walks through every step in order, and Back returns to the previous one.
 * - When the record can't be read the prompt stays closed instead of reopening on every page load.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EscalationTour, resetEscalationTourForTests } from "@/components/help-queue/escalation-tour";

let mockIsStaff = true;
let mockUserId = "staff-a";
jest.mock("@/hooks/useClassProfiles", () => ({ useIsGraderOrInstructor: () => mockIsStaff }));
jest.mock("@/hooks/useAuthState", () => ({ __esModule: true, default: () => ({ user: { id: mockUserId } }) }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

/**
 * The signed-in user's rows in user_whats_new_seen. The component only reads its own row by item
 * (RLS limits it to the caller's rows) and upserts it on Close or Done.
 */
const mockSeen = new Set<string>();
let mockReadError: { message: string } | null = null;
let mockReadGate: Promise<void> | null = null;
const mockFrom = jest.fn();
const mockUpsert = jest.fn();
jest.mock("@/utils/supabase/client", () => ({ createClient: () => ({ from: mockFrom }) }));

const ITEM = "oh-escalation:v1";
const PROMPT = "New in Office Hours: ticket escalation";
const STEP_TITLES = [
  "Escalate: hand a ticket on",
  "What an escalated ticket looks like",
  "Resolve now checks in with the student",
  "End ticket: done for good",
  "Resolve vs End ticket"
];

function renderTour() {
  return render(
    <ChakraProvider value={defaultSystem}>
      <EscalationTour />
    </ChakraProvider>
  );
}

const dialogTitle = () =>
  screen.queryByRole("heading", { name: new RegExp(`^(${[PROMPT, ...STEP_TITLES].join("|")})$`) });

beforeEach(() => {
  resetEscalationTourForTests();
  mockIsStaff = true;
  mockUserId = "staff-a";
  mockSeen.clear();
  mockReadError = null;
  mockReadGate = null;
  mockUpsert.mockReset().mockImplementation(async (row: { item: string }) => {
    mockSeen.add(row.item);
    return { error: null };
  });
  mockFrom.mockReset().mockImplementation((table: string) => {
    expect(table).toBe("user_whats_new_seen");
    return {
      select: () => ({
        eq: (column: string, item: string) => ({
          maybeSingle: async () => {
            expect(column).toBe("item");
            if (mockReadGate) await mockReadGate;
            if (mockReadError) return { data: null, error: mockReadError };
            return { data: mockSeen.has(item) ? { item } : null, error: null };
          }
        })
      }),
      upsert: mockUpsert
    };
  });
});

const expectSeenWritten = () =>
  expect(mockUpsert).toHaveBeenCalledWith({ item: ITEM }, { onConflict: "user_id,item", ignoreDuplicates: true });

describe("EscalationTour", () => {
  it("renders nothing for students", () => {
    mockIsStaff = false;
    renderTour();
    expect(screen.queryByRole("button", { name: "What's new" })).toBeNull();
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("opens the prompt on a staff member's first visit", async () => {
    renderTour();
    expect(await screen.findByText(PROMPT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show me" })).toBeInTheDocument();
  });

  it("Close dismisses without the tutorial and is remembered", async () => {
    const { unmount } = renderTour();
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
    expect(screen.queryByText(STEP_TITLES[0])).toBeNull();
    expectSeenWritten();

    // A later visit, on this browser or any other, reads the row and stays closed.
    unmount();
    mockFrom.mockClear();
    renderTour();
    expect(screen.getByRole("button", { name: "What's new" })).toBeInTheDocument();
    await waitFor(() => expect(mockFrom).toHaveBeenCalled());
    await expect(screen.findByText(PROMPT, undefined, { timeout: 500 })).rejects.toThrow();
  });

  it("walks through every step in order, with Back, and Done closes it", async () => {
    renderTour();
    fireEvent.click(await screen.findByRole("button", { name: "Show me" }));

    for (let i = 0; i < STEP_TITLES.length; i++) {
      expect(await screen.findByText(STEP_TITLES[i])).toBeInTheDocument();
      expect(screen.getByRole("img", { name: `Step ${i + 1} of ${STEP_TITLES.length}` })).toBeInTheDocument();
      if (i === 1) {
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(await screen.findByText(STEP_TITLES[0])).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText(STEP_TITLES[1])).toBeInTheDocument();
      }
      if (i < STEP_TITLES.length - 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(dialogTitle()).toBeNull());
    expectSeenWritten();
  });

  it("the first step's Back is disabled", async () => {
    renderTour();
    fireEvent.click(await screen.findByRole("button", { name: "Show me" }));
    expect(await screen.findByRole("button", { name: "Back" })).toBeDisabled();
  });

  it("What's new reopens the tour at the prompt after it was seen", async () => {
    mockSeen.add(ITEM);
    renderTour();
    await expect(screen.findByText(PROMPT, undefined, { timeout: 500 })).rejects.toThrow();
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(await screen.findByText(PROMPT)).toBeInTheDocument();
  });

  it("stays closed when the record can't be read, and What's new still opens it", async () => {
    // A prompt we can't check would otherwise open on every page load.
    mockReadError = { message: "network down" };
    renderTour();
    await expect(screen.findByText(PROMPT, undefined, { timeout: 500 })).rejects.toThrow();
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(await screen.findByText(PROMPT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
  });

  it("still closes when saving the record fails", async () => {
    mockUpsert.mockImplementation(async () => ({ error: { message: "network down" } }));
    renderTour();
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
    expectSeenWritten();
  });

  it("a slow read doesn't reopen the tour after the user has opened and closed it", async () => {
    let release!: () => void;
    mockReadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderTour();
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());

    // The read was started before Close and reports nothing saved yet.
    mockSeen.clear();
    release();
    await expect(screen.findByText(PROMPT, undefined, { timeout: 500 })).rejects.toThrow();
  });

  it("stays closed after Close when it remounts before the record is saved", async () => {
    // Staff can leave the office hours layout and come back before the upsert commits. The new
    // instance's read then finds no row, so it must also check what this page session dismissed.
    let save!: () => void;
    mockUpsert.mockImplementation(
      (row: { item: string }) =>
        new Promise((resolve) => {
          save = () => {
            mockSeen.add(row.item);
            resolve({ error: null });
          };
        })
    );
    const { unmount } = renderTour();
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
    expectSeenWritten();

    unmount();
    mockFrom.mockClear();
    renderTour();
    await waitFor(() => expect(mockFrom).toHaveBeenCalled());
    await expect(screen.findByText(PROMPT, undefined, { timeout: 500 })).rejects.toThrow();
    save();
  });

  it("still opens for another user who signs in on the same tab before the record is saved", async () => {
    // Signing out is a soft navigation, so the page doesn't reload between the two users.
    let save!: () => void;
    mockUpsert.mockImplementation(
      (row: { item: string }) =>
        new Promise((resolve) => {
          save = () => {
            mockSeen.add(row.item);
            resolve({ error: null });
          };
        })
    );
    const { unmount } = renderTour();
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());

    unmount();
    mockUserId = "staff-b";
    renderTour();
    expect(await screen.findByText(PROMPT)).toBeTruthy();
    save();
  });

  it("keeps every control inside a step's preview out of the tab order", async () => {
    renderTour();
    fireEvent.click(await screen.findByRole("button", { name: "Show me" }));
    for (let i = 0; i < STEP_TITLES.length; i++) {
      await screen.findByText(STEP_TITLES[i]);
      const previews = Array.from(document.querySelectorAll("[aria-hidden='true']")).filter((el) =>
        el.querySelector("button, a[href], input, select, textarea, [tabindex]")
      );
      for (const preview of previews) {
        // aria-hidden hides the preview from screen readers; inert also takes its buttons out of
        // the tab order, so a keyboard user can't land on a control nobody announces.
        expect(preview.closest("[inert]")).not.toBeNull();
      }
      if (i < STEP_TITLES.length - 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
  });
});
