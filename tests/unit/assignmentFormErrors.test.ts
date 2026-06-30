import { ADVANCED_FIELD_KEYS, FIELD_LABELS, summarizeInvalidFields } from "@/lib/assignmentFormErrors";

describe("summarizeInvalidFields", () => {
  it("returns no names and no advanced error for an empty list", () => {
    expect(summarizeInvalidFields([])).toEqual({ names: [], hasAdvancedError: false });
  });

  it("maps known keys to human-readable labels", () => {
    const { names } = summarizeInvalidFields(["title", "due_date", "total_points"]);
    expect(names).toEqual(["Title", "Due Date", "Points Possible"]);
  });

  it("falls back to the raw key for unknown fields", () => {
    const { names } = summarizeInvalidFields(["title", "some_unmapped_field"]);
    expect(names).toEqual(["Title", "some_unmapped_field"]);
  });

  it("flags an advanced error when an advanced field is invalid", () => {
    expect(summarizeInvalidFields(["regrade_deadline"]).hasAdvancedError).toBe(true);
    expect(summarizeInvalidFields(["show_leaderboard", "title"]).hasAdvancedError).toBe(true);
  });

  it("does not flag an advanced error for only non-advanced fields", () => {
    expect(summarizeInvalidFields(["title", "slug", "due_date"]).hasAdvancedError).toBe(false);
  });

  it("keeps the advanced field set and labels in sync (every advanced key has a label)", () => {
    for (const key of ADVANCED_FIELD_KEYS) {
      // Not every advanced field needs a label, but the ones with labels should round-trip.
      if (FIELD_LABELS[key]) {
        expect(summarizeInvalidFields([key]).names[0]).toBe(FIELD_LABELS[key]);
      }
    }
  });
});
