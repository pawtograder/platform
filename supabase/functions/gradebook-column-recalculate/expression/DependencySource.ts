import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
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
    return coerceRoundValue(raw);
  }

  async _retrieveValues({
    keys,
    supabase
  }: {
    keys: ExprDependencyInstance[];
    supabase: SupabaseClient<Database>;
  }): Promise<ResolvedExprDependencyInstance[]> {
    // Fetch assignments referenced by keys (ids)
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

    // Gather students in this batch
    const students = new Set<string>(keys.map((key) => key.student_id));

    // Fetch active submissions for these assignments
    const allSubmissions: { id: number; assignment_id: number; profile_id: string }[] = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const to = from + pageSize - 1;
      const { data: subs, error: subsError } = await supabase
        .from("submissions")
        .select("id, assignment_id, profile_id")
        .in("assignment_id", assignmentIds)
        .eq("is_active", true)
        .range(from, to);
      if (subsError) {
        throw subsError;
      }
      if (!subs || subs.length === 0) break;
      allSubmissions.push(...subs);
      if (subs.length < pageSize) break;
      from += pageSize;
    }

    const submissionIds = allSubmissions.map((s) => s.id);
    if (submissionIds.length === 0) {
      return [];
    }

    // Fetch submission reviews joined with rubrics to get review_round
    const allReviews: Array<{
      submission_id: number;
      total_score: number | null;
      released: boolean | null;
      review_round: string | null;
    }> = [];
    from = 0;
    while (true) {
      const to = from + pageSize - 1;
      const { data: reviews, error: reviewsError } = await supabase
        .from("submission_reviews")
        .select("submission_id, total_score, released, rubrics(review_round)")
        .in("submission_id", submissionIds)
        .range(from, to);
      if (reviewsError) {
        throw reviewsError;
      }
      if (!reviews || reviews.length === 0) break;
      for (const r of reviews) {
        allReviews.push({
          submission_id: r.submission_id as number,
          total_score: (r as unknown as { total_score: number | null }).total_score ?? null,
          released: (r as unknown as { released: boolean | null }).released ?? null,
          review_round:
            (r as unknown as { rubrics: { review_round: string | null } | null }).rubrics?.review_round ?? null
        });
      }
      if (reviews.length < pageSize) break;
      from += pageSize;
    }

    // Build maps for quick lookup
    const submissionByAssignmentAndStudent = new Map<
      string,
      { id: number; assignment_id: number; profile_id: string }
    >();
    for (const sub of allSubmissions) {
      submissionByAssignmentAndStudent.set(`${sub.assignment_id}:${sub.profile_id}`, sub);
    }

    const reviewsBySubmission = new Map<
      number,
      Array<{ total_score: number | null; released: boolean | null; review_round: string | null }>
    >();
    for (const rev of allReviews) {
      const arr = reviewsBySubmission.get(rev.submission_id) ?? [];
      arr.push(rev);
      reviewsBySubmission.set(rev.submission_id, arr);
    }

    // Build resolved values per student and assignment
    const results: ResolvedExprDependencyInstance[] = [];
    for (const student_id of students) {
      for (const assignmentId of assignmentIds) {
        const sub = submissionByAssignmentAndStudent.get(`${assignmentId}:${student_id}`);
        const assignment = this.assignmentMap.get(assignmentId);
        if (!assignment || !assignment.slug) continue;
        const keySlug = assignment.slug;
        const class_id = assignment.class_id!;
        const reviews = sub ? (reviewsBySubmission.get(sub.id) ?? []) : [];
        // Aggregate scores by review_round
        const privateScoreByRound: Record<string, number | undefined> = {};
        const publicScoreByRound: Record<string, number | undefined> = {};
        for (const rv of reviews) {
          const round = rv.review_round ?? "grading-review";
          const score = rv.total_score ?? undefined;
          privateScoreByRound[round] = score;
          publicScoreByRound[round] = rv.released ? score : undefined;
        }
        results.push({ key: keySlug, student_id, value: privateScoreByRound, class_id, is_private: true });
        results.push({ key: keySlug, student_id, value: publicScoreByRound, class_id, is_private: false });
      }
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
    const ret = super.execute({ function_name, context, key, class_id }) as GradebookColumnStudentWithMaxScore;
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
      if (ret) {
        context.incomplete_values.missing.gradebook_columns.push(ret.column_slug);
      }
    }
    if (
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
        console.error(`Error fetching gradebook column students (range ${from}-${to}):`, gradebookColumnsFetchError);
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
        console.error(`Error fetching gradebook columns (range ${from}-${to}):`, gradebookColumnsError);
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
    return allGradebookColumnStudents
      .filter((studentRecord) => students.has(studentRecord.student_id!))
      .map((studentRecord) => ({
        key: this.gradebookColumnMap.get(studentRecord.gradebook_column_id!)?.slug ?? "unknown",
        student_id: studentRecord.student_id!,
        value: {
          ...studentRecord,
          score: studentRecord.score_override ?? studentRecord.score ?? 0,
          max_score: this.gradebookColumnMap.get(studentRecord.gradebook_column_id!)?.max_score ?? 0,
          column_slug: this.gradebookColumnMap.get(studentRecord.gradebook_column_id!)?.slug ?? "unknown"
        },
        display: studentRecord.score?.toString() ?? "",
        class_id: studentRecord.class_id,
        is_private: studentRecord.is_private
      }));
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

  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imports: Record<string, (...args: any[]) => unknown> = {};
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
          class_id: keys[0].class_id,
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
        (v) => v !== undefined && v.score !== undefined && v.max_score !== undefined
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
    console.log("Mean called with non-matrix value", value);
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
