/**
 * @jest-environment node
 */

/**
 * `help-requests list --status` filter translation.
 *
 * The status column is an enum of four values, but the CLI also accepts the two
 * groupings the office-hours UI uses: `active` (not yet finished) and `all` (no
 * filter). Mapping these wrong silently shows the operator the wrong slice of
 * the queue — the failure looks like an empty or over-full list, not an error.
 */

import {
  parseStatusFilter,
  HELP_REQUEST_STATUSES,
  HELP_REQUEST_STATUS_FILTERS,
  TERMINAL_HELP_REQUEST_STATUSES,
  HELP_REQUEST_RESOLUTION_STATUSES,
  participantsNeedingActivity,
  resolvedAtForClose
} from "../../supabase/functions/cli/utils/helpRequestStatus";

describe("parseStatusFilter", () => {
  it("maps 'active' to the two unfinished statuses", () => {
    expect(parseStatusFilter("active")).toEqual({ statuses: ["open", "in_progress"] });
  });

  it("applies no filter for 'all'", () => {
    expect(parseStatusFilter("all")).toEqual({ statuses: null });
  });

  it("applies no filter when the status is omitted", () => {
    expect(parseStatusFilter(undefined)).toEqual({ statuses: null });
    expect(parseStatusFilter(null)).toEqual({ statuses: null });
  });

  it.each(["open", "in_progress", "resolved", "closed"])("passes through the enum value %s", (status) => {
    expect(parseStatusFilter(status)).toEqual({ statuses: [status] });
  });

  it("reports an error naming every valid choice for an unknown status", () => {
    const result = parseStatusFilter("pending");

    expect(result).not.toHaveProperty("statuses");
    const error = (result as { error: string }).error;
    expect(error).toMatch(/Invalid status: pending/);
    for (const choice of HELP_REQUEST_STATUS_FILTERS) {
      expect(error).toContain(choice);
    }
  });

  it("does not accept near-misses like trailing space or wrong case", () => {
    expect(parseStatusFilter("closed ")).toHaveProperty("error");
    expect(parseStatusFilter("OPEN")).toHaveProperty("error");
    expect(parseStatusFilter("")).toHaveProperty("error");
  });
});

describe("help request status constants", () => {
  it("offers exactly the four enum values plus the two aliases", () => {
    expect(HELP_REQUEST_STATUS_FILTERS).toEqual(["open", "in_progress", "resolved", "closed", "active", "all"]);
  });

  it("treats only resolved and closed as terminal", () => {
    expect(TERMINAL_HELP_REQUEST_STATUSES).toEqual(["resolved", "closed"]);
    // Terminal statuses must be a subset of the real enum.
    for (const status of TERMINAL_HELP_REQUEST_STATUSES) {
      expect(HELP_REQUEST_STATUSES).toContain(status);
    }
  });

  it("lists the resolution statuses the schema defines", () => {
    expect(HELP_REQUEST_RESOLUTION_STATUSES).toEqual([
      "self_solved",
      "staff_helped",
      "peer_helped",
      "no_time",
      "other"
    ]);
  });
});

/**
 * `--force` corrects resolution metadata on an already-closed request. It must not
 * rewrite when the request was completed: the office-hours history sorts terminal
 * requests by `resolved_at`, so restamping made an old request surface as newly
 * resolved and lost the real completion time.
 */
describe("resolvedAtForClose", () => {
  const NOW = "2026-08-04T02:00:00.000Z";
  const ORIGINAL = "2026-07-28T14:12:00.000Z";

  it("stamps now on a genuine transition out of a nonterminal state", () => {
    expect(resolvedAtForClose(false, null, NOW)).toBe(NOW);
    // Even if a stray value is present, a real resolution sets the current time.
    expect(resolvedAtForClose(false, ORIGINAL, NOW)).toBe(NOW);
  });

  it("preserves the original time on a forced correction", () => {
    expect(resolvedAtForClose(true, ORIGINAL, NOW)).toBe(ORIGINAL);
  });

  it("falls back to now when a terminal row has no resolved_at to preserve", () => {
    expect(resolvedAtForClose(true, null, NOW)).toBe(NOW);
    expect(resolvedAtForClose(true, undefined, NOW)).toBe(NOW);
  });
});

/**
 * The activity write is deduplicated by reading what is already there, not by refusing to
 * run on a terminal request. Gating on the status stopped `--force` duplicating rows but
 * also made a *failed* write unrepairable — the retry saw a terminal request and skipped
 * logging, so the per-student history kept its hole for good.
 */
describe("participantsNeedingActivity", () => {
  const A = "aaaaaaaa-0000-0000-0000-00000000000a";
  const B = "bbbbbbbb-0000-0000-0000-00000000000b";
  const C = "cccccccc-0000-0000-0000-00000000000c";

  it("returns every participant when nothing is logged yet", () => {
    expect(participantsNeedingActivity([A, B], [])).toEqual([A, B]);
  });

  it("returns nothing when all participants are already logged", () => {
    // The idempotent rerun: --force on a fully logged request adds no duplicates.
    expect(participantsNeedingActivity([A, B], [B, A])).toEqual([]);
  });

  it("fills only the gap left by a partly failed write", () => {
    // The retry case: A landed, B and C did not, and the request is now terminal.
    expect(participantsNeedingActivity([A, B, C], [A])).toEqual([B, C]);
  });

  it("collapses duplicate participants so one call cannot write two rows", () => {
    expect(participantsNeedingActivity([A, A, B], [])).toEqual([A, B]);
  });

  it("ignores null and undefined ids on either side", () => {
    expect(participantsNeedingActivity([A, null, undefined, B], [null, B])).toEqual([A]);
  });

  it("preserves participant order", () => {
    expect(participantsNeedingActivity([C, A, B], [A])).toEqual([C, B]);
  });
});
