import { SupabaseClient } from "@supabase/supabase-js";
import { isArray, isDenseMatrix, MathJsInstance, Matrix } from "mathjs";
import { minimatch } from "minimatch";
import { Database } from "../../_shared/SupabaseTypes.d.ts";
import { Assignment, GradebookColumn, GradebookColumnStudent } from "./types.d.ts";

export type PrivateProfileId = string;

export type ResolvedExprDependencyInstance = ExprDependencyInstance & {
  display: string;
  value: unknown;
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
   * @param student_id
   * @param key
   * @returns
   */
  execute: ({
    function_name,
    student_id,
    key,
    class_id
  }: {
    function_name: string;
    student_id: string;
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
    class_id,
    supabase
  }: {
    keys: ExprDependencyInstance[];
    class_id: number;
    supabase: SupabaseClient<Database>;
  }): Promise<ResolvedExprDependencyInstance[]>;
  async retrieveValues({
    keys,
    class_id,
    supabase
  }: {
    keys: ExprDependencyInstance[];
    class_id: number;
    supabase: SupabaseClient<Database>;
  }): Promise<void> {
    try {
      const allValues = await this._retrieveValues({ keys, class_id, supabase });
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
    student_id,
    key,
    class_id
  }: {
    function_name: string;
    student_id: string;
    key: string | string[];
    class_id: number;
  }): unknown {
    if (typeof key === "object") {
      return key.map(
        (k) => this.valuesMap.get(student_id)?.find((value) => value.key === k && value.class_id === class_id)?.value
      );
    }
    return this.valuesMap.get(student_id)?.find((value) => value.key === key && value.class_id === class_id)?.value;
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
    class_id,
    supabase
  }: {
    keys: ExprDependencyInstance[];
    class_id: number;
    supabase: SupabaseClient<Database>;
  }): Promise<ResolvedExprDependencyInstance[]> {
    const { data: assignments, error: assignmentsFetchError } = await supabase
      .from("assignments")
      .select("*")
      .eq("class_id", class_id);
    if (assignmentsFetchError) {
      throw assignmentsFetchError;
    }
    for (const assignment of assignments) {
      this.assignmentMap.set(assignment.id, assignment);
    }
    const students = new Set<string>(keys.map((key) => key.student_id));
    const assignmentIds = keys.map((key) => Number(key.key));
    const { data: submissions, error: submissionsFetchError } = await supabase
      .from("submissions_with_grades_for_assignment")
      .select("*")
      .in("assignment_id", assignmentIds)
      .eq("class_id", class_id);
    if (submissionsFetchError) {
      throw submissionsFetchError;
    }
    return submissions
      .filter((submission) => students.has(submission.student_id!))
      .map((submission) => ({
        key: submission.assignment_slug ?? "",
        student_id: submission.student_id!,
        value: submission.total_score,
        display: submission.total_score?.toString() ?? "",
        class_id: submission.class_id!
      }));
  }
}

class GradebookColumnsDependencySource extends DependencySourceBase {
  getFunctionNames(): string[] {
    return ["gradebook_columns"];
  }
  private gradebookColumnMap: Map<number, GradebookColumn> = new Map();
  async _retrieveValues({
    keys,
    class_id,
    supabase
  }: {
    keys: ExprDependencyInstance[];
    class_id: number;
    supabase: SupabaseClient<Database>;
  }): Promise<ResolvedExprDependencyInstance[]> {
    const students = new Set<string>(keys.map((key) => key.student_id));
    const gradebookColumnIds = new Set(keys.map((key) => Number(key.key)));
    const uniqueGradebookColumnIds = Array.from(gradebookColumnIds);
    const { data: gradebookColumnStudents, error: gradebookColumnsFetchError } = await supabase
      .from("gradebook_column_students")
      .select("*")
      .in("gradebook_column_id", uniqueGradebookColumnIds)
      .eq("class_id", class_id);
    if (gradebookColumnsFetchError) {
      throw gradebookColumnsFetchError;
    }
    const { data: gradebookColumns, error: gradebookColumnsError } = await supabase
      .from("gradebook_columns")
      .select("*")
      .in("id", uniqueGradebookColumnIds)
      .eq("class_id", class_id);
    if (gradebookColumnsError) {
      throw gradebookColumnsError;
    }
    for (const gradebookColumn of gradebookColumns) {
      this.gradebookColumnMap.set(gradebookColumn.id, gradebookColumn);
    }
    return gradebookColumnStudents
      .filter((studentRecord) => students.has(studentRecord.student_id!))
      .map((studentRecord) => ({
        key: this.gradebookColumnMap.get(studentRecord.gradebook_column_id!)?.slug ?? "unknown",
        student_id: studentRecord.student_id!,
        value: studentRecord,
        display: studentRecord.score?.toString() ?? "",
        class_id: studentRecord.class_id
      }));
  }
  expandKey({ key, class_id }: { key: string; class_id: number }): string[] {
    const matchingColumns = Array.from(this.gradebookColumnMap.values()).filter(
      (column) => column.class_id === class_id && minimatch(column.slug, key)
    );
    return matchingColumns.map((column) => column.slug);
  }

  override execute({
    function_name,
    student_id,
    key,
    class_id
  }: {
    function_name: string;
    student_id: string;
    key: string | string[];
    class_id: number;
  }): unknown {
    if (key === undefined) {
      throw new Error(`Key is undefined for ${function_name} for ${student_id} with class_id ${class_id}`);
    }
    const ret = super.execute({ function_name, student_id, key, class_id });
    if (ret) {
      //If we return a single value, unwrap it to a score
      if (typeof ret === "object" && "score_override" in ret) {
        const val = ret as GradebookColumnStudent;
        if (val.score_override) {
          return val.score_override;
        }
        return val.score;
      } else if (isDenseMatrix(ret)) {
        //If we return an ARRAY of values, keep the whole object to allow for further processing of its fields
        return ret;
      }
    }
    return ret;
  }
}
export const DependencySourceMap = {
  assignments: new AssignmentsDependencySource(),
  gradebook_columns: new GradebookColumnsDependencySource()
};

function isGradebookColumnStudent(value: unknown): value is GradebookColumnStudent {
  return (
    typeof value === "object" &&
    value !== null &&
    "score" in value &&
    "score_override" in value &&
    "is_droppable" in value &&
    "is_excused" in value &&
    "is_missing" in value
  );
}

export async function addDependencySourceFunctions({
  math,
  keys,
  class_id,
  supabase
}: {
  math: MathJsInstance;
  keys: ExprDependencyInstance[];
  class_id: number;
  supabase: SupabaseClient<Database>;
}) {
  await Promise.all(
    Object.values(DependencySourceMap).map((dependencySource) =>
      dependencySource.retrieveValues({ keys, class_id, supabase })
    )
  );

  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imports: Record<string, (...args: any[]) => unknown> = {};
  for (const dependencySourceProvider of Object.values(DependencySourceMap)) {
    const functionNames = dependencySourceProvider.getFunctionNames();
    for (const functionName of functionNames) {
      imports[functionName] = (student_id: string, key: string) => {
        return dependencySourceProvider.execute({
          function_name: functionName,
          student_id,
          key,
          class_id: keys[0].class_id
        });
      };
    }
  }

  imports["importCSV"] = () => {
    return undefined;
  };
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
  imports["mean"] = (value: number | number[] | Matrix) => {
    if (isDenseMatrix(value)) {
      const valuesToAverage = value.toArray().map((v) => {
        if (isGradebookColumnStudent(v)) {
          if (v.is_missing || (v.score === undefined && v.score_override === undefined)) {
            if (v.is_excused) {
              return undefined;
            }
            return 0;
          }
          return v.score_override ?? v.score ?? undefined;
        }
        if (isArray(v)) {
          throw new Error("Unsupported nesting of arrays");
        }
        return Number(v);
      });
      const validValues = valuesToAverage.filter((v) => v !== undefined);
      if (validValues.length === 0) {
        return undefined;
      }
      return validValues.reduce((a, b) => a + b, 0) / validValues.length;
    }
    throw new Error("Mean called with non-matrix value");
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
