import {
  dedupeIncompleteValues,
  pickPreferredGradebookValue,
  pushMissingDependenciesToContext,
  type GradebookColumnDependencyValue,
  type IncompleteValuesAdvice
} from "@/supabase/functions/gradebook-column-recalculate/expression/shared";

describe("gradebook expression shared helpers", () => {
  test("pickPreferredGradebookValue prefers persisted score_override over override candidate", () => {
    const overrideValue: GradebookColumnDependencyValue = {
      score: 100,
      score_override: null,
      is_missing: false,
      column_slug: "final-grade"
    };
    const baseValue: GradebookColumnDependencyValue = {
      score: 40,
      score_override: 91,
      is_missing: false,
      column_slug: "final-grade"
    };

    const result = pickPreferredGradebookValue(overrideValue, baseValue);
    expect(result).toEqual({
      ...baseValue,
      score: 91
    });
  });

  test("pickPreferredGradebookValue falls back to override then base", () => {
    const overrideValue: GradebookColumnDependencyValue = {
      score: 72,
      score_override: null,
      is_missing: false,
      column_slug: "assignment-1"
    };
    const baseValue: GradebookColumnDependencyValue = {
      score: 58,
      score_override: null,
      is_missing: false,
      column_slug: "assignment-1"
    };

    expect(pickPreferredGradebookValue(overrideValue, baseValue)).toBe(overrideValue);
    expect(pickPreferredGradebookValue(undefined, baseValue)).toBe(baseValue);
    expect(pickPreferredGradebookValue(undefined, undefined)).toBeUndefined();
  });

  test("pushMissingDependenciesToContext tracks direct and nested missing dependencies", () => {
    const context: { incomplete_values: IncompleteValuesAdvice | null } = {
      incomplete_values: null
    };

    const value: GradebookColumnDependencyValue = {
      score: null,
      score_override: null,
      is_missing: true,
      column_slug: "assignment-1",
      incomplete_values: {
        missing: {
          gradebook_columns: ["assignment-2", "assignment-3"]
        }
      }
    };

    pushMissingDependenciesToContext(context, value);
    expect(context.incomplete_values?.missing?.gradebook_columns).toEqual([
      "assignment-1",
      "assignment-2",
      "assignment-3"
    ]);
  });

  test("pushMissingDependenciesToContext tolerates undefined values", () => {
    const context: { incomplete_values: IncompleteValuesAdvice | null } = {
      incomplete_values: null
    };
    pushMissingDependenciesToContext(context, undefined);
    expect(context.incomplete_values).toBeNull();
  });

  test("dedupeIncompleteValues removes duplicate column slugs", () => {
    const input: IncompleteValuesAdvice = {
      missing: {
        gradebook_columns: ["a", "b", "a"]
      },
      not_released: {
        gradebook_columns: ["x", "x", "y"]
      }
    };

    expect(dedupeIncompleteValues(input)).toEqual({
      missing: { gradebook_columns: ["a", "b"] },
      not_released: { gradebook_columns: ["x", "y"] }
    });
  });
});
