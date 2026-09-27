/**
 * @jest-environment node
 */

/**
 * The two PostgREST ceilings the CLI reads against, and why they differ.
 *
 * `PAGE_SIZE` bounds rows coming back; `UUID_IN_BATCH_SIZE` bounds ids going out
 * in an `.in()` filter, which is serialized into the query string and therefore
 * limited by the HTTP URL length rather than by `max_rows`. Conflating the two is
 * exactly how a UUID list gets batched at 500 and produces an ~18 KB URL that
 * fails before Postgres sees it — a failure that looks nothing like "too many
 * rows", so these tests pin the budget rather than leaving it to a comment.
 */

import { PAGE_SIZE, UUID_IN_BATCH_SIZE, estimateInFilterBytes } from "../../supabase/functions/cli/utils/pagingLimits";

/** Conservative ceiling: proxies commonly cap a request line + headers at 8 KB. */
const SAFE_URL_BUDGET_BYTES = 4096;

const UUID_LENGTH = 36;
/** A bigint id in a large deployment, e.g. 9 digits. */
const NUMERIC_ID_LENGTH = 9;

describe("PAGE_SIZE", () => {
  it("does not exceed the API's max_rows", () => {
    // supabase/config.toml sets max_rows = 1000. A larger page would be silently
    // clamped, and a paging loop that breaks on `rows.length < PAGE_SIZE` would
    // then stop after the first page and report a partial result as complete.
    expect(PAGE_SIZE).toBeLessThanOrEqual(1000);
  });
});

describe("UUID_IN_BATCH_SIZE", () => {
  it("keeps a UUID .in() filter inside a safe URL budget", () => {
    expect(estimateInFilterBytes(UUID_IN_BATCH_SIZE, UUID_LENGTH)).toBeLessThan(SAFE_URL_BUDGET_BYTES);
  });

  it("is well below the batch size that is safe for numeric ids", () => {
    // Numeric ids are ~4x cheaper, which is why they are batched at PAGE_SIZE.
    expect(UUID_IN_BATCH_SIZE).toBeLessThan(PAGE_SIZE);
    expect(estimateInFilterBytes(PAGE_SIZE, NUMERIC_ID_LENGTH)).toBeLessThan(SAFE_URL_BUDGET_BYTES * 3);
  });

  it("documents the failure it prevents: PAGE_SIZE UUIDs would blow the budget", () => {
    // This is the mistake the constant exists to stop. If someone ever "unifies"
    // the two limits, this assertion explains why they cannot.
    expect(estimateInFilterBytes(PAGE_SIZE, UUID_LENGTH)).toBeGreaterThan(8192);
  });
});

describe("estimateInFilterBytes", () => {
  it("counts separators between ids", () => {
    // 2 ids of length 3 => "col=in.()" + 6 + 1 separator
    expect(estimateInFilterBytes(2, 3)).toBe("col=in.()".length + 6 + 1);
  });

  it("costs nothing for an empty list", () => {
    expect(estimateInFilterBytes(0, 36)).toBe(0);
  });
});
