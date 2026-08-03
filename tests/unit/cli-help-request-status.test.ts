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
  HELP_REQUEST_RESOLUTION_STATUSES
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
