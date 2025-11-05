"use client";
import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import TableController, { type BroadcastMessage } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import {
  Assignment,
  GradebookColumn,
  GradebookColumnDependencies,
  GradebookColumnStudent
} from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Link, Spinner, Text, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CourseController, useCourseController } from "./useCourseController";

import type { Json } from "@/utils/supabase/SupabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { all, ConstantNode, create, FunctionNode, Matrix } from "mathjs";
import { minimatch } from "minimatch";
import { useClassProfiles } from "./useClassProfiles";

export default function useGradebook() {
  const gradebookController = useGradebookController();

  return gradebookController;
}

export type GradebookRecordsForStudent = {
  private_profile_id: string;
  entries: {
    gcs_id: number;
    gc_id: number;
    is_private: boolean;
    score: number | null;
    score_override: number | null;
    is_missing: boolean;
    is_excused: boolean;
    is_droppable: boolean;
    released: boolean;
    score_override_note: string | null;
    is_recalculating: boolean;
    incomplete_values: Json; // JSONB type
  }[];
};
export function useIsGradebookDataReady() {
  const gradebookController = useGradebookController();
  const [isReady, setIsReady] = useState(gradebookController.table.ready);
  useEffect(() => {
    let cleanedUp = false;
    gradebookController.table.readyPromise.then(() => {
      if (cleanedUp) return;
      setIsReady(true);
    });
    return () => {
      cleanedUp = true;
    };
  }, [gradebookController]);
  return isReady;
}
export function useGradebookColumns() {
  const gradebookController = useGradebookController();
  const [columns, setColumns] = useState<GradebookColumn[]>(gradebookController.gradebook_columns.rows);

  useEffect(() => {
    return gradebookController.gradebook_columns.list((data) => {
      setColumns(data);
    }).unsubscribe;
  }, [gradebookController]);

  return columns;
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

  useEffect(() => {
    // Use the specialized index for direct access to student/column pair
    const unsubscribe = gradebookController.subscribeStudentColumnPair(student_id, column_id, setColumnStudent);
    return () => unsubscribe();
  }, [column_id, student_id, gradebookController]);

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
    const assignment = gradebookController.assignments_table.rows.find((a) => a.gradebook_column_id === column_id);
    if (!assignment) return { status: "not-an-assignment" };
    const submissions = gradebookController.studentSubmissions.get(student_id);
    if (!submissions) return { status: "no-submission" };
    const submission = submissions.find((s) => s.assignment_id === assignment.id);
    if (!submission) return { status: "no-submission" };
    return { status: "found", submission_id: submission.submission_id };
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
        if (assignment.submission_id) {
          return `/course/${column?.class_id}/assignments/${assignment.assignment_id}/submissions/${assignment.submission_id}`;
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
          if (assignment.submission_id) {
            links.push(
              <Link
                tabIndex={-1}
                target="_blank"
                key={`assignment-${assignment.assignment_id}`}
                href={`/course/${column?.class_id}/assignments/${assignment.assignment_id}/submissions/${assignment.submission_id}`}
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
  }, [gradebookController, column, student_id, dependencies, inclusions.assignments, inclusions.gradebook_columns]);
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
      const depColumn = gradebookController.getGradebookColumn(depId);
      if (!depColumn) return false;
      return depColumn.released;
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

    // Subscribe to gradebook data changes for dependency checking
    const unsubscribeGradebookData = gradebookController.table.subscribeToData(() => {
      // Any change in gradebook data might affect dependencies
      checkDependencies();
    });
    unsubscribers.push(unsubscribeGradebookData);

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
    gradebookCellController: GradebookCellController,
    profile_id: string,
    isInstructorOrGrader: boolean
  ) {
    this._profile_id = profile_id;
    this._isInstructorOrGrader = isInstructorOrGrader;

    // Initialize with current data
    const studentData = gradebookCellController.getStudentData(profile_id);
    if (studentData) {
      this._updateColumnsForStudentFromNewFormat(studentData);
    }

    // Subscribe to changes for this specific student
    const unsubscribe = gradebookCellController.subscribeToStudent(profile_id, (studentData) => {
      if (studentData) {
        this._updateColumnsForStudentFromNewFormat(studentData);
      } else {
        this._columnsForStudent = [];
        this._columnStudentSubscribers.forEach((subscribers) => {
          subscribers.forEach((cb) => cb(undefined));
        });
      }
    });
    this._unsubscribes.push(unsubscribe);
  }

  private _updateColumnsForStudentFromNewFormat(studentData: GradebookRecordsForStudent) {
    // Convert entries to GradebookColumnStudent format for backward compatibility
    const newColumns: GradebookColumnStudent[] = studentData.entries
      .filter((entry) => entry.is_private || !this._isInstructorOrGrader)
      .map((entry) => ({
        id: entry.gcs_id,
        created_at: "", // Not available in new format
        updated_at: "", // Not available in new format
        class_id: 0, // Will be set by the parent controller
        gradebook_column_id: entry.gc_id,
        gradebook_id: 0, // Will be set by the parent controller
        is_droppable: entry.is_droppable,
        is_excused: entry.is_excused,
        is_missing: entry.is_missing,
        released: entry.released,
        score: entry.score,
        score_override: entry.score_override,
        score_override_note: entry.score_override_note,
        student_id: this._profile_id,
        is_recalculating: entry.is_recalculating,
        is_private: entry.is_private,
        incomplete_values: entry.incomplete_values
      }));

    if (
      newColumns.length !== this._columnsForStudent.length ||
      !this._arraysEqual(newColumns, this._columnsForStudent)
    ) {
      this._columnsForStudent = newColumns;

      // Notify subscribers of changes
      this._columnsForStudent.forEach((student) => {
        this._columnStudentSubscribers.get(student.gradebook_column_id)?.forEach((cb) => cb(student));
      });
    }
  }

  private _arraysEqual(a: GradebookColumnStudent[], b: GradebookColumnStudent[]): boolean {
    if (a.length !== b.length) return false;

    // Simple check - compare by id and basic score fields
    for (let i = 0; i < a.length; i++) {
      const aItem = a[i];
      const bItem = b[i];
      if (
        aItem.id !== bItem.id ||
        aItem.score !== bItem.score ||
        aItem.score_override !== bItem.score_override ||
        aItem.gradebook_column_id !== bItem.gradebook_column_id
      ) {
        return false;
      }
    }
    return true;
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

/**
 * Efficient controller for managing gradebook cell data using streaming fetch function.
 * Uses a single fetch function to load all data, and subscribes to real-time updates.
 */
export class GradebookCellController {
  private _data: GradebookRecordsForStudent[] = [];
  private _ready: boolean = false;
  private _readyPromise: Promise<void>;
  private _client: SupabaseClient<Database>;
  private _classRealTimeController: ClassRealTimeController;
  private _class_id: number;
  private _unsubscribes: (() => void)[] = [];
  private _closed: boolean = false;

  // Debounce management for refresh
  private _refreshDataDebounceTimer: NodeJS.Timeout | null = null;
  private _refreshDataDebounceDelay: number = 3000; // 3 seconds
  private _lastRefreshCallTime: number = 0;

  // Subscriber management
  private _dataListeners: ((data: GradebookRecordsForStudent[]) => void)[] = [];
  private _studentListeners: Map<string, ((data: GradebookRecordsForStudent | undefined) => void)[]> = new Map();

  constructor(class_id: number, classRealTimeController: ClassRealTimeController, client: SupabaseClient) {
    this._class_id = class_id;
    this._classRealTimeController = classRealTimeController;
    this._client = client;

    this._readyPromise = this._initialize();
  }

  private _lastLoadTimestamp: number = 0;
  private async _initializeEntireGradebookForAllStudents(): Promise<void> {
    const now = Date.now();
    Sentry.addBreadcrumb({
      category: "Gradebook",
      message: "Gradebook data load throttled"
    });
    if (now - this._lastLoadTimestamp < 1000) {
      Sentry.captureMessage("Gradebook data load throttled");
      return;
    }
    this._lastLoadTimestamp = now;
    const { data, error } = await this._client.rpc("get_gradebook_records_for_all_students", {
      p_class_id: this._class_id
    });

    if (this._closed) return;
    if (error) {
      throw new Error(`Failed to load gradebook data: ${error.message}`);
    }
    this._data = (data as GradebookRecordsForStudent[]) || [];
  }
  private async _initializeGradebookForThisStudent(): Promise<void> {
    const { data, error } = await this._client
      .from("gradebook_column_students")
      .select("*")
      .eq("class_id", this._class_id)
      .eq("student_id", this._classRealTimeController.profileId);
    if (this._closed) return;

    if (error) {
      throw new Error(`Failed to load gradebook data: ${error.message}`);
    }
    this._data = [
      {
        private_profile_id: this._classRealTimeController.profileId,
        entries: data.map((item) => ({
          gcs_id: item.id,
          gc_id: item.gradebook_column_id,
          is_private: item.is_private,
          score: item.score,
          score_override: item.score_override,
          is_missing: item.is_missing,
          is_excused: item.is_excused,
          is_droppable: item.is_droppable,
          released: item.released,
          score_override_note: item.score_override_note,
          is_recalculating: item.is_recalculating,
          incomplete_values: item.incomplete_values
        }))
      }
    ];
  }
  private async _initialize(): Promise<void> {
    try {
      if (this._classRealTimeController.isStaff) {
        // Load initial data using the efficient bulk fetch function
        await this._initializeEntireGradebookForAllStudents();
      } else {
        //Load initial data from gradebook_column_students table directly
        await this._initializeGradebookForThisStudent();
      }

      if (this._closed) {
        return;
      }

      // Set up real-time subscriptions for gradebook updates
      this._setupRealTimeSubscriptions();

      this._ready = true;

      // Notify all data listeners
      this._dataListeners.forEach((listener) => listener(this._data));

      // Notify student-specific listeners
      this._data.forEach((student) => {
        const listeners = this._studentListeners.get(student.private_profile_id);
        if (listeners) {
          listeners.forEach((listener) => listener(student));
        }
      });
    } catch (error) {
      if (!this._closed) {
        throw error;
      }
    }
  }

  private _setupRealTimeSubscriptions(): void {
    // Subscribe to gradebook-specific channels (gradebook_column_students)
    // Note: gradebook_row_recalc_state broadcasts are handled directly by callers, not via triggers
    const unsubscribeGradebook = this._classRealTimeController.subscribeToGradebookChannel((message) => {
      if (this._closed) return;

      // Route messages to appropriate handlers
      if (message.table === "gradebook_column_students") {
        this._handleGradebookColumnStudentChange(message);
      } else if (message.table === "gradebook_row_recalc_state") {
        // Still handle these messages if callers broadcast them directly
        this._handleRowRecalcStateChange(message);
      }
    });
    this._unsubscribes.push(unsubscribeGradebook);

    // Subscribe to gradebook_columns changes (for column additions/deletions)
    // This still uses subscribeToTable since it's not part of the gradebook-specific channels
    const unsubscribeColumns = this._classRealTimeController.subscribeToTable("gradebook_columns", (message) => {
      if (this._closed) return;
      this._handleGradebookColumnChange(message);
    });
    this._unsubscribes.push(unsubscribeColumns);
  }

  private _handleGradebookColumnStudentChange(message: BroadcastMessage): void {
    if (message.table !== "gradebook_column_students") return;
    if (message.class_id !== this._class_id) return;

    // Handle bulk operations
    if (message.operation === "BULK_UPDATE" || ("requires_refetch" in message && message.requires_refetch)) {
      // Trigger full refresh for bulk operations
      this._refreshData();
      return;
    }

    // Handle single-row operations with row_ids array (from small bulk operations)
    if ("row_ids" in message && message.row_ids && message.row_ids.length > 0) {
      // For bulk operations with IDs, we need to refetch those specific rows
      // Since we don't have a method to refetch by IDs, trigger a full refresh
      // This could be optimized later to only refetch specific rows
      this._refreshData();
      return;
    }

    // Handle single-row operations
    const data = message.data as GradebookColumnStudent | undefined;
    if (!data) return;

    switch (message.operation) {
      case "INSERT":
      case "UPDATE":
        this._updateStudentEntry(data);
        break;
      case "DELETE":
        if (message.row_id) {
          this._removeStudentEntry(message.row_id as number);
        }
        break;
    }
  }

  private _handleGradebookColumnChange(message: BroadcastMessage): void {
    if (message.table !== "gradebook_columns") return;

    Sentry.addBreadcrumb({
      category: "Gradebook",
      message: "Gradebook column change"
    });
    // For column changes that might affect the overall structure,
    // we could implement specific handling here or trigger a full refresh
    // For now, let's just trigger a refresh to keep things simple
    this._refreshData();
  }

  private _handleRowRecalcStateChange(message: BroadcastMessage): void {
    if (message.table !== "gradebook_row_recalc_state") return;
    if (message.class_id !== this._class_id) return;

    // Handle bulk operations - refresh data since we can't efficiently update individual rows
    if (message.operation === "BULK_UPDATE" || ("requires_refetch" in message && message.requires_refetch)) {
      this._refreshData();
      return;
    }

    // Handle single-row operations
    const payload = (message.data || {}) as Record<string, unknown>;
    const classId = payload["class_id"] as number | undefined;
    const studentId = payload["student_id"] as string | undefined;
    const isPrivate = payload["is_private"] as boolean | undefined;
    const isRecalculating = payload["is_recalculating"] as boolean | undefined;

    if (classId !== this._class_id || !studentId || typeof isPrivate !== "boolean") {
      return;
    }

    // Determine new recalculating state based on operation
    let newState: boolean | undefined = isRecalculating;
    if (message.operation === "DELETE") {
      // Treat deletion as recalculation finished
      newState = false;
    }

    if (typeof newState !== "boolean") return;

    // Update all entries for this student and privacy
    const studentRecord = this._data.find((s) => s.private_profile_id === studentId);
    if (!studentRecord) return;

    let changed = false;
    for (let i = 0; i < studentRecord.entries.length; i++) {
      const entry = studentRecord.entries[i];
      if (entry.is_private === isPrivate && entry.is_recalculating !== newState) {
        studentRecord.entries[i] = { ...entry, is_recalculating: newState };
        changed = true;
      }
    }

    if (changed) {
      // Notify listeners for overall data and the specific student
      this._dataListeners.forEach((listener) => listener(this._data));
      const studentListeners = this._studentListeners.get(studentId);
      if (studentListeners) {
        studentListeners.forEach((listener) => listener(studentRecord));
      }
    }
  }

  private _updateStudentEntry(columnStudent: GradebookColumnStudent): void {
    const studentId = columnStudent.student_id;

    // Find or create student record
    let studentRecord = this._data.find((s) => s.private_profile_id === studentId);

    if (!studentRecord) {
      studentRecord = {
        private_profile_id: studentId,
        entries: []
      };
      this._data.push(studentRecord);
    }

    // Update or add the entry for this column
    const entryIndex = studentRecord.entries.findIndex(
      (e) => e.gc_id === columnStudent.gradebook_column_id && e.is_private === columnStudent.is_private
    );

    const newEntry = {
      gcs_id: columnStudent.id,
      gc_id: columnStudent.gradebook_column_id,
      is_private: columnStudent.is_private,
      score: columnStudent.score,
      score_override: columnStudent.score_override,
      is_missing: columnStudent.is_missing,
      is_excused: columnStudent.is_excused,
      is_droppable: columnStudent.is_droppable,
      released: columnStudent.released,
      score_override_note: columnStudent.score_override_note,
      is_recalculating: columnStudent.is_recalculating,
      incomplete_values: columnStudent.incomplete_values
    };

    if (entryIndex >= 0) {
      studentRecord.entries[entryIndex] = newEntry;
    } else {
      studentRecord.entries.push(newEntry);
    }

    // Notify listeners
    this._dataListeners.forEach((listener) => listener(this._data));

    const studentListeners = this._studentListeners.get(studentId);
    if (studentListeners) {
      studentListeners.forEach((listener) => listener(studentRecord));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private _removeStudentEntry(_gradebookColumnStudentId: number): void {
    // Parameter is intentionally unused - it's provided by the broadcast message
    // but we can't efficiently map it to a specific student/column without additional context
    // Since we don't have the column_id or student_id in the delete message,
    // we can't easily identify which specific entry to remove.
    // For now, we'll trigger a full refresh to ensure consistency.
    // This is a limitation that could be addressed by enhancing the real-time
    // message format to include more context for delete operations.
    Sentry.addBreadcrumb({
      category: "Gradebook",
      message: "Gradebook column student delete"
    });
    this._refreshData();
  }

  private _refreshData(): void {
    const now = Date.now();
    const timeSinceLastCall = now - this._lastRefreshCallTime;

    // Clear any existing debounce timer
    if (this._refreshDataDebounceTimer) {
      clearTimeout(this._refreshDataDebounceTimer);
      this._refreshDataDebounceTimer = null;
    }

    this._lastRefreshCallTime = now;

    // If more than 3 seconds have passed since the last call, execute immediately
    if (timeSinceLastCall >= this._refreshDataDebounceDelay) {
      this._refreshDataImmediate();
    } else {
      // Otherwise, debounce for the remaining time
      this._refreshDataDebounceTimer = setTimeout(() => {
        this._refreshDataImmediate();
        this._refreshDataDebounceTimer = null;
      }, this._refreshDataDebounceDelay);
    }
  }

  private async _refreshDataImmediate(): Promise<void> {
    try {
      // Reset streaming state for full refresh
      this._data = [];

      if (this._classRealTimeController.isStaff) {
        // Load all data using streaming
        await this._initializeEntireGradebookForAllStudents();
      } else {
        // Load all data using streaming
        await this._initializeGradebookForThisStudent();
      }

      // Notify all listeners
      this._dataListeners.forEach((listener) => listener(this._data));

      this._data.forEach((student) => {
        const listeners = this._studentListeners.get(student.private_profile_id);
        if (listeners) {
          listeners.forEach((listener) => listener(student));
        }
      });
    } catch {
      // Silent failure for refresh operations to avoid disrupting the UI
    }
  }

  // Public API methods

  get ready(): boolean {
    return this._ready;
  }

  get readyPromise(): Promise<void> {
    return this._readyPromise;
  }

  get data(): GradebookRecordsForStudent[] {
    return this._data;
  }

  /**
   * Subscribe to all gradebook data changes
   */
  subscribeToData(listener: (data: GradebookRecordsForStudent[]) => void): () => void {
    this._dataListeners.push(listener);

    // Immediately call with current data if ready
    if (this._ready) {
      listener(this._data);
    }

    return () => {
      this._dataListeners = this._dataListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Subscribe to a specific student's gradebook data
   */
  subscribeToStudent(studentId: string, listener: (data: GradebookRecordsForStudent | undefined) => void): () => void {
    const listeners = this._studentListeners.get(studentId) || [];
    listeners.push(listener);
    this._studentListeners.set(studentId, listeners);

    // Immediately call with current data if ready
    if (this._ready) {
      const studentData = this._data.find((s) => s.private_profile_id === studentId);
      listener(studentData);
    }

    return () => {
      const currentListeners = this._studentListeners.get(studentId) || [];
      const filteredListeners = currentListeners.filter((l) => l !== listener);
      if (filteredListeners.length > 0) {
        this._studentListeners.set(studentId, filteredListeners);
      } else {
        this._studentListeners.delete(studentId);
      }
    };
  }

  /**
   * Get gradebook data for a specific student
   */
  getStudentData(studentId: string): GradebookRecordsForStudent | undefined {
    return this._data.find((s) => s.private_profile_id === studentId);
  }

  /**
   * Get a specific cell value for a student and column
   */
  getCellData(studentId: string, columnId: number) {
    const studentData = this.getStudentData(studentId);
    if (!studentData) return undefined;

    return studentData.entries.find((e) => e.gc_id === columnId);
  }

  /**
   * Force a refresh of all data from the database (debounced)
   */
  refresh(): void {
    this._refreshData();
  }

  /**
   * Update a gradebook cell entry
   */
  async updateGradebookEntry(
    gcs_id: number,
    updates: Partial<{
      score: number | null;
      score_override: number | null;
      is_missing: boolean;
      is_excused: boolean;
      is_droppable: boolean;
      score_override_note: string | null;
      is_recalculating: boolean;
      incomplete_values: Json;
    }>
  ): Promise<void> {
    const { error } = await this._client.from("gradebook_column_students").update(updates).eq("id", gcs_id);

    if (error) {
      throw error;
    }

    // Note: Real-time updates will handle refreshing the local data
  }

  /**
   * Clean up resources and subscriptions
   */
  close(): void {
    this._closed = true;

    // Clear any pending debounce timer
    if (this._refreshDataDebounceTimer) {
      clearTimeout(this._refreshDataDebounceTimer);
      this._refreshDataDebounceTimer = null;
    }

    this._unsubscribes.forEach((unsubscribe) => unsubscribe());
    this._unsubscribes = [];
    this._dataListeners = [];
    this._studentListeners.clear();
  }
}

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

  // --- TableController instances ---
  readonly gradebook_columns: TableController<"gradebook_columns">;
  readonly table: GradebookCellController;
  readonly assignments_table: TableController<"assignments">;

  readonly readyPromise: Promise<[void, void, void]>;

  public studentSubmissions: Map<string, Database["public"]["Views"]["active_submissions_for_class"]["Row"][]> =
    new Map();

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

    this.table = new GradebookCellController(class_id, classRealTimeController, client);

    this.assignments_table = new TableController({
      client,
      table: "assignments",
      query: client.from("assignments").select("*").eq("class_id", class_id),
      classRealTimeController
    });

    this.readyPromise = Promise.all([
      this.gradebook_columns.readyPromise,
      this.table.readyPromise,
      this.assignments_table.readyPromise
    ]);

    // Set up refetch status tracking
    this._setupRefetchTracking();
  }

  private _setupRefetchTracking() {
    // Track refetch status for tables (GradebookCellController doesn't expose refetch status)
    const tables = [this.gradebook_columns, this.assignments_table];

    tables.forEach((table) => {
      const unsubscribe = table.subscribeToRefetchStatus(() => {
        this._updateRefetchStatus();
      });
      this._tableRefetchUnsubscribes.push(unsubscribe);
    });
  }

  private _updateRefetchStatus() {
    // Check if any table is currently refetching
    const isAnyRefetching = this.gradebook_columns.isRefetching || this.assignments_table.isRefetching;

    if (this._isAnyTableRefetching !== isAnyRefetching) {
      this._isAnyTableRefetching = isAnyRefetching;
      this._refetchStatusListeners.forEach((listener) => listener(isAnyRefetching));
    }
  }

  close() {
    this.gradebook_columns.close();
    this.table.close();
    this.assignments_table.close();
    this._unsubscribes.forEach((unsubscribe) => unsubscribe());
    this._unsubscribes = [];

    // Clean up refetch subscriptions
    this._tableRefetchUnsubscribes.forEach((unsubscribe) => unsubscribe());
    this._tableRefetchUnsubscribes = [];
    this._refetchStatusListeners = [];

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

  // Subscribe to a specific student/column pair using the new controller
  subscribeStudentColumnPair(
    student_id: string,
    column_id: number,
    cb: (item: GradebookColumnStudent | undefined) => void,
    preferPrivate: boolean = this._isInstructorOrGrader // If true, prefer private records, otherwise prefer non-private
  ) {
    // Subscribe to the specific student's data and extract the column
    return this.table.subscribeToStudent(student_id, (studentData) => {
      if (!studentData) {
        cb(undefined);
        return;
      }

      // Find the entry for this column, preferring the appropriate privacy level
      let entry = studentData.entries.find((e) => e.gc_id === column_id && e.is_private === preferPrivate);

      // If preferred record doesn't exist, try the other type
      if (!entry) {
        entry = studentData.entries.find((e) => e.gc_id === column_id && e.is_private === !preferPrivate);
      }

      if (entry) {
        // Convert the entry back to GradebookColumnStudent format for backward compatibility
        const gradebookColumnStudent: GradebookColumnStudent = {
          id: entry.gcs_id,
          created_at: "", // Not available in new format, but likely not used
          updated_at: "", // Not available in new format
          class_id: this.class_id,
          gradebook_column_id: entry.gc_id,
          gradebook_id: this.gradebook_id,
          is_droppable: entry.is_droppable,
          is_excused: entry.is_excused,
          is_missing: entry.is_missing,
          released: entry.released,
          score: entry.score,
          score_override: entry.score_override,
          score_override_note: entry.score_override_note,
          student_id: student_id,
          is_recalculating: entry.is_recalculating,
          is_private: entry.is_private,
          incomplete_values: entry.incomplete_values
        };
        cb(gradebookColumnStudent);
      } else {
        cb(undefined);
      }
    });
  }

  // Get all students for a specific column using the new controller
  getStudentsForColumn(column_id: number): GradebookColumnStudent[] {
    const students: GradebookColumnStudent[] = [];

    // Iterate through all students in the new controller
    for (const studentData of this.table.data) {
      const entry = studentData.entries.find((e) => e.gc_id === column_id);
      if (entry && (entry.is_private || !this._isInstructorOrGrader)) {
        // Convert to GradebookColumnStudent format for backward compatibility
        const gradebookColumnStudent: GradebookColumnStudent = {
          id: entry.gcs_id,
          created_at: "", // Not available in new format
          updated_at: "", // Not available in new format
          class_id: this.class_id,
          gradebook_column_id: entry.gc_id,
          gradebook_id: this.gradebook_id,
          is_droppable: entry.is_droppable,
          is_excused: entry.is_excused,
          is_missing: entry.is_missing,
          released: entry.released,
          score: entry.score,
          score_override: entry.score_override,
          score_override_note: entry.score_override_note,
          student_id: studentData.private_profile_id,
          is_recalculating: entry.is_recalculating,
          is_private: entry.is_private,
          incomplete_values: entry.incomplete_values
        };
        students.push(gradebookColumnStudent);
      }
    }
    return students;
  }

  // Subscribe to all students for a specific column
  subscribeStudentsForColumn(column_id: number, cb: (items: GradebookColumnStudent[]) => void) {
    // Get initial value
    const initialStudents = this.getStudentsForColumn(column_id);
    cb(initialStudents);

    // Subscribe to changes in the table data
    return this.table.subscribeToData(() => {
      const updatedStudents = this.getStudentsForColumn(column_id);
      cb(updatedStudents);
    });
  }

  // Get all columns for a specific student using the new controller
  getColumnsForStudent(student_id: string): GradebookColumnStudent[] {
    const studentData = this.table.getStudentData(student_id);
    if (!studentData) {
      return [];
    }

    const columns: GradebookColumnStudent[] = [];
    for (const entry of studentData.entries) {
      if (entry.is_private || !this._isInstructorOrGrader) {
        // Convert to GradebookColumnStudent format for backward compatibility
        const gradebookColumnStudent: GradebookColumnStudent = {
          id: entry.gcs_id,
          created_at: "", // Not available in new format
          updated_at: "", // Not available in new format
          class_id: this.class_id,
          gradebook_column_id: entry.gc_id,
          gradebook_id: this.gradebook_id,
          is_droppable: entry.is_droppable,
          is_excused: entry.is_excused,
          is_missing: entry.is_missing,
          released: entry.released,
          score: entry.score,
          score_override: entry.score_override,
          score_override_note: entry.score_override_note,
          student_id: student_id,
          is_recalculating: entry.is_recalculating,
          is_private: entry.is_private,
          incomplete_values: entry.incomplete_values
        };
        columns.push(gradebookColumnStudent);
      }
    }
    return columns;
  }

  // Subscribe to all columns for a specific student
  subscribeColumnsForStudent(student_id: string, cb: (items: GradebookColumnStudent[]) => void) {
    // Get initial value
    const initialColumns = this.getColumnsForStudent(student_id);
    cb(initialColumns);

    // Subscribe to changes for this specific student
    return this.table.subscribeToStudent(student_id, () => {
      const updatedColumns = this.getColumnsForStudent(student_id);
      cb(updatedColumns);
    });
  }

  getGradebookColumn(id: number) {
    return this.gradebook_columns.rows.find((col) => col.id === id);
  }

  getGradebookColumnStudent(column_id: number, student_id: string): GradebookColumnStudent | undefined {
    const studentData = this.table.getStudentData(student_id);
    if (!studentData) {
      return undefined;
    }

    // Try to get the appropriate record based on user role
    // Instructors/graders prefer private records, students get non-private
    const preferPrivate = this._isInstructorOrGrader;
    let entry = studentData.entries.find((e) => e.gc_id === column_id && e.is_private === preferPrivate);

    // If preferred record doesn't exist, try the other type
    if (!entry) {
      entry = studentData.entries.find((e) => e.gc_id === column_id && e.is_private === !preferPrivate);
    }

    if (!entry) {
      return undefined;
    }

    // Convert to GradebookColumnStudent format for backward compatibility
    return {
      id: entry.gcs_id,
      created_at: "", // Not available in new format
      updated_at: "", // Not available in new format
      class_id: this.class_id,
      gradebook_column_id: entry.gc_id,
      gradebook_id: this.gradebook_id,
      is_droppable: entry.is_droppable,
      is_excused: entry.is_excused,
      is_missing: entry.is_missing,
      released: entry.released,
      score: entry.score,
      score_override: entry.score_override,
      score_override_note: entry.score_override_note,
      student_id: student_id,
      is_recalculating: entry.is_recalculating,
      is_private: entry.is_private,
      incomplete_values: entry.incomplete_values
    };
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
        } catch {
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
        new StudentGradebookController(this.gradebook_columns, this.table, student_id, this._isInstructorOrGrader)
      );
    }
    return this.studentGradebookControllers.get(student_id)!;
  }

  // Removed get gradebook() method - use new GradebookCellController data directly instead
  get isReady() {
    return this.gradebook_columns.ready && this.table.ready && this.assignments_table.ready;
  }

  get isAnyTableRefetching() {
    return this._isAnyTableRefetching;
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
   * Update a gradebook cell entry (backward compatibility method)
   */
  async updateGradebookColumnStudent(
    gcs_id: number,
    updates: Partial<{
      score: number | null;
      score_override: number | null;
      is_missing: boolean;
      is_excused: boolean;
      is_droppable: boolean;
      score_override_note: string | null;
      is_recalculating: boolean;
      incomplete_values: Json;
    }>
  ): Promise<void> {
    return this.table.updateGradebookEntry(gcs_id, updates);
  }
  exportGradebook(courseController: CourseController) {
    const roster = courseController.getRosterWithUserInfo().data;
    const columns = [...this.gradebook_columns.rows];
    columns.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const result = [];
    result.push(["Name", "Email", "Canvas ID", "SID", ...columns.map((col) => col.name)]);
    roster.forEach((student) => {
      if (student.disabled) return; //Skip dropped students
      const studentGradebookController = this.getStudentGradebookController(student.private_profile_id);
      const userProfile = courseController.profiles.getById(student.private_profile_id);
      const gradesForStudent = columns.map((col) => getScore(studentGradebookController.getGradesForStudent(col.id)));
      const row = [
        userProfile.data.name ?? "Unknown",
        student.users.email ?? "Unknown",
        student.canvas_id,
        student.users.sis_user_id,
        ...gradesForStudent
      ];
      result.push(row);
    });

    return result;
  }
  get columns() {
    return this.gradebook_columns.rows;
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
  const { role: classRole } = useClassProfiles();
  const course = classRole.classes;
  const courseController = useCourseController();
  const gradebook_id = course.gradebook_id;
  const class_id = course.id;
  const isInstructorOrGrader = classRole.role === "instructor" || classRole.role === "grader";
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
  const [controllerIsReady, setControllerIsReady] = useState(controller.isReady);
  useEffect(() => {
    controller.readyPromise.then(() => {
      setControllerIsReady(true);
    });
  }, [controller]);
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

  const { data: submissions, isLoading: submissionsLoading } = useList<
    Database["public"]["Views"]["active_submissions_for_class"]["Row"]
  >({
    resource: "active_submissions_for_class",
    filters: [{ field: "class_id", operator: "eq", value: class_id }],
    pagination: { pageSize: 500 },
    queryOptions: { enabled: !!class_id },
    meta: {
      select: "*"
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
    if (!submissionsLoading && controllerIsReady) {
      setReady(true);
    }
  }, [submissionsLoading, setReady, controllerIsReady]);
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
