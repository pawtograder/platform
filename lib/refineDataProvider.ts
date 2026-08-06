import type { BaseRecord, DataProvider, GetOneParams, GetOneResponse } from "@refinedev/core";
import { dataProvider as supabaseDataProvider } from "@refinedev/supabase";

/**
 * The `@refinedev/supabase` data provider, with `getOne` fixed to report a
 * missing row as an error instead of as a successful empty response.
 *
 * Upstream implements `getOne` as an ordinary filtered select and returns
 * `{ data: (data || [])[0] }` — no `.single()`, no error when nothing matches
 * (see `getOne` in @refinedev/supabase). So when the row is gone, or is simply
 * no longer *visible* to this session under RLS, PostgREST answers `200 []` and
 * React Query is handed a **defined** response object whose `data` is
 * `undefined`.
 *
 * `useOne`'s type says `data: TData` (never undefined), so callers reasonably
 * write `result?.data.name`: the optional chain guards the *response*, not the
 * row. `result` is defined, `result.data` is not, and the render throws
 * `TypeError: Cannot read properties of undefined (reading 'name')`.
 *
 * That is the crash reported from long-idle tabs: while the tab sat in the
 * background its stored Supabase session was replaced by another tab's (a
 * different user signed in), so on reconnect the refetch of the *rendered*
 * user's profile came back `200 []` under the new session's RLS and the course
 * layout's UserMenu crashed for every route in the course.
 *
 * Failing the query turns that into the state every consumer already handles:
 * `data` stays `undefined`, `?.` short-circuits, and the component falls back to
 * its loading/empty branch. Only `getOne` is wrapped — list endpoints already
 * return `[]` for "nothing visible", which is a legitimate result.
 */
export function withMissingRowErrors(base: DataProvider): DataProvider {
  return {
    ...base,
    getOne: async <TData extends BaseRecord = BaseRecord>(params: GetOneParams): Promise<GetOneResponse<TData>> => {
      const response = await base.getOne<TData>(params);
      if (response?.data === undefined || response?.data === null) {
        // Shaped like a refine HttpError so `useOne`'s `error` carries a status.
        throw Object.assign(
          new Error(`No ${params.resource} record with id ${String(params.id)} is visible to the current session.`),
          { statusCode: 404 }
        );
      }
      return response;
    }
  };
}

/** React Query's own default: three retries before the error surfaces. */
const DEFAULT_QUERY_RETRIES = 3;

/**
 * React Query retry policy that skips retries for the 404 above.
 *
 * A missing or invisible row is deterministic — refetching it three times over
 * several seconds of backoff produces the same `200 []`, and until the retries
 * are exhausted `useOne` stays in its loading state instead of showing the
 * not-found/empty branch. Everything else keeps the default retry behaviour.
 */
export function retryUnlessMissingRow(failureCount: number, error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  if (statusCode === 404) return false;
  return failureCount < DEFAULT_QUERY_RETRIES;
}

/** The app's refine data provider: Supabase, plus the `getOne` fix above. */
export function createDataProvider(client: Parameters<typeof supabaseDataProvider>[0]): DataProvider {
  return withMissingRowErrors(supabaseDataProvider(client));
}
