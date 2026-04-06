import React from "react";
import { render, renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LeaderProvider, useLeaderContext } from "@/lib/cross-tab/LeaderProvider";
import { TabLeaderElection } from "@/lib/cross-tab/TabLeaderElection";
import { setupMockBroadcastChannel, resetAllChannels } from "@/tests/mocks/MockBroadcastChannel";

// ---------------------------------------------------------------------------
// BroadcastChannel mock (jsdom has no native support)
// ---------------------------------------------------------------------------

beforeAll(() => {
  setupMockBroadcastChannel();
});

afterEach(() => {
  resetAllChannels();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false }
    }
  });
}

function createWrapper() {
  const queryClient = createQueryClient();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <LeaderProvider>{children}</LeaderProvider>
      </QueryClientProvider>
    );
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LeaderProvider", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Provides context values
  // -------------------------------------------------------------------------
  it("provides leader, diffChannel, tabId, and isLeader via context", () => {
    const captured: ReturnType<typeof useLeaderContext>[] = [];

    function Consumer() {
      const ctx = useLeaderContext();
      captured.push(ctx);
      return null;
    }

    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <LeaderProvider>
          <Consumer />
        </LeaderProvider>
      </QueryClientProvider>
    );

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const ctx = captured[captured.length - 1];
    expect(ctx).toHaveProperty("isLeader");
    expect(ctx).toHaveProperty("leader");
    expect(ctx).toHaveProperty("diffChannel");
    expect(ctx).toHaveProperty("tabId");
    expect(ctx.leader).not.toBeNull();
    expect(ctx.diffChannel).not.toBeNull();
    expect(typeof ctx.tabId).toBe("string");
  });

  // -------------------------------------------------------------------------
  // 2. isLeader eventually becomes true (single tab)
  // -------------------------------------------------------------------------
  it("isLeader becomes true after election timeout for a single tab", () => {
    const { result } = renderHook(() => useLeaderContext(), {
      wrapper: createWrapper()
    });

    expect(result.current.isLeader).toBe(false);

    // The initial claim timeout is 1 second in TabLeaderElection
    act(() => {
      jest.advanceTimersByTime(1_000);
    });

    expect(result.current.isLeader).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. tabId is non-empty
  // -------------------------------------------------------------------------
  it("tabId is a non-empty string", () => {
    const { result } = renderHook(() => useLeaderContext(), {
      wrapper: createWrapper()
    });

    expect(result.current.tabId).toBeTruthy();
    expect(typeof result.current.tabId).toBe("string");
    expect(result.current.tabId.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 4. Leader and diffChannel are non-null after mount
  // -------------------------------------------------------------------------
  it("leader and diffChannel are non-null after mount", () => {
    const { result } = renderHook(() => useLeaderContext(), {
      wrapper: createWrapper()
    });

    expect(result.current.leader).toBeInstanceOf(TabLeaderElection);
    expect(result.current.diffChannel).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 5. Cleanup on unmount calls close()
  // -------------------------------------------------------------------------
  it("calls leader.close() on unmount", () => {
    const closeSpy = jest.spyOn(TabLeaderElection.prototype, "close");

    const queryClient = createQueryClient();
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <LeaderProvider>
          <div />
        </LeaderProvider>
      </QueryClientProvider>
    );

    expect(closeSpy).not.toHaveBeenCalled();

    unmount();

    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 6. Default context values outside provider
  // -------------------------------------------------------------------------
  it("returns default context values when used outside LeaderProvider", () => {
    const queryClient = createQueryClient();
    const { result } = renderHook(() => useLeaderContext(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      )
    });

    expect(result.current.isLeader).toBe(false);
    expect(result.current.leader).toBeNull();
    expect(result.current.diffChannel).toBeNull();
    expect(result.current.tabId).toBe("");
  });
});
