import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { isDenseMatrix, MathJsInstance, Matrix } from "mathjs";
import { minimatch } from "minimatch";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";
import type {
  Assignment,
  GradebookColumn,
  GradebookColumnStudent,
  GradebookColumnStudentWithMaxScore
} from "./types.d.ts";
import { addCommonExpressionFunctions, COMMON_CONTEXT_FUNCTIONS } from "./commonMathFunctions.ts";
import {
  type IncompleteValuesAdvice,
  pickPreferredGradebookValue,
  pushMissingDependenciesToContext
} from "./shared.ts";

export type PrivateProfileId = string;

export type ExpressionContext = {
  student_id: PrivateProfileId;
  is_private_calculation: boolean;
  incomplete_values: IncompleteValuesAdvice | null;
  incomplete_values_policy: "assume_max" | "assume_zero" | "report_only";
  scope: Sentry.Scope;
  class_id: number;
};
export type ResolvedExprDependencyInstance = ExprDependencyInstance & {
  value: unknown;
  is_private: boolean;
  /** True when the gradebook column is staff-only until released (student view frozen after release). */
  instructor_only?: boolean;
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
      const matchPrivate = (k: string) =>
        this.valuesMap.get(context.student_id)?.find((value) => {
          if (value.key !== k || value.class_id !== class_id) return false;
          if (value.instructor_only) {
            return value.is_private === true;
          }
          return value.is_private === context.is_private_calculation;
        })?.value;
      if (Array.isArray(key)) {
        const ret = key.map((k) => matchPrivate(k as string));
        return ret;
      }
      if (isDenseMatrix(key)) {
        const ret = (key as Matrix<string>).toArray().map((k) => matchPrivate(k as string));
        return ret;
      }
      throw new Error(`Unsupported key type: ${typeof key}`);
    }
    const studentValues = this.valuesMap.get(context.student_id);
    const matchingValue = studentValues?.find((value) => {
      if (value.key !== key || value.class_id !== class_id) return false;
      if (value.instructor_only) {
        return value.is_private === true;
      }
      return value.is_private === context.is_private_calculation;
    });
    return matchingValue?.value;
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

    type ReviewsByRoundRow = {
      assignment_id: number;
      class_id: number;
      student_private_profile_id: string;
      assignment_slug: string | null;
      scores_by_round_private: Record<string, number | null> | null;
      scores_by_round_public: Record<string, number | null> | null;
      individual_scores: Partial<Record<string, number>> | null;
      per_student_grading_totals: Partial<Record<string, number>> | null;
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
          "assignment_id, class_id, student_private_profile_id, assignment_slug, scores_by_round_private, scores_by_round_public, individual_scores, per_student_grading_totals"
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
      // Prefer per_student_grading_totals (shared hand + autograde + tweak + individual slice).
      // Else fall back to individual_scores (legacy slice only) when present.
      const profileId = row.student_private_profile_id;
      const combined = row.per_student_grading_totals?.[profileId];
      if (combined !== undefined && combined !== null) {
        const studentScore = Number(combined);
        if (!Number.isNaN(studentScore)) {
          privateByRound["grading-review"] = studentScore;
          if (publicByRound["grading-review"] !== undefined) {
            publicByRound["grading-review"] = studentScore;
          }
        }
      } else if (row.individual_scores && profileId in row.individual_scores) {
        const raw = row.individual_scores[profileId];
        const studentScore = raw !== undefined && raw !== null ? Number(raw) : NaN;
        if (!Number.isNaN(studentScore)) {
          privateByRound["grading-review"] = studentScore;
          if (publicByRound["grading-review"] !== undefined) {
            publicByRound["grading-review"] = studentScore;
          }
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
      const resolveValue = (slug: string) => {
        const overrideVal = readOverride(slug);
        const baseVal = readBase(slug);
        return pickPreferredGradebookValue(overrideVal, baseVal);
      };
      if (typeof key === "object") {
        if (Array.isArray(key)) {
          const values = key.map((k) => {
            if (typeof k !== "string") return undefined;
            return resolveValue(k);
          });
          pushMissingDependenciesToContext(
            context,
            values.filter((v): v is GradebookColumnStudentWithMaxScore => !!v)
          );
          return values;
        }
        if (isDenseMatrix(key)) {
          const values = (key as Matrix<string>).toArray().map((k) => {
            if (typeof k !== "string") return undefined;
            return resolveValue(k);
          });
          pushMissingDependenciesToContext(
            context,
            values.filter((v): v is GradebookColumnStudentWithMaxScore => !!v)
          );
          return values;
        }
      } else if (typeof key === "string") {
        const value = resolveValue(key);
        if (value) {
          pushMissingDependenciesToContext(context, value);
          return value;
        }
      }
    }

    const ret = super.execute({ function_name, context, key, class_id }) as
      | GradebookColumnStudentWithMaxScore
      | GradebookColumnStudentWithMaxScore[];
    pushMissingDependenciesToContext(context, ret);

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
    const studentIds = Array.from(students);

    // Fetch gradebook column students using the bulk RPC function with pagination
    // The RPC function uses stable sorting (ORDER BY id) to ensure consistent pagination
    const allGradebookColumnStudents: GradebookColumnStudent[] = [];
    const pageSize = 1000;
    let offset = 0;

    while (true) {
      const { data: pageData, error: rpcError } = await (
        supabase.rpc as unknown as (
          name: string,
          args: {
            p_student_ids: unknown;
            p_gradebook_column_ids: unknown;
            p_limit: number;
            p_offset: number;
          }
        ) => Promise<{ data: GradebookColumnStudent[] | null; error: unknown }>
      )("get_gradebook_column_students_bulk", {
        p_student_ids: studentIds,
        p_gradebook_column_ids: uniqueGradebookColumnIds,
        p_limit: pageSize,
        p_offset: offset
      });

      if (rpcError) {
        throw new Error(
          `Failed to fetch gradebook column students via RPC at offset ${offset}: ${JSON.stringify(rpcError)}`
        );
      }

      if (!pageData || pageData.length === 0) {
        break;
      }

      allGradebookColumnStudents.push(...pageData);

      // If we got fewer rows than the page size, we've reached the end
      if (pageData.length < pageSize) {
        break;
      }

      offset += pageSize;
    }

    // Fetch all gradebook columns with pagination
    const allGradebookColumns: GradebookColumn[] = [];
    let from = 0;
    const columnPageSize = 1000;

    while (true) {
      const to = from + columnPageSize - 1;
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

      if (gradebookColumns.length < columnPageSize) {
        break;
      }

      from += columnPageSize;
    }

    for (const gradebookColumn of allGradebookColumns) {
      this.gradebookColumnMap.set(gradebookColumn.id, gradebookColumn);
    }
    const ret = allGradebookColumnStudents
      .filter((studentRecord) => students.has(studentRecord.student_id!))
      .map((studentRecord) => {
        const col = this.gradebookColumnMap.get(studentRecord.gradebook_column_id!);
        const instructorOnly = Boolean(col?.instructor_only);
        return {
          key: col?.slug ?? "unknown",
          student_id: studentRecord.student_id!,
          value: {
            ...studentRecord,
            score: studentRecord.score_override ?? studentRecord.score ?? null,
            max_score: col?.max_score ?? 0,
            column_slug: col?.slug ?? "unknown"
          },
          display: studentRecord.score?.toString() ?? "",
          class_id: studentRecord.class_id,
          is_private: studentRecord.is_private,
          instructor_only: instructorOnly
        };
      });
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
export const ContextFunctions = [...COMMON_CONTEXT_FUNCTIONS];

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

  type ImportFunction = (...args: never[]) => unknown;
  const imports: Record<string, ImportFunction> = {};
  for (const dependencySourceProvider of Object.values(batchDependencySourceMap)) {
    const functionNames = dependencySourceProvider.getFunctionNames();
    for (const functionName of functionNames) {
      imports[functionName] = ((context: ExpressionContext, ...args: unknown[]) => {
        const key = args[0] as string | string[];
        const rest = args.slice(1);
        return dependencySourceProvider.execute({
          function_name: functionName,
          context,
          key,
          class_id: context.class_id,
          args: rest
        });
      }) as ImportFunction;
    }
  }

  // Return the dependency source map so it can be used for wildcard expansion
  // during expression compilation
  (math as unknown as Record<string, unknown>)._batchDependencySourceMap = batchDependencySourceMap;

  addCommonExpressionFunctions(imports, {
    enforcePrivateCalculationMatch: true,
    includeSecurityGuards: true
  });
  math.import(imports, { override: true });
}
