import { act, renderHook } from "@testing-library/react";
import { NOW_TICK_MS, useNow } from "@/hooks/useNow";
import { REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS, useRefreshWhenShown } from "@/hooks/useRefreshWhenShown";

const mockRouter = { refresh: jest.fn() };
jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter
}));

const PAGE_LOAD = new Date("2026-11-01T23:30:00Z").getTime();

let visibility: DocumentVisibilityState = "visible";
let online = true;

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function setOnline(next: boolean) {
  online = next;
  act(() => {
    window.dispatchEvent(new Event(next ? "online" : "offline"));
  });
}

beforeAll(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
});

afterAll(() => {
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
  delete (navigator as { onLine?: boolean }).onLine;
});

beforeEach(() => {
  visibility = "visible";
  online = true;
  mockRouter.refresh.mockClear();
  jest.useFakeTimers({ now: PAGE_LOAD });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useNow", () => {
  it("renders the server's time first, then the browser clock once mounted", () => {
    const serverRenderedAt = PAGE_LOAD - 90_000;
    const rendered: number[] = [];
    const { result } = renderHook(() => {
      const now = useNow(serverRenderedAt);
      rendered.push(now);
      return now;
    });

    expect(rendered[0]).toBe(serverRenderedAt);
    expect(result.current).toBe(PAGE_LOAD);
  });

  it("re-reads the clock every 30 s while the tab is visible", () => {
    const { result } = renderHook(() => useNow(PAGE_LOAD));

    act(() => {
      jest.advanceTimersByTime(NOW_TICK_MS - 1);
    });
    expect(result.current).toBe(PAGE_LOAD);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe(PAGE_LOAD + NOW_TICK_MS);
  });

  it("does not tick while hidden, and reads the clock as soon as the tab is shown", () => {
    const { result } = renderHook(() => useNow(PAGE_LOAD));

    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(5 * 60_000);
    });
    expect(result.current).toBe(PAGE_LOAD);

    setVisibility("visible");
    expect(result.current).toBe(PAGE_LOAD + 5 * 60_000);

    act(() => {
      jest.advanceTimersByTime(NOW_TICK_MS);
    });
    expect(result.current).toBe(PAGE_LOAD + 5 * 60_000 + NOW_TICK_MS);
  });

  it("keeps the browser clock when a refresh brings a server time that is behind it", () => {
    const { result, rerender } = renderHook(({ t }) => useNow(t), { initialProps: { t: PAGE_LOAD } });

    act(() => {
      jest.advanceTimersByTime(NOW_TICK_MS);
    });
    expect(result.current).toBe(PAGE_LOAD + NOW_TICK_MS);

    // router.refresh() renders the component again with the new payload's server time.
    rerender({ t: PAGE_LOAD - 60_000 });
    expect(result.current).toBe(PAGE_LOAD + NOW_TICK_MS);
  });

  it("leaves no timer running after unmount", () => {
    const { unmount } = renderHook(() => useNow(PAGE_LOAD));
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("useRefreshWhenShown", () => {
  it("does not refresh a tab shown again within a minute of loading", () => {
    renderHook(() => useRefreshWhenShown(PAGE_LOAD));

    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS - 1);
    });
    setVisibility("visible");

    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });

  it("refreshes when shown a minute or more after the last fetch, at most once a minute", () => {
    renderHook(() => useRefreshWhenShown(PAGE_LOAD));

    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS);
    });
    setVisibility("visible");
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);

    // Flicking between tabs 30 s later does not refetch.
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    setVisibility("hidden");
    setVisibility("visible");
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);

    // A minute after the refresh it may refetch again.
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    setVisibility("hidden");
    setVisibility("visible");
    expect(mockRouter.refresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes once when a dashboard rendered 10 minutes ago is shown again, even right after it mounts", () => {
    // Back restores the dashboard from the router cache whatever its age, so the data on screen
    // can be much older than the component.
    renderHook(() => useRefreshWhenShown(PAGE_LOAD - 10 * 60_000));

    setVisibility("hidden");
    setVisibility("visible");
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);

    // The refresh restarts the throttle.
    setVisibility("hidden");
    setVisibility("visible");
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);
  });

  it("throttles a dashboard rendered 30 s ago until a minute after it was rendered", () => {
    renderHook(() => useRefreshWhenShown(PAGE_LOAD - 30_000));

    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS - 30_000 - 1);
    });
    setVisibility("visible");
    expect(mockRouter.refresh).not.toHaveBeenCalled();

    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(1);
    });
    setVisibility("visible");
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);
  });

  it("restarts the minute when a new payload arrives", () => {
    const { rerender } = renderHook(({ renderedAt }) => useRefreshWhenShown(renderedAt), {
      initialProps: { renderedAt: PAGE_LOAD }
    });

    // Something else refreshed the page 50 s after load.
    act(() => {
      jest.advanceTimersByTime(50_000);
    });
    rerender({ renderedAt: PAGE_LOAD + 50_000 });

    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(20_000);
    });
    setVisibility("visible");
    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });

  it("costs at most one extra refresh when the browser clock is 10 minutes ahead of the server", () => {
    const skew = 10 * 60_000;
    const { rerender } = renderHook(({ renderedAt }) => useRefreshWhenShown(renderedAt), {
      initialProps: { renderedAt: PAGE_LOAD - skew }
    });

    // At mount this looks like a page rendered 10 minutes ago, so the first show refreshes.
    setVisibility("hidden");
    setVisibility("visible");
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);

    // The refresh's payload arrives a second later with the server's time, still 10 minutes behind.
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    rerender({ renderedAt: Date.now() - skew });
    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    setVisibility("visible");
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes a minute after mount when the server clock is 10 minutes ahead of the browser", () => {
    renderHook(() => useRefreshWhenShown(PAGE_LOAD + 10 * 60_000));

    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS);
    });
    setVisibility("visible");
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);
  });

  it("never refreshes on hide, or on the interval alone", () => {
    renderHook(() => useRefreshWhenShown(PAGE_LOAD));

    act(() => {
      jest.advanceTimersByTime(10 * 60_000);
    });
    setVisibility("hidden");

    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });

  it("skips the refresh while offline, and catches up once when the network returns", () => {
    renderHook(() => useRefreshWhenShown(PAGE_LOAD));

    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS);
    });
    setOnline(false);
    setVisibility("visible");
    expect(mockRouter.refresh).not.toHaveBeenCalled();

    setOnline(true);
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);
  });

  it("waits for the tab to be shown when the network returns while it is hidden", () => {
    renderHook(() => useRefreshWhenShown(PAGE_LOAD));

    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS);
    });
    setOnline(false);
    setOnline(true);
    expect(mockRouter.refresh).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);
  });

  it("doesn't refresh when the network returns inside the minute", () => {
    renderHook(() => useRefreshWhenShown(PAGE_LOAD));

    setOnline(false);
    setOnline(true);

    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });

  it("doesn't refresh a tab that stayed visible when the network drops and returns", () => {
    renderHook(() => useRefreshWhenShown(PAGE_LOAD));

    act(() => {
      jest.advanceTimersByTime(2 * REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS);
    });
    setOnline(false);
    setOnline(true);

    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });

  it("stops listening after unmount", () => {
    const { unmount } = renderHook(() => useRefreshWhenShown(PAGE_LOAD));

    // A refresh is skipped first, so a leaked `online` listener would have something to catch up on.
    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(2 * REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS);
    });
    setOnline(false);
    setVisibility("visible");
    unmount();

    setOnline(true);
    setVisibility("hidden");
    setVisibility("visible");

    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });
});
