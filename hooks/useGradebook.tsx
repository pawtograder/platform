"use client";
import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import {
  Assignment,
  GradebookColumn,
  GradebookColumnDependencies,
  GradebookColumnStudent
} from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Link, Spinner, Text, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useCourse } from "./useAuthState";
import { CourseController, useCourseController } from "./useCourseController";

import { Database } from "@/utils/supabase/SupabaseTypes";
import { all, ConstantNode, create, FunctionNode, Matrix } from "mathjs";
import { minimatch } from "minimatch";

export default function useGradebook() {
  const gradebookController = useGradebookController();

  return gradebookController;
}

export function useGradebookColumns() {
  const gradebookController = useGradebookController();
  const [columns, setColumns] = useState<GradebookColumn[]>(gradebookController.gradebook_columns.rows);
  const isRefetching = useGradebookRefetchStatus();

  useEffect(() => {
    return gradebookController.gradebook_columns.list((data) => {
      setColumns(data);
    }).unsubscribe;
  }, [gradebookController]);

  // Return empty array during refetch to prevent showing partial data
  return isRefetching ? [] : columns;
}

export function useGradebookColumn(column_id: number) {
  const gradebookController = useGradebookController();
  const [column, setColumn] = useState<GradebookColumn | undefined>(
    gradebookController.gradebook_columns.rows.find((col) => col.id === column_id)
  );
  useEffect(() => {
    return gradebookController.gradebook_columns.getById(column_id, (data) => {
      setColumn(data);
    }).unsubscribe;
  }, [gradebookController, column_id]);
  if (!column) {
    throw new Error(`Column ${column_id} not found`);
  }
  return column;
}

export function useGradebookColumnGrades(column_id: number) {
  const gradebookController = useGradebookController();
  const [grades, setGrades] = useState<GradebookColumnStudent[]>(gradebookController.getStudentsForColumn(column_id));
  const isRefetching = useGradebookRefetchStatus();
  useEffect(() => {
    return gradebookController.subscribeStudentsForColumn(column_id, setGrades);
  }, [gradebookController, column_id]);

  // Return empty array during refetch to prevent showing partial data
  return isRefetching ? [] : grades;
}

export function useGradebookColumnStudent(column_id: number, student_id: string) {
  const gradebookController = useGradebookController();
  const [columnStudent, setColumnStudent] = useState<GradebookColumnStudent | undefined>(
    gradebookController.getGradebookColumnStudent(column_id, student_id)
  );
  const isRefetching = useGradebookRefetchStatus();
  if (isRefetching) {
    throw new Error("Should not try to get gradebook column student when any table is refetching");
    // return undefined;
  }

  useEffect(() => {
    // Use the specialized index for direct access to student/column pair
    const unsubscribe = gradebookController.subscribeStudentColumnPair(student_id, column_id, setColumnStudent);
    return () => unsubscribe();
  }, [column_id, student_id, gradebookController]);

  // Return undefined during refetch to prevent showing partial data
  return isRefetching ? undefined : columnStudent;
}

export function getScore(gradebookColumnStudent: GradebookColumnStudent | undefined) {
  return gradebookColumnStudent?.score_override !== null
    ? gradebookColumnStudent?.score_override
    : gradebookColumnStudent?.score;
}
export function useSubmissionIDForColumn(column_id: number, student_id: string) {
  const gradebookController = useGradebookController();
  const submissionID = useMemo(() => {
    const assignment = gradebookController.assignments_table.rows.find((a) => a.gradebook_column_id === column_id);
    if (!assignment) return { status: "not-an-assignment" };
    const submissions = gradebookController.studentSubmissions.get(student_id);
    if (!submissions) return { status: "no-submission" };
    const submission = submissions.find((s) => s.assignment_id === assignment.id);
    if (!submission) return { status: "no-submission" };
    return { status: "found", submission_id: submission.activesubmissionid };
  }, [gradebookController.assignments_table.rows, gradebookController.studentSubmissions, column_id, student_id]);
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
                View Submission
              </Link>
            );
          } else {
            links.push(<Text key={`assignment-${assignment.assignment_id}`}>Assignment not submitted</Text>);
          }
        }
      }
    }
    if (inclusions.gradebook_columns && dependencies.gradebook_columns) {
      for (const column_id of dependencies.gradebook_columns) {
        const column = gradebookController.gradebook_columns.rows.find((col) => col.id === column_id);
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
  const column = gradebookController.gradebook_columns.rows.find((col) => col.id === columnId);
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
      const unsubscribeColumn = gradebookController.gradebook_columns.getById(depId, () => {
        checkDependencies();
      }).unsubscribe;
      unsubscribers.push(unsubscribeColumn);
    });

    // Subscribe to column student changes for each dependency
    allDependencyColumnIds.forEach((depId) => {
      const unsubscribeColumnStudent = gradebookController.gradebook_column_students.list((data) => {
        // Check if any students for this column changed
        const hasChanges = data.some((student) => student.gradebook_column_id === depId);
        if (hasChanges) {
          checkDependencies();
        }
      }).unsubscribe;
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
  private _unsubscribes: (() => void)[] = [];

  constructor(
    gradebookColumns: TableController<"gradebook_columns">,
    gradebookColumnStudents: TableController<"gradebook_column_students">,
    profile_id: string,
    isInstructorOrGrader: boolean
  ) {
    this._profile_id = profile_id;
    this._isInstructorOrGrader = isInstructorOrGrader;

    // Initialize with current data
    this._updateColumnsForStudent(gradebookColumnStudents.rows);

    // Subscribe to changes in gradebook_column_students
    const { unsubscribe } = gradebookColumnStudents.list((data) => {
      this._updateColumnsForStudent(data);
    });
    this._unsubscribes.push(unsubscribe);
  }

  private _updateColumnsForStudent(allStudents: GradebookColumnStudent[]) {
    // Filter by student_id only since the TableController query already filters by appropriate is_private value
    const newColumns = allStudents.filter((s) => s.student_id === this._profile_id);
    if (newColumns.length !== this._columnsForStudent.length) {
      this._columnsForStudent = newColumns;

      // Notify subscribers of changes
      this._columnsForStudent.forEach((student) => {
        this._columnStudentSubscribers.get(student.gradebook_column_id)?.forEach((cb) => cb(student));
      });
    }
  }

  close() {
    this._unsubscribes.forEach((unsubscribe) => unsubscribe());
    this._unsubscribes = [];
  }
  setColumnForStudent(updatedColumn: GradebookColumnStudent) {
    if (updatedColumn.student_id !== this._profile_id) {
      throw new Error("Column is not for this student");
    }
    // Accept the column since the data already comes from the appropriate is_private filtered query
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
  private _studentDetailView: string | null = null;
  private studentDetailViewSubscribers: ((view: string | null) => void)[] = [];

  private studentGradebookControllers: Map<string, StudentGradebookController> = new Map();

  private cellRenderersByColumnId: Map<number, (cell: RendererParams) => React.ReactNode> = new Map();

  // Refetch tracking
  private _isAnyTableRefetching: boolean = false;
  private _refetchStatusListeners: ((isRefetching: boolean) => void)[] = [];
  private _tableRefetchUnsubscribes: (() => void)[] = [];

  // --- Specialized index for student/column pairs ---
  private studentColumnIndex: Map<string, number> = new Map(); // Maps (student_id, column_id) -> gradebook_column_student.id
  private _isStudentColumnIndexPopulated: boolean = false;
  private _studentColumnIndexListeners: ((isPopulated: boolean) => void)[] = [];

  // --- TableController instances ---
  readonly gradebook_columns: TableController<"gradebook_columns">;
  readonly gradebook_column_students: TableController<"gradebook_column_students">;
  readonly assignments_table: TableController<"assignments">;

  readonly readyPromise: Promise<[void, void, void]>;

  public studentSubmissions: Map<string, SubmissionWithGrades[]> = new Map();

  // Helper method to generate index key for student/column pair
  private getStudentColumnKey(student_id: string, column_id: number, isPrivate: boolean): string {
    return `${student_id}:${column_id}:${isPrivate}`;
  }

  // Update the specialized index when gradebook_column_students data changes
  private updateStudentColumnIndex() {
    this.studentColumnIndex.clear();
    this.gradebook_column_students.rows.forEach((student) => {
      // Index all student records with is_private distinction
      // The query already filters by appropriate is_private value based on user role
      const key = this.getStudentColumnKey(student.student_id, student.gradebook_column_id, student.is_private);
      this.studentColumnIndex.set(key, student.id);
    });

    // Consider index populated if we have data from gradebook_column_students table
    // and the table is ready (not still loading initial data)
    const wasPopulated = this._isStudentColumnIndexPopulated;
    this._isStudentColumnIndexPopulated =
      this.gradebook_column_students.ready && this.gradebook_column_students.rows.length > 0;

    // Notify listeners if status changed
    if (wasPopulated !== this._isStudentColumnIndexPopulated) {
      this._studentColumnIndexListeners.forEach((listener) => listener(this._isStudentColumnIndexPopulated));
    }
  }

  private _assignments?: Assignment[];
  private _isInstructorOrGrader: boolean;
  private _expression_prefix?: string;
  readonly gradebook_id: number;
  readonly class_id: number;

  private _unsubscribes: (() => void)[] = [];
  private _classRealTimeController: ClassRealTimeController;
  public constructor(
    isInstructorOrGrader: boolean,
    class_id: number,
    gradebook_id: number,
    classRealTimeController: ClassRealTimeController
  ) {
    const client = createClient();
    this._isInstructorOrGrader = isInstructorOrGrader;
    this.gradebook_id = gradebook_id;
    this.class_id = class_id;
    this._classRealTimeController = classRealTimeController;
    this.gradebook_columns = new TableController({
      client,
      table: "gradebook_columns",
      query: client.from("gradebook_columns").select("*").eq("gradebook_id", gradebook_id),
      classRealTimeController
    });
    const { unsubscribe: updateRendererUnsubscribe, data: gradebookColumns } = this.gradebook_columns.list((data) => {
      data.forEach((col) => {
        if (!this.cellRenderersByColumnId.has(col.id)) {
          this.cellRenderersByColumnId.set(col.id, this.createRendererForColumn(col));
        }
      });
    });
    this._unsubscribes.push(updateRendererUnsubscribe);
    gradebookColumns.forEach((col) => {
      if (!this.cellRenderersByColumnId.has(col.id)) {
        this.cellRenderersByColumnId.set(col.id, this.createRendererForColumn(col));
      }
    });

    this.gradebook_column_students = new TableController({
      client,
      table: "gradebook_column_students",
      query: client.from("gradebook_column_students").select("*").eq("class_id", class_id),
      classRealTimeController
    });

    // Subscribe to gradebook_column_students changes to update the index
    const { unsubscribe: indexUnsubscribe } = this.gradebook_column_students.list(() => {
      this.updateStudentColumnIndex();
    });
    this._unsubscribes.push(indexUnsubscribe);
    this.updateStudentColumnIndex(); // Initialize with current data

    this.assignments_table = new TableController({
      client,
      table: "assignments",
      query: client.from("assignments").select("*").eq("class_id", class_id),
      classRealTimeController
    });

    this.readyPromise = Promise.all([
      this.gradebook_columns.readyPromise,
      this.gradebook_column_students.readyPromise,
      this.assignments_table.readyPromise
    ]);

    // Set up gradebook-specific broadcast subscriptions
    this._setupGradebookSubscriptions();

    // Set up refetch status tracking
    this._setupRefetchTracking();
  }

  private _setupGradebookSubscriptions() {
    // Subscribe to gradebook_columns changes for column structure updates
    const unsubscribeColumns = this._classRealTimeController.subscribeToTable("gradebook_columns", (message) => {
      // The TableController will handle the actual data updates
      // This subscription is for any additional gradebook-specific logic
    });
    this._unsubscribes.push(unsubscribeColumns);

    // Subscribe to gradebook_column_students changes for grade updates
    const unsubscribeColumnStudents = this._classRealTimeController.subscribeToTable(
      "gradebook_column_students",
      (message) => {
        // The TableController will handle the actual data updates
        // This subscription is for any additional gradebook-specific logic

        // Handle specific business logic for grade changes
        if (message.operation === "UPDATE" && message.data) {
          this._handleGradeChange(message.data as GradebookColumnStudent);
        }
      }
    );
    this._unsubscribes.push(unsubscribeColumnStudents);
  }

  private _handleGradeChange(gradeData: GradebookColumnStudent) {
    // Handle any gradebook-specific logic when grades change
    // This could include updating calculated columns, notifications, etc.

    // Example: If this is a student's public grade (is_private = false),
    // we might want to trigger additional UI updates
    if (gradeData.is_private === false) {
      // Update any cached calculations or trigger UI refresh
      // The actual data updates are handled by TableController
    }
  }

  private _setupRefetchTracking() {
    // Track refetch status for all tables
    const tables = [this.gradebook_columns, this.gradebook_column_students, this.assignments_table];

    tables.forEach((table) => {
      const unsubscribe = table.subscribeToRefetchStatus(() => {
        this._updateRefetchStatus();
      });
      this._tableRefetchUnsubscribes.push(unsubscribe);
    });
  }

  private _updateRefetchStatus() {
    // Check if any table is currently refetching
    const isAnyRefetching =
      this.gradebook_columns.isRefetching ||
      this.gradebook_column_students.isRefetching ||
      this.assignments_table.isRefetching;

    if (this._isAnyTableRefetching !== isAnyRefetching) {
      this._isAnyTableRefetching = isAnyRefetching;
      this._refetchStatusListeners.forEach((listener) => listener(isAnyRefetching));
    }
  }

  close() {
    this.gradebook_columns.close();
    this.gradebook_column_students.close();
    this.assignments_table.close();
    this._unsubscribes.forEach((unsubscribe) => unsubscribe());
    this._unsubscribes = [];

    // Clean up refetch subscriptions
    this._tableRefetchUnsubscribes.forEach((unsubscribe) => unsubscribe());
    this._tableRefetchUnsubscribes = [];
    this._refetchStatusListeners = [];
    this._studentColumnIndexListeners = [];

    // Close all student controllers
    this.studentGradebookControllers.forEach((controller) => {
      controller.close();
    });
    this.studentGradebookControllers.clear();
  }

  public get assignments() {
    if (!this._assignments) throw new Error("Assignments not loaded");
    return this._assignments;
  }

  public set assignments(assignments: Assignment[]) {
    this._assignments = assignments;
  }

  // Removed old subscription methods - use TableController directly

  // Register a subscriber for a specific mapping by id
  subscribeColumnStudent(id: number, cb: (item: GradebookColumnStudent | undefined) => void) {
    return this.gradebook_column_students.getById(id, cb).unsubscribe;
  }

  // Subscribe to a specific student/column pair using the specialized index
  subscribeStudentColumnPair(
    student_id: string,
    column_id: number,
    cb: (item: GradebookColumnStudent | undefined) => void,
    preferPrivate: boolean = this._isInstructorOrGrader // If true, prefer private records, otherwise prefer non-private
  ) {
    // Get initial value
    const initialValue = this.getGradebookColumnStudent(column_id, student_id);
    cb(initialValue);

    // Try to get the appropriate record based on user role
    // Instructors/graders prefer private records, students get non-private
    let key = this.getStudentColumnKey(student_id, column_id, preferPrivate);
    let studentId = this.studentColumnIndex.get(key);

    // If preferred record doesn't exist, try the other type
    if (!studentId) {
      key = this.getStudentColumnKey(student_id, column_id, !preferPrivate);
      studentId = this.studentColumnIndex.get(key);
    }

    if (!studentId) {
      // If no record exists, subscribe to list changes to catch when it's created
      return this.gradebook_column_students.list(() => {
        this.updateStudentColumnIndex();
        const updatedValue = this.getGradebookColumnStudent(column_id, student_id);
        cb(updatedValue);
      }).unsubscribe;
    }

    // Subscribe to the specific record using getById
    return this.gradebook_column_students.getById(studentId, (data) => {
      // Apply privacy filter
      if (data && (data.is_private || !this._isInstructorOrGrader)) {
        cb(data);
      } else {
        cb(undefined);
      }
    }).unsubscribe;
  }

  // Register a subscriber for the full list
  subscribeColumnStudentList(cb: (items: GradebookColumnStudent[]) => void) {
    return this.gradebook_column_students.list((data) => {
      cb(data);
    }).unsubscribe;
  }

  // Get all students for a specific column using the specialized index
  getStudentsForColumn(column_id: number): GradebookColumnStudent[] {
    // Don't return data if any table is refetching to avoid partial data
    if (this._isAnyTableRefetching) {
      return [];
    }

    const students: GradebookColumnStudent[] = [];
    this.studentColumnIndex.forEach((studentId, key) => {
      // Extract column_id from the key (format: "student_id:column_id:isPrivate")
      const keyParts = key.split(":");
      const keyColumnId = parseInt(keyParts[1]);

      if (keyColumnId === column_id) {
        const student = this.gradebook_column_students.rows.find((s) => s.id === studentId);
        if (student && (student.is_private || !this._isInstructorOrGrader)) {
          students.push(student);
        }
      }
    });
    return students;
  }

  // Subscribe to all students for a specific column
  subscribeStudentsForColumn(column_id: number, cb: (items: GradebookColumnStudent[]) => void) {
    // Get initial value
    const initialStudents = this.getStudentsForColumn(column_id);
    cb(initialStudents);

    // Subscribe to changes
    return this.gradebook_column_students.list(() => {
      this.updateStudentColumnIndex();
      const updatedStudents = this.getStudentsForColumn(column_id);
      cb(updatedStudents);
    }).unsubscribe;
  }

  // Get all columns for a specific student using the specialized index
  getColumnsForStudent(student_id: string): GradebookColumnStudent[] {
    // Don't return data if any table is refetching to avoid partial data
    if (this._isAnyTableRefetching) {
      return [];
    }

    const columns: GradebookColumnStudent[] = [];
    this.studentColumnIndex.forEach((studentId, key) => {
      // Extract student_id from the key (format: "student_id:column_id:isPrivate")
      const keyParts = key.split(":");
      const keyStudentId = keyParts[0];

      if (keyStudentId === student_id) {
        const student = this.gradebook_column_students.rows.find((s) => s.id === studentId);
        if (student && (student.is_private || !this._isInstructorOrGrader)) {
          columns.push(student);
        }
      }
    });
    return columns;
  }

  // Subscribe to all columns for a specific student
  subscribeColumnsForStudent(student_id: string, cb: (items: GradebookColumnStudent[]) => void) {
    // Get initial value
    const initialColumns = this.getColumnsForStudent(student_id);
    cb(initialColumns);

    // Subscribe to changes
    return this.gradebook_column_students.list(() => {
      this.updateStudentColumnIndex();
      const updatedColumns = this.getColumnsForStudent(student_id);
      cb(updatedColumns);
    }).unsubscribe;
  }

  getGradebookColumn(id: number) {
    return this.gradebook_columns.rows.find((col) => col.id === id);
  }

  getGradebookColumnStudent(column_id: number, student_id: string): GradebookColumnStudent | undefined {
    // Don't return data if any table is refetching to avoid partial data
    if (this._isAnyTableRefetching) {
      throw new Error("Should not try to get gradebook column student when any table is refetching");
      // return undefined;
    }

    // Try to get the appropriate record based on user role
    // Instructors/graders prefer private records, students get non-private
    const preferPrivate = this._isInstructorOrGrader;
    let key = this.getStudentColumnKey(student_id, column_id, preferPrivate);
    let studentId = this.studentColumnIndex.get(key);

    // If preferred record doesn't exist, try the other type
    if (!studentId) {
      key = this.getStudentColumnKey(student_id, column_id, !preferPrivate);
      studentId = this.studentColumnIndex.get(key);
    }

    if (!studentId) {
      // Return undefined if student doesn't have an entry for this column (normal case)
      return undefined;
    }

    // Get the actual student record from the TableController
    const student = this.gradebook_column_students.rows.find((s) => s.id === studentId);

    // Apply privacy filter - return student if authorized, undefined if not
    if (student && (student.is_private || !this._isInstructorOrGrader)) {
      return student;
    }

    // Return undefined for unauthorized access instead of throwing
    // This handles cases where students shouldn't see private data
    return undefined;
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
      gradebook_columns: this.gradebook_columns.rows
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
        (this._expression_prefix || "") + "\n" + (column.render_expression ?? "round(score, 2)");
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

  getStudentGradebookController(student_id: string) {
    if (!this.studentGradebookControllers.has(student_id)) {
      this.studentGradebookControllers.set(
        student_id,
        new StudentGradebookController(
          this.gradebook_columns,
          this.gradebook_column_students,
          student_id,
          this._isInstructorOrGrader
        )
      );
    }
    return this.studentGradebookControllers.get(student_id)!;
  }

  // Removed get gradebook() method - use TableController data directly instead
  get isReady() {
    return this.gradebook_columns.ready && this.gradebook_column_students.ready && this.assignments_table.ready;
  }

  get isAnyTableRefetching() {
    return this._isAnyTableRefetching;
  }

  get isStudentColumnIndexPopulated() {
    return this._isStudentColumnIndexPopulated;
  }

  /**
   * Subscribe to refetch status changes across all tables
   * @param listener Callback that receives the current refetch status
   * @returns Unsubscribe function
   */
  subscribeToRefetchStatus(listener: (isRefetching: boolean) => void) {
    this._refetchStatusListeners.push(listener);
    // Immediately call with current status
    listener(this._isAnyTableRefetching);
    return () => {
      this._refetchStatusListeners = this._refetchStatusListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Subscribe to studentColumnIndex population status changes
   * @param listener Callback that receives the current population status
   * @returns Unsubscribe function
   */
  subscribeToStudentColumnIndexStatus(listener: (isPopulated: boolean) => void) {
    this._studentColumnIndexListeners.push(listener);
    // Immediately call with current status
    listener(this._isStudentColumnIndexPopulated);
    return () => {
      this._studentColumnIndexListeners = this._studentColumnIndexListeners.filter((l) => l !== listener);
    };
  }
  exportGradebook(courseController: CourseController) {
    const roster = courseController.getRosterWithUserInfo().data;
    const columns = [...this.gradebook_columns.rows];
    columns.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const result = [];
    result.push(["Name", "Email", "Canvas ID", "SID", ...columns.map((col) => col.name)]);
    roster.forEach((student) => {
      const studentGradebookController = this.getStudentGradebookController(student.private_profile_id);
      const userProfile = courseController.profiles.getById(student.private_profile_id);
      const gradesForStudent = columns.map((col) => getScore(studentGradebookController.getGradesForStudent(col.id)));
      const row = [
        userProfile.data.name ?? "Unknown",
        student.users.email ?? "Unknown",
        student.canvas_id,
        userProfile?.data?.sis_user_id,
        ...gradesForStudent
      ];
      result.push(row);
    });

    return result;
  }
  get columns() {
    // Don't return data if any table is refetching to avoid partial data
    if (this._isAnyTableRefetching) {
      return [];
    }
    return this.gradebook_columns.rows;
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
    const columnStudents = this.gradebook_column_students.rows.filter(
      (student) => student.gradebook_column_id === columnId
    );
    const allGradesNull = columnStudents.every((student) => {
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
  const courseController = useCourseController();
  const gradebook_id = course.classes.gradebook_id;
  const class_id = course.classes.id;
  const isInstructorOrGrader = course.role === "instructor" || course.role === "grader";
  const controller = useRef<GradebookController | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    return () => {
      if (controller.current) {
        controller.current.close();
        controller.current = null;
      }
    };
  }, []);

  if (!gradebook_id || isNaN(Number(gradebook_id))) {
    return <Text>Error: Gradebook is not enabled for this course.</Text>;
  }

  if (controller.current === null) {
    controller.current = new GradebookController(
      isInstructorOrGrader,
      class_id,
      gradebook_id,
      courseController.classRealTimeController
    );
  }

  return (
    <GradebookContext.Provider value={{ gradebookController: controller.current }}>
      <GradebookControllerCreator class_id={class_id} setReady={setReady} controller={controller.current} />
      {!ready && <LoadingScreen />}
      {ready && children}
    </GradebookContext.Provider>
  );
}

function GradebookControllerCreator({
  class_id,
  setReady,
  controller
}: {
  class_id: number;
  setReady: (ready: boolean) => void;
  controller: GradebookController;
}) {
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
      select: "activesubmissionid, student_private_profile_id, assignment_id, grader, groupname"
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
    if (!submissionsLoading) {
      setReady(true);
    }
  }, [submissionsLoading, setReady]);
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

export function useGradebookRefetchStatus() {
  const gradebookController = useGradebookController();
  const [isRefetching, setIsRefetching] = useState(gradebookController.isAnyTableRefetching);

  useEffect(() => {
    return gradebookController.subscribeToRefetchStatus(setIsRefetching);
  }, [gradebookController]);

  return isRefetching;
}

export function useStudentColumnIndexStatus() {
  const gradebookController = useGradebookController();
  const [isPopulated, setIsPopulated] = useState(gradebookController.isStudentColumnIndexPopulated);

  useEffect(() => {
    return gradebookController.subscribeToStudentColumnIndexStatus(setIsPopulated);
  }, [gradebookController]);

  return isPopulated;
}
