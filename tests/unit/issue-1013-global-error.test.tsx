import { act, render, screen } from "@testing-library/react";
import GlobalError from "@/app/global-error";
import { isCutResponseError, reloadOnceReachable } from "@/lib/staleBundleRecovery";

const mockCapture = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (error: unknown) => mockCapture(error)
}));

let visibility: DocumentVisibilityState = "visible";
const mockFetch = jest.fn();

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

// Lets the same-origin check's promise settle.
const settle = () => act(async () => {});

beforeAll(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  global.fetch = mockFetch;
});

afterAll(() => {
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
});

beforeEach(() => {
  visibility = "visible";
  window.sessionStorage.clear();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true });
  mockCapture.mockClear();
});

describe("isCutResponseError", () => {
  it.each(["Connection closed.", "network error", "Load failed"])("knows %s", (message) => {
    expect(isCutResponseError(new TypeError(message))).toBe(true);
  });

  it.each(["An error occurred in the Server Components render.", "Failed to find Server Action", "reading 'map'"])(
    "leaves %s alone",
    (message) => {
      expect(isCutResponseError(new Error(message))).toBe(false);
    }
  );

  it("handles something that isn't an error", () => {
    expect(isCutResponseError(undefined)).toBe(false);
    expect(isCutResponseError("Load failed")).toBe(false);
  });
});

describe("reloadOnceReachable", () => {
  it("reloads once the server answers", async () => {
    const reload = jest.fn();
    const uninstall = reloadOnceReachable(reload);
    await settle();
    expect(mockFetch).toHaveBeenCalledWith("/favicon.ico", { method: "HEAD", cache: "no-store" });
    expect(reload).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it("keeps the page while the network is down, and the next show tries again", async () => {
    const reload = jest.fn();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const uninstall = reloadOnceReachable(reload);
    await settle();
    expect(reload).not.toHaveBeenCalled();

    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it("keeps the page when something else answers for the server, such as a proxy's 502", async () => {
    const reload = jest.fn();
    mockFetch.mockResolvedValueOnce({ ok: false });
    const uninstall = reloadOnceReachable(reload);
    await settle();
    expect(reload).not.toHaveBeenCalled();
    uninstall();
  });

  it("waits for a hidden tab to be shown", async () => {
    const reload = jest.fn();
    visibility = "hidden";
    const uninstall = reloadOnceReachable(reload);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    setVisibility("visible");
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it("doesn't loop on a page that keeps failing", async () => {
    const reload = jest.fn();
    // As after each reload: a new page, the same failure, the same tab's guard.
    for (let load = 0; load < 3; load++) {
      const uninstall = reloadOnceReachable(reload);
      await settle();
      uninstall();
    }
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stops listening once uninstalled", async () => {
    const reload = jest.fn();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const uninstall = reloadOnceReachable(reload);
    await settle();
    uninstall();
    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("GlobalError", () => {
  // jsdom can't reload, so the guard recoverFromStaleBundle writes first stands in for one.
  const reloaded = () => window.sessionStorage.getItem("pawtograder:stale-bundle-reloaded-at") !== null;

  // Quiet because this page has to render <html>, which a test's container can't hold, and jsdom
  // reports the reload it can't do.
  let quiet: jest.SpyInstance;
  beforeEach(() => {
    quiet = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    quiet.mockRestore();
  });

  const renderPage = (error: Error) => render(<GlobalError error={error} />);

  const staleBundleError = () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'call')");
    error.stack = "at a (app:///_next/static/chunks/webpack-x.js:1:526)";
    return error;
  };

  it.each([
    ["a cut response", new Error("Connection closed.")],
    ["a chunk that failed to load", Object.assign(new Error("Loading chunk 1 failed"), { name: "ChunkLoadError" })],
    ["a tree that names a module this bundle doesn't have", staleBundleError()]
  ])("checks the server, then reloads, after %s", async (_name, error) => {
    renderPage(error);
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(reloaded()).toBe(true);
    expect(mockCapture).toHaveBeenCalledWith(error);
  });

  it.each([
    ["a bug", new Error("Cannot read properties of null (reading 'map')")],
    [
      "a server render that threw",
      Object.assign(new Error("An error occurred in the Server Components render."), { digest: "1" })
    ]
  ])("keeps today's page after %s", async (_name, error) => {
    renderPage(error);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(reloaded()).toBe(false);
    expect(mockCapture).toHaveBeenCalledWith(error);
    expect(screen.getByRole("button", { name: "Try Again" })).toBeTruthy();
  });

  it("stops checking when the page goes away", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { unmount } = renderPage(new Error("Load failed"));
    await settle();
    unmount();
    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
