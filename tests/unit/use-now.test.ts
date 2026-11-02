import { act, renderHook } from "@testing-library/react";
import { NOW_TICK_MS, useNow } from "@/hooks/useNow";
import { REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS, useRefreshWhenShown } from "@/hooks/useRefreshWhenShown";

const mockRouter = { refresh: jest.fn() };
jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter
}));

const PAGE_LOAD = new Date("2026-11-01T23:30:00Z").getTime();

let visibility: DocumentVisibilityState = "visible";

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeAll(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterAll(() => {
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
});

beforeEach(() => {
  visibility = "visible";
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

  it("leaves no timer running after unmount", () => {
    const { unmount } = renderHook(() => useNow(PAGE_LOAD));
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("useRefreshWhenShown", () => {
  it("does not refresh a tab shown again within a minute of loading", () => {
    renderHook(() => useRefreshWhenShown());

    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS - 1);
    });
    setVisibility("visible");

    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });

  it("refreshes when shown a minute or more after the last fetch, at most once a minute", () => {
    renderHook(() => useRefreshWhenShown());

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

  it("never refreshes on hide, or on the interval alone", () => {
    renderHook(() => useRefreshWhenShown());

    act(() => {
      jest.advanceTimersByTime(10 * 60_000);
    });
    setVisibility("hidden");

    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });

  it("stops listening after unmount", () => {
    const { unmount } = renderHook(() => useRefreshWhenShown());
    unmount();

    setVisibility("hidden");
    act(() => {
      jest.advanceTimersByTime(2 * REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS);
    });
    setVisibility("visible");

    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });
});
