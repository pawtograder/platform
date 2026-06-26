/**
 * @jest-environment node
 *
 * Unit coverage for the roster-sync drop guard in lib/lti/roster.ts. A class with
 * multiple LTI contexts (e.g. separate lecture + lab Canvas courses) must NOT let
 * one context's sync drop class-wide members, and a failed/indeterminate count
 * must fail safe (never drop) — getting this wrong mass-disables students owned
 * by sibling contexts.
 */
// roster.ts's only non-pure imports are the DB client and the NRPS HTTP module;
// stub both so importing the module (for the pure canDropMissing helper) doesn't
// pull in the service-role client / network chain.
jest.mock("@/lib/lti/db", () => ({ ltiAdminClient: jest.fn() }));
jest.mock("@/lib/lti/nrps", () => ({ fetchMemberships: jest.fn(), mapRoster: jest.fn() }));

import { canDropMissing } from "@/lib/lti/roster";

describe("canDropMissing", () => {
  test("drops when this is the sole linked context", () => {
    expect(canDropMissing(1, null)).toBe(true);
  });

  test("does NOT drop when the class has multiple linked contexts", () => {
    expect(canDropMissing(2, null)).toBe(false);
    expect(canDropMissing(5, null)).toBe(false);
  });

  test("fails safe (no drop) when the count query errored", () => {
    expect(canDropMissing(1, new Error("boom"))).toBe(false);
    // even a count that would otherwise permit dropping must not drop on error
    expect(canDropMissing(0, { message: "transient" })).toBe(false);
  });

  test("fails safe (no drop) when the count is null/undefined", () => {
    expect(canDropMissing(null, null)).toBe(false);
    expect(canDropMissing(undefined, null)).toBe(false);
  });

  test("drops on a zero count (degenerate sole-context case)", () => {
    expect(canDropMissing(0, null)).toBe(true);
  });
});
