/**
 * Id batching and error accounting for the Discord discussion stats update.
 *
 * Both of these are regression tests for the same production run on 2026-09-07:
 *
 *   Error fetching authors: { message: "URI too long\nrequest_id: 4896813a..." }
 *   Processing batch of 280 Discord messages
 *   Completed: 780 processed, 0 updated, 779 skipped (unchanged), 0 errors
 *
 * The author lookup put a whole 500-row batch's author UUIDs into one `.in()`
 * filter, which is bounded by URL length rather than by `max_rows`, so the request
 * failed before Postgres saw it. And the failure only produced a console line, so
 * the summary on the next line still said `0 errors` — a partial failure that
 * looked like a clean run to anyone (or anything) reading it.
 */

import {
  AUTHOR_ID_IN_BATCH_SIZE,
  chunkIds,
  countUnresolvedAuthorMessages,
  fetchAuthorNamesInChunks,
  type AuthorRow
} from "@/supabase/functions/discord-discussion-stats-update/idBatching";
// The byte accounting is shared with the CLI's paging limits, so the bound is pinned
// against the same estimator the CLI's own test uses. This is a test-only import; the
// edge function itself does not reach into another function's code.
import { estimateInFilterBytes } from "@/supabase/functions/cli/utils/pagingLimits";

/** Conservative ceiling: proxies commonly cap a request line + headers at 8 KB. */
const SAFE_URL_BUDGET_BYTES = 4096;
const UUID_LENGTH = 36;
/** The numeric-id chunk size the function uses for threads and topics. */
const NUMERIC_ID_IN_BATCH_SIZE = 200;
/** A bigint id in a large deployment, e.g. 9 digits. */
const NUMERIC_ID_LENGTH = 9;

function uuids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
}

describe("chunkIds", () => {
  it("keeps every chunk inside the URL budget for the batch that failed in production", () => {
    // 280 is the batch size in the logged failure; 500 is the function's page size,
    // which is what the unchunked query actually serialized.
    for (const batchSize of [280, 500]) {
      const chunks = chunkIds(uuids(batchSize), AUTHOR_ID_IN_BATCH_SIZE);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(estimateInFilterBytes(chunk.length, UUID_LENGTH)).toBeLessThan(SAFE_URL_BUDGET_BYTES);
      }
    }
  });

  it("shows the unchunked batch of 280 UUIDs was over the budget", () => {
    // This is the failure itself: ~10 KB of query string in one `.in()` filter.
    expect(estimateInFilterBytes(280, UUID_LENGTH)).toBeGreaterThan(8192);
  });

  it("bounds numeric id chunks independently of the batch size", () => {
    // The thread and topic lookups were not the production failure and were not over
    // any limit: 500 nine-digit ids is ~5 KB, well inside the ~8 KB a proxy accepts,
    // and pagingLimits.ts documents numeric lists at 1000 ids per filter as fine.
    // They are chunked so the URI no longer depends on batchSize staying at 500.
    expect(estimateInFilterBytes(500, NUMERIC_ID_LENGTH)).toBeLessThan(8192);
    expect(estimateInFilterBytes(NUMERIC_ID_IN_BATCH_SIZE, NUMERIC_ID_LENGTH)).toBeLessThan(SAFE_URL_BUDGET_BYTES);
  });

  it("preserves every id exactly once, in order", () => {
    const ids = uuids(283);
    expect(chunkIds(ids, AUTHOR_ID_IN_BATCH_SIZE).flat()).toEqual(ids);
  });

  it("returns no chunks for an empty list", () => {
    expect(chunkIds([], AUTHOR_ID_IN_BATCH_SIZE)).toEqual([]);
  });

  it("rejects a non-positive chunk size rather than looping forever", () => {
    expect(() => chunkIds(uuids(3), 0)).toThrow(/positive integer chunk size/);
    expect(() => chunkIds(uuids(3), -1)).toThrow(/positive integer chunk size/);
  });

  // NaN and Infinity both slip past a bare `size <= 0`, and each fails SILENTLY in a
  // different direction: NaN yields one empty chunk (no names, no recorded failures, so
  // every author silently becomes "Anonymous" and the run still claims 0 errors), while
  // Infinity yields one unbounded chunk, which is the URI-too-long bug again. A fractional
  // size produces boundaries that no longer correspond to the byte budget the number was
  // derived from.
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction", 2.5]
  ])("rejects %s, which would otherwise fail silently", (_label, size) => {
    expect(() => chunkIds(uuids(3), size as number)).toThrow(/positive integer chunk size/);
  });
});

describe("fetchAuthorNamesInChunks", () => {
  it("issues one bounded request per chunk and merges the names", async () => {
    const ids = uuids(280);
    const seen: string[][] = [];
    const result = await fetchAuthorNamesInChunks(ids, AUTHOR_ID_IN_BATCH_SIZE, (chunk) => {
      seen.push(chunk);
      return Promise.resolve({
        data: chunk.map((id) => ({ id, name: `name-${id.slice(-3)}` })) as AuthorRow[],
        error: null
      });
    });

    expect(seen.length).toBe(Math.ceil(280 / AUTHOR_ID_IN_BATCH_SIZE));
    for (const chunk of seen) expect(chunk.length).toBeLessThanOrEqual(AUTHOR_ID_IN_BATCH_SIZE);
    expect(result.names.size).toBe(280);
    expect(result.failedChunks).toBe(0);
    expect(result.failedAuthorIds.size).toBe(0);
  });

  it("counts a failed chunk and still fetches the rest", async () => {
    const ids = uuids(280);
    const result = await fetchAuthorNamesInChunks(ids, AUTHOR_ID_IN_BATCH_SIZE, (chunk) =>
      Promise.resolve(
        chunk.includes(ids[0])
          ? { data: null, error: { message: "URI too long\nrequest_id: 4896813a\n" } }
          : { data: chunk.map((id) => ({ id, name: "Someone" })) as AuthorRow[], error: null }
      )
    );

    expect(result.failedChunks).toBe(1);
    expect(result.errors[0]).toContain("URI too long");
    // The failed chunk's ids are unresolved, not "Anonymous".
    expect(result.failedAuthorIds.has(ids[0])).toBe(true);
    expect(result.names.has(ids[0])).toBe(false);
    // The other chunks still landed.
    expect(result.names.size).toBe(280 - AUTHOR_ID_IN_BATCH_SIZE);
  });

  it("treats a thrown request as a failed chunk instead of aborting the run", async () => {
    const ids = uuids(120);
    const result = await fetchAuthorNamesInChunks(ids, AUTHOR_ID_IN_BATCH_SIZE, (chunk) => {
      if (chunk.includes(ids[0])) return Promise.reject(new Error("network unreachable"));
      return Promise.resolve({ data: chunk.map((id) => ({ id, name: "Someone" })) as AuthorRow[], error: null });
    });

    expect(result.failedChunks).toBe(1);
    expect(result.errors[0]).toBe("network unreachable");
    expect(result.names.size).toBe(120 - AUTHOR_ID_IN_BATCH_SIZE);
  });

  it("maps a profile with no name to Anonymous, which is different from unresolved", async () => {
    const ids = uuids(2);
    const result = await fetchAuthorNamesInChunks(ids, AUTHOR_ID_IN_BATCH_SIZE, (chunk) =>
      Promise.resolve({ data: [{ id: chunk[0], name: null }], error: null })
    );

    expect(result.names.get(ids[0])).toBe("Anonymous");
    // The second id simply has no row; that is a legitimate miss, not a failure.
    expect(result.failedChunks).toBe(0);
    expect(result.failedAuthorIds.size).toBe(0);
  });
});

describe("countUnresolvedAuthorMessages", () => {
  it("makes a failed author chunk show up in the summary instead of 0 errors", async () => {
    // Reproduces the shape of the production run: a batch of 280 messages, the author
    // lookup fails, and the summary must not be able to claim zero errors.
    const authorIds = uuids(280);
    const messageAuthorIds = authorIds.slice();

    const lookup = await fetchAuthorNamesInChunks(authorIds, AUTHOR_ID_IN_BATCH_SIZE, () =>
      Promise.resolve({ data: null, error: { message: "URI too long" } })
    );

    const stats = { processed: 0, updated: 0, skipped: 0, errors: 0 };
    stats.errors += countUnresolvedAuthorMessages(messageAuthorIds, lookup.failedAuthorIds);

    expect(lookup.failedChunks).toBe(Math.ceil(280 / AUTHOR_ID_IN_BATCH_SIZE));
    expect(stats.errors).not.toBe(0);
    expect(stats.errors).toBe(280);
  });

  it("counts only the messages whose author was in the failed chunk", () => {
    const failed = new Set(["a", "b"]);
    expect(countUnresolvedAuthorMessages(["a", "c", "b", "a", null, undefined], failed)).toBe(3);
  });

  it("counts nothing when the lookup fully succeeded", () => {
    expect(countUnresolvedAuthorMessages(["a", "b"], new Set())).toBe(0);
  });
});
