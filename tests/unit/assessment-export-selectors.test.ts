/**
 * @jest-environment node
 */

/**
 * Selector resolution semantics for assessment export.
 *
 * The selector code drives which assignments and gradebook columns are
 * included in an export. Wrong matches here mean either silently exporting
 * the wrong subset, or surfacing "no assignments matched" warnings on a
 * selector that should have worked. These tests pin the contract.
 */

import {
  resolveSelectors,
  selectorPredicate,
  type Identifiable
} from "../../supabase/functions/cli/utils/selectors";

const candidates: Identifiable[] = [
  { id: 1, slug: "hw-1" },
  { id: 2, slug: "hw-2" },
  { id: 3, slug: "lab-1" },
  { id: 4, slug: "final-project" },
  { id: 5, slug: null }
];

describe("selectorPredicate", () => {
  it("matches by numeric id when selector is a digit-only string", () => {
    const p = selectorPredicate("3");
    expect(candidates.filter(p).map((c) => c.id)).toEqual([3]);
  });

  it("matches by numeric id when selector is a number", () => {
    const p = selectorPredicate(2);
    expect(candidates.filter(p).map((c) => c.id)).toEqual([2]);
  });

  it("matches by exact slug for plain strings", () => {
    const p = selectorPredicate("lab-1");
    expect(candidates.filter(p).map((c) => c.id)).toEqual([3]);
  });

  it("does not partial-match — 'hw' alone matches nothing", () => {
    // Partial matches would be ambiguous; the CLI requires globs to be explicit.
    const p = selectorPredicate("hw");
    expect(candidates.filter(p)).toEqual([]);
  });

  it("matches by glob with * wildcard", () => {
    const p = selectorPredicate("hw-*");
    expect(candidates.filter(p).map((c) => c.id)).toEqual([1, 2]);
  });

  it("matches by glob with ? single-char wildcard", () => {
    const p = selectorPredicate("hw-?");
    expect(candidates.filter(p).map((c) => c.id)).toEqual([1, 2]);
  });

  it("escapes regex metacharacters in glob patterns", () => {
    // A slug containing '.' must not be matched by a literal '.' acting as
    // a regex metachar — a glob 'a.b' should match exactly 'a.b', not 'aXb'.
    const rows: Identifiable[] = [
      { id: 1, slug: "a.b" },
      { id: 2, slug: "aXb" }
    ];
    const p = selectorPredicate("a.b");
    expect(rows.filter(p).map((r) => r.id)).toEqual([1]);
  });

  it("never matches rows with null slug for slug-based selectors", () => {
    expect(selectorPredicate("anything")(candidates[4]!)).toBe(false);
    expect(selectorPredicate("*")(candidates[4]!)).toBe(false);
  });

  it("can match rows with null slug by id", () => {
    expect(selectorPredicate("5")(candidates[4]!)).toBe(true);
  });
});

describe("resolveSelectors", () => {
  it("returns all candidates when selectors are undefined", () => {
    const { resolved, unmatched } = resolveSelectors(undefined, candidates);
    expect(resolved).toEqual(candidates);
    expect(unmatched).toEqual([]);
  });

  it("returns all candidates when selectors are an empty array", () => {
    const { resolved, unmatched } = resolveSelectors([], candidates);
    expect(resolved).toEqual(candidates);
    expect(unmatched).toEqual([]);
  });

  it("preserves candidate order, not selector order", () => {
    // The export's stable shape depends on candidate-order preservation —
    // an analyst should see the same row order whether they ask for
    // ['hw-2', 'hw-1'] or ['hw-1', 'hw-2'].
    const { resolved } = resolveSelectors(["hw-2", "hw-1"], candidates);
    expect(resolved.map((c) => c.id)).toEqual([1, 2]);
  });

  it("dedupes overlapping selectors", () => {
    // 'hw-*' and 'hw-1' both match id 1, but it should appear once.
    const { resolved } = resolveSelectors(["hw-*", "hw-1"], candidates);
    expect(resolved.map((c) => c.id)).toEqual([1, 2]);
  });

  it("collects selectors that match nothing into unmatched", () => {
    const { resolved, unmatched } = resolveSelectors(
      ["hw-*", "nonexistent-*", "lab-1", "also-missing"],
      candidates
    );
    expect(resolved.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(unmatched).toEqual(["nonexistent-*", "also-missing"]);
  });

  it("does not flag a selector as unmatched if a previous selector already matched the same row", () => {
    // A selector is unmatched only if it would have added zero new ids — but
    // this is by design: once a row is in, a redundant selector covering it
    // is not interesting to surface as a problem.
    const { unmatched } = resolveSelectors(["hw-*", "hw-1"], candidates);
    expect(unmatched).toEqual(["hw-1"]);
  });

  it("handles mixed numeric/slug/glob selectors", () => {
    const { resolved, unmatched } = resolveSelectors([4, "hw-*", "missing"], candidates);
    expect(resolved.map((c) => c.id)).toEqual([1, 2, 4]);
    expect(unmatched).toEqual(["missing"]);
  });
});
