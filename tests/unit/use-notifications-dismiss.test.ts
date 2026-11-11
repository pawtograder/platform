/**
 * #1249: `dismiss` puts a notification back only when the server says it still exists.
 *
 * Deletes and the existence check go through the app's real data provider, backed by a fake
 * Supabase client that answers each query from a script, so the errors have the same shapes
 * as in production (PostgREST errors, the provider's 404 and refused-write errors).
 */
import { act, renderHook } from "@testing-library/react";
import { toaster } from "@/components/ui/toaster";
import { createDataProvider } from "@/lib/refineDataProvider";
import { useNotifications } from "@/hooks/useNotifications";
import type { Notification } from "@/utils/supabase/DatabaseTypes";

type QueryResult = { data: unknown; error: unknown };

/** Results for the queries the provider will await, in order. */
let mockQueryResults: QueryResult[] = [];

function scriptedClient() {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "delete", "match", "eq", "limit"]) {
    builder[method] = () => builder;
  }
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
    const next = mockQueryResults.shift();
    if (!next) return Promise.reject(new Error("Unexpected query")).then(resolve, reject);
    return Promise.resolve(next).then(resolve, reject);
  };
  return { from: () => builder } as unknown as Parameters<typeof createDataProvider>[0];
}

const mockProvider = createDataProvider(scriptedClient());
const mockInvalidate = jest.fn();
const mockController = {
  courseId: 1,
  handleGenericDataEvent: jest.fn(),
  listGenericData: () => ({ unsubscribe: () => {}, data: [] }),
  getValueWithSubscription: () => ({ unsubscribe: () => {}, data: undefined })
};

jest.mock("@refinedev/core", () => ({
  ...jest.requireActual("@refinedev/core"),
  useUpdate: () => ({ mutateAsync: jest.fn() }),
  useDelete: () => ({
    mutateAsync: (params: Parameters<typeof mockProvider.deleteOne>[0]) => mockProvider.deleteOne(params)
  }),
  useDataProvider: () => () => mockProvider,
  useInvalidate: () => mockInvalidate
}));
jest.mock("@/hooks/useCourseController", () => ({ useCourseController: () => mockController }));
jest.mock("@/hooks/useClassProfiles", () => ({ useIsReadOnly: () => false }));
jest.mock("@/components/ui/toaster", () => ({ toaster: { error: jest.fn() } }));
jest.mock("@/components/notifications/notification-teaser", () => ({}));

const notification = { id: 7, class_id: 1, viewed_at: null } as unknown as Notification;
const ROW = { data: [{ id: 7 }], error: null };
const NO_ROWS = { data: [], error: null };
const NETWORK_ERROR = { data: null, error: { message: "TypeError: Failed to fetch", code: "" } };

function eventTypes() {
  return mockController.handleGenericDataEvent.mock.calls.map(([, event]) => event.type);
}

async function dismiss() {
  const { result } = renderHook(() => useNotifications());
  await act(() => result.current.dismiss(notification));
}

beforeEach(() => {
  mockQueryResults = [];
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
    expect(toaster.error).not.toHaveBeenCalled();
  });

  it("doesn't restore a notification the server deleted when the response was lost", async () => {
    // The delete request fails, then the existence check finds no row: the delete went through.
    mockQueryResults = [NETWORK_ERROR, NO_ROWS];

    await dismiss();

    expect(eventTypes()).toEqual(["deleted"]);
    expect(toaster.error).not.toHaveBeenCalled();
  });

  it("restores the notification and reports the failure when the row still exists", async () => {
    mockQueryResults = [NETWORK_ERROR, ROW];

    await dismiss();

    expect(eventTypes()).toEqual(["deleted", "created"]);
    expect(toaster.error).toHaveBeenCalledWith({
      title: "Failed to dismiss notification",
      description: "TypeError: Failed to fetch"
    });
  });

  it("leaves the outcome open and refetches the list when the check also fails", async () => {
    mockQueryResults = [NETWORK_ERROR, NETWORK_ERROR];

    await dismiss();

    expect(eventTypes()).toEqual(["deleted"]);
    expect(mockInvalidate).toHaveBeenCalledWith({ resource: "notifications", invalidates: ["list"] });
    expect(toaster.error).toHaveBeenCalledWith({
      title: "Couldn't confirm the notification was dismissed",
      description: "If it wasn't, it will come back when your notifications reload. TypeError: Failed to fetch"
    });
  });

  it("restores a refused delete without a second check", async () => {
    // Delete matches nothing, the provider's own follow-up select still sees the row: refused.
    mockQueryResults = [NO_ROWS, ROW];

    await dismiss();

    expect(eventTypes()).toEqual(["deleted", "created"]);
    expect(jest.mocked(toaster.error).mock.calls[0][0]).toMatchObject({ title: "Failed to dismiss notification" });
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});
