/**
 * #1249: `dismiss` puts a notification back only when the server says it still exists.
 *
 * Deletes go through the app's real data provider, and the existence check is a direct select on
 * the course controller's Supabase client. Both use a fake Supabase client that answers each query
 * from one script, so the errors have the same shapes as in production (PostgREST errors and the
 * provider's refused-write errors).
 */
import { createElement, type ReactNode } from "react";
import { Refine } from "@refinedev/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toaster } from "@/components/ui/toaster";
import { createDataProvider } from "@/lib/refineDataProvider";
import { useCourseNotificationsQuery } from "@/hooks/useCourseNotificationsQuery";
import { useNotifications } from "@/hooks/useNotifications";
import type { Notification } from "@/utils/supabase/DatabaseTypes";

/** A query's result, or `{ throws }` for a request that rejects instead of returning an error. */
type QueryResult = { data: unknown; error: unknown; count?: number } | { throws: Error };

/** Results for the queries the provider and the existence check will await, in order. */
let mockQueryResults: QueryResult[] = [];
/** Each query the controller's client built, as "table: method(args) ...". */
const mockControllerQueries: string[] = [];

function scriptedClient(log?: string[]) {
  return {
    from: (table: string) => {
      const calls: string[] = [];
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "delete", "match", "eq", "limit", "range", "order", "maybeSingle"]) {
        builder[method] = (...args: unknown[]) => {
          calls.push(`${method}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`);
          return builder;
        };
      }
      builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        log?.push(`${table}: ${calls.join(" ")}`);
        const next = mockQueryResults.shift();
        if (!next) return Promise.reject(new Error("Unexpected query")).then(resolve, reject);
        if ("throws" in next) return Promise.reject(next.throws).then(resolve, reject);
        return Promise.resolve(next).then(resolve, reject);
      };
      return builder;
    }
  } as unknown as Parameters<typeof createDataProvider>[0];
}

const mockProvider = createDataProvider(scriptedClient());
const mockInvalidate = jest.fn();
/** The controller's generic-data store for notifications, keyed by id. */
const mockStore = new Map<number, unknown>();
const mockController = {
  courseId: 1,
  client: scriptedClient(mockControllerQueries),
  registerGenericDataType: jest.fn(),
  setGeneric: jest.fn((_type: string, rows: { id: number }[]) => rows.forEach((row) => mockStore.set(row.id, row))),
  handleGenericDataEvent: jest.fn((_type: string, event: { type: string; payload: { id: number } }) => {
    if (event.type === "deleted") mockStore.delete(event.payload.id);
    else mockStore.set(event.payload.id, event.payload);
  }),
  listGenericData: () => ({ unsubscribe: () => {}, data: [] }),
  getValueWithSubscription: () => ({ unsubscribe: () => {}, data: undefined })
};

jest.mock("@refinedev/core", () => ({
  ...jest.requireActual("@refinedev/core"),
  useUpdate: () => ({ mutateAsync: jest.fn() }),
  useDelete: () => ({
    mutateAsync: (params: Parameters<typeof mockProvider.deleteOne>[0]) => mockProvider.deleteOne(params)
  }),
  useInvalidate: () => mockInvalidate
}));
jest.mock("@/hooks/useCourseController", () => ({ useCourseController: () => mockController }));
jest.mock("@/hooks/useClassProfiles", () => ({ useIsReadOnly: () => false }));
jest.mock("@/components/ui/toaster", () => ({ toaster: { error: jest.fn() } }));
jest.mock("@/components/notifications/notification-teaser", () => ({}));

const notification = { id: 7, class_id: 1, viewed_at: null } as unknown as Notification;
// Results for the data provider's queries, which read lists of rows.
const ROW = { data: [{ id: 7 }], error: null };
const NO_ROWS = { data: [], error: null };
// Results for the existence check, a `.maybeSingle()` select: one row, or null when there is none.
const STILL_THERE = { data: { id: 7 }, error: null };
const GONE = { data: null, error: null };
const NETWORK_ERROR = { data: null, error: { message: "TypeError: Failed to fetch", code: "" } };
const CHECK_QUERY = 'notifications: select("id") eq("id", 7) maybeSingle()';

function eventTypes() {
  return mockController.handleGenericDataEvent.mock.calls.map(([, event]) => event.type);
}

async function dismiss() {
  const { result } = renderHook(() => useNotifications());
  await act(() => result.current.dismiss(notification));
}

beforeEach(() => {
  mockQueryResults = [];
  mockControllerQueries.length = 0;
  mockStore.clear();
  mockController.handleGenericDataEvent.mockClear();
  mockInvalidate.mockClear();
  jest.mocked(toaster.error).mockClear();
});

afterEach(() => {
  // Every scripted query was used: no more and no fewer requests than the case expects.
  expect(mockQueryResults).toEqual([]);
});

describe("useNotifications dismiss", () => {
  it("removes the notification when the delete succeeds", async () => {
    mockQueryResults = [ROW];

    await dismiss();

    expect(eventTypes()).toEqual(["deleted"]);
    expect(mockControllerQueries).toEqual([]);
    expect(toaster.error).not.toHaveBeenCalled();
  });

  it("doesn't restore a notification the server deleted when the response was lost", async () => {
    // The delete request fails, then the existence check finds no row: the delete went through.
    mockQueryResults = [NETWORK_ERROR, GONE];

    await dismiss();

    expect(mockControllerQueries).toEqual([CHECK_QUERY]);
    expect(eventTypes()).toEqual(["deleted"]);
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(toaster.error).not.toHaveBeenCalled();
  });

  it("restores the notification and reports the failure when the row still exists", async () => {
    mockQueryResults = [NETWORK_ERROR, STILL_THERE];

    await dismiss();

    expect(mockControllerQueries).toEqual([CHECK_QUERY]);
    expect(eventTypes()).toEqual(["deleted", "created"]);
    expect(toaster.error).toHaveBeenCalledWith({
      title: "Failed to dismiss notification",
      description: "TypeError: Failed to fetch"
    });
  });

  it("leaves the outcome open and refetches the list when the check also fails", async () => {
    mockQueryResults = [NETWORK_ERROR, NETWORK_ERROR];

    await dismiss();

    expect(mockControllerQueries).toEqual([CHECK_QUERY]);
    expect(eventTypes()).toEqual(["deleted"]);
    expect(mockInvalidate).toHaveBeenCalledWith({ resource: "notifications", invalidates: ["list"] });
    expect(toaster.error).toHaveBeenCalledWith({
      title: "Couldn't confirm the notification was dismissed",
      description: "If it wasn't, it will come back when your notifications reload. TypeError: Failed to fetch"
    });
  });

  it("leaves the outcome open when the check request throws instead of returning an error", async () => {
    mockQueryResults = [NETWORK_ERROR, { throws: new Error("socket hang up") }];

    await dismiss();

    expect(mockControllerQueries).toEqual([CHECK_QUERY]);
    expect(eventTypes()).toEqual(["deleted"]);
    expect(mockInvalidate).toHaveBeenCalledWith({ resource: "notifications", invalidates: ["list"] });
    // The toast reports the delete's failure, not the check's.
    expect(toaster.error).toHaveBeenCalledWith({
      title: "Couldn't confirm the notification was dismissed",
      description: "If it wasn't, it will come back when your notifications reload. TypeError: Failed to fetch"
    });
  });

  it("restores a refused delete without a second check", async () => {
    // Delete matches nothing, the provider's own follow-up select still sees the row: refused.
    mockQueryResults = [NO_ROWS, ROW];

    await dismiss();

    expect(mockControllerQueries).toEqual([]);
    expect(eventTypes()).toEqual(["deleted", "created"]);
    expect(jest.mocked(toaster.error).mock.calls[0][0]).toMatchObject({ title: "Failed to dismiss notification" });
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});

describe("reconciling an unconfirmed dismiss", () => {
  const ROWS = { data: [{ id: 7, class_id: 1, user_id: "user-1", viewed_at: null }], count: 1, error: null };

  it("brings the notification back when the refetch returns the same rows", async () => {
    // Initial load, the failed delete, the failed check, then a refetch with identical rows.
    mockQueryResults = [ROWS, NETWORK_ERROR, NETWORK_ERROR, ROWS];
    const realUseInvalidate = jest.requireActual("@refinedev/core").useInvalidate;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Refine, { dataProvider: mockProvider, options: { disableTelemetry: true } }, children);

    const { result } = renderHook(
      () => {
        // The real query and the real invalidate, so the refetch goes through React Query.
        useCourseNotificationsQuery(
          mockController as unknown as Parameters<typeof useCourseNotificationsQuery>[0],
          "user-1",
          false
        );
        mockInvalidate.mockImplementation(realUseInvalidate());
        return useNotifications();
      },
      { wrapper }
    );
    await waitFor(() => expect(mockStore.has(7)).toBe(true));

    await act(() => result.current.dismiss(notification));
    expect(mockInvalidate).toHaveBeenCalledWith({ resource: "notifications", invalidates: ["list"] });

    // The refetch returns the same rows, so React Query keeps the same `data` reference.
    await waitFor(() => expect(mockQueryResults).toEqual([]));
    await waitFor(() => expect(mockStore.has(7)).toBe(true));
  });
});
