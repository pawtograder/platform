import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isArray, isDenseMatrix, MathJsInstance, Matrix } from "mathjs";
import { minimatch } from "minimatch";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import type {
  Assignment,
  GradebookColumn,
  GradebookColumnStudent,
  GradebookColumnStudentWithMaxScore,
  SubmissionWithGradesForAssignment
} from "./types.d.ts";

export type PrivateProfileId = string;

export type ExpressionContext = {
  student_id: PrivateProfileId;
  is_private_calculation: boolean;
  incomplete_values: IncompleteValuesAdvice | null;
  incomplete_values_policy: "assume_max" | "assume_zero" | "report_only";
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
    class_id
  }: {
    function_name: string;
    context: ExpressionContext;
    key: string | string[];
    class_id: number;
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

  async _retrieveValues({
    keys,
    supabase
  }: {
    keys: ExprDependencyInstance[];
    supabase: SupabaseClient<Database>;
  }): Promise<ResolvedExprDependencyInstance[]> {
    // Fetch all assignments with pagination
    const allAssignments: Assignment[] = [];
    let from = 0;
    const pageSize = 1000;
    const classIds = new Set(keys.map((key) => key.class_id));

    while (true) {
      const to = from + pageSize - 1;
      const { data: assignments, error: assignmentsFetchError } = await supabase
        .from("assignments")
        .select("*")
        .in("class_id", Array.from(classIds))
        .range(from, to);

      if (assignmentsFetchError) {
        throw assignmentsFetchError;
      }

      if (!assignments || assignments.length === 0) {
        break;
      }

      allAssignments.push(...assignments);

      if (assignments.length < pageSize) {
        break;
      }

      from += pageSize;
    }

    for (const assignment of allAssignments) {
      this.assignmentMap.set(assignment.id, assignment);
    }

    const students = new Set<string>(keys.map((key) => key.student_id));
    const assignmentIds = keys.map((key) => Number(key.key));

    // Fetch all submissions with pagination
    const allSubmissions: SubmissionWithGradesForAssignment[] = [];
    from = 0;

    while (true) {
      const to = from + pageSize - 1;
      const { data: submissions, error: submissionsFetchError } = await supabase
        .from("submissions_with_grades_for_assignment")
        .select("*")
        .in("assignment_id", assignmentIds)
        .range(from, to);

      if (submissionsFetchError) {
        throw submissionsFetchError;
      }

      if (!submissions || submissions.length === 0) {
        break;
      }

      allSubmissions.push(...submissions);

      if (submissions.length < pageSize) {
        break;
      }

      from += pageSize;
    }

    const private_results = allSubmissions
      .filter((submission) => students.has(submission.student_id!))
      .map((submission) => ({
        key: submission.assignment_slug ?? "",
        student_id: submission.student_id!,
        value: submission.total_score,
        class_id: submission.class_id!,
        is_private: true
      }));
    const public_results = allSubmissions
      .filter((submission) => students.has(submission.student_id!))
      .map((submission) => ({
        key: submission.assignment_slug ?? "",
        student_id: submission.student_id!,
        value: submission.released ? submission.total_score : undefined,
        class_id: submission.class_id!,
        is_private: false
      }));
    return [...private_results, ...public_results];
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
      context.incomplete_values.missing.gradebook_columns.push(ret.column_slug);
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
  await Promise.all(
    Object.values(DependencySourceMap).map((dependencySource) => dependencySource.retrieveValues({ keys, supabase }))
  );

  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imports: Record<string, (...args: any[]) => unknown> = {};
  for (const dependencySourceProvider of Object.values(DependencySourceMap)) {
    const functionNames = dependencySourceProvider.getFunctionNames();
    for (const functionName of functionNames) {
      imports[functionName] = (context: ExpressionContext, key: string) => {
        return dependencySourceProvider.execute({
          function_name: functionName,
          context,
          key,
          class_id: keys[0].class_id
        });
      };
    }
  }

  imports["multiply"] = (a: number, b: number) => {
    if (a === undefined || b === undefined) {
      return undefined;
    }
    return a * b;
  };
  imports["add"] = (a: number, b: number) => {
    if (a === undefined || b === undefined) {
      return undefined;
    }
    return a + b;
  };
  imports["sum"] = (context: ExpressionContext, value: (GradebookColumnStudentWithMaxScore | number)[]) => {
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
    context: ExpressionContext,
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
    context: ExpressionContext,
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
  imports["drop_lowest"] = (context: ExpressionContext, value: GradebookColumnStudentWithMaxScore[], count: number) => {
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
