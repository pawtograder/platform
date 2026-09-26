/**
 * Id batching for the stats-update function's PostgREST reads.
 *
 * On 2026-09-07 the hourly run logged:
 *
 *   [discord-discussion-stats-update] Error fetching authors:
 *     { message: "URI too long\nrequest_id: 4896813a..." }
 *   [discord-discussion-stats-update] Processing batch of 280 Discord messages
 *   [discord-discussion-stats-update] Completed: 780 processed, 0 updated,
 *     779 skipped (unchanged), 0 errors
 *
 * Two things were wrong. The author lookup put every author id in the batch into
 * one `.in()` filter; that filter is serialized into the query string, so its
 * size is bounded by the HTTP URL limit and not by `max_rows`. A batch of 280
 * profile UUIDs is ~10 KB of query string, past the ~8 KB a proxy accepts, so the
 * request died before Postgres saw it. And because the failure only produced a
 * `console.error` and fell through to the "Anonymous" fallback, the very next
 * summary line still claimed `0 errors`.
 *
 * The chunk size therefore comes from a byte budget rather than from a row count.
 * Do not raise it to "the batch size" — that is precisely the conflation that
 * produced the failure above.
 *
 * This module deliberately has no imports: the Jest suite in `tests/unit` can then
 * exercise it directly, since the Node tsconfig rejects the `.ts` import
 * specifiers that the Deno entrypoint uses.
 */

/**
 * Max author UUIDs per `.in()` filter.
 *
 * The byte accounting behind this number is written up in
 * `supabase/functions/cli/utils/pagingLimits.ts`, which arrived at the same bound of
 * 50 for its own UUID lists: a UUID plus its separator costs 37 bytes, so 50 of them
 * is ~1.9 KB of query string, comfortably inside the ~4 KB that module budgets for a
 * request line. The constant is duplicated here rather than imported because that
 * module belongs to the `cli` edge function, and a function importing another
 * function's internals would be the only such import in the codebase; shared code
 * lives in `_shared/`. If a third caller ever needs this bound, that is the moment to
 * promote it to `_shared/pagingLimits.ts` and collapse the duplication.
 */
export const AUTHOR_ID_IN_BATCH_SIZE = 50;

/**
 * Split `ids` into chunks of at most `size`, so each `.in()` filter stays inside a URL budget.
 *
 * The guard demands a positive INTEGER, not merely a positive number, because the two ways to fail
 * that check are both silent. `NaN` slips past `size <= 0` (every comparison with NaN is false) and
 * then `i += NaN` ends the loop on its first pass, yielding `[[]]` — one empty chunk. The caller
 * would issue a single `.in("id", [])`, get no rows, record no names AND no failures, and every
 * author would fall through to the "Anonymous" fallback while the summary reported `0 errors`:
 * exactly the defect this module was written to fix. `Infinity` passes the same check and produces
 * one unbounded chunk, which reinstates the URI-too-long failure instead. Neither is reachable from
 * the two call sites today (both pass module constants), but a silent wrong answer from a pure
 * helper is worth one comparison to rule out.
 */
export function chunkIds<T>(ids: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunkIds requires a positive integer chunk size, got ${size}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

/** One `profiles` row as this function reads it. */
export interface AuthorRow {
  id: string;
  name: string | null;
}

export interface AuthorLookupResult {
  /** Author id -> display name, for every chunk that came back. */
  names: Map<string, string>;
  /** Number of chunks whose request failed. */
  failedChunks: number;
  /**
   * Author ids we could not resolve because their chunk failed. Distinct from an id
   * that simply has no `profiles` row: a missing row is legitimately "Anonymous",
   * whereas an id in here has an unknown name, and rendering it as "Anonymous"
   * would write a wrong author into Discord and persist it via `last_synced_stats`.
   */
  failedAuthorIds: Set<string>;
  /** Error messages, one per failed chunk, for logging and Sentry. */
  errors: string[];
}

/**
 * Fetch author display names one bounded chunk at a time.
 *
 * A failed chunk is recorded and the remaining chunks still run: the author name is
 * cosmetic decoration on an embed, and aborting would throw away the enqueued
 * updates for every other batch in an hourly cron run. The caller is responsible
 * for turning `failedChunks` / `failedAuthorIds` into a non-zero error tally —
 * see `countUnresolvedAuthorMessages`.
 */
export async function fetchAuthorNamesInChunks(
  authorIds: readonly string[],
  chunkSize: number,
  // PromiseLike, not Promise: a PostgREST filter builder is thenable but is not a
  // Promise, so requiring Promise here would reject the call site outright.
  fetchChunk: (chunk: string[]) => PromiseLike<{ data: AuthorRow[] | null; error: { message: string } | null }>
): Promise<AuthorLookupResult> {
  const result: AuthorLookupResult = {
    names: new Map<string, string>(),
    failedChunks: 0,
    failedAuthorIds: new Set<string>(),
    errors: []
  };

  for (const chunk of chunkIds(authorIds, chunkSize)) {
    let data: AuthorRow[] | null = null;
    let error: { message: string } | null = null;
    try {
      const response = await fetchChunk(chunk);
      data = response.data;
      error = response.error;
    } catch (err) {
      // A thrown error (fetch failure, abort) is the same outcome as a returned one:
      // this chunk's names are unknown. It must not escape and kill the other chunks.
      error = { message: err instanceof Error ? err.message : String(err) };
    }

    if (error) {
      result.failedChunks++;
      result.errors.push(error.message);
      for (const id of chunk) result.failedAuthorIds.add(id);
      continue;
    }

    for (const author of data ?? []) {
      result.names.set(author.id, author.name || "Anonymous");
    }
  }

  return result;
}

/**
 * How many messages are affected by a failed author chunk.
 *
 * This is what makes the summary honest. It counts per affected message rather
 * than per failed chunk, so the `N errors` in the completion line is the number of
 * Discord messages this run declined to update — the quantity a human or a monitor
 * reading that line actually cares about. It is deliberately conservative: a
 * message is counted whenever its author is unresolved, even if it would have been
 * skipped for another reason, because under-reporting is the bug being fixed.
 */
export function countUnresolvedAuthorMessages(
  messageAuthorIds: Iterable<string | null | undefined>,
  failedAuthorIds: ReadonlySet<string>
): number {
  if (failedAuthorIds.size === 0) return 0;
  let count = 0;
  for (const authorId of messageAuthorIds) {
    if (authorId && failedAuthorIds.has(authorId)) count++;
  }
  return count;
}
