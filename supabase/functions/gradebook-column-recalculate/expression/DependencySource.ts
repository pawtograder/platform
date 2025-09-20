import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isArray, isDenseMatrix, MathJsInstance, Matrix } from "mathjs";
import { minimatch } from "minimatch";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";
import type {
  Assignment,
  GradebookColumn,
  GradebookColumnStudent,
  GradebookColumnStudentWithMaxScore
} from "./types.d.ts";

export type PrivateProfileId = string;

export type ExpressionContext = {
  student_id: PrivateProfileId;
  is_private_calculation: boolean;
  incomplete_values: IncompleteValuesAdvice | null;
  incomplete_values_policy: "assume_max" | "assume_zero" | "report_only";
  scope: Sentry.Scope;
  class_id: number;
};
//TODO: Move this to a shared file
//See also in hooks/useGradebookWhatIf.tsx
export type IncompleteValuesAdvice = {
  missing?: {
    gradebook_columns?: string[];
  };
  not_released?: {
    gradebook_columns?: string[];
  };
};

export type ResolvedExprDependencyInstance = ExprDependencyInstance & {
  value: unknown;
  is_private: boolean;
};
export type ExprDependencyInstance = {
  class_id: number;
  key: string | string[];
  student_id: PrivateProfileId;
};

export interface DependencySource {
  /**
   * The names of the functions that this dependency source provides.
   */
  getFunctionNames: () => string[];

  /**
   * Users might specify keys using globs. This function should expand the glob into a list of keys.
   *
   * The DependencySource will get back the same keys passed along iwth ExprDependencyInstance.
   *
   * @param key
   * @returns
   */
  expandKey: ({ key, class_id }: { key: string; class_id: number }) => string[];

  /**
   * Retrieve the values of the dependencies for the given keys.
   *
   * This is the only time you can access the database before evaluating the expression.
   *
   * @param keys - The keys of the dependencies to retrieve.
   * @param supabase - The Supabase client to use to retrieve the values.
   * @returns The values of the dependencies.
   */
  retrieveValues: ({
    keys,
    class_id,
    supabase
  }: {
    keys: ExprDependencyInstance[];
    class_id: number;
    supabase: SupabaseClient<Database>;
  }) => Promise<void>;

  /**
   * Execute the function with the given parameters.
   *
   * @param function_name
   * @param context
   * @param key
   * @returns
   */
  execute: ({
    function_name,
    context,
    key,
    class_id,
    args
  }: {
    function_name: string;
    context: ExpressionContext;
    key: string | string[];
    class_id: number;
    args?: unknown[];
  }) => unknown;
}

// Row-level override map for computed gradebook_columns values during per-row recalculation
// Keyed by `${class_id}:${student_id}:${is_private}` → Map<slug, GradebookColumnStudentWithMaxScore>
const rowOverrideValues: Map<string, Map<string, GradebookColumnStudentWithMaxScore>> = new Map();

export function setRowOverrideValues(
  class_id: number,
  student_id: PrivateProfileId,
  is_private: boolean,
  valuesBySlug: Map<string, GradebookColumnStudentWithMaxScore>
) {
  const key = `${class_id}:${student_id}:${is_private}`;
  rowOverrideValues.set(key, valuesBySlug);
}

export function clearRowOverrideValues(class_id: number, student_id: PrivateProfileId, is_private: boolean) {
  const key = `${class_id}:${student_id}:${is_private}`;
  rowOverrideValues.delete(key);
}

export function mergeRowOverrideValues(
  class_id: number,
  student_id: PrivateProfileId,
  is_private: boolean,
  valuesBySlug: Map<string, GradebookColumnStudentWithMaxScore>
) {
  const key = `${class_id}:${student_id}:${is_private}`;
  const existing = rowOverrideValues.get(key) ?? new Map<string, GradebookColumnStudentWithMaxScore>();
  valuesBySlug.forEach((value, slug) => {
    existing.set(slug, value);
  });
  rowOverrideValues.set(key, existing);
}
/**
 * A dependency source is a class that implements the DependencySource interface, simply returning
 * the pre-calculated values for the dependencies.
 */
abstract class DependencySourceBase implements DependencySource {
  abstract getFunctionNames(): string[];
  private valuesMap: Map<PrivateProfileId, ResolvedExprDependencyInstance[]> = new Map();
  abstract _retrieveValues({
    keys,
    supabase
  }: {
    keys: ExprDependencyInstance[];
    supabase: SupabaseClient<Database>;
  }): Promise<ResolvedExprDependencyInstance[]>;
  async retrieveValues({
    keys,
    supabase
  }: {
    keys: ExprDependencyInstance[];
    supabase: SupabaseClient<Database>;
  }): Promise<void> {
    try {
      const allValues = await this._retrieveValues({ keys, supabase });
      for (const value of allValues) {
        this.valuesMap.set(value.student_id, [...(this.valuesMap.get(value.student_id) ?? []), value]);
      }
    } catch (error) {
      console.error(`Error retrieving values for ${this.getFunctionNames().join(", ")}:`, error);
      throw error;
    }
  }

  abstract expandKey({ key, class_id }: { key: string; class_id: number }): string[];

  execute({
    context,
    key,
    class_id
  }: {
    function_name: string;
    context: ExpressionContext;
    key: string | string[];
    class_id: number;
    args?: unknown[];
  }): unknown {
    if (typeof key === "object") {
      if (Array.isArray(key)) {
        const ret = key.map(
          (k) =>
            this.valuesMap
              .get(context.student_id)
              ?.find(
                (value) =>
                  value.key === k && value.class_id === class_id && value.is_private === context.is_private_calculation
              )?.value
        );
        return ret;
      }
      if (isDenseMatrix(key)) {
        const ret = (key as Matrix<string>)
          .toArray()
          .map(
            (k) =>
              this.valuesMap
                .get(context.student_id)
                ?.find(
                  (value) =>
                    value.key === k &&
                    value.class_id === class_id &&
                    value.is_private === context.is_private_calculation
                )?.value
          );
        return ret;
      }
      throw new Error(`Unsupported key type: ${typeof key}`);
    }
    return this.valuesMap
      .get(context.student_id)
      ?.find(
        (value) =>
          value.key === key && value.class_id === class_id && value.is_private === context.is_private_calculation
      )?.value;
  }
}

class AssignmentsDependencySource extends DependencySourceBase {
  getFunctionNames(): string[] {
    return ["assignments"];
  }
  expandKey({ key, class_id }: { key: string; class_id: number }): string[] {
    const matchingAssignments = Array.from(this.assignmentMap.values()).filter(
      (assignment) => assignment.class_id === class_id && minimatch(assignment.slug!, key)
    );
    return matchingAssignments.map((assignment) => assignment.slug ?? "ERROR");
  }
  private assignmentMap: Map<number, Assignment> = new Map();

  // Execute with optional review round argument. Defaults to 'grading-review'.
  override execute({
    context,
    key,
    class_id,
    args
  }: {
    function_name: string;
    context: ExpressionContext;
    key: string | string[];
    class_id: number;
    args?: unknown[];
  }): unknown {
    const requestedRound = (args && typeof args[0] === "string" ? (args[0] as string) : "grading-review") as string;
    const coerceRoundValue = (val: unknown): number | undefined => {
      if (val === null || val === undefined) return undefined;
      if (typeof val === "number") return val;
      if (typeof val === "object" && val !== null && requestedRound in (val as Record<string, unknown>)) {
        const v = (val as Record<string, unknown>)[requestedRound];
        return v === undefined || v === null ? undefined : (v as number);
      }
      // Back-compat: if stored as a single number
      return undefined;
    };
    const raw = super.execute({ function_name: "assignments", context, key, class_id });
    if (Array.isArray(raw)) {
      return raw.map((v) => coerceRoundValue(v));
    }
    const ret = coerceRoundValue(raw);
    return ret;
  }

  async _retrieveValues({
    keys,
    supabase
  }: {
    keys: ExprDependencyInstance[];
    supabase: SupabaseClient<Database>;
  }): Promise<ResolvedExprDependencyInstance[]> {
    // Fetch assignments referenced by keys (ids) for slug/class mapping
    const assignmentIds = Array.from(new Set(keys.map((key) => Number(key.key))));
    if (assignmentIds.length === 0) return [];

    const { data: assignments, error: assignmentsFetchError } = await supabase
      .from("assignments")
      .select("id, slug, class_id")
      .in("id", assignmentIds);

    if (assignmentsFetchError) {
      throw assignmentsFetchError;
    }

    for (const assignment of assignments ?? []) {
      this.assignmentMap.set(assignment.id, assignment as unknown as Assignment);
    }

    // Gather target students in this batch
    const students = new Set<string>(keys.map((key) => key.student_id));

    // Query optimized view that returns one row per student per assignment with scores by review round
    type ReviewsByRoundRow = {
      assignment_id: number;
      class_id: number;
      student_private_profile_id: string;
      assignment_slug: string | null;
      scores_by_round_private: Record<string, number | null> | null;
      scores_by_round_public: Record<string, number | null> | null;
    };

    const allRows: ReviewsByRoundRow[] = [];
    const classIds = Array.from(new Set(keys.map((k) => k.class_id)));
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const to = from + pageSize - 1;
      let query = supabase
        .from("submissions_with_reviews_by_round_for_assignment")
        .select(
          "assignment_id, class_id, student_private_profile_id, assignment_slug, scores_by_round_private, scores_by_round_public"
        )
        .in("assignment_id", assignmentIds);
      // Only filter by students when the set is reasonably small to avoid exceeding IN limits
      if (students.size > 0 && students.size <= 20) {
        query = query.in("student_private_profile_id", Array.from(students));
      }
      query = classIds.length === 1 ? query.eq("class_id", classIds[0]) : query.in("class_id", classIds);
      // Ensure stable pagination
      query = query
        .order("assignment_id", { ascending: true })
        .order("student_private_profile_id", { ascending: true });
      const { data: rows, error } = await query.range(from, to);
      if (error) {
        throw error;
      }
      if (!rows || rows.length === 0) break;
      allRows.push(...(rows as unknown as ReviewsByRoundRow[]));
      if (rows.length < pageSize) break;
      from += pageSize;
    }

    const results: ResolvedExprDependencyInstance[] = [];
    for (const row of allRows) {
      if (!students.has(row.student_private_profile_id)) continue;
      const slug = row.assignment_slug ?? this.assignmentMap.get(row.assignment_id)?.slug ?? "";
      const privateByRound: Record<string, number | undefined> = {};
      const publicByRound: Record<string, number | undefined> = {};
      if (row.scores_by_round_private) {
        for (const [round, score] of Object.entries(row.scores_by_round_private)) {
          privateByRound[round] = score === null ? undefined : (score as number);
        }
      }
      if (row.scores_by_round_public) {
        for (const [round, score] of Object.entries(row.scores_by_round_public)) {
          publicByRound[round] = score === null ? undefined : (score as number);
        }
      }
      results.push({
        key: slug,
        student_id: row.student_private_profile_id,
        value: privateByRound,
        class_id: row.class_id,
        is_private: true
      });
      results.push({
        key: slug,
        student_id: row.student_private_profile_id,
        value: publicByRound,
        class_id: row.class_id,
        is_private: false
      });
    }

    return results;
  }
}

class GradebookColumnsDependencySource extends DependencySourceBase {
  getFunctionNames(): string[] {
    return ["gradebook_columns"];
  }
  private gradebookColumnMap: Map<number, GradebookColumn> = new Map();

  private _pushMissingIfNeeded(
    context: ExpressionContext,
    ret: GradebookColumnStudentWithMaxScore | GradebookColumnStudentWithMaxScore[]
  ) {
    const handleOne = (ret: GradebookColumnStudentWithMaxScore) => {
      // Handle cases where THIS gradebook column is missing
      if (!ret || ret.is_missing || (ret.score === null && ret.score_override === null)) {
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
        context.incomplete_values.missing.gradebook_columns.push(ret.column_slug);
      }
      // Handle cases where OUR DEPENDENCIES ARE MISSING
      if (
        ret &&
        ret.incomplete_values !== null &&
        typeof ret.incomplete_values === "object" &&
        "missing" in ret.incomplete_values
      ) {
        const missing = ret.incomplete_values.missing as { gradebook_columns?: string[] };
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
        context.incomplete_values.missing.gradebook_columns.push(...(missing.gradebook_columns ?? []));
      }
    };
    if (Array.isArray(ret)) {
      ret.forEach(handleOne);
    } else {
      handleOne(ret);
    }
  }

  override execute({
    function_name,
    context,
    key,
    class_id
  }: {
    function_name: string;
    context: ExpressionContext;
    key: string | string[];
    class_id: number;
  }): unknown {
    // Prefer row-level computed overrides if present
    const overrideKey = `${class_id}:${context.student_id}:${context.is_private_calculation}`;
    const overrides = rowOverrideValues.get(overrideKey);
    // Hybrid approach: use override when present, otherwise fall back to base values
    if (overrides) {
      const readOverride = (slug: string) => overrides.get(slug);
      const readBase = (slug: string) =>
        super.execute({ function_name, context, key: slug, class_id }) as
          | GradebookColumnStudentWithMaxScore
          | undefined;
      if (typeof key === "object") {
        if (Array.isArray(key)) {
          const values = key.map((k) => {
            if (typeof k !== "string") return undefined;
            return readOverride(k) ?? readBase(k);
          });
          this._pushMissingIfNeeded(
            context,
            values.filter((v): v is GradebookColumnStudentWithMaxScore => !!v)
          );
          return values;
        }
        if (isDenseMatrix(key)) {
          const values = (key as Matrix<string>)
            .toArray()
            .map((k) => (typeof k === "string" ? (readOverride(k) ?? readBase(k)) : undefined));
          this._pushMissingIfNeeded(
            context,
            values.filter((v): v is GradebookColumnStudentWithMaxScore => !!v)
          );
          return values;
        }
      } else if (typeof key === "string") {
        const value = readOverride(key) ?? readBase(key);
        if (value) {
          this._pushMissingIfNeeded(context, value);
          return value;
        }
      }
    }

    const ret = super.execute({ function_name, context, key, class_id }) as
      | GradebookColumnStudentWithMaxScore
      | GradebookColumnStudentWithMaxScore[];
    this._pushMissingIfNeeded(context, ret);

    return ret;
  }
  async _retrieveValues({
    keys,
    supabase
  }: {
    keys: ExprDependencyInstance[];
    supabase: SupabaseClient<Database>;
  }): Promise<ResolvedExprDependencyInstance[]> {
    const students = new Set<string>(keys.map((key) => key.student_id));
    const gradebookColumnIds = new Set(keys.map((key) => Number(key.key)));
    const uniqueGradebookColumnIds = Array.from(gradebookColumnIds);

    // Fetch all gradebook column students with pagination
    const allGradebookColumnStudents: GradebookColumnStudent[] = [];
    let from = 0;
    const pageSize = 1000;

    while (true) {
      const to = from + pageSize - 1;
      const { data: gradebookColumnStudents, error: gradebookColumnsFetchError } = await supabase
        .from("gradebook_column_students")
        .select("*")
        .in("gradebook_column_id", uniqueGradebookColumnIds)
        .range(from, to);

      if (gradebookColumnsFetchError) {
        throw gradebookColumnsFetchError;
      }

      if (!gradebookColumnStudents || gradebookColumnStudents.length === 0) {
        break;
      }

      allGradebookColumnStudents.push(...gradebookColumnStudents);

      if (gradebookColumnStudents.length < pageSize) {
        break;
      }

      from += pageSize;
    }

    // Fetch all gradebook columns with pagination
    const allGradebookColumns: GradebookColumn[] = [];
    from = 0;

    while (true) {
      const to = from + pageSize - 1;
      const { data: gradebookColumns, error: gradebookColumnsError } = await supabase
        .from("gradebook_columns")
        .select("*")
        .in("id", uniqueGradebookColumnIds)
        .range(from, to);

      if (gradebookColumnsError) {
        throw gradebookColumnsError;
      }

      if (!gradebookColumns || gradebookColumns.length === 0) {
        break;
      }

      allGradebookColumns.push(...gradebookColumns);

      if (gradebookColumns.length < pageSize) {
        break;
      }

      from += pageSize;
    }

    for (const gradebookColumn of allGradebookColumns) {
      this.gradebookColumnMap.set(gradebookColumn.id, gradebookColumn);
    }
    const ret = allGradebookColumnStudents
      .filter((studentRecord) => students.has(studentRecord.student_id!))
      .map((studentRecord) => ({
        key: this.gradebookColumnMap.get(studentRecord.gradebook_column_id!)?.slug ?? "unknown",
        student_id: studentRecord.student_id!,
        value: {
          ...studentRecord,
          score: studentRecord.score_override ?? studentRecord.score ?? null,
          max_score: this.gradebookColumnMap.get(studentRecord.gradebook_column_id!)?.max_score ?? 0,
          column_slug: this.gradebookColumnMap.get(studentRecord.gradebook_column_id!)?.slug ?? "unknown"
        },
        display: studentRecord.score?.toString() ?? "",
        class_id: studentRecord.class_id,
        is_private: studentRecord.is_private
      }));
    return ret;
  }
  expandKey({ key, class_id }: { key: string; class_id: number }): string[] {
    const matchingColumns = Array.from(this.gradebookColumnMap.values()).filter(
      (column) => column.class_id === class_id && minimatch(column.slug, key)
    );
    return matchingColumns.map((column) => column.slug);
  }
}
export const DependencySourceMap = {
  assignments: new AssignmentsDependencySource(),
  gradebook_columns: new GradebookColumnsDependencySource()
};
//These functions should be called with a context object as the first argument
export const ContextFunctions = ["mean", "countif", "sum", "drop_lowest"];

function isGradebookColumnStudent(value: unknown): value is GradebookColumnStudentWithMaxScore {
  return (
    typeof value === "object" &&
    value !== null &&
    "score" in value &&
    "score_override" in value &&
    "is_droppable" in value &&
    "is_excused" in value &&
    "is_missing" in value &&
    "max_score" in value &&
    "column_slug" in value
  );
}

export async function addDependencySourceFunctions({
  math,
  keys,
  supabase
}: {
  math: MathJsInstance;
  keys: ExprDependencyInstance[];
  supabase: SupabaseClient<Database>;
}) {
  // Create fresh dependency source instances for this batch to ensure
  // they pick up the latest values from the database
  const batchDependencySourceMap = {
    assignments: new AssignmentsDependencySource(),
    gradebook_columns: new GradebookColumnsDependencySource()
  };

  await Promise.all(
    Object.values(batchDependencySourceMap).map((dependencySource) =>
      dependencySource.retrieveValues({ keys, supabase })
    )
  );

  // Union type for all possible import function signatures
  type ImportFunction =
    | ((context: ExpressionContext, ...args: unknown[]) => unknown) // Context functions
    | ((
        a: number | GradebookColumnStudentWithMaxScore,
        b: number | GradebookColumnStudentWithMaxScore
      ) => number | undefined) // Binary operations
    | ((...values: (number | GradebookColumnStudentWithMaxScore)[]) => number | undefined) // Variadic functions like min
    | ((context: ExpressionContext, value: (GradebookColumnStudentWithMaxScore | number)[]) => number | undefined) // sum
    | ((value: number | GradebookColumnStudentWithMaxScore, threshold: number) => 0 | 1) // Comparison functions
    | ((
        context: ExpressionContext,
        value: GradebookColumnStudentWithMaxScore[],
        condition: (value: GradebookColumnStudentWithMaxScore) => boolean
      ) => number | undefined) // countif
    | ((
        context: ExpressionContext,
        value: GradebookColumnStudentWithMaxScore[],
        weighted?: boolean
      ) => number | undefined) // mean
    | ((
        context: ExpressionContext,
        value: GradebookColumnStudentWithMaxScore[],
        count: number
      ) => GradebookColumnStudentWithMaxScore[]) // drop_lowest
    | ((conditions: Matrix<unknown>) => number | undefined) // case_when
    | (() => never); // Security functions that throw errors

  const imports: Record<string, ImportFunction> = {};
  for (const dependencySourceProvider of Object.values(batchDependencySourceMap)) {
    const functionNames = dependencySourceProvider.getFunctionNames();
    for (const functionName of functionNames) {
      imports[functionName] = (context: ExpressionContext, ...args: unknown[]) => {
        const key = args[0] as string | string[];
        const rest = args.slice(1);
        return dependencySourceProvider.execute({
          function_name: functionName,
          context,
          key,
          class_id: context.class_id,
          args: rest
        });
      };
    }
  }

  // Return the dependency source map so it can be used for wildcard expansion
  // during expression compilation
  (math as unknown as Record<string, unknown>)._batchDependencySourceMap = batchDependencySourceMap;

  imports["divide"] = (
    a: number | GradebookColumnStudentWithMaxScore,
    b: number | GradebookColumnStudentWithMaxScore
  ) => {
    if (a === undefined || b === undefined) {
      return undefined;
    }
    let a_val = 0;
    let b_val = 0;
    if (isGradebookColumnStudent(a)) {
      a_val = a.score ?? 0;
    } else if (typeof a === "number") {
      a_val = a;
    }
    if (isGradebookColumnStudent(b)) {
      b_val = b.score ?? 0;
    } else if (typeof b === "number") {
      b_val = b;
    }
    return a_val / b_val;
  };
  imports["subtract"] = (
    a: number | GradebookColumnStudentWithMaxScore,
    b: number | GradebookColumnStudentWithMaxScore
  ) => {
    if (a === undefined || b === undefined) {
      return undefined;
    }
    let a_val = 0;
    let b_val = 0;
    if (isGradebookColumnStudent(a)) {
      a_val = a.score ?? 0;
    } else if (typeof a === "number") {
      a_val = a;
    }
    if (isGradebookColumnStudent(b)) {
      b_val = b.score ?? 0;
    } else if (typeof b === "number") {
      b_val = b;
    }
    return a_val - b_val;
  };
  imports["multiply"] = (
    a: number | GradebookColumnStudentWithMaxScore,
    b: number | GradebookColumnStudentWithMaxScore
  ) => {
    if (a === undefined || b === undefined) {
      return undefined;
    }
    let a_val = 0;
    let b_val = 0;
    if (isGradebookColumnStudent(a)) {
      a_val = a.score ?? 0;
    } else if (typeof a === "number") {
      a_val = a;
    }
    if (isGradebookColumnStudent(b)) {
      b_val = b.score ?? 0;
    } else if (typeof b === "number") {
      b_val = b;
    }
    return a_val * b_val;
  };
  imports["add"] = (a: number | GradebookColumnStudentWithMaxScore, b: number | GradebookColumnStudentWithMaxScore) => {
    if (a === undefined || b === undefined) {
      return undefined;
    }
    let a_val = 0;
    let b_val = 0;
    if (isGradebookColumnStudent(a)) {
      a_val = a.score ?? 0;
    } else if (typeof a === "number") {
      a_val = a;
    }
    if (isGradebookColumnStudent(b)) {
      b_val = b.score ?? 0;
    } else if (typeof b === "number") {
      b_val = b;
    }
    return a_val + b_val;
  };
  imports["sum"] = (_context: ExpressionContext, value: (GradebookColumnStudentWithMaxScore | number)[]) => {
    if (Array.isArray(value)) {
      const values = value
        .map((v) => {
          if (isGradebookColumnStudent(v)) {
            return v.score ?? 0;
          }
          if (typeof v === "number") {
            return v;
          }
          throw new Error(
            `Unsupported value type for sum. Sum can only be applied to gradebook columns or numbers. Got: ${JSON.stringify(v, null, 2)}`
          );
        })
        .filter((v) => v !== undefined);
      if (values.length === 0) {
        return undefined;
      }
      return values.reduce((a, b) => a + b, 0);
    }
    throw new Error(`Sum called with non-array value: ${JSON.stringify(value, null, 2)}`);
  };
  imports["equal"] = (value: number | GradebookColumnStudentWithMaxScore, threshold: number) => {
    if (isGradebookColumnStudent(value)) {
      return value.score === threshold ? 1 : 0;
    }
    return value === threshold ? 1 : 0;
  };
  imports["unequal"] = (value: number | GradebookColumnStudentWithMaxScore, threshold: number) => {
    if (isGradebookColumnStudent(value)) {
      return value.score !== threshold ? 1 : 0;
    }
    return value !== threshold ? 1 : 0;
  };
  imports["largerEq"] = (value: number | GradebookColumnStudentWithMaxScore, threshold: number) => {
    if (isGradebookColumnStudent(value)) {
      return value.score >= threshold ? 1 : 0;
    }
    return value >= threshold ? 1 : 0;
  };
  imports["smallerEq"] = (value: number | GradebookColumnStudentWithMaxScore, threshold: number) => {
    if (isGradebookColumnStudent(value)) {
      return value.score <= threshold ? 1 : 0;
    }
    return value <= threshold ? 1 : 0;
  };
  imports["min"] = (...values: (number | GradebookColumnStudentWithMaxScore)[]) => {
    const validValues = values
      .filter((v) => {
        if (isGradebookColumnStudent(v)) {
          return v.score !== undefined;
        }
        return v !== undefined;
      })
      .map((v) => {
        if (isGradebookColumnStudent(v)) {
          return v.score;
        }
        return v;
      });
    if (validValues.length === 0) {
      return undefined;
    }
    return Math.min(...validValues);
  };
  imports["larger"] = (value: number | GradebookColumnStudentWithMaxScore, threshold: number) => {
    if (isGradebookColumnStudent(value)) {
      return value.score > threshold ? 1 : 0;
    }
    return value > threshold ? 1 : 0;
  };
  imports["smaller"] = (value: number | GradebookColumnStudentWithMaxScore, threshold: number) => {
    if (isGradebookColumnStudent(value)) {
      return value.score < threshold ? 1 : 0;
    }
    return value < threshold ? 1 : 0;
  };
  imports["countif"] = (
    _context: ExpressionContext,
    value: GradebookColumnStudentWithMaxScore[],
    condition: (value: GradebookColumnStudentWithMaxScore) => boolean
  ) => {
    if (Array.isArray(value)) {
      const values = value.map((v) => {
        const ret = condition(v) ? 1 : 0;
        return ret;
      });
      const validValues = values.filter((v) => v !== undefined);
      if (validValues.length === 0) {
        return undefined;
      }
      return validValues.filter((v) => v === 1).length;
    }
    throw new Error("Countif called with non-array value");
  };

  imports["mean"] = (
    _context: ExpressionContext,
    value: GradebookColumnStudentWithMaxScore[],
    weighted: boolean = true
  ) => {
    if (Array.isArray(value)) {
      const valuesToAverage = value.map((v) => {
        if (isGradebookColumnStudent(v)) {
          if (!v.released && !v.is_private) {
            return undefined;
          } else if (v.is_missing) {
            if (v.is_excused) {
              return { score: undefined, max_score: v.max_score };
            }
            return { score: 0, max_score: v.max_score };
          }
          return { score: v.score, max_score: v.max_score };
        }
        if (isArray(v)) {
          throw new Error("Unsupported nesting of arrays");
        }
        throw new Error(
          `Unsupported value type for mean. Mean can only be applied to gradebook columns because it expects a max_score for each value. Got: ${JSON.stringify(v, null, 2)}`
        );
      });
      const validValues = valuesToAverage.filter(
        (v) => v !== undefined && v.score !== undefined && v.max_score !== undefined && v.score !== null
      );
      if (validValues.length === 0) {
        return undefined;
      }
      if (weighted) {
        const totalPoints = validValues.reduce((a, b) => a + (b?.max_score ?? 0), 0);
        const totalScore = validValues.reduce((a, b) => a + (b?.score ?? 0), 0);
        if (totalPoints === 0) {
          return undefined;
        }
        const ret = (100 * totalScore) / totalPoints;
        return ret;
      } else {
        const ret =
          (100 * validValues.reduce((a, b) => a + (b && b.score ? b.score / b.max_score : 0), 0)) / validValues.length;
        return ret;
      }
    }
    throw new Error("Mean called with non-matrix value");
  };
  imports["drop_lowest"] = (
    _context: ExpressionContext,
    value: GradebookColumnStudentWithMaxScore[],
    count: number
  ) => {
    if (Array.isArray(value)) {
      const sorted = [...value].sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
      const ret: GradebookColumnStudentWithMaxScore[] = [];
      let numDropped = 0;
      for (const v of sorted) {
        if (numDropped < count && v.is_droppable) {
          numDropped++;
          continue;
        }
        ret.push(v);
      }
      return ret;
    }
    throw new Error("Drop_lowest called with non-matrix value");
  };
  imports["case_when"] = (conditions: Matrix<unknown>) => {
    const conditionValues = conditions.toArray();
    for (const condition of conditionValues) {
      const [value, result] = condition as [boolean, number];
      if (value) {
        return result;
      }
    }
    return undefined;
  };
  //Remove access to security-sensitive functions
  const securityFunctions = ["import", "createUnit", "reviver", "resolve"];
  for (const functionName of securityFunctions) {
    imports[functionName] = () => {
      throw new Error(`${functionName} is not allowed`);
    };
  }
  math.import(imports, { override: true });
}
