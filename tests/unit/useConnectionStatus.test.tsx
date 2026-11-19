import { act, renderHook } from "@testing-library/react";
import { useConnectionStatus, type OfficeHoursChannelStatus } from "@/hooks/useConnectionStatus";

type ChannelState = OfficeHoursChannelStatus["state"];

let mockChannelState: ChannelState = "joining";
let mockListeners: (() => void)[] = [];

function overallFor(state: ChannelState) {
  if (state === "joined") return "connected";
  return "disconnected";
}

const mockController = {
  isReady: false,
  getConnectionStatus: () => ({
    overall: overallFor(mockChannelState),
    channels: [{ name: "help_queues:5", state: mockChannelState, type: "help_queues" }],
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

function moveChannelTo(state: ChannelState) {
  act(() => {
    mockChannelState = state;
    mockListeners.forEach((listener) => listener());
  });
}

describe("useConnectionStatus connectionFailed", () => {
  beforeEach(() => {
    mockChannelState = "joining";
    mockListeners = [];
  });

  it("stays false while the channels make their first join", () => {
    const { result } = renderHook(() => useConnectionStatus());

    expect(result.current.connectionFailed).toBe(false);

    moveChannelTo("joined");

    expect(result.current.connectionFailed).toBe(false);
  });

  it("turns on when a channel errors and holds through a retry until the channel joins", () => {
    const { result } = renderHook(() => useConnectionStatus());

    moveChannelTo("errored");
    expect(result.current.connectionFailed).toBe(true);

    moveChannelTo("joining");
    expect(result.current.connectionFailed).toBe(true);

    moveChannelTo("joined");
    expect(result.current.connectionFailed).toBe(false);
  });

  it("turns on when a channel closes", () => {
    const { result } = renderHook(() => useConnectionStatus());

    moveChannelTo("closed");

    expect(result.current.connectionFailed).toBe(true);
  });
});
