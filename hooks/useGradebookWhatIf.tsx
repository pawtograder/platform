import { GradebookColumnStudent, GradebookColumnWithEntries } from "@/utils/supabase/DatabaseTypes";
import { all, create, FunctionNode, isArray, MathNode, Matrix } from "mathjs";
import { minimatch } from "minimatch";
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { GradebookController, useGradebookController } from "./useGradebook";
export type ExpressionContext = {
  student_id: string;
  is_private_calculation: boolean;
  incomplete_values: IncompleteValuesAdvice | null;
  incomplete_values_policy: "assume_max" | "assume_zero" | "report_only";
};
//These functions should be called with a context object as the first argument
export const ContextFunctions = ["mean", "countif", "sum", "drop_lowest", "gradebook_columns"];

//See also in supabase/functions/gradebook-column-recalculate/expression/DependencySource.ts
export type IncompleteValuesAdvice = {
  missing?: {
    gradebook_columns?: string[];
  };
  not_released?: {
    gradebook_columns?: string[];
  };
};

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

class GradebookWhatIfController {
  private _grades: GradebookWhatIfGradeMap = {};
  private _incompleteValues: GradebookWhatIfIncompleteValuesMap = {};
  private _subscribers: (() => void)[] = [];
  private _gradebookUnsubscribe: (() => void) | null = null;

  constructor(
    private gradebookController: GradebookController,
    private private_profile_id: string
  ) {
    this.initializeGradebookGrades();
    this.setupGradebookListener();
  }

  private initializeGradebookGrades() {
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
    //Recalculate all columns
    this.recalculateDependentColumns();
  }

  private setupGradebookListener() {
    // Subscribe to gradebook column student changes for this specific student
    this._gradebookUnsubscribe = this.gradebookController.subscribeColumnsForStudent(
      this.private_profile_id,
      (students) => {
        let hasChanges = false;

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
          }
        }

        // If there were changes, recalculate any what-if grades that depend on these columns
        if (hasChanges) {
          this.recalculateDependentColumns();
        }
      }
    );
  }

  private recalculateDependentColumns() {
    const allColumns = this.gradebookController.columns as GradebookColumnWithEntries[];
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
      //eslint-disable-next-line @typescript-eslint/no-explicit-any
      const imports: Record<string, (...args: any[]) => unknown> = {};
      imports["gradebook_columns"] = (context: ExpressionContext, columnSlug: string | string[]) => {
        const findOne = (slug: string) => {
          const matchingColumns = allColumns.filter((c) => minimatch(c.slug, slug));
          if (!matchingColumns.length) return null;
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
              column_slug: thisColumn!.slug!
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

            //Track not released values
            if (!ret.released && !ret.is_private) {
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
            } else if (ret.is_missing) {
              //Track missing values
              if (!context.incomplete_values) {
                context.incomplete_values = {};
              }
              if (!context.incomplete_values?.missing) {
                context.incomplete_values.missing = {};
              }
              if (!context.incomplete_values.missing.gradebook_columns) {
                context.incomplete_values.missing.gradebook_columns = [];
              }
              context.incomplete_values.missing.gradebook_columns.push(ret.column_slug!);
            }
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
      };
      imports["assignments"] = (assignmentSlug: string | string[]) => {
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
          const submission = this.gradebookController.studentSubmissions
            .get(this.private_profile_id)
            ?.find((s) => s.assignment_id === matchingAssignments[0].id);

          // Type assertion to include total_score
          const submissionWithScore = submission as typeof submission & { total_score?: number | null };

          if (!submissionWithScore || submissionWithScore.total_score === null) return null;
          return submissionWithScore.total_score;
        };
        if (Array.isArray(assignmentSlug)) {
          const ret = assignmentSlug.map(findOne);
          return ret;
        } else {
          const ret = findOne(assignmentSlug);
          return ret;
        }
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
              (100 * validValues.reduce((a, b) => a + (b && b.score ? b.score / b.max_score : 0), 0)) /
              validValues.length;
            return ret;
          }
        }
        throw new Error("Mean called with non-matrix value");
      };
      imports["drop_lowest"] = (
        context: ExpressionContext,
        value: GradebookColumnStudentWithMaxScore[],
        count: number
      ) => {
        if (Array.isArray(value)) {
          const droppableValues = value.filter((v) => !v.is_missing && !v.is_excused && v.is_droppable);
          const sortedValues = droppableValues.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
          if (sortedValues.length === 0) {
            return undefined;
          }
          return sortedValues.slice(count);
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
            incomplete_values_policy: policy as "assume_max" | "assume_zero" | "report_only"
          };
          const result = instrumented.evaluate({
            context: context
          });
          let score: number;
          if (typeof result === "object" && result !== null && "entries" in result) {
            const lastEntry = result.entries[result.entries.length - 1];
            score = Number(lastEntry);
          } else {
            score = Number(result);
          }
          scores[policy as "report_only" | "assume_max" | "assume_zero"] = score;
          if (policy === "report_only") {
            //If there are any incomplete values, dedupliate them
            if (context.incomplete_values) {
              if (context.incomplete_values.missing?.gradebook_columns) {
                context.incomplete_values.missing.gradebook_columns = [
                  ...new Set(context.incomplete_values.missing.gradebook_columns)
                ];
              }
              if (context.incomplete_values.not_released?.gradebook_columns) {
                context.incomplete_values.not_released.gradebook_columns = [
                  ...new Set(context.incomplete_values.not_released.gradebook_columns)
                ];
              }
            }
            this._incompleteValues[columnId] = context.incomplete_values;
          }
        }
        if (scores.gradebook_score !== scores.report_only && scores.report_only !== null) {
          scores.what_if = scores.report_only;
        } else {
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
  }
}

const GradebookWhatIfContext = createContext<GradebookWhatIfController | null>(null);

export function GradebookWhatIfProvider({
  children,
  private_profile_id
}: {
  children: React.ReactNode;
  private_profile_id: string;
}) {
  const gradebookController = useGradebookController();
  const controllerRef = useRef<GradebookWhatIfController>();

  // Initialize controller synchronously if it doesn't exist
  if (!controllerRef.current) {
    controllerRef.current = new GradebookWhatIfController(gradebookController, private_profile_id);
  }

  // Cleanup and reinitialize when private_profile_id changes
  useEffect(() => {
    // If private_profile_id changed, cleanup and create new controller
    if (controllerRef.current) {
      controllerRef.current.cleanup();
      controllerRef.current = new GradebookWhatIfController(gradebookController, private_profile_id);
    }

    return () => {
      if (controllerRef.current) {
        controllerRef.current.cleanup();
      }
    };
  }, [private_profile_id, gradebookController]);

  return <GradebookWhatIfContext.Provider value={controllerRef.current}>{children}</GradebookWhatIfContext.Provider>;
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
