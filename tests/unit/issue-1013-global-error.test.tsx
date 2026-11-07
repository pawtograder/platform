import { act, render, screen } from "@testing-library/react";
import { Component, type ReactNode, useEffect } from "react";
import GlobalError from "@/app/global-error";
import { trackPendingWrite } from "@/lib/pendingWrites";
import { isCutResponseError, recoverFromStaleBundle, reloadOnceReachable } from "@/lib/staleBundleRecovery";

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
  const reload = jest.fn();
  let uninstall = () => {};

  beforeEach(() => {
    reload.mockClear();
  });

  // Here and not in each test, so a failed assertion doesn't leave a listener for the next one.
  afterEach(() => {
    uninstall();
  });

  it("reloads once the server answers for this document", async () => {
    uninstall = reloadOnceReachable(reload);
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(window.location.href, expect.objectContaining({ cache: "no-store" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stops the check at its headers, so the page isn't transferred", async () => {
    uninstall = reloadOnceReachable(reload);
    await settle();
    const { signal } = mockFetch.mock.calls[0][1] as { signal: AbortSignal };
    expect(signal.aborted).toBe(true);
  });

  describe("a write still on its way", () => {
    function pendingWrite() {
      let resolve = () => {};
      let reject: (error: Error) => void = () => {};
      const write = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      trackPendingWrite(write);
      return { resolve, reject };
    }

    it("sends no check and doesn't reload until it has settled", async () => {
      const write = pendingWrite();
      uninstall = reloadOnceReachable(reload);
      await settle();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();

      write.resolve();
      await settle();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("counts a failed write as settled", async () => {
      const write = pendingWrite();
      uninstall = reloadOnceReachable(reload);
      write.reject(new Error("Failed to fetch"));
      await settle();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("waits for every write, including one tracked during the wait", async () => {
      const first = pendingWrite();
      const second = pendingWrite();
      uninstall = reloadOnceReachable(reload);
      first.resolve();
      await settle();
      const third = pendingWrite();
      second.resolve();
      await settle();
      expect(mockFetch).not.toHaveBeenCalled();

      third.resolve();
      await settle();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("holds through shows, and sends one check when it settles", async () => {
      const write = pendingWrite();
      uninstall = reloadOnceReachable(reload);
      setVisibility("hidden");
      setVisibility("visible");
      setVisibility("hidden");
      setVisibility("visible");
      await settle();
      expect(mockFetch).not.toHaveBeenCalled();

      write.resolve();
      await settle();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("never checks if it was uninstalled during the wait", async () => {
      const write = pendingWrite();
      uninstall = reloadOnceReachable(reload);
      uninstall();
      write.resolve();
      await settle();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });

    it("waits for the next show if the tab was hidden when it settled", async () => {
      const write = pendingWrite();
      uninstall = reloadOnceReachable(reload);
      setVisibility("hidden");
      write.resolve();
      await settle();
      expect(mockFetch).not.toHaveBeenCalled();

      setVisibility("visible");
      await settle();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  describe("a check still out", () => {
    function checkOut() {
      let answer: (response: { ok: boolean }) => void = () => {};
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          })
      );
      return (response: { ok: boolean }) => answer(response);
    }

    it("doesn't reload if it was uninstalled before the answer", async () => {
      const answer = checkOut();
      uninstall = reloadOnceReachable(reload);
      await settle();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      uninstall();
      answer({ ok: true });
      await settle();
      expect(reload).not.toHaveBeenCalled();
      expect(window.sessionStorage.length).toBe(0);
    });

    it("doesn't reload if the tab was hidden before the answer, and the next show tries again", async () => {
      const answer = checkOut();
      uninstall = reloadOnceReachable(reload);
      await settle();

      setVisibility("hidden");
      answer({ ok: true });
      await settle();
      expect(reload).not.toHaveBeenCalled();
      expect(window.sessionStorage.length).toBe(0);

      setVisibility("visible");
      await settle();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("sends no second check for a show before the answer", async () => {
      const answer = checkOut();
      uninstall = reloadOnceReachable(reload);
      await settle();
      setVisibility("hidden");
      setVisibility("visible");
      await settle();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      answer({ ok: true });
      await settle();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the page while the network is down, and the next show tries again", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    uninstall = reloadOnceReachable(reload);
    await settle();
    expect(reload).not.toHaveBeenCalled();

    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the page when something else answers for the server, such as a proxy's 502", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    uninstall = reloadOnceReachable(reload);
    await settle();
    expect(reload).not.toHaveBeenCalled();
  });

  it("waits for a hidden tab to be shown", async () => {
    visibility = "hidden";
    uninstall = reloadOnceReachable(reload);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    setVisibility("visible");
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("doesn't loop on a page that keeps failing", async () => {
    // As after each reload: a new page, the same failure, the same tab's guard.
    for (let load = 0; load < 3; load++) {
      uninstall();
      uninstall = reloadOnceReachable(reload);
      await settle();
    }
    // One check: inside the 5 minutes there's no reload to check for, so the server isn't asked to render.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  describe("a page that fails slowly", () => {
    const PAGE_LOAD = 1_800_000_000_000;
    let now: jest.SpyInstance;

    beforeEach(() => {
      now = jest.spyOn(Date, "now").mockReturnValue(PAGE_LOAD);
    });
    afterEach(() => {
      now.mockRestore();
    });

    async function loadAt(msAfterFirst: number) {
      now.mockReturnValue(PAGE_LOAD + msAfterFirst);
      uninstall();
      uninstall = reloadOnceReachable(reload);
      await settle();
    }

    it("reloads once across three loads 60 s apart", async () => {
      await loadAt(0);
      await loadAt(60_000);
      await loadAt(120_000);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("keeps Try Again through a show inside the 5 minutes, and tries again after them", async () => {
      await loadAt(0);
      await loadAt(60_000);
      expect(reload).toHaveBeenCalledTimes(1);

      now.mockReturnValue(PAGE_LOAD + 5 * 60_000 - 1);
      setVisibility("hidden");
      setVisibility("visible");
      await settle();
      expect(reload).toHaveBeenCalledTimes(1);

      now.mockReturnValue(PAGE_LOAD + 5 * 60_000);
      setVisibility("hidden");
      setVisibility("visible");
      await settle();
      expect(reload).toHaveBeenCalledTimes(2);
    });

    it("leaves recoverFromStaleBundle's own 30 s alone", () => {
      expect(recoverFromStaleBundle(reload)).toBe(true);
      now.mockReturnValue(PAGE_LOAD + 29_999);
      expect(recoverFromStaleBundle(reload)).toBe(false);
      now.mockReturnValue(PAGE_LOAD + 30_000);
      expect(recoverFromStaleBundle(reload)).toBe(true);
      expect(reload).toHaveBeenCalledTimes(2);
    });
  });

  it("doesn't reload when it can't record the reload, because the next page would never see it", async () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    try {
      uninstall = reloadOnceReachable(reload);
      await settle();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it("stops listening once uninstalled", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    uninstall = reloadOnceReachable(reload);
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
  // jsdom can't reload, so the guard reloadOnceReachable writes first stands in for one.
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

  // The order this rests on: the page's passive cleanup runs before the error page's mount effect in the
  // same commit, so the wait sees what the cleanup tracked. In the same order in Next's own copy of React.
  it("waits for a write the page tracks as it unmounts, in the commit that mounts this page", async () => {
    class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
      state = { error: null };
      static getDerivedStateFromError(error: Error) {
        return { error };
      }
      render() {
        return this.state.error ? <GlobalError error={this.state.error} /> : this.props.children;
      }
    }
    let settleWrite = () => {};
    const write = new Promise<void>((resolve) => {
      settleWrite = resolve;
    });
    function SurveyPage({ crash }: { crash: boolean }) {
      useEffect(() => () => trackPendingWrite(write), []);
      if (crash) throw new Error("Connection closed.");
      return null;
    }
    const { rerender } = render(
      <Boundary>
        <SurveyPage crash={false} />
      </Boundary>
    );
    rerender(
      <Boundary>
        <SurveyPage crash={true} />
      </Boundary>
    );
    await settle();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(reloaded()).toBe(false);

    settleWrite();
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(reloaded()).toBe(true);
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
