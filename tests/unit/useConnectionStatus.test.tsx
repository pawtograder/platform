import { act, renderHook } from "@testing-library/react";
import { useConnectionStatus, type OfficeHoursChannelStatus } from "@/hooks/useConnectionStatus";

type ChannelState = OfficeHoursChannelStatus["state"];

let mockChannelStates: ChannelState[] = ["joining"];
let mockListeners: (() => void)[] = [];

function overallFor(states: ChannelState[]) {
  const joined = states.filter((s) => s === "joined").length;
  if (states.length === 0) return "connecting";
  if (joined === states.length) return "connected";
  if (joined === 0) return "disconnected";
  return "partial";
}

const mockController = {
  isReady: false,
  getConnectionStatus: () => ({
    overall: overallFor(mockChannelStates),
    channels: mockChannelStates.map((state, i) => ({ name: `help_queue:${i}`, state, type: "help_queue" })),
    lastUpdate: new Date()
  }),
  officeHoursRealTimeController: {
    subscribeToStatus: (listener: () => void) => {
      mockListeners.push(listener);
      return () => {
        mockListeners = mockListeners.filter((l) => l !== listener);
      };
    }
  }
};

jest.mock("@/hooks/useOfficeHoursRealtime", () => ({
  useOfficeHoursController: () => mockController
}));

function moveChannelsTo(...states: ChannelState[]) {
  act(() => {
    mockChannelStates = states;
    mockListeners.forEach((listener) => listener());
  });
}

describe("useConnectionStatus connectionFailed", () => {
  beforeEach(() => {
    mockChannelStates = ["joining"];
    mockListeners = [];
  });

  it("stays false while the channels make their first join", () => {
    const { result } = renderHook(() => useConnectionStatus());

    expect(result.current.connectionFailed).toBe(false);

    moveChannelsTo("joined");

    expect(result.current.connectionFailed).toBe(false);
  });

  it("turns on when a channel errors and holds through a retry until the channel joins", () => {
    const { result } = renderHook(() => useConnectionStatus());

    moveChannelsTo("errored");
    expect(result.current.connectionFailed).toBe(true);

    moveChannelsTo("joining");
    expect(result.current.connectionFailed).toBe(true);

    moveChannelsTo("joined");
    expect(result.current.connectionFailed).toBe(false);
  });

  it("turns on when a channel closes", () => {
    const { result } = renderHook(() => useConnectionStatus());

    moveChannelsTo("closed");

    expect(result.current.connectionFailed).toBe(true);
  });

  it("stays on while one channel has failed and another has joined", () => {
    const { result } = renderHook(() => useConnectionStatus());

    moveChannelsTo("errored", "joined");

    expect(result.current.connectionFailed).toBe(true);
  });

  it("clears when no channels are left", () => {
    const { result } = renderHook(() => useConnectionStatus());

    moveChannelsTo("errored");
    expect(result.current.connectionFailed).toBe(true);

    moveChannelsTo();
    expect(result.current.connectionFailed).toBe(false);
  });
});
