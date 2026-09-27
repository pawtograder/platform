/**
 * Row and id-list ceilings for PostgREST reads.
 *
 * Two different limits, easy to conflate:
 *
 *   - `PAGE_SIZE` bounds how many rows come back. PostgREST caps every response
 *     at `max_rows` (1000, see supabase/config.toml) and does so silently, so an
 *     unpaged select returns a truncated page that looks complete.
 *   - `UUID_IN_BATCH_SIZE` bounds how many ids go *out*. An `.in()` filter is
 *     serialized into the query string, so its length is capped by the HTTP URL
 *     limit rather than by `max_rows`. A UUID costs 37 bytes once the separator
 *     is counted, so 500 of them is ~18 KB — past the ~8 KB a proxy typically
 *     accepts, and the request fails before Postgres sees it. Numeric ids cost
 *     ~8 bytes, so batching those at `PAGE_SIZE` stays around 4 KB and is fine.
 *
 * No imports here, so the constants can be asserted from the Jest suite; the
 * Node tsconfig rejects the `.ts` import specifiers the Deno modules use.
 */

/** Rows fetched per request. Must not exceed the API's max_rows. */
export const PAGE_SIZE = 1000;

/** Max ids per `.in()` filter when the ids are UUIDs. */
export const UUID_IN_BATCH_SIZE = 50;

/** Bytes an `.in()` filter costs in the query string, separators included. */
export function estimateInFilterBytes(idCount: number, idLength: number): number {
  if (idCount <= 0) return 0;
  // `col=in.(` + ids + separators + `)`
  return "col=in.()".length + idCount * idLength + (idCount - 1);
}
