export type IncompleteValuesAdvice = {
  missing?: {
    gradebook_columns?: string[];
  };
  not_released?: {
    gradebook_columns?: string[];
  };
};

export type ExpressionContextWithIncompleteValues = {
  incomplete_values: IncompleteValuesAdvice | null;
};

export type GradebookColumnDependencyValue = {
  score: number | null;
  score_override: number | null;
  is_missing?: boolean | null;
  column_slug: string;
  incomplete_values?: unknown | null;
};

function ensureMissingColumns(context: ExpressionContextWithIncompleteValues): string[] {
  if (!context.incomplete_values) {
    context.incomplete_values = {
      missing: {
        gradebook_columns: []
      }
    };
  }
  if (!context.incomplete_values.missing) {
    context.incomplete_values.missing = {
      gradebook_columns: []
    };
  }
  if (!context.incomplete_values.missing.gradebook_columns) {
    context.incomplete_values.missing.gradebook_columns = [];
  }
  return context.incomplete_values.missing.gradebook_columns;
}

function extractNestedMissingColumns(incompleteValues: unknown): string[] {
  if (!incompleteValues || typeof incompleteValues !== "object" || !("missing" in incompleteValues)) {
    return [];
  }
  const missing = (incompleteValues as { missing?: { gradebook_columns?: string[] } }).missing;
  return missing?.gradebook_columns ?? [];
}

/**
 * Ground-truth behavior for missing dependency propagation.
 * This logic mirrors the edge-function dependency source implementation.
 */
export function pushMissingDependenciesToContext(
  context: ExpressionContextWithIncompleteValues,
  valueOrValues: GradebookColumnDependencyValue | GradebookColumnDependencyValue[] | undefined | null
): void {
  const values = Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues];
  for (const value of values) {
    if (!value) continue;

    if (value.is_missing || (value.score === null && value.score_override === null)) {
      ensureMissingColumns(context).push(value.column_slug);
    }

    const nestedMissing = extractNestedMissingColumns(value.incomplete_values);
    if (nestedMissing.length > 0) {
      ensureMissingColumns(context).push(...nestedMissing);
    }
  }
}

/**
 * Mirrors edge-function behavior: if a persisted score_override exists,
 * use it as the effective score regardless of an override candidate value.
 */
export function pickPreferredGradebookValue<T extends GradebookColumnDependencyValue>(
  overrideValue: T | undefined,
  baseValue: T | undefined
): T | undefined {
  if (overrideValue && baseValue && baseValue.score_override !== null && baseValue.score_override !== undefined) {
    return {
      ...baseValue,
      score: baseValue.score_override
    };
  }
  return overrideValue ?? baseValue;
}

export function dedupeIncompleteValues(
  incompleteValues: IncompleteValuesAdvice | null | undefined
): IncompleteValuesAdvice | null | undefined {
  if (!incompleteValues) return incompleteValues;

  const dedupe = (arr?: string[]) => (arr ? [...new Set(arr)] : arr);
  return {
    ...incompleteValues,
    missing: incompleteValues.missing
      ? {
          ...incompleteValues.missing,
          gradebook_columns: dedupe(incompleteValues.missing.gradebook_columns)
        }
      : incompleteValues.missing,
    not_released: incompleteValues.not_released
      ? {
          ...incompleteValues.not_released,
          gradebook_columns: dedupe(incompleteValues.not_released.gradebook_columns)
        }
      : incompleteValues.not_released
  };
}
