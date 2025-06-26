"use client";
import {
  Assignment,
  GradebookColumn,
  GradebookColumnDependencies,
  GradebookColumnStudent,
  GradebookColumnWithEntries,
  GradebookWithAllData
} from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Link, Spinner, Text, VStack } from "@chakra-ui/react";
import { LiveEvent, useList, useShow } from "@refinedev/core";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useCourse } from "./useAuthState";
import { CourseController } from "./useCourseController";

import { Database } from "@/utils/supabase/SupabaseTypes";
import { all, ConstantNode, create, FunctionNode, Matrix } from "mathjs";
import { minimatch } from "minimatch";

// --- Types ---

export default function useGradebook() {
  const gradebookController = useGradebookController();

  return gradebookController;
}

export function useGradebookColumns() {
  const gradebookController = useGradebookController();
  const [columns, setColumns] = useState<GradebookColumnWithEntries[]>(
    gradebookController.gradebook.gradebook_columns as GradebookColumnWithEntries[]
  );
  useEffect(() => {
    const unsubscribe = gradebookController.subscribeColumns(setColumns);
    return () => unsubscribe();
  }, [gradebookController]);
  return columns;
}

export function useGradebookColumn(column_id: number) {
  const gradebookController = useGradebookController();
  const [column, setColumn] = useState<GradebookColumnWithEntries | undefined>(
    gradebookController.getGradebookColumn(column_id) as GradebookColumnWithEntries
  );
  useEffect(() => {
    return gradebookController.getColumnWithSubscription(column_id, setColumn);
  }, [gradebookController, column_id]);
  if (!column) {
    throw new Error(`Column ${column_id} not found`);
  }
  return column;
}

export function useGradebookColumnGrades(column_id: number) {
  const gradebookController = useGradebookController();
  const column = useGradebookColumn(column_id);
  const [grades, setGrades] = useState<GradebookColumnStudent[]>(column.gradebook_column_students);
  useEffect(() => {
    return gradebookController.subscribeColumnStudentList(setGrades);
  }, [gradebookController]);
  return grades;
}

export function useGradebookColumnStudent(column_id: number, student_id: string) {
  const gradebookController = useGradebookController();
  const studentGradebookController = gradebookController.getStudentGradebookController(student_id);
  const [columnStudent, setColumnStudent] = useState<GradebookColumnStudent | undefined>(
    gradebookController.getGradebookColumnStudent(column_id, student_id)
  );
  useEffect(() => {
    const unsubscribe = studentGradebookController.subscribeColumnStudent(column_id, setColumnStudent);
    return () => unsubscribe();
  }, [column_id, studentGradebookController]);
  return columnStudent;
}

export function getScore(gradebookColumnStudent: GradebookColumnStudent | undefined) {
  return gradebookColumnStudent?.score_override !== null
    ? gradebookColumnStudent?.score_override
    : gradebookColumnStudent?.score;
}
export function useSubmissionIDForColumn(column_id: number, student_id: string) {
  const gradebookController = useGradebookController();
  const submissionID = useMemo(() => {
    const assignment = gradebookController.assignments.find((a) => a.gradebook_column_id === column_id);
    if (!assignment) return { status: "not-an-assignment" };
    const submissions = gradebookController.studentSubmissions.get(student_id);
    if (!submissions) return { status: "no-submission" };
    const submission = submissions.find((s) => s.assignment_id === assignment.id);
    if (!submission) return { status: "no-submission" };
    return { status: "found", submission_id: submission.activesubmissionid };
  }, [gradebookController.assignments, gradebookController.studentSubmissions, column_id, student_id]);
  return submissionID;
}
export function useLinkToAssignment(column_id: number, student_id: string) {
  const gradebookController = useGradebookController();
  const column = useGradebookColumn(column_id);
  const dependencies = column?.dependencies as { gradebook_columns?: number[]; assignments?: number[] };
  const assignmentLink = useMemo(() => {
    if (!dependencies) return null;
    const gradesForStudent = gradebookController.studentSubmissions.get(student_id);
    for (const assignment_id of dependencies.assignments ?? []) {
      const assignment = gradesForStudent?.find((s) => s.assignment_id === assignment_id);
      if (assignment) {
        if (assignment.activesubmissionid) {
          return `/course/${column?.class_id}/assignments/${assignment.assignment_id}/submissions/${assignment.activesubmissionid}`;
        } else {
          return undefined;
        }
      }
    }
    return null;
  }, [gradebookController, column, dependencies, student_id]);
  return assignmentLink;
}
export function useReferencedContent(
  column_id: number,
  student_id: string,
  inclusions: { assignments?: boolean; gradebook_columns?: boolean } = { assignments: true, gradebook_columns: true }
) {
  const gradebookController = useGradebookController();
  const column = useGradebookColumn(column_id);
  const dependencies = column?.dependencies as { gradebook_columns?: number[]; assignments?: number[] };
  const referencedContent = useMemo(() => {
    if (!dependencies) return null;
    const links: React.ReactNode[] = [];
    if (inclusions.assignments && dependencies.assignments && dependencies.assignments.length > 0) {
      const gradesForStudent = gradebookController.studentSubmissions.get(student_id);
      for (const assignment_id of dependencies.assignments) {
        const assignment = gradesForStudent?.find((s) => s.assignment_id === assignment_id);
        if (assignment) {
          if (assignment.activesubmissionid) {
            links.push(
              <Link
                tabIndex={-1}
                target="_blank"
                key={`assignment-${assignment.assignment_id}`}
                href={`/course/${column?.class_id}/assignments/${assignment.assignment_id}/submissions/${assignment.activesubmissionid}`}
              >
                Assignment {assignment.assignment_slug}
              </Link>
            );
          } else {
            links.push(
              <Text key={`assignment-${assignment.assignment_id}`}>
                Assignment {assignment.assignment_slug} (Not submitted)
              </Text>
            );
          }
        }
      }
    }
    if (inclusions.gradebook_columns && dependencies.gradebook_columns) {
      for (const column_id of dependencies.gradebook_columns) {
        const column = gradebookController.getGradebookColumn(column_id);
        if (column) {
          links.push(<Text key={`gradebook-column-${column_id}`}>Gradebook column {column.name}</Text>);
        }
      }
    }
    return links.length > 0 ? (
      <HStack align="left">
        <Heading size="sm">Referenced values:</Heading>
        <VStack align="left">{links}</VStack>
      </HStack>
    ) : null;
  }, [gradebookController, column, student_id, dependencies]);
  return referencedContent;
}

/**
 * Hook to check if all dependencies of a column have been released
 * Sets up subscriptions to watch for changes in grades and release status
 */
export function useAreAllDependenciesReleased(columnId: number): boolean {
  const gradebookController = useGradebookController();
  const column = gradebookController.getGradebookColumn(columnId);
  const [dependenciesReleased, setDependenciesReleased] = useState(false);

  // Get all dependency column IDs recursively
  const allDependencyColumnIds = useMemo(() => {
    const visited = new Set<number>();
    const dependencies: number[] = [];

    const collectDependencies = (colId: number) => {
      if (visited.has(colId)) return;
      visited.add(colId);

      const col = gradebookController.getGradebookColumn(colId);
      if (!col?.dependencies) return;

      const deps = col.dependencies as GradebookColumnDependencies;
      if (deps.gradebook_columns) {
        for (const depId of deps.gradebook_columns) {
          dependencies.push(depId);
          collectDependencies(depId);
        }
      }
    };

    collectDependencies(columnId);
    return [...new Set(dependencies)];
  }, [columnId, gradebookController]);

  // Function to check all dependencies
  const checkDependencies = useCallback(() => {
    if (!column?.dependencies) {
      setDependenciesReleased(true);
      return;
    }

    const allReleased = allDependencyColumnIds.every((depId) => {
      return gradebookController.isColumnEffectivelyReleased(depId);
    });

    setDependenciesReleased(allReleased);
  }, [column, allDependencyColumnIds, gradebookController]);

  // Initial check
  useEffect(() => {
    checkDependencies();
  }, [checkDependencies]);

  // Set up subscriptions for dependency columns using gradebookController
  useEffect(() => {
    if (allDependencyColumnIds.length === 0) return;

    const unsubscribers: (() => void)[] = [];

    // Subscribe to column changes for each dependency
    allDependencyColumnIds.forEach((depId) => {
      const unsubscribeColumn = gradebookController.getColumnWithSubscription(depId, () => {
        checkDependencies();
      });
      unsubscribers.push(unsubscribeColumn);
    });

    // Subscribe to column student changes for each dependency
    allDependencyColumnIds.forEach((depId) => {
      const unsubscribeColumnStudent = gradebookController.subscribeColumnStudent(depId, () => {
        checkDependencies();
      });
      unsubscribers.push(unsubscribeColumnStudent);
    });

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [columnId, allDependencyColumnIds, gradebookController, checkDependencies]);

  return dependenciesReleased;
}
class StudentGradebookController {
  private _columnsForStudent: GradebookColumnStudent[] = [];
  private _profile_id: string;
  private _columnStudentSubscribers: Map<number, ((item: GradebookColumnStudent | undefined) => void)[]> = new Map();
  private _isInstructorOrGrader: boolean;
  constructor(gradebook: GradebookWithAllData, profile_id: string, isInstructorOrGrader: boolean) {
    this._profile_id = profile_id;
    gradebook.gradebook_columns.forEach((col) => {
      col.gradebook_column_students.forEach((s) => {
        if (s.student_id === profile_id && (s.is_private || !isInstructorOrGrader)) {
          this._columnsForStudent.push(s);
        }
      });
    });
    this._isInstructorOrGrader = isInstructorOrGrader;
  }
  setColumnForStudent(updatedColumn: GradebookColumnStudent) {
    if (updatedColumn.student_id !== this._profile_id) {
      throw new Error("Column is not for this student");
    }
    if (!updatedColumn.is_private && this._isInstructorOrGrader) {
      return;
    }
    const index = this._columnsForStudent.findIndex((s) => s.id === updatedColumn.id);
    if (index === -1) {
      this._columnsForStudent.push(updatedColumn);
    } else {
      this._columnsForStudent[index] = updatedColumn;
    }
    this._columnStudentSubscribers.get(updatedColumn.gradebook_column_id)?.forEach((cb) => cb(updatedColumn));
  }
  getColumnForStudent(column_id: number, cb?: (item: GradebookColumnStudent | undefined) => void) {
    const item = this._columnsForStudent.find((s) => s.gradebook_column_id === column_id);
    if (cb) {
      const unsubscribe = this.subscribeColumnStudent(column_id, cb);
      return {
        item,
        unsubscribe
      };
    }
    return {
      item,
      unsubscribe: () => {}
    };
  }

  subscribeColumnStudent(column_id: number, cb: (item: GradebookColumnStudent | undefined) => void) {
    const arr = this._columnStudentSubscribers.get(column_id) || [];
    this._columnStudentSubscribers.set(column_id, [...arr, cb]);
    return () => {
      const arr = this._columnStudentSubscribers.get(column_id) || [];
      this._columnStudentSubscribers.set(
        column_id,
        arr.filter((fn) => fn !== cb)
      );
    };
  }

  public getGradesForStudent(column_id: number) {
    return this._columnsForStudent.find((s) => s.gradebook_column_id === column_id);
  }

  public filter(column_id: number, filterValue: string) {
    const item = this._columnsForStudent.find((s) => s.gradebook_column_id === column_id);
    if (!item) return false;
    return String(item.score_override ?? item.score ?? "") === filterValue;
  }
}

type SubmissionWithGrades = Omit<Database["public"]["Views"]["submissions_with_grades_for_assignment"]["Row"], "id"> & {
  id: number;
};
// --- Controller ---

type RendererParams = {
  score: number | null;
  max_score: number | null;
  score_override: number | null;
  is_missing: boolean;
  is_excused: boolean;
  is_droppable: boolean;
  released: boolean;
};
export class GradebookController {
  private _gradebook?: GradebookWithAllData;
  private _studentDetailView: string | null = null;
  private studentDetailViewSubscribers: ((view: string | null) => void)[] = [];

  private studentGradebookControllers: Map<string, StudentGradebookController> = new Map();

  private cellRenderersByColumnId: Map<number, (cell: RendererParams) => React.ReactNode> = new Map();

  // --- Live event system specific for gradebook_column_student ---
  private columnStudentSubscribers: Map<number, ((item: GradebookColumnStudent | undefined) => void)[]> = new Map();
  private columnStudentListSubscribers: ((items: GradebookColumnStudent[]) => void)[] = [];

  // --- Subscribers for gradebook columns ---
  private columnSubscribers: ((columns: GradebookColumnWithEntries[]) => void)[] = [];
  private columnSubscribersByColumnId: Map<number, ((column: GradebookColumnWithEntries) => void)[]> = new Map();

  public studentSubmissions: Map<string, SubmissionWithGrades[]> = new Map();

  private _assignments?: Assignment[];
  private _isInstructorOrGrader: boolean;

  public constructor(isInstructorOrGrader: boolean) {
    this._isInstructorOrGrader = isInstructorOrGrader;
  }

  public get assignments() {
    if (!this._assignments) throw new Error("Assignments not loaded");
    return this._assignments;
  }

  public set assignments(assignments: Assignment[]) {
    this._assignments = assignments;
  }

  // Subscribe to gradebook columns
  subscribeColumns(cb: (columns: GradebookColumnWithEntries[]) => void) {
    this.columnSubscribers.push(cb);
    return () => {
      this.columnSubscribers = this.columnSubscribers.filter((fn) => fn !== cb);
    };
  }

  getColumnWithSubscription(column_id: number, cb: (column: GradebookColumnWithEntries) => void) {
    const arr = this.columnSubscribersByColumnId.get(column_id) || [];
    this.columnSubscribersByColumnId.set(column_id, [...arr, cb]);
    return () => {
      const arr = this.columnSubscribersByColumnId.get(column_id) || [];
      this.columnSubscribersByColumnId.set(
        column_id,
        arr.filter((fn) => fn !== cb)
      );
    };
  }
  // Notify all column subscribers
  private notifyColumnSubscribers() {
    this.columnSubscribers.forEach((cb) => cb([...this.gradebook.gradebook_columns] as GradebookColumnWithEntries[]));
  }

  // Register a subscriber for a specific mapping by id
  subscribeColumnStudent(id: number, cb: (item: GradebookColumnStudent | undefined) => void) {
    const arr = this.columnStudentSubscribers.get(id) || [];
    this.columnStudentSubscribers.set(id, [...arr, cb]);
    return () => {
      const arr = this.columnStudentSubscribers.get(id) || [];
      this.columnStudentSubscribers.set(
        id,
        arr.filter((fn) => fn !== cb)
      );
    };
  }
  // Register a subscriber for the full list
  subscribeColumnStudentList(cb: (items: GradebookColumnStudent[]) => void) {
    this.columnStudentListSubscribers.push(cb);
    return () => {
      this.columnStudentListSubscribers = this.columnStudentListSubscribers.filter((fn) => fn !== cb);
    };
  }

  getGradebookColumn(id: number) {
    return this.gradebook.gradebook_columns.find((col) => col.id === id);
  }

  getGradebookColumnStudent(column_id: number, student_id: string) {
    return this.gradebook.gradebook_columns
      .find((c) => c.id === column_id)
      ?.gradebook_column_students.find(
        (s) => s.student_id === student_id && (s.is_private || !this._isInstructorOrGrader)
      );
  }

  public getRendererForColumn(column_id: number) {
    const ret = this.cellRenderersByColumnId.get(column_id);
    if (!ret) {
      throw new Error(`No renderer found for column ${column_id}`);
    }
    return ret;
  }

  public extractAndValidateDependencies(expr: string, column_id: number) {
    const math = create(all);
    const exprNode = math.parse(expr);
    const dependencies: Record<string, Set<number>> = {};
    const errors: string[] = [];
    const availableDependencies = {
      assignments: this._assignments || [],
      gradebook_columns: this.gradebook.gradebook_columns
    };
    exprNode.traverse((node) => {
      if (node.type === "FunctionNode") {
        const functionName = (node as FunctionNode).fn.name;
        if (functionName in availableDependencies) {
          const args = (node as FunctionNode).args;
          const argType = args[0].type;
          if (argType === "ConstantNode") {
            const argName = (args[0] as ConstantNode).value;
            if (typeof argName === "string") {
              const matching = availableDependencies[functionName as keyof typeof availableDependencies].filter((d) =>
                minimatch(d.slug!, argName)
              );
              if (matching.length > 0) {
                if (!(functionName in dependencies)) {
                  dependencies[functionName] = new Set();
                }
                matching.forEach((d) => dependencies[functionName].add(d.id));
              } else {
                errors.push(`Invalid dependency: ${argName} for function ${functionName}`);
              }
            }
          }
        }
      }
    });
    //Flatten the dependencies
    const flattenedDependencies: Record<string, number[]> = {};
    for (const [functionName, ids] of Object.entries(dependencies)) {
      flattenedDependencies[functionName] = Array.from(ids);
    }
    if (flattenedDependencies.gradebook_columns) {
      //Check for cycles between the columns
      const checkForCycles = (visited_column_id: number) => {
        if (errors.length > 0) return;
        if (column_id === visited_column_id) {
          errors.push(`Cycle detected in score expression`);
          return;
        }
        const column = this.getGradebookColumn(visited_column_id);
        if (column) {
          const deps = column.dependencies as { gradebook_columns?: number[] };
          if (deps && deps.gradebook_columns) {
            for (const dependency of deps.gradebook_columns) {
              checkForCycles(dependency);
            }
          }
        }
      };
      for (const dependentColumn of flattenedDependencies.gradebook_columns) {
        checkForCycles(dependentColumn);
      }
    }
    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }
    if (Object.keys(flattenedDependencies).length === 0) {
      return null;
    }
    return flattenedDependencies;
  }

  createRendererForColumn(column: GradebookColumn): (cell: RendererParams) => React.ReactNode {
    const math = create(all);
    //Remove access to security-sensitive functions
    const securityFunctions = ["import", "createUnit", "reviver", "resolve"];
    //eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imports: Record<string, (...args: any[]) => any> = {};
    const letterBreakpoints = [
      { score: 93, letter: "A" },
      { score: 90, letter: "A-" },
      { score: 87, letter: "B+" },
      { score: 83, letter: "B" },
      { score: 80, letter: "B-" },
      { score: 77, letter: "C+" },
      { score: 73, letter: "C" },
      { score: 70, letter: "C-" },
      { score: 67, letter: "D+" },
      { score: 63, letter: "D" },
      { score: 60, letter: "D-" },
      { score: 0, letter: "F" }
    ];
    imports["letter"] = (score: number | undefined, max_score: number | undefined) => {
      if (score === undefined) return "(N/A)";
      const normalizedScore = 100 * (score / (max_score ?? 100));
      const letter = letterBreakpoints.find((b) => normalizedScore >= b.score);
      return letter ? letter.letter : "F";
    };
    imports["customLabel"] = (value: number | undefined, breakpoints: Matrix<unknown>) => {
      if (value === undefined) return "(N/A)";
      const breakpointsArray = breakpoints.toArray();
      for (const [score, letter] of breakpointsArray as [number, string][]) {
        if (value >= score) {
          return letter;
        }
      }
      return "Error";
    };
    const checkBreakpoints = [
      { score: 90, mark: "✔️+" },
      { score: 80, mark: "✔️" },
      { score: 70, mark: "✔️-" },
      { score: 0, mark: "❌" }
    ];
    imports["checkOrX"] = (score: number | undefined, max_score: number | undefined) => {
      if (score === undefined) return "(N/A)";
      const normalizedScore = 100 * (score / (max_score ?? 1));
      return normalizedScore > 0 ? "✔️" : "❌";
    };
    imports["check"] = (score: number | undefined, max_score: number | undefined) => {
      if (score === undefined) return "(N/A)";
      const normalizedScore = 100 * (score / (max_score ?? 100));
      const check = checkBreakpoints.find((b) => normalizedScore >= b.score);
      return check ? check.mark : "❌";
    };
    for (const functionName of securityFunctions) {
      imports[functionName] = () => {
        throw new Error(`${functionName} is not allowed`);
      };
    }
    math.import(imports, { override: true });
    try {
      const theRenderExpression =
        this.gradebook.expression_prefix + "\n" + (column.render_expression ?? "round(score, 2)");
      const expr = math.parse(theRenderExpression);
      const compiled = expr.compile();
      const cache = new Map<string, string>();
      const Renderer = (cell: RendererParams) => {
        try {
          if (cell.is_missing) {
            return "Missing";
          }
          if ((cell.score_override ?? cell.score) === null || (cell.score_override ?? cell.score) === undefined) {
            return "-";
          }
          const key = JSON.stringify(cell);
          if (cache.has(key)) {
            return cache.get(key)!;
          }
          const ret = compiled.evaluate({
            score: cell.score_override ?? cell.score,
            max_score: cell.max_score
          });
          let renderedVal: string;
          if (typeof ret === "object" && "entries" in ret) {
            //Return just the last result
            renderedVal = ret.entries[ret.entries.length - 1];
          } else {
            renderedVal = ret;
          }
          cache.set(key, renderedVal);
          return renderedVal;
        } catch (e) {
          console.error(e);
          return "Expression evaluation error";
        }
      };
      return Renderer;
    } catch {
      return () => {
        return "Expression parse error";
      };
    }
  }

  handleColumnEvent(event: LiveEvent) {
    const body = event.payload as Omit<GradebookColumn, "dependencies"> & { dependencies: GradebookColumnDependencies };
    const column_id = body.id;
    const column = this.getGradebookColumn(column_id);
    const newColumn: GradebookColumnWithEntries = {
      ...body,
      gradebook_column_students: column?.gradebook_column_students || []
    };
    if (column?.render_expression !== newColumn.render_expression) {
      this.cellRenderersByColumnId.set(column_id, this.createRendererForColumn(newColumn));
    }
    if (newColumn.sort_order !== column?.sort_order) {
      const newColumns = this.gradebook.gradebook_columns.map((c) => (c.id === column_id ? newColumn : c));
      newColumns.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      this.gradebook.gradebook_columns = newColumns;
    } else {
      //update in place
      const idx = this.gradebook.gradebook_columns.findIndex((c) => c.id === column_id);
      this.gradebook.gradebook_columns[idx] = newColumn;
    }
    this.columnSubscribersByColumnId.get(column_id)?.forEach((cb) => cb(newColumn));
    this.notifyColumnSubscribers();
  }

  // Handle a live event for gradebook_column_student
  handleColumnStudentEvent(event: LiveEvent) {
    const body = event.payload as GradebookColumnStudent;
    const column_id = body.gradebook_column_id;
    if (event.type === "created" || event.type === "updated") {
      if (!body.is_private && this._isInstructorOrGrader) {
        //Instructors and graders only work on private columns
        return;
      }
      // Update or add the mapping in the column
      const column = this.getGradebookColumn(column_id);
      if (column) {
        if (column.gradebook_column_students.find((s) => s.student_id === body.student_id)) {
          // Update the mapping
          column.gradebook_column_students = column.gradebook_column_students.map((s) =>
            s.student_id === body.student_id ? body : s
          );
        }
        column.gradebook_column_students.push(body);
        this.columnStudentSubscribers.get(column_id)?.forEach((cb) => cb(body));
        this.columnStudentListSubscribers.forEach((cb) => cb([...column.gradebook_column_students]));
      } else {
        //Race: Column was created but we got this message first
        const newColumn: GradebookColumnWithEntries = {
          id: column_id,
          name: "Loading...",
          sort_order: 0,
          gradebook_id: body.gradebook_id,
          class_id: body.class_id,
          dependencies: null,
          description: null,
          max_score: null,
          released: false,
          render_expression: null,
          score_expression: null,
          gradebook_column_students: [body],
          created_at: new Date().toISOString(),
          show_max_score: false,
          slug: "loading",
          external_data: null
        };
        this.gradebook.gradebook_columns.push(newColumn);
        this.columnStudentSubscribers.get(column_id)?.forEach((cb) => cb(body));
        this.columnStudentListSubscribers.forEach((cb) => cb([...newColumn.gradebook_column_students]));
        return;
      }
      // Update the columnsForStudent map
      if (!this.studentGradebookControllers.has(body.student_id)) {
        this.studentGradebookControllers.set(
          body.student_id,
          new StudentGradebookController(this.gradebook, body.student_id, this._isInstructorOrGrader)
        );
      } else {
        this.studentGradebookControllers.get(body.student_id)!.setColumnForStudent(body);
      }
      this.columnStudentSubscribers.get(column_id)?.forEach((cb) => cb(body));
      this.columnStudentListSubscribers.forEach((cb) => cb([...column.gradebook_column_students]));
    }
  }

  getStudentGradebookController(student_id: string) {
    if (!this.studentGradebookControllers.has(student_id)) {
      this.studentGradebookControllers.set(
        student_id,
        new StudentGradebookController(this.gradebook, student_id, this._isInstructorOrGrader)
      );
    }
    return this.studentGradebookControllers.get(student_id)!;
  }

  set gradebook(gradebook: GradebookWithAllData) {
    this._gradebook = gradebook;
    this.studentGradebookControllers.clear();
    this.gradebook.gradebook_columns.forEach((col) => {
      this.cellRenderersByColumnId.set(col.id, this.createRendererForColumn(col));
      col.gradebook_column_students.forEach((s) => {
        if (!s.is_private && this._isInstructorOrGrader) {
          //Instructors and graders only work on private columns
          return;
        }
        if (!this.studentGradebookControllers.has(s.student_id)) {
          this.studentGradebookControllers.set(
            s.student_id,
            new StudentGradebookController(this.gradebook, s.student_id, this._isInstructorOrGrader)
          );
        }
      });
    });
    this.notifyColumnSubscribers();
  }
  get gradebook() {
    if (!this._gradebook) throw new Error("Gradebook not set");
    return this._gradebook;
  }
  get isReady() {
    return !!this._gradebook;
  }
  exportGradebook(courseController: CourseController) {
    const roster = courseController.getRoster();
    const columns = this.gradebook.gradebook_columns;
    columns.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const result = [];
    result.push(["Name", "Email", "Canvas ID", "SID", ...columns.map((col) => col.name)]);
    roster.forEach((student) => {
      const studentGradebookController = this.getStudentGradebookController(student.private_profile_id);
      const userProfile = courseController.getUserProfile(student.private_profile_id);
      const gradesForStudent = columns.map((col) => getScore(studentGradebookController.getGradesForStudent(col.id)));
      const row = [
        student.users.name,
        student.users.email,
        student.canvas_id,
        userProfile?.data?.sis_user_id,
        ...gradesForStudent
      ];
      result.push(row);
    });

    return result;
  }
  get columns() {
    return this.gradebook.gradebook_columns;
  }

  /**
   * Check if a column is effectively released (either released or all grades are null)
   */
  isColumnEffectivelyReleased(columnId: number): boolean {
    const column = this.getGradebookColumn(columnId);
    if (!column) return false;

    // If the column is released, it's effectively released
    if (column.released) return true;

    // If the column is not released, check if all grades are null
    // If all grades are null, students see the same thing regardless of release status
    const allGradesNull = column.gradebook_column_students.every((student) => {
      const score = student.score_override ?? student.score;
      const ret = score === null || score === undefined || student.is_missing || !student.is_private;
      return ret;
    });

    return allGradesNull;
  }

  get studentDetailView() {
    return this._studentDetailView;
  }

  setStudentDetailView(view: string | null) {
    this._studentDetailView = view;
    this.studentDetailViewSubscribers.forEach((cb) => cb(view));
  }

  subscribeStudentDetailView(cb: (view: string | null) => void) {
    this.studentDetailViewSubscribers.push(cb);
    return () => {
      this.studentDetailViewSubscribers = this.studentDetailViewSubscribers.filter((fn) => fn !== cb);
    };
  }
}

// --- Context ---
type GradebookContextType = {
  gradebookController: GradebookController;
};
const GradebookContext = createContext<GradebookContextType | null>(null);
export function useGradebookController() {
  const ctx = useContext(GradebookContext);
  if (!ctx) throw new Error("useGradebookController must be used within GradebookProvider");
  return ctx.gradebookController;
}

function LoadingScreen() {
  return (
    <Box w="100vh" h="100vh">
      <Spinner size="xl" />
    </Box>
  );
}

// --- Provider ---
export function GradebookProvider({ children }: { children: React.ReactNode }) {
  const course = useCourse();
  const gradebook_id = course.classes.gradebook_id;
  const class_id = course.classes.id;
  const isInstructorOrGrader = course.role === "instructor" || course.role === "grader";
  const controller = useRef<GradebookController>(new GradebookController(isInstructorOrGrader));
  const [ready, setReady] = useState(false);

  if (!gradebook_id || isNaN(Number(gradebook_id))) {
    return <Text>Error: Gradebook is not enabled for this course.</Text>;
  }

  return (
    <GradebookContext.Provider value={{ gradebookController: controller.current }}>
      <GradebookControllerCreator
        gradebook_id={gradebook_id}
        class_id={class_id}
        setReady={setReady}
        controller={controller.current}
      />
      {!ready && <LoadingScreen />}
      {ready && children}
    </GradebookContext.Provider>
  );
}

function GradebookControllerCreator({
  gradebook_id,
  class_id,
  setReady,
  controller
}: {
  gradebook_id: number;
  class_id: number;
  setReady: (ready: boolean) => void;
  controller: GradebookController;
}) {
  // Fetch gradebook
  const { query: gradebookQuery } = useShow<GradebookWithAllData>({
    resource: "gradebooks",
    id: gradebook_id,
    queryOptions: { enabled: !!gradebook_id },
    meta: {
      select: "*, gradebook_columns!gradebook_columns_gradebook_id_fkey(*, gradebook_column_students(*))"
    }
  });

  // Fetch columns for live events
  useList<GradebookColumn>({
    resource: "gradebook_columns",
    filters: [{ field: "gradebook_id", operator: "eq", value: gradebook_id }],
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: !!gradebook_id },
    liveMode: "manual",
    onLiveEvent: (event: LiveEvent) => {
      controller.handleColumnEvent(event);
    }
  });

  // Fetch student/column mappings
  useList<GradebookColumnStudent>({
    resource: "gradebook_column_students",
    filters: [{ field: "class_id", operator: "eq", value: class_id }],
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: !!class_id },
    liveMode: "manual",
    onLiveEvent: (event: LiveEvent) => {
      controller.handleColumnStudentEvent(event);
    }
  });

  useEffect(() => {
    if (gradebookQuery.data?.data) {
      controller.gradebook = gradebookQuery.data.data;
    }
  }, [gradebookQuery.data, controller]);

  //Fetch assignments, needed for calculating dependencies
  const { data: assignments, isLoading: assignmentsLoading } = useList<Assignment>({
    resource: "assignments",
    filters: [{ field: "class_id", operator: "eq", value: class_id }],
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: !!class_id }
  });
  useEffect(() => {
    if (assignments && !assignmentsLoading) {
      controller.assignments = assignments.data;
    }
  }, [assignments, assignmentsLoading, controller]);

  const { data: submissions, isLoading: submissionsLoading } = useList<SubmissionWithGrades>({
    resource: "submissions_with_grades_for_assignment",
    filters: [{ field: "class_id", operator: "eq", value: class_id }],
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: !!class_id },
    meta: {
      select: "activesubmissionid, student_private_profile_id, assignment_id, assignment_slug, grader, groupname"
    }
  });
  useEffect(() => {
    if (submissions && !submissionsLoading) {
      for (const submission of submissions.data) {
        if (!submission.student_private_profile_id) continue;
        if (!controller.studentSubmissions.has(submission.student_private_profile_id)) {
          controller.studentSubmissions.set(submission.student_private_profile_id ?? "", []);
        }
        controller.studentSubmissions.get(submission.student_private_profile_id ?? "")!.push(submission);
      }
    }
  }, [submissions, submissionsLoading, controller]);
  useEffect(() => {
    if (!gradebookQuery.isLoading && !submissionsLoading) {
      setReady(true);
    }
  }, [gradebookQuery.isLoading, submissionsLoading, setReady]);
  return null;
}

export function useStudentDetailView() {
  const gradebookController = useGradebookController();
  const [view, setView] = useState<string | null>(gradebookController.studentDetailView);

  useEffect(() => {
    return gradebookController.subscribeStudentDetailView(setView);
  }, [gradebookController]);

  return {
    view,
    setView: (newView: string | null) => gradebookController.setStudentDetailView(newView)
  };
}
