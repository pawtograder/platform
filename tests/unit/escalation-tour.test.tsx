/**
 * "What's new" walkthrough for ticket escalation (components/help-queue/escalation-tour.tsx).
 *
 * - Staff only: students get neither the automatic prompt nor the header button.
 * - The prompt opens on its own the first time staff visit, and not again once dismissed, whether
 *   by Close (no tutorial) or by finishing the tour. The header button reopens it at the prompt.
 * - Show me walks through every step in order, and Back returns to the previous one.
 * - When storage is blocked the prompt stays closed instead of reopening on every page load.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EscalationTour } from "@/components/help-queue/escalation-tour";

let mockIsStaff = true;
jest.mock("@/hooks/useClassProfiles", () => ({ useIsGraderOrInstructor: () => mockIsStaff }));

const SEEN_KEY = "pawtograder:whats-new:oh-escalation:v1";
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
  mockIsStaff = true;
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe("EscalationTour", () => {
  it("renders nothing for students", () => {
    mockIsStaff = false;
    renderTour();
    expect(screen.queryByRole("button", { name: "What's new" })).toBeNull();
    expect(screen.queryByText(PROMPT)).toBeNull();
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
    expect(window.localStorage.getItem(SEEN_KEY)).toBe("seen");

    unmount();
    renderTour();
    expect(screen.getByRole("button", { name: "What's new" })).toBeInTheDocument();
    expect(screen.queryByText(PROMPT)).toBeNull();
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
    expect(window.localStorage.getItem(SEEN_KEY)).toBe("seen");
  });

  it("the first step's Back is disabled", async () => {
    renderTour();
    fireEvent.click(await screen.findByRole("button", { name: "Show me" }));
    expect(await screen.findByRole("button", { name: "Back" })).toBeDisabled();
  });

  it("What's new reopens the tour at the prompt after it was seen", async () => {
    window.localStorage.setItem(SEEN_KEY, "seen");
    renderTour();
    expect(screen.queryByText(PROMPT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(await screen.findByText(PROMPT)).toBeInTheDocument();
  });

  it("stays closed when storage is blocked, and What's new still opens it", async () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    renderTour();
    expect(screen.queryByText(PROMPT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(await screen.findByText(PROMPT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
  });

  it("stays closed when storage can be read but not written", async () => {
    // Storage full, or blocked for writes only: Close couldn't remember the dismissal, so an
    // automatic prompt would come back on every page load.
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    renderTour();
    // The prompt opens after mount, so wait as long as the first-visit test would.
    await expect(screen.findByText(PROMPT, undefined, { timeout: 500 })).rejects.toThrow();
    expect(screen.getByRole("button", { name: "What's new" })).toBeInTheDocument();
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
