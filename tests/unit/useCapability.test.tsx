/**
 * useCapability (#1010, step 3): one shared fetch per class page, false while loading, and a
 * filtered, debounced re-ask on staff channel notes.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const rpc = jest.fn();
const subscribers: { table: string; callback: (message: Record<string, unknown>) => void }[] = [];
const statusListeners: ((status: { channels: { name: string; state: string }[] }) => void)[] = [];
let isReadOnly = false;

jest.mock("@/app/actions", () => ({ signOutAction: jest.fn() }));
jest.mock("@/utils/supabase/client", () => ({ createClient: () => ({ rpc }) }));
jest.mock("@/hooks/useAuthState", () => ({ __esModule: true, default: () => ({ user: { id: "me" } }) }));
// One controller object, like the real context value, so effects keyed on it don't re-run every render.
const courseController = {
  courseId: 7,
  classRealTimeController: {
    subscribeToTable: (table: string, callback: (message: Record<string, unknown>) => void) => {
      subscribers.push({ table, callback });
      return () => {};
    },
    subscribeToStatus: (callback: (status: { channels: { name: string; state: string }[] }) => void) => {
      statusListeners.push(callback);
      return () => {};
    }
  }
};
jest.mock("@/hooks/useCourseController", () => ({ useCourseController: () => courseController }));
jest.mock("@/hooks/useClassProfiles", () => ({
  ...jest.requireActual("@/hooks/useClassProfiles"),
  useClassProfiles: () => ({ isReadOnly })
}));

import { CAPABILITY_REFRESH_DEBOUNCE_MS, ClassCapabilitiesProvider } from "@/hooks/useClassCapabilities";
import { ClassCapabilitiesContext, useCapability } from "@/hooks/useClassProfiles";

function respondWith(capabilities: string[]) {
  rpc.mockReturnValue({
    eq: () => Promise.resolve({ data: capabilities.map((capability) => ({ class_id: 7, capability })), error: null })
  });
}

function staffChannel(state: string) {
  for (const listener of statusListeners) listener({ channels: [{ name: "class:7:staff", state }] });
}

function sendNote(table: string, data: Record<string, unknown> = {}) {
  for (const subscriber of subscribers.filter((s) => s.table === table)) {
    subscriber.callback({ type: "table_change", table, data, class_id: 7 });
  }
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <ClassCapabilitiesProvider>{children}</ClassCapabilitiesProvider>
);

beforeEach(() => {
  jest.useFakeTimers();
  rpc.mockReset();
  subscribers.length = 0;
  statusListeners.length = 0;
  isReadOnly = false;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useCapability", () => {
  it("is false while loading, then true once the viewer holds the capability", async () => {
    let resolve: (value: unknown) => void = () => {};
    rpc.mockReturnValue({ eq: () => new Promise((r) => (resolve = r)) });
    const { result } = renderHook(() => useCapability("publish_groups"), { wrapper });
    expect(result.current).toBe(false);

    await act(async () => resolve({ data: [{ class_id: 7, capability: "publish_groups" }], error: null }));
    expect(result.current).toBe(true);
  });

  it("is false without the provider, and for a capability the viewer doesn't hold", () => {
    expect(renderHook(() => useCapability("publish_groups")).result.current).toBe(false);
    const loaded = ({ children }: { children: ReactNode }) => (
      <ClassCapabilitiesContext.Provider value={{ capabilities: new Set(["publish_groups"]), isLoading: false }}>
        {children}
      </ClassCapabilitiesContext.Provider>
    );
    expect(renderHook(() => useCapability("manage_roles"), { wrapper: loaded }).result.current).toBe(false);
  });

  it("is false while viewing as a student, even for a capability the viewer holds", async () => {
    respondWith(["publish_groups"]);
    const { result, rerender } = renderHook(() => useCapability("publish_groups"), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));

    isReadOnly = true;
    rerender();
    expect(result.current).toBe(false);
  });

  it("shares one fetch between every caller on the page", async () => {
    respondWith(["publish_groups"]);
    const { result } = renderHook(() => [useCapability("publish_groups"), useCapability("manage_roles")], {
      wrapper
    });
    await waitFor(() => expect(result.current).toEqual([true, false]));
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("re-asks on a note about the viewer's own role or a role's capabilities", async () => {
    respondWith(["publish_groups"]);
    const { result } = renderHook(() => useCapability("manage_review_assignments"), { wrapper });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    respondWith(["publish_groups", "manage_review_assignments"]);
    act(() => sendNote("user_roles", { user_id: "me" }));
    await act(async () => jest.advanceTimersByTime(CAPABILITY_REFRESH_DEBOUNCE_MS));
    await waitFor(() => expect(result.current).toBe(true));
    expect(rpc).toHaveBeenCalledTimes(2);

    act(() => sendNote("role_capabilities", { role_id: 3 }));
    await act(async () => jest.advanceTimersByTime(CAPABILITY_REFRESH_DEBOUNCE_MS));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
  });

  it("ignores notes about other people's roles", async () => {
    respondWith([]);
    renderHook(() => useCapability("publish_groups"), { wrapper });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    act(() => {
      for (let i = 0; i < 200; i++) sendNote("user_roles", { user_id: `student-${i}` });
    });
    await act(async () => jest.advanceTimersByTime(CAPABILITY_REFRESH_DEBOUNCE_MS * 2));
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("turns a burst of relevant notes into one re-ask", async () => {
    respondWith([]);
    renderHook(() => useCapability("publish_groups"), { wrapper });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    act(() => {
      sendNote("role_capabilities", { role_id: 3 });
      sendNote("role_capabilities", { role_id: 4 });
      sendNote("user_roles", { user_id: "me" });
    });
    await act(async () => jest.advanceTimersByTime(CAPABILITY_REFRESH_DEBOUNCE_MS / 2));
    act(() => sendNote("role_capabilities", { role_id: 5 }));
    await act(async () => jest.advanceTimersByTime(CAPABILITY_REFRESH_DEBOUNCE_MS));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    await act(async () => jest.advanceTimersByTime(CAPABILITY_REFRESH_DEBOUNCE_MS * 2));
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("catches up when the staff channel joins or rejoins, since missed notes aren't replayed", async () => {
    respondWith([]);
    renderHook(() => useCapability("publish_groups"), { wrapper });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    act(() => staffChannel("joined"));
    await act(async () => jest.advanceTimersByTime(CAPABILITY_REFRESH_DEBOUNCE_MS));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));

    act(() => staffChannel("joined"));
    await act(async () => jest.advanceTimersByTime(CAPABILITY_REFRESH_DEBOUNCE_MS));
    // Staying joined is not a rejoin.
    expect(rpc).toHaveBeenCalledTimes(2);

    act(() => staffChannel("closed"));
    act(() => staffChannel("joined"));
    await act(async () => jest.advanceTimersByTime(CAPABILITY_REFRESH_DEBOUNCE_MS));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
  });

  it("retries a failed first load", async () => {
    rpc.mockReturnValueOnce({ eq: () => Promise.resolve({ data: null, error: new Error("503") }) }).mockReturnValue({
      eq: () => Promise.resolve({ data: [{ class_id: 7, capability: "publish_groups" }], error: null })
    });
    const { result } = renderHook(() => useCapability("publish_groups"), { wrapper });
    expect(result.current).toBe(false);
    await act(async () => jest.advanceTimersByTime(250));
    await waitFor(() => expect(result.current).toBe(true));
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
