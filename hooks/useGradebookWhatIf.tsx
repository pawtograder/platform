import { GradebookColumnStudent, GradebookColumnWithEntries } from "@/utils/supabase/DatabaseTypes";
import { all, create, FunctionNode, MathNode } from "mathjs";
import { minimatch } from "minimatch";
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { GradebookController, useGradebookController } from "./useGradebook";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { createClient } from "@/utils/supabase/client";
import { CourseController, useCourseController } from "./useCourseController";
import { Spinner } from "@chakra-ui/react";
import * as Sentry from "@sentry/nextjs";
import { toaster } from "@/components/ui/toaster";
import {
  dedupeIncompleteValues,
  pushMissingDependenciesToContext
} from "@/supabase/functions/gradebook-column-recalculate/expression/shared";
import {
  addCommonExpressionFunctions,
  COMMON_CONTEXT_FUNCTIONS
} from "@/supabase/functions/gradebook-column-recalculate/expression/commonMathFunctions";
import type { IncompleteValuesAdvice } from "@/supabase/functions/gradebook-column-recalculate/expression/shared";

const TRACE_WHAT_IF_CALCULATIONS = false;

export type ExpressionContext = {
  student_id: string;
  is_private_calculation: boolean;
  incomplete_values: IncompleteValuesAdvice | null;
  incomplete_values_policy: "assume_max" | "assume_zero" | "report_only";
  scope: Sentry.Scope;
  class_id: number;
};
//These functions should be called with a context object as the first argument
export const ContextFunctions = [...COMMON_CONTEXT_FUNCTIONS, "gradebook_columns", "assignments"];

export type { IncompleteValuesAdvice } from "@/supabase/functions/gradebook-column-recalculate/expression/shared";

export type WhatIfGradeValue = {
  what_if: number | undefined;
  report_only: number | undefined;
  assume_max: number | undefined;
  assume_zero: number | undefined;
  gradebook_score: number | undefined;
};
export type GradebookWhatIfGradeMap = Record<number, WhatIfGradeValue | undefined>;
export type GradebookWhatIfIncompleteValuesMap = Record<number, IncompleteValuesAdvice | null>;
export type GradebookColumnStudentWithMaxScore = Omit<GradebookColumnStudent, "score"> & {
  score: number;
  max_score: number;
  column_slug: string;
};

type AssignmentForStudentDashboard = Database["public"]["Views"]["assignments_for_student_dashboard"]["Row"];
class GradebookWhatIfController {
  private _grades: GradebookWhatIfGradeMap = {};
  public debugID: string = crypto.randomUUID();
  private _incompleteValues: GradebookWhatIfIncompleteValuesMap = {};
  private _subscribers: (() => void)[] = [];
  // Tracks columns explicitly set by user input (vs derived what-if values).
  private _userSetWhatIfColumns = new Set<number>();
  private _gradebookUnsubscribe: (() => void) | null = null;
  private _assignments: AssignmentForStudentDashboard[] = [];
  // Track shown errors to avoid spamming the user with duplicate toasts (scoped per controller instance)
  private _shownExpressionErrors = new Set<string>();

  constructor(
    private gradebookController: GradebookController,
    private private_profile_id: string,
    private courseController: CourseController
  ) {
    this.initializeGradebookGrades();
    this.setupGradebookListener();
  }

  private initializeGradebookGrades() {
    //Fetch all assignments for the student with their submissions
    const client = createClient();
    client
      .from("assignments_for_student_dashboard")
      .select("*")
      .eq("class_id", this.gradebookController.class_id)
      .eq("student_user_id", this.courseController.userId)
      .eq("student_profile_id", this.private_profile_id)
      .then(({ data }) => {
        this._assignments = data ?? [];
      });
    // Initialize with current grades from the gradebook
    const allColumns = this.gradebookController.columns as GradebookColumnWithEntries[];
    for (const column of allColumns) {
      const columnStudent = this.gradebookController.getGradebookColumnStudent(column.id, this.private_profile_id);
      // Initialize grade entry for all columns, even if student doesn't have an existing entry
      const gradebookScore = columnStudent
        ? columnStudent.score_override !== null
          ? columnStudent.score_override
          : (columnStudent.score ?? undefined)
        : undefined;

      this._grades[column.id] = {
        what_if: undefined,
        report_only: undefined,
        assume_max: undefined,
        assume_zero: undefined,
        gradebook_score: gradebookScore
      };
    }
    // Recalculate all dependent formula columns (initial full pass)
    this.recalculateDependentColumns();
  }

  private setupGradebookListener() {
    // Subscribe to gradebook column student changes for this specific student
    this._gradebookUnsubscribe = this.gradebookController.subscribeColumnsForStudent(
      this.private_profile_id,
      (students) => {
        let hasChanges = false;
        const changedColumnIds: number[] = [];

        for (const student of students) {
          const gradebookScore =
            student.score_override !== null ? student.score_override : (student.score ?? undefined);
          const existingGrade = this._grades[student.gradebook_column_id];
          if (!existingGrade || existingGrade.gradebook_score !== gradebookScore) {
            if (!existingGrade) {
              this._grades[student.gradebook_column_id] = {
                what_if: undefined,
                report_only: undefined,
                assume_max: undefined,
                assume_zero: undefined,
                gradebook_score: gradebookScore
              };
            } else {
              existingGrade.gradebook_score = gradebookScore;
            }
            hasChanges = true;
            changedColumnIds.push(student.gradebook_column_id);
          }
        }

        // If there were changes, recalculate any what-if grades that depend on these columns
        if (hasChanges) {
          this.recalculateDependentColumns(changedColumnIds);
        }
      }
    );
  }

  private recalculateDependentColumns(startingColumnIds?: number[]) {
    const allColumns = this.gradebookController.columns as GradebookColumnWithEntries[];
    // If specific starting columns provided, recalc only downstream dependents transitively via recalculate()
    if (startingColumnIds && startingColumnIds.length > 0) {
      const started = new Set<number>();
      for (const changedId of startingColumnIds) {
        for (const column of allColumns) {
          if (column.dependencies?.gradebook_columns?.includes(changedId)) {
            if (!started.has(column.id)) {
              started.add(column.id);
              this.recalculate(column.id);
            }
          }
        }
      }
      return;
    }
    // Otherwise, full pass: recalc all formula columns
    for (const column of allColumns) {
      if (column.dependencies?.gradebook_columns) {
        this.recalculate(column.id);
      }
    }
  }

  getGrade(columnId: number): WhatIfGradeValue | undefined {
    return this._grades[columnId];
  }

  getIncompleteValues(columnId: number): IncompleteValuesAdvice | null {
    return this._incompleteValues[columnId] ?? null;
  }

  // Check if a column depends on other columns that have user-set what-if values
  private hasWhatIfDependencies(columnId: number): boolean {
    const allColumns = this.gradebookController.columns as GradebookColumnWithEntries[];
    const column = allColumns.find((c) => c.id === columnId);

    if (!column?.dependencies?.gradebook_columns) {
      return false;
    }

    // Recursively check if any dependency has user-set what-if values
    const checkDependencies = (depColumnId: number, visited = new Set<number>()): boolean => {
      if (visited.has(depColumnId)) return false; // Prevent cycles
      visited.add(depColumnId);

      const depGrade = this._grades[depColumnId];

      // If this dependency has a user-set what-if value, return true
      if (depGrade?.what_if !== undefined) {
        const depColumn = allColumns.find((c) => c.id === depColumnId);
        // Check if it's a user-editable column (no dependencies) with a what-if value
        // OR if it's a calculated column that depends on user what-if values
        if (!depColumn?.dependencies?.gradebook_columns) {
          // This is a user-editable column with a what-if value
          return true;
        } else {
          // This is a calculated column, check its dependencies recursively
          return depColumn.dependencies.gradebook_columns.some((subDepId) =>
            checkDependencies(subDepId, new Set(visited))
          );
        }
      }

      return false;
    };

    return column.dependencies.gradebook_columns.some((depId) => checkDependencies(depId));
  }

  setWhatIfGrade(columnId: number, value: number | undefined, incompleteValues: IncompleteValuesAdvice | null) {
    if (!this._grades[columnId]) {
      // Create grade entry if it doesn't exist (safety net)
      this._grades[columnId] = {
        what_if: value,
        report_only: undefined,
        assume_max: undefined,
        assume_zero: undefined,
        gradebook_score: undefined
      };
    } else {
      this._grades[columnId] = {
        ...this._grades[columnId],
        what_if: value
      };
    }
    if (value === undefined) {
      this._userSetWhatIfColumns.delete(columnId);
    } else {
      this._userSetWhatIfColumns.add(columnId);
    }
    this._incompleteValues[columnId] = incompleteValues;
    //Find everything that depends on this column
    const allColumns = this.gradebookController.columns as GradebookColumnWithEntries[];
    for (const column of allColumns) {
      if (column.dependencies?.gradebook_columns?.includes(columnId)) {
        this.recalculate(column.id);
      }
    }
    this.notify();
  }

  // Clear what-if grades for a column
  clearGrade(columnId: number) {
    const existingGrade = this._grades[columnId];
    if (existingGrade) {
      // Preserve the gradebook score but clear what-if grades
      this._grades[columnId] = {
        what_if: undefined,
        report_only: undefined,
        assume_max: undefined,
        assume_zero: undefined,
        gradebook_score: existingGrade.gradebook_score
      };
    }
    this._userSetWhatIfColumns.delete(columnId);
    delete this._incompleteValues[columnId];
    // Recalculate dependent columns
    const allColumns = this.gradebookController.columns as GradebookColumnWithEntries[];
    for (const column of allColumns) {
      if (column.dependencies?.gradebook_columns?.includes(columnId)) {
        this.recalculate(column.id);
      }
    }
    this.notify();
  }

  // Naive recalculation: just returns the input value for now
  recalculate(columnId: number, history: number[] = []) {
    if (history.includes(columnId)) throw new Error(`Cycle detected: ${history.join(" -> ")} -> ${columnId}`);
    history.push(columnId);
    // In the future, this could recalculate all columns based on dependencies
    // For now, do nothing (tentative grade is just the input)
    const column = this.gradebookController.getGradebookColumn(columnId);
    const allColumns = this.gradebookController.columns as GradebookColumnWithEntries[];
    if (!column) return;
    if (column.score_expression) {
      const math = create(all, {});
      type ImportFunction = (...args: never[]) => unknown;
      const imports: Record<string, ImportFunction> = {};
      imports["gradebook_columns"] = ((context: ExpressionContext, columnSlug: string | string[]) => {
        if (TRACE_WHAT_IF_CALCULATIONS) {
          console.log("context", context);
          console.log("columnSlug", columnSlug);
        }
        const findOne = (slug: string) => {
          const matchingColumns = allColumns.filter((c) => minimatch(c.slug, slug));
          if (!matchingColumns.length) return null;
          if (TRACE_WHAT_IF_CALCULATIONS) {
            console.log("matchingColumns", matchingColumns);
          }
          const scoreForColumnID = (columnId: number) => {
            const whatIfVal = this.getGrade(columnId);
            const incompleteValues = this.getIncompleteValues(columnId);
            const columnStudent = this.gradebookController.getGradebookColumnStudent(columnId, this.private_profile_id);

            const thisColumn = allColumns.find((c) => c.id === columnId);
            if (!thisColumn) {
              throw new Error(`Column ${columnId} not found in allColumns`);
            }
            //Determine which score to use
            let score: number | undefined;
            let released = columnStudent?.released ?? false;
            let is_missing = columnStudent?.is_missing ?? true;
            if (TRACE_WHAT_IF_CALCULATIONS) {
              console.log("===========Getting Score For Column =============");
              console.log("columnStudent", columnStudent);
              console.log("whatIfVal", whatIfVal);
              console.log("incompleteValues", incompleteValues);
              console.log("context", context);
              console.log("columnSlug", columnSlug);
              console.log("================================================");
            }

            if (columnStudent?.score_override !== null && columnStudent?.score_override !== undefined) {
              score = columnStudent.score_override;
              is_missing = false;
              released = true;
              if (incompleteValues) {
                delete incompleteValues.missing;
                delete incompleteValues.not_released;
              }
            } else if (whatIfVal?.what_if !== undefined && whatIfVal.what_if !== null) {
              score = whatIfVal.what_if;
              is_missing = false;
              released = true;
            } else if (!released && context.incomplete_values_policy !== "report_only") {
              if (context.incomplete_values_policy === "assume_max") {
                is_missing = false;
                released = true;
                if (whatIfVal?.assume_max !== undefined && whatIfVal.assume_max !== null) {
                  score = whatIfVal.assume_max;
                } else {
                  score = thisColumn.max_score ?? 0;
                }
              } else if (context.incomplete_values_policy === "assume_zero") {
                is_missing = false;
                released = true;
                if (whatIfVal?.assume_zero !== undefined && whatIfVal.assume_zero !== null) {
                  score = whatIfVal.assume_zero;
                } else {
                  score = 0;
                }
              }
            } else if (columnStudent?.score !== null && columnStudent?.score !== undefined) {
              score = columnStudent.score;
            } else {
              score = undefined;
            }

            const ret: GradebookColumnStudentWithMaxScore = {
              is_missing: is_missing,
              is_excused: false,
              is_droppable: true,
              score: score ?? 0,
              score_override: null,
              class_id: column.class_id,
              created_at: column.created_at,
              gradebook_column_id: column.id,
              gradebook_id: column.gradebook_id,
              id: thisColumn!.id,
              released: released,
              score_override_note: null,
              student_id: this.private_profile_id,
              max_score: thisColumn?.max_score ?? 0,
              incomplete_values: incompleteValues,
              is_private: false,
              is_recalculating: false,
              column_slug: thisColumn!.slug!,
              updated_at: column.updated_at
            };
            //Find any not released or missing values that this column depends on
            const existingIncompleteValues = this.getIncompleteValues(columnId);
            if (existingIncompleteValues && ret.score_override === null) {
              if (existingIncompleteValues.missing?.gradebook_columns) {
                if (!context.incomplete_values) {
                  context.incomplete_values = {};
                }
                if (!context.incomplete_values?.missing) {
                  context.incomplete_values.missing = {};
                }
                if (!context.incomplete_values.missing.gradebook_columns) {
                  context.incomplete_values.missing.gradebook_columns = [];
                }
                context.incomplete_values.missing.gradebook_columns.push(
                  ...existingIncompleteValues.missing.gradebook_columns
                );
              }
              if (existingIncompleteValues.not_released?.gradebook_columns) {
                if (!context.incomplete_values) {
                  context.incomplete_values = {};
                }
                if (!context.incomplete_values?.not_released) {
                  context.incomplete_values.not_released = {};
                }
                if (!context.incomplete_values.not_released.gradebook_columns) {
                  context.incomplete_values.not_released.gradebook_columns = [];
                }
                context.incomplete_values.not_released.gradebook_columns.push(
                  ...existingIncompleteValues.not_released.gradebook_columns
                );
              }
            }

            // Track not-released values the same way as backend report_only behavior.
            if (!ret.released && !ret.is_private && (ret.score === null || ret.score === undefined)) {
              if (!context.incomplete_values) {
                context.incomplete_values = {};
              }
              if (!context.incomplete_values?.not_released) {
                context.incomplete_values.not_released = {};
              }
              if (!context.incomplete_values.not_released.gradebook_columns) {
                context.incomplete_values.not_released.gradebook_columns = [];
              }
              context.incomplete_values.not_released.gradebook_columns.push(ret.column_slug!);
            }
            pushMissingDependenciesToContext(context, ret);
            return ret;
          };
          if (matchingColumns.length === 1 && !slug.includes("*")) {
            return scoreForColumnID(matchingColumns[0].id);
          } else {
            return matchingColumns.map((col) => scoreForColumnID(col.id));
          }
        };
        if (Array.isArray(columnSlug)) {
          const ret = columnSlug.map(findOne);
          return ret;
        } else {
          const ret = findOne(columnSlug);
          if (ret && !columnSlug.includes("*")) {
            return ret;
          }
          if (Array.isArray(ret)) {
            return ret;
          }
          return [ret as GradebookColumnStudent];
        }
      }) as ImportFunction;
      imports["assignments"] = ((_context: ExpressionContext, assignmentSlug: string | string[]) => {
        const findOne = (slug: string) => {
          const matchingAssignments = this.gradebookController.assignments?.filter(
            (a) => a.slug && minimatch(a.slug, slug)
          );
          if (!matchingAssignments.length) return null;
          // To find a temporary what-if, find a column that depends on only this assignment
          const column = allColumns.find((c) => c.dependencies?.assignments?.includes(matchingAssignments[0].id));
          if (column) {
            const whatIfVal = this.getGrade(column.id);
            if (whatIfVal) return whatIfVal;
          }
          const assignment = this._assignments.find((a) => a.id === matchingAssignments[0].id);
          if (!assignment || assignment.total_points === null) return null;
          return assignment.total_points;
        };
        if (Array.isArray(assignmentSlug)) {
          const ret = assignmentSlug.map(findOne);
          return ret;
        } else {
          const ret = findOne(assignmentSlug);
          return ret;
        }
      }) as ImportFunction;
      addCommonExpressionFunctions(imports, {
        includeSecurityGuards: false
      });

      math.import(imports, { override: true });
      if (column.score_expression) {
        const expr = math.parse(column.score_expression);
        //instrument the functions that are called with a context object as the first argument
        const instrumented = expr.transform((node: MathNode) => {
          if (node.type === "FunctionNode") {
            const fn = node as FunctionNode;
            if (ContextFunctions.includes(fn.fn.name)) {
              const newArgs: MathNode[] = [];
              newArgs.push(new math.SymbolNode("context"));
              newArgs.push(...fn.args);
              fn.args = newArgs;
              return node;
            }
          }
          return node;
        });

        const scores: WhatIfGradeValue = {
          what_if: undefined,
          report_only: undefined,
          assume_max: undefined,
          assume_zero: undefined,
          gradebook_score: this._grades[columnId]?.gradebook_score
        };
        for (const policy of ["assume_max", "assume_zero", "report_only"]) {
          const context: ExpressionContext = {
            student_id: this.private_profile_id,
            is_private_calculation: false,
            incomplete_values: {},
            incomplete_values_policy: policy as "assume_max" | "assume_zero" | "report_only",
            scope: new Sentry.Scope(),
            class_id: this.gradebookController.class_id
          };
          let result;
          let evalError: Error | null = null;
          try {
            result = instrumented.evaluate({
              context: context
            });
          } catch (err) {
            evalError = err instanceof Error ? err : new Error(String(err));
            // Log to Sentry but don't crash the app
            Sentry.captureException(err, {
              extra: {
                columnId,
                policy,
                columnSlug: column.slug,
                expression: column.score_expression
              }
            });
            // Show toast only once per column to avoid spamming the user
            const errorKey = `${columnId}`;
            if (!this._shownExpressionErrors.has(errorKey)) {
              this._shownExpressionErrors.add(errorKey);
              toaster.create({
                title: "Grade calculation error",
                description: `Unable to calculate "${column.name || column.slug}". We've been notified and are looking into it.`,
                type: "warning",
                duration: 8000
              });
            }
          }
          // If evaluation failed, skip processing this policy
          if (evalError) {
            scores[policy as "report_only" | "assume_max" | "assume_zero"] = undefined;
            continue;
          }
          let score: number;
          if (typeof result === "object" && result !== null && "entries" in result) {
            const lastEntry = result.entries[result.entries.length - 1];
            score = Number(lastEntry);
          } else {
            score = Number(result);
          }
          scores[policy as "report_only" | "assume_max" | "assume_zero"] = score;
          if (policy === "report_only") {
            this._incompleteValues[columnId] = dedupeIncompleteValues(context.incomplete_values) ?? null;
          }
        }

        // Determine if we should show a what-if value
        const existingWhatIf = this._grades[columnId]?.what_if;
        const hasUserSetWhatIf = this._userSetWhatIfColumns.has(columnId);

        // Check if this column depends on other columns with user-set what-if values
        const hasWhatIfDependencies = this.hasWhatIfDependencies(columnId);

        if (hasUserSetWhatIf) {
          // User has explicitly set a what-if value, preserve it
          scores.what_if = existingWhatIf;
        } else if (
          hasWhatIfDependencies &&
          scores.gradebook_score !== scores.report_only &&
          scores.report_only !== null
        ) {
          // This calculated column depends on other columns with what-if values
          // and the calculated result differs from the gradebook score
          scores.what_if = scores.report_only;
        } else {
          // No user-set what-if value and no what-if dependencies
          scores.what_if = undefined;
        }
        if (Number.isNaN(scores.what_if ?? 0)) {
          scores.what_if = undefined;
        }
        if (Number.isNaN(scores.report_only ?? 0)) {
          scores.report_only = undefined;
        }
        if (Number.isNaN(scores.assume_max ?? 0)) {
          scores.assume_max = undefined;
        }
        if (Number.isNaN(scores.assume_zero ?? 0)) {
          scores.assume_zero = undefined;
        }
        this._grades[columnId] = scores;
      }
      //Find everything that depends on this column
      for (const column of allColumns) {
        if (column.dependencies?.gradebook_columns?.includes(columnId)) {
          this.recalculate(column.id, [...history]);
        }
      }
    }
  }
  subscribe(cb: () => void) {
    this._subscribers.push(cb);
    return () => {
      this._subscribers = this._subscribers.filter((fn) => fn !== cb);
    };
  }

  notify() {
    this._subscribers.forEach((cb) => cb());
  }

  // Cleanup method to unsubscribe from gradebook listener
  cleanup() {
    if (this._gradebookUnsubscribe) {
      this._gradebookUnsubscribe();
      this._gradebookUnsubscribe = null;
    }
    // Clear error tracking Set when controller is cleaned up
    this._shownExpressionErrors.clear();
    this._userSetWhatIfColumns.clear();
  }
}

const GradebookWhatIfContext = createContext<GradebookWhatIfController | null>(null);

function GradebookWhatIfProviderInternal({
  children,
  private_profile_id
}: {
  children: React.ReactNode;
  private_profile_id: string;
}) {
  const gradebookController = useGradebookController();
  const courseController = useCourseController();
  const controllerRef = useRef<GradebookWhatIfController | null>(null);

  // Cleanup and reinitialize when private_profile_id changes
  useEffect(() => {
    // If private_profile_id changed, cleanup and create new controller
    if (controllerRef.current) {
      controllerRef.current.cleanup();
      controllerRef.current = new GradebookWhatIfController(gradebookController, private_profile_id, courseController);
    }

    return () => {
      if (controllerRef.current) {
        controllerRef.current.cleanup();
        controllerRef.current = null;
      }
    };
  }, [private_profile_id, gradebookController, courseController]);

  if (!controllerRef.current) {
    controllerRef.current = new GradebookWhatIfController(gradebookController, private_profile_id, courseController);
  }
  return <GradebookWhatIfContext.Provider value={controllerRef.current}>{children}</GradebookWhatIfContext.Provider>;
}

export function GradebookWhatIfProvider({
  children,
  private_profile_id
}: {
  children: React.ReactNode;
  private_profile_id: string;
}) {
  const gradebookController = useGradebookController();
  const [isReady, setIsReady] = useState(gradebookController.isReady);
  useEffect(() => {
    gradebookController.readyPromise.then(() => setIsReady(true));
  }, [gradebookController]);
  if (!isReady) {
    return <Spinner />;
  }

  return (
    <GradebookWhatIfProviderInternal private_profile_id={private_profile_id}>
      {children}
    </GradebookWhatIfProviderInternal>
  );
}

export function useWhatIfGrade(columnId: number) {
  const whatIf = useGradebookWhatIf();
  const [value, setValue] = useState<WhatIfGradeValue | undefined>(whatIf.getGrade(columnId));
  useEffect(() => {
    const unsub = whatIf.subscribe(() => setValue(whatIf.getGrade(columnId)));
    return unsub;
  }, [whatIf, columnId]);
  return value;
}
export function useGradebookWhatIf() {
  const ctx = useContext(GradebookWhatIfContext);
  if (!ctx) throw new Error("useGradebookWhatIf must be used within GradebookWhatIfProvider");
  return ctx;
}
