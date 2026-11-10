/**
 * Without a Sentry DSN a report can't be sent, so every report entry point falls back to the
 * GitHub issue link it had before the report dialog. Each entry point is checked both ways,
 * plus server rendering and hydration of the availability hook.
 */
import { ChakraProvider, defaultSystem, Menu } from "@chakra-ui/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

let mockDsn: object | undefined;
let mockHasClient = true;
jest.mock("@sentry/nextjs", () => ({
  getClient: () => (mockHasClient ? { getDsn: () => mockDsn, on: () => () => {} } : undefined),
  captureException: () => "e".repeat(32),
  captureMessage: () => "m".repeat(32)
}));

const mockOpenReportDialog = jest.fn();
jest.mock("@/components/bugReport/BugReportProvider", () => ({
  useBugReport: () => ({ openReportDialog: mockOpenReportDialog })
}));
jest.mock("@/lib/bugReport/reportDialog", () => ({
  openReportDialog: (o: unknown) => {
    mockOpenReportDialog(o);
    return true;
  }
}));

import GlobalError from "@/app/global-error";
import { SyncReportIssuesLink } from "@/app/course/[course_id]/manage/assignments/[assignment_id]/repositories/SyncReportIssuesLink";
import { ReportBugButton } from "@/components/bugReport/ReportBugButton";
import { ReportBugMenuItem } from "@/components/bugReport/ReportBugMenuItem";
import { toaster } from "@/components/ui/toaster";
import { bugReportingAvailable, GITHUB_BUG_REPORT_URL, useBugReportingAvailable } from "@/lib/bugReport/availability";

const STUB_DSN = "http://e2epublickey@127.0.0.1:54399/1";
const originalDsnEnv = process.env.NEXT_PUBLIC_SENTRY_DSN;

function setAvailable(available: boolean) {
  mockHasClient = true;
  mockDsn = available ? { host: "sentry.test" } : undefined;
}

const withChakra = (ui: React.ReactNode) => <ChakraProvider value={defaultSystem}>{ui}</ChakraProvider>;

beforeEach(() => {
  mockOpenReportDialog.mockReset();
  toaster.remove();
});

afterEach(() => {
  if (originalDsnEnv === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  else process.env.NEXT_PUBLIC_SENTRY_DSN = originalDsnEnv;
});

describe("bugReportingAvailable", () => {
  it("is true with a browser client that has a DSN", () => {
    setAvailable(true);
    expect(bugReportingAvailable()).toBe(true);
  });

  it("is false when the client has no DSN", () => {
    setAvailable(false);
    expect(bugReportingAvailable()).toBe(false);
  });

  it("is false when Sentry never started", () => {
    mockHasClient = false;
    expect(bugReportingAvailable()).toBe(false);
  });
});

describe("useBugReportingAvailable on the server and during hydration", () => {
  function Probe() {
    return <span data-testid="probe">{useBugReportingAvailable() ? "form" : "github"}</span>;
  }

  it.each([
    [STUB_DSN, "form"],
    [undefined, "github"],
    ["not a dsn", "github"]
  ])("server-renders from the build's DSN (%s)", (dsn, expected) => {
    if (dsn === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    else process.env.NEXT_PUBLIC_SENTRY_DSN = dsn;
    expect(renderToString(<Probe />)).toContain(`>${expected}<`);
  });

  /** Server-renders `ui`, then hydrates it with the browser client's DSN set to `clientHasDsn`. */
  async function hydrate(ui: React.ReactElement, clientHasDsn: boolean) {
    const container = document.createElement("div");
    // jsdom has a window, so a component that reads the client during render would see it on
    // the "server" too. Give the server pass the opposite answer so the control below mismatches.
    setAvailable(!clientHasDsn);
    container.innerHTML = renderToString(ui);
    document.body.appendChild(container);
    setAvailable(clientHasDsn);
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const recoverable = jest.fn();
    const root = await act(async () => hydrateRoot(container, ui, { onRecoverableError: recoverable }));
    const text = container.textContent;
    // RTL 16 wraps react-dom/test-utils act on React 18.3, which logs a deprecation notice.
    const problems = [
      ...errors.mock.calls.filter((args) => !String(args[0]).includes("ReactDOMTestUtils.act")),
      ...recoverable.mock.calls
    ];
    errors.mockRestore();
    act(() => root.unmount());
    container.remove();
    return { text, problems };
  }

  it.each([
    [STUB_DSN, true, "form"],
    [undefined, false, "github"],
    // The build has a DSN but the browser SDK has none: the server markup hydrates cleanly,
    // then the entry point switches to the fallback.
    [STUB_DSN, false, "github"],
    [undefined, true, "form"]
  ])("hydrates without a mismatch (build DSN %s, browser client DSN %s)", async (dsn, clientHasDsn, expected) => {
    if (dsn === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    else process.env.NEXT_PUBLIC_SENTRY_DSN = dsn;
    const { text, problems } = await hydrate(<Probe />, clientHasDsn);
    expect(text).toBe(expected);
    expect(problems).toEqual([]);
  });

  it("(control) the harness catches a render that reads the client directly", async () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    function Unsafe() {
      return <span>{bugReportingAvailable() ? "form" : "github"}</span>;
    }
    const { problems } = await hydrate(<Unsafe />, true);
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe("UserMenu 'Report a bug'", () => {
  function renderMenu() {
    render(
      withChakra(
        <Menu.Root open>
          <Menu.Content>
            <ReportBugMenuItem />
          </Menu.Content>
        </Menu.Root>
      )
    );
    return screen.getByRole("menuitem", { name: "Report a bug" });
  }
  // Selecting an item closes the menu on a later tick; let that settle inside act.
  async function selectItem(item: HTMLElement) {
    await act(async () => {
      fireEvent.click(item);
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("opens the report dialog when reports can be sent", async () => {
    setAvailable(true);
    const item = renderMenu();
    expect(item.querySelector("a")).toBeNull();
    await selectItem(item);
    expect(mockOpenReportDialog).toHaveBeenCalledTimes(1);
  });

  it("links to a new GitHub issue when they can't", async () => {
    setAvailable(false);
    const item = renderMenu();
    const link = item.querySelector("a");
    expect(link).toHaveAttribute("href", GITHUB_BUG_REPORT_URL);
    expect(link).toHaveAttribute("target", "_blank");
    await selectItem(item);
    expect(mockOpenReportDialog).not.toHaveBeenCalled();
  });
});

describe("repositories page Sync notice", () => {
  it("opens the report dialog when reports can be sent", () => {
    setAvailable(true);
    render(withChakra(<SyncReportIssuesLink />));
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "report any issues" }));
    expect(mockOpenReportDialog).toHaveBeenCalledTimes(1);
  });

  it("links to GitHub when they can't", () => {
    setAvailable(false);
    const { container } = render(withChakra(<SyncReportIssuesLink />));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: "on GitHub" })).toHaveAttribute("href", GITHUB_BUG_REPORT_URL);
    expect(container.textContent).toBe("report any issues on GitHub");
  });
});

describe("/error page 'Report a bug' button", () => {
  it("opens the report dialog when reports can be sent", () => {
    setAvailable(true);
    render(withChakra(<ReportBugButton />));
    fireEvent.click(screen.getByRole("button", { name: "Report a bug" }));
    expect(mockOpenReportDialog).toHaveBeenCalledWith({ eventId: undefined });
  });

  it("links to a new GitHub issue when they can't", () => {
    setAvailable(false);
    render(withChakra(<ReportBugButton />));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: "Report a bug" })).toHaveAttribute("href", GITHUB_BUG_REPORT_URL);
  });
});

describe("global error page", () => {
  // GlobalError renders its own <html>; mounting it in a div is fine for these checks, but
  // React warns about the nesting, so console.error is silenced here.
  let errors: jest.SpyInstance;
  beforeEach(() => {
    errors = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errors.mockRestore());
  const renderGlobalError = () => render(<GlobalError error={new Error("boom")} />);

  it("shows the report form when reports can be sent", () => {
    setAvailable(true);
    renderGlobalError();
    expect(screen.getByTestId("global-error-report-form")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "report it on our issue tracker" })).toBeNull();
  });

  it("shows the GitHub link with the error ID when they can't", () => {
    setAvailable(false);
    renderGlobalError();
    expect(screen.queryByTestId("global-error-report-form")).toBeNull();
    expect(screen.getByRole("link", { name: "report it on our issue tracker" })).toHaveAttribute(
      "href",
      GITHUB_BUG_REPORT_URL
    );
    expect(document.body.textContent).toContain(`include the error ID: ${"e".repeat(32)}`);
  });
});

describe("error toasts", () => {
  type ToastAction = { label: string };
  const actionOf = (id: string) =>
    (toaster.getVisibleToasts() as { id: string; action?: ToastAction }[]).find((t) => t.id === id)?.action;

  it("get a 'Report this' action when reports can be sent", () => {
    setAvailable(true);
    const id = toaster.error({ title: "Could not save" }) as unknown as string;
    expect(actionOf(id)?.label).toBe("Report this");
  });

  it("get no action when they can't", () => {
    setAvailable(false);
    const id = toaster.error({ title: "Could not save" }) as unknown as string;
    const viaCreate = toaster.create({ type: "error", title: "Could not load" }) as unknown as string;
    expect(actionOf(id)).toBeUndefined();
    expect(actionOf(viaCreate)).toBeUndefined();
  });
});
