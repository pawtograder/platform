import {
  dedupeIncompleteValues,
  pickPreferredGradebookValue,
  pushMissingDependenciesToContext,
  type GradebookColumnDependencyValue,
  type IncompleteValuesAdvice
} from "@/supabase/functions/gradebook-column-recalculate/expression/shared";
import {
  addCommonExpressionFunctions,
  type GradebookExpressionValue
} from "@/supabase/functions/gradebook-column-recalculate/expression/commonMathFunctions";

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

  test("pickPreferredGradebookValue treats score_override0 as valid (not missing)", () => {
    const overrideValue: GradebookColumnDependencyValue = {
      score: 100,
      score_override: null,
      is_missing: false,
      column_slug: "test"
    };
    const baseValue: GradebookColumnDependencyValue = {
      score: 50,
      score_override: 0,
      is_missing: false,
      column_slug: "test"
    };

    expect(pickPreferredGradebookValue(overrideValue, baseValue)).toEqual({
      ...baseValue,
      score: 0
    });
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

  test("pushMissingDependenciesToContext merges mixed present and missing entries", () => {
    const context: { incomplete_values: IncompleteValuesAdvice | null } = {
      incomplete_values: null
    };
    const present: GradebookColumnDependencyValue = {
      score: 80,
      score_override: null,
      is_missing: false,
      column_slug: "graded-col"
    };
    const missing: GradebookColumnDependencyValue = {
      score: null,
      score_override: null,
      is_missing: true,
      column_slug: "missing-col",
      incomplete_values: {
        missing: {
          gradebook_columns: ["nested-col"]
        }
      }
    };
    pushMissingDependenciesToContext(context, [present, missing]);
    expect(context.incomplete_values?.missing?.gradebook_columns).toEqual(["missing-col", "nested-col"]);
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

  test("dedupeIncompleteValues tolerates null input and empty arrays", () => {
    expect(dedupeIncompleteValues(null)).toBeNull();
    expect(dedupeIncompleteValues(undefined)).toBeUndefined();
    expect(dedupeIncompleteValues({ missing: { gradebook_columns: [] } })).toEqual({
      missing: { gradebook_columns: [] }
    });
  });

  test("addCommonExpressionFunctions provides shared arithmetic + aggregate behavior", () => {
    const imports: Record<string, (...args: never[]) => unknown> = {};
    addCommonExpressionFunctions(imports);
    const runtime = imports as unknown as Record<string, (...args: unknown[]) => unknown>;

    const context = {
      student_id: "student-1",
      class_id: 1,
      is_private_calculation: false,
      incomplete_values: null,
      scope: {
        setTag: jest.fn(),
        addBreadcrumb: jest.fn()
      }
    };

    const a: GradebookExpressionValue = {
      score: 40,
      score_override: null,
      is_missing: false,
      is_droppable: true,
      is_excused: false,
      max_score: 50,
      is_private: false,
      column_slug: "a"
    };
    const b: GradebookExpressionValue = {
      score: 80,
      score_override: null,
      is_missing: false,
      is_droppable: true,
      is_excused: false,
      max_score: 100,
      is_private: false,
      column_slug: "b"
    };

    expect(runtime.add(a, 10)).toBe(50);
    expect(runtime.sum(context, [a, b])).toBe(120);
    expect(runtime.mean(context, [a, b], true)).toBeCloseTo(80);
  });

  test("addCommonExpressionFunctions enforces is_private boundary when enabled", () => {
    const imports: Record<string, (...args: never[]) => unknown> = {};
    addCommonExpressionFunctions(imports, { enforcePrivateCalculationMatch: true });
    const runtime = imports as unknown as Record<string, (...args: unknown[]) => unknown>;

    const context = {
      student_id: "student-1",
      class_id: 1,
      is_private_calculation: false,
      incomplete_values: null
    };

    const privateValue: GradebookExpressionValue = {
      score: 10,
      score_override: null,
      is_missing: false,
      is_droppable: true,
      is_excused: false,
      max_score: 10,
      is_private: true,
      column_slug: "private-col"
    };

    expect(() => runtime.mean(context, [privateValue], true)).toThrow("is_private mismatch");
  });

  test("drop_lowest shared behavior preserves backend semantics", () => {
    const imports: Record<string, (...args: never[]) => unknown> = {};
    addCommonExpressionFunctions(imports);
    const runtime = imports as unknown as Record<string, (...args: unknown[]) => unknown>;

    const context = {
      student_id: "student-1",
      class_id: 1,
      is_private_calculation: false,
      incomplete_values: null
    };

    const values: GradebookExpressionValue[] = [
      {
        score: 1,
        score_override: null,
        is_missing: false,
        is_droppable: true,
        is_excused: false,
        max_score: 10,
        is_private: false,
        column_slug: "drop"
      },
      {
        score: 8,
        score_override: null,
        is_missing: false,
        is_droppable: false,
        is_excused: false,
        max_score: 10,
        is_private: false,
        column_slug: "keep"
      },
      {
        score: 5,
        score_override: null,
        is_missing: false,
        is_droppable: true,
        is_excused: false,
        max_score: 0,
        is_private: false,
        column_slug: "invalid"
      }
    ];

    const result = runtime.drop_lowest(context, values, 1) as GradebookExpressionValue[];
    expect(result.map((v) => v.column_slug)).toEqual(["keep"]);
  });
});
