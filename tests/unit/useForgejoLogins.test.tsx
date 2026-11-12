/**
 * useForgejoLogins (#1092): the roster's Forgejo usernames, refreshed while the roster is open so an
 * account created after enrollment shows up without a reload.
 */
import { act, renderHook, waitFor } from "@testing-library/react";

let rows: { user_id: string; login: string }[] = [];
let failNext = false;
let hangNext = false;
const queries = jest.fn();

// Each query resolves with the current `rows`, with an error when `failNext` is set, or never when `hangNext` is.
function query() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    not: () => chain,
    order: () => chain,
    range: () => {
      queries();
      if (hangNext) {
        hangNext = false;
        return new Promise(() => {});
      }
      if (failNext) {
        failNext = false;
        return Promise.resolve({ data: null, error: { message: "boom" } });
      }
      return Promise.resolve({ data: rows, error: null });
    }
  };
  return chain;
}
jest.mock("@/utils/supabase/client", () => ({ createClient: () => ({ from: () => query() }) }));

import { useForgejoLogins } from "@/hooks/useForgejoLogins";

beforeEach(() => {
  jest.useFakeTimers();
  rows = [{ user_id: "u1", login: "alex.kim" }];
  failNext = false;
  hangNext = false;
  queries.mockClear();
});
afterEach(() => jest.useRealTimers());

test("an account created after the roster opened appears on the next refresh, without a loading state", async () => {
  const { result } = renderHook(() => useForgejoLogins(true));
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.byUserId.get("u2")).toBeUndefined();

  rows = [...rows, { user_id: "u2", login: "taylor.brooks" }];
  act(() => {
    jest.advanceTimersByTime(30_000);
  });
  expect(result.current.loading).toBe(false);
  await waitFor(() => expect(result.current.byUserId.get("u2")).toBe("taylor.brooks"));
});

test("a refresh that finds nothing new keeps the same map, and one that fails keeps the last list", async () => {
  const { result } = renderHook(() => useForgejoLogins(true));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const first = result.current.byUserId;

  act(() => {
    jest.advanceTimersByTime(30_000);
  });
  await waitFor(() => expect(queries).toHaveBeenCalledTimes(2));
  expect(result.current.byUserId).toBe(first);

  failNext = true;
  act(() => {
    jest.advanceTimersByTime(30_000);
  });
  await waitFor(() => expect(queries).toHaveBeenCalledTimes(3));
  expect(result.current.error).toBeNull();
  expect(result.current.byUserId.get("u1")).toBe("alex.kim");
});

test("a first load that fails is reported", async () => {
  failNext = true;
  const { result } = renderHook(() => useForgejoLogins(true));
  await waitFor(() => expect(result.current.error).toBe("boom"));
  expect(result.current.loading).toBe(false);
});

test("a first lookup that a refresh overtakes still ends the loading state", async () => {
  hangNext = true;
  const { result } = renderHook(() => useForgejoLogins(true));
  expect(result.current.loading).toBe(true);
  act(() => {
    jest.advanceTimersByTime(30_000);
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.byUserId.get("u1")).toBe("alex.kim");
});
