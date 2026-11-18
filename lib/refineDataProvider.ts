import type {
  BaseRecord,
  DataProvider,
  DeleteOneParams,
  DeleteOneResponse,
  GetOneParams,
  GetOneResponse,
  UpdateParams,
  UpdateResponse
} from "@refinedev/core";
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
 * its loading/empty branch. List endpoints are left alone — they already
 * return `[]` for "nothing visible", which is a legitimate result.
 *
 * `update` has the same hole, with worse consequences. Upstream `update` runs
 * `.update(...).select()` and returns `(data || [])[0]`. When RLS refuses the
 * write (e.g. a grader saving Edit Assignment, where only instructors may
 * UPDATE `assignments`), PostgREST matches **0 rows** and answers `200 []` —
 * no error. Refine then reports success and the page shows "Assignment
 * Updated" for a save that never happened (pawtograder/platform#983, #1125).
 * So a missing row after `update` is thrown as a 403: the write was refused,
 * and every edit page's existing `onError` path shows it.
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
    },
    update: async <TData extends BaseRecord = BaseRecord, TVariables = object>(
      params: UpdateParams<TVariables>
    ): Promise<UpdateResponse<TData>> => {
      const response = await base.update<TData, TVariables>(params);
      if (response?.data === undefined || response?.data === null) {
        throw refusedWriteError("update", params.resource, params.id);
      }
      return response;
    }
  };
}

/** Error for a write that RLS silently refused (0 rows affected, no PostgREST error). */
function refusedWriteError(action: "update" | "delete", resource: string, id: unknown) {
  // Shaped like a refine HttpError so mutation `onError` handlers see a status.
  return Object.assign(
    new Error(
      `You don't have permission to ${action} this ${resource} record (id ${String(id)}), or it no longer exists. Nothing was changed.`
    ),
    { statusCode: 403, refusedWrite: true as const }
  );
}

/**
 * True when `error` is the error this provider throws for a refine `update` or
 * `deleteOne` that RLS refused (0 rows changed, no PostgREST error).
 *
 * Use it to tell a refusal apart from other failures, e.g. to show a
 * permission message instead of a generic one. A PostgREST error, such as an
 * RLS violation on insert (42501), is not one of these refusals and returns
 * false.
 */
export function isRefusedWriteError(error: unknown): error is Error & { statusCode: 403; refusedWrite: true } {
  return error instanceof Error && (error as { refusedWrite?: unknown }).refusedWrite === true;
}

/**
 * True when `error` is the 404 this provider's `getOne` throws because the row
 * is not visible to the current session: deleted, or hidden from it by RLS.
 * Any other `getOne` failure (network, PostgREST error) returns false.
 */
export function isMissingRowError(error: unknown): error is Error & { statusCode: 404 } {
  return error instanceof Error && (error as { statusCode?: unknown }).statusCode === 404;
}

type PostgrestResult = PromiseLike<{
  data: unknown[] | null;
  error: { message: string; code: string } | null;
}>;

/** A filtered PostgREST query: `.eq()` or `.match()` on a delete or select builder. */
type FilterBuilder<T> = {
  match: (filter: Record<string, unknown>) => T;
  eq: (column: string, value: unknown) => T;
};

/** Minimal slice of the Supabase client that `withBlockedDeleteErrors` uses. */
type DeleteClient = {
  schema?: (schema: string) => DeleteClient;
  from: (resource: string) => {
    delete: () => FilterBuilder<{ select: (columns: string) => PostgrestResult }>;
    select: (columns: string) => FilterBuilder<{ limit: (count: number) => PostgrestResult }>;
  };
};

/** Same shape upstream's handleError produces for PostgREST errors. */
function postgrestError(error: { message: string; code: string }) {
  return Object.assign(new Error(error.message), { ...error, statusCode: Number.parseInt(error.code) });
}

/**
 * Replaces `deleteOne` so that RLS refusing a delete is reported as an error,
 * while deleting a row that is already gone still succeeds.
 *
 * Upstream `deleteOne` runs `.delete()` **without** `.select()`, so PostgREST
 * returns no rows whether the delete worked or was refused — `data` is always
 * empty and the "row missing" check used for `update` can't tell them apart.
 * Here the delete asks for the deleted ids back (`.select(idColumn)`). A real
 * delete returns the row and resolves exactly like upstream did.
 *
 * When nothing comes back, the row was either refused by RLS or already gone
 * (a second tab, a double click, a realtime race). Both look the same from the
 * delete, so a follow-up select checks whether the row is still visible:
 *
 * - **Still visible:** the session can read the row but was not allowed to
 *   delete it. Thrown as a 403 (`isRefusedWriteError`).
 * - **Not visible:** the row is gone, or the session can't see it at all.
 *   Resolves as a success, which is what upstream always did. A delete that
 *   RLS refused ends up here only on tables whose SELECT policy is no wider
 *   than their DELETE policy (e.g. `notifications`), where the user could not
 *   have seen the row to begin with.
 */
export function withBlockedDeleteErrors(base: DataProvider, client: DeleteClient): DataProvider {
  return {
    ...base,
    deleteOne: async <TData extends BaseRecord = BaseRecord, TVariables = object>(
      params: DeleteOneParams<TVariables>
    ): Promise<DeleteOneResponse<TData>> => {
      const { resource, id, meta } = params;
      const scoped = meta?.schema && client.schema ? client.schema(meta.schema) : client;
      const idColumn: string = meta?.idColumnName ?? "id";
      const filter = <T>(builder: FilterBuilder<T>): T =>
        meta?.idColumnName ? builder.eq(idColumn, id) : builder.match({ id });

      const { data, error } = await filter(scoped.from(resource).delete()).select(idColumn);
      if (error) {
        throw postgrestError(error);
      }
      if (data && data.length > 0) {
        return { data: data[0] as TData };
      }

      // Nothing deleted: refused, or already gone? Only a row we can still see was refused.
      const { data: remaining, error: selectError } = await filter(scoped.from(resource).select(idColumn)).limit(1);
      if (selectError) {
        throw postgrestError(selectError);
      }
      if (remaining && remaining.length > 0) {
        throw refusedWriteError("delete", resource, id);
      }
      return { data: { [idColumn]: id } as unknown as TData };
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

/** The app's refine data provider: Supabase, plus the missing-row / refused-write fixes above. */
export function createDataProvider(client: Parameters<typeof supabaseDataProvider>[0]): DataProvider {
  return withBlockedDeleteErrors(withMissingRowErrors(supabaseDataProvider(client)), client as unknown as DeleteClient);
}
