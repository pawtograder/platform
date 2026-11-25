/**
 * The generic What's New component (components/whats-new/whats-new.tsx) with several walkthroughs
 * registered. tests/unit/escalation-tour.test.tsx covers the dialog itself with the one real entry.
 *
 * - Only entries for this page, this viewer's audience and an enabled course feature show.
 * - The first unseen entry opens on its own; after it is dismissed, the next one waits for the
 *   next page load.
 * - An entry past its showUntil date no longer opens on its own.
 * - The header button opens the newest matching entry, even one already seen or past its date.
 * - Every seen record is read in one query.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WhatsNewEntry } from "@/lib/whatsNew/define";

let mockIsStaff = true;
let mockFeatures: { name: string; enabled: boolean }[] = [];
jest.mock("@/hooks/useClassProfiles", () => ({
  useIsGraderOrInstructor: () => mockIsStaff,
  useIsStudent: () => !mockIsStaff
}));
jest.mock("@/hooks/useCourseController", () => ({ useCourse: () => ({ features: mockFeatures }) }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

let mockEntries: WhatsNewEntry[] = [];
jest.mock("@/lib/whatsNew/registry", () => ({
  get WHATS_NEW_ENTRIES() {
    return mockEntries;
  }
}));

const mockSeen = new Set<string>();
const mockReads: string[][] = [];
const mockUpsert = jest.fn();
jest.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        in: async (_column: string, items: string[]) => {
          mockReads.push(items);
          return { data: items.filter((item) => mockSeen.has(item)).map((item) => ({ item })), error: null };
        }
      }),
      upsert: mockUpsert
    })
  })
}));

// Imported after the mocks so it picks up the mocked registry.
import { resetWhatsNewForTests, WhatsNew } from "@/components/whats-new/whats-new";

function entry(id: string, overrides: Partial<WhatsNewEntry> = {}): WhatsNewEntry {
  return {
    id: id as WhatsNewEntry["id"],
    page: "office-hours",
    audience: "staff",
    showUntil: "2999-12-31",
    title: `Title ${id}`,
    intro: <p>Intro {id}</p>,
    steps: [{ title: `Step of ${id}`, body: <p>Body {id}</p> }],
    ...overrides
  };
}

function renderWhatsNew() {
  return render(
    <ChakraProvider value={defaultSystem}>
      <WhatsNew page="office-hours" />
    </ChakraProvider>
  );
}

const stayClosed = (text: string) => expect(screen.findByText(text, undefined, { timeout: 500 })).rejects.toThrow();

beforeEach(() => {
  resetWhatsNewForTests();
  mockIsStaff = true;
  mockFeatures = [];
  mockEntries = [];
  mockSeen.clear();
  mockReads.length = 0;
  mockUpsert.mockReset().mockImplementation(async (row: { item: string }) => {
    mockSeen.add(row.item);
    return { error: null };
  });
});

describe("WhatsNew with several walkthroughs", () => {
  it("opens the first unseen one, reading every record in one query", async () => {
    mockEntries = [entry("a:v1"), entry("b:v1"), entry("c:v1")];
    mockSeen.add("a:v1");
    renderWhatsNew();
    expect(await screen.findByText("Title b:v1")).toBeInTheDocument();
    expect(mockReads).toEqual([["a:v1", "b:v1", "c:v1"]]);
  });

  it("opens the next one on the next page load, not right after the first is closed", async () => {
    mockEntries = [entry("a:v1"), entry("b:v1")];
    const { unmount } = renderWhatsNew();
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("Title a:v1")).toBeNull());
    await stayClosed("Title b:v1");
    expect(mockUpsert).toHaveBeenCalledWith({ item: "a:v1" }, { onConflict: "user_id,item", ignoreDuplicates: true });

    unmount();
    renderWhatsNew();
    expect(await screen.findByText("Title b:v1")).toBeInTheDocument();
  });

  it("shows only entries for this page, this audience and an enabled feature", async () => {
    mockEntries = [
      entry("students:v1", { audience: "students" }),
      entry("flagged:v1", { feature: "office-hours-queue-health" }),
      entry("staff:v1")
    ];
    renderWhatsNew();
    expect(await screen.findByText("Title staff:v1")).toBeInTheDocument();
    expect(mockReads).toEqual([["staff:v1"]]);
  });

  it("shows a flagged entry once the course turns the feature on", async () => {
    mockFeatures = [{ name: "office-hours-queue-health", enabled: true }];
    mockEntries = [entry("flagged:v1", { feature: "office-hours-queue-health" })];
    renderWhatsNew();
    expect(await screen.findByText("Title flagged:v1")).toBeInTheDocument();
  });

  it("shows an 'everyone' entry to students", async () => {
    mockIsStaff = false;
    mockEntries = [entry("all:v1", { audience: "everyone" }), entry("staff:v1")];
    renderWhatsNew();
    expect(await screen.findByText("Title all:v1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("Title all:v1")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(await screen.findByText("Title all:v1")).toBeInTheDocument();
  });

  it("renders nothing when no entry matches", () => {
    mockEntries = [entry("students:v1", { audience: "students" })];
    renderWhatsNew();
    expect(screen.queryByRole("button", { name: "What's new" })).toBeNull();
    expect(mockReads).toEqual([]);
  });

  it("doesn't open an entry past its showUntil date, but the button still opens it", async () => {
    mockEntries = [entry("old:v1", { showUntil: "2000-01-01" })];
    renderWhatsNew();
    await stayClosed("Title old:v1");
    expect(mockReads).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(await screen.findByText("Title old:v1")).toBeInTheDocument();
  });

  it("the header button opens the newest entry, even when an older one is unseen", async () => {
    mockEntries = [entry("a:v1"), entry("b:v1")];
    mockSeen.add("b:v1");
    renderWhatsNew();
    expect(await screen.findByText("Title a:v1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("Title a:v1")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(await screen.findByText("Title b:v1")).toBeInTheDocument();
  });
});
