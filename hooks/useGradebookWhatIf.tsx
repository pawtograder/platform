import { GradebookColumnStudent, GradebookColumnWithEntries } from "@/utils/supabase/DatabaseTypes";
import { Spinner } from "@chakra-ui/react";
import { all, create, isArray, isDenseMatrix, Matrix } from "mathjs";
import { minimatch } from "minimatch";
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { GradebookController, useGradebookController } from "./useGradebook";

export type GradebookWhatIfGradeMap = Record<number, number | undefined>;

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
type UnreleasedGradebookColumnStudent = {
  score: undefined;
  score_override: undefined;
  is_missing: true;
  is_excused: true;
  is_droppable: true;
  is_released: false;
};
function isUnreleasedGradebookColumnStudent(value: unknown): value is UnreleasedGradebookColumnStudent {
  return (
    typeof value === "object" &&
    value !== null &&
    "is_missing" in value &&
    value.is_missing === true &&
    "is_excused" in value &&
    value.is_excused === true
  );
}

class GradebookWhatIfController {
  private _grades: GradebookWhatIfGradeMap = {};
  private _subscribers: (() => void)[] = [];

  constructor(
    private gradebookController: GradebookController,
    private private_profile_id: string
  ) {}

  getGrade(columnId: number): number | undefined {
    return this._grades[columnId];
  }

  setGrade(columnId: number, value: number | undefined) {
    this._grades[columnId] = value;
    //Find everything that depends on this column
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
      imports["gradebook_columns"] = (columnSlug: string | string[]) => {
        const findOne = (slug: string) => {
          const matchingColumns = allColumns.filter((c) => minimatch(c.slug, slug));
          if (!matchingColumns.length) return null;
          const scoreForColumnID = (columnId: number) => {
            const whatIfVal = this.getGrade(columnId);
            const columnStudent = this.gradebookController.getGradebookColumnStudent(columnId, this.private_profile_id);
            if (!columnStudent) {
              if (whatIfVal !== undefined) {
                const ret: GradebookColumnStudent = {
                  is_missing: false,
                  is_excused: false,
                  is_droppable: true,
                  score: whatIfVal,
                  score_override: whatIfVal,
                  class_id: column.class_id,
                  created_at: column.created_at,
                  gradebook_column_id: column.id,
                  gradebook_id: column.gradebook_id,
                  id: column.id,
                  released: false,
                  score_override_note: null,
                  student_id: this.private_profile_id
                };
                return ret;
              }
              const ret: UnreleasedGradebookColumnStudent = {
                is_missing: true,
                is_excused: true,
                is_droppable: true,
                is_released: false,
                score: undefined,
                score_override: undefined
              };
              if (!isUnreleasedGradebookColumnStudent(ret)) {
                throw new Error("Invalid unreleased gradebook column student");
              }
              return ret;
            }
            return { ...columnStudent, score_override: whatIfVal ?? columnStudent.score_override };
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
            const val = ret as GradebookColumnStudent;
            return val.score_override ?? val.score;
          }
          return ret;
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
          if (!submission) return null;
          return submission.total_score;
        };
        if (Array.isArray(assignmentSlug)) {
          return assignmentSlug.map(findOne);
        } else {
          return findOne(assignmentSlug);
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
      imports["mean"] = (value: number | number[] | Matrix) => {
        if (isDenseMatrix(value) || isArray(value)) {
          const valuesToAverage = (isDenseMatrix(value) ? value.toArray() : value).map((v) => {
            if (isGradebookColumnStudent(v) || isUnreleasedGradebookColumnStudent(v)) {
              if (
                v.is_missing ||
                (v.score === null && v.score_override === null) ||
                (v.score === undefined && v.score_override === undefined)
              ) {
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
        throw new Error("Unsupported mean value");
      };
      math.import(imports, { override: true });
      if (column.score_expression) {
        const result = math.evaluate(column.score_expression);
        this._grades[columnId] = result;
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
  if (!controllerRef.current) {
    if (gradebookController.isReady) {
      controllerRef.current = new GradebookWhatIfController(gradebookController, private_profile_id);
    } else {
      return <Spinner />;
    }
  }

  return <GradebookWhatIfContext.Provider value={controllerRef.current}>{children}</GradebookWhatIfContext.Provider>;
}

export function useWhatIfGrade(columnId: number) {
  const whatIf = useGradebookWhatIf();
  const [value, setValue] = useState<number | undefined>(whatIf.getGrade(columnId));
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
