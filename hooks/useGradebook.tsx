"use client";
import type {
  Assignment,
  GradebookColumn,
  GradebookColumnDependencies,
  GradebookColumnStudent,
  GradebookColumnWithEntries,
  GradebookWithAllData
} from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Link, Spinner, Text, VStack } from "@chakra-ui/react";
import { type LiveEvent, useList, useShow } from "@refinedev/core";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useCourse } from "./useAuthState";
import { CourseController } from "./useCourseController";

import type { Database } from "@/utils/supabase/SupabaseTypes";
import { all, ConstantNode, create, FunctionNode } from "mathjs";
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
  const [column, setColumn] = useState<GradebookColumn | undefined>(gradebookController.getGradebookColumn(column_id));
  useEffect(() => {
    return gradebookController.getColumnWithSubscription(column_id, setColumn);
  }, [gradebookController, column_id]);
  if (!column) {
    throw new Error(`Column ${column_id} not found`);
  }
  return column;
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
export function useReferencedContent(column_id: number, student_id: string) {
  const gradebookController = useGradebookController();
  const column = useGradebookColumn(column_id);
  const dependencies = column?.dependencies as { gradebook_columns?: number[]; assignments?: number[] };
  const referencedContent = useMemo(() => {
    if (!dependencies) return null;
    const links: React.ReactNode[] = [];
    if (dependencies.assignments && dependencies.assignments.length > 0) {
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
    if (dependencies.gradebook_columns) {
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
class StudentGradebookController {
  private _columnsForStudent: GradebookColumnStudent[] = [];
  private _profile_id: string;
  private _columnStudentSubscribers: Map<number, ((item: GradebookColumnStudent | undefined) => void)[]> = new Map();

  constructor(gradebook: GradebookWithAllData, profile_id: string) {
    this._profile_id = profile_id;
    gradebook.gradebook_columns.forEach((col) => {
      col.gradebook_column_students.forEach((s) => {
        if (s.student_id === profile_id) {
          this._columnsForStudent.push(s);
        }
      });
    });
  }
  setColumnForStudent(updatedColumn: GradebookColumnStudent) {
    if (updatedColumn.student_id !== this._profile_id) {
      throw new Error("Column is not for this student");
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

  getColumnWithSubscription(column_id: number, cb: (column: GradebookColumn) => void) {
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
      ?.gradebook_column_students.find((s) => s.student_id === student_id);
  }

  public getRendererForColumn(column_id: number) {
    const ret = this.cellRenderersByColumnId.get(column_id);
    if (!ret) {
      throw new Error(`No renderer found for column ${column_id}`);
    }
    return ret;
  }

  public extractAndValidateDependencies(expr: string, column_id: number) {
    const math = create(all!);
    const exprNode = math.parse(expr);
    const dependencies: Record<string, number[]> = {};
    const errors: string[] = [];
    const availableDependencies = {
      assignments: this._assignments || [],
      gradebook_columns: this.gradebook.gradebook_columns
    };
    exprNode.traverse((node) => {
      if (node.type === "FunctionNode") {
        const functionName = (node as FunctionNode).fn.name;
        if (functionName in availableDependencies) {
          const firstArg = (node as FunctionNode).args?.[0];
          if (firstArg?.type === "ConstantNode") {
            const argName = (firstArg as ConstantNode).value;
            if (typeof argName === "string") {
              const matching = availableDependencies[functionName as keyof typeof availableDependencies].filter((d) =>
                minimatch(d.slug!, argName)
              );
              if (matching.length > 0) {
                (dependencies[functionName] ??= []).push(...matching.map((d) => d.id));
              } else {
                errors.push(`Invalid dependency: ${argName} for function ${functionName}`);
              }
            }
          }
        }
      }
    });
    if (dependencies["gradebook_columns"]) {
      //Check for cycles between the columns
      const visited = new Set<number>();
      const checkForCycles = (column_id: number) => {
        if (errors.length > 0) return;
        if (visited.has(column_id)) {
          errors.push(`Cycle detected in score expression`);
          return;
        }
        visited.add(column_id);
        const column = this.getGradebookColumn(column_id);
        if (column) {
          const deps = column.dependencies as { gradebook_columns?: number[] };
          if (deps && deps.gradebook_columns) {
            for (const dependency of deps.gradebook_columns) {
              checkForCycles(dependency);
            }
          }
        }
      };
      visited.add(column_id);
      for (const dependentColumn of dependencies["gradebook_columns"]!) {
        checkForCycles(dependentColumn);
      }
    }
    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }
    if (Object.keys(dependencies).length === 0) {
      return null;
    }
    return dependencies;
  }

  createRendererForColumn(column: GradebookColumn): (cell: RendererParams) => React.ReactNode {
    const math = create(all!);
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
    imports["letter"] = (score: number | undefined) => {
      if (score === undefined) return "(Missing)";
      const letter = letterBreakpoints.find((b) => score >= b.score);
      return letter ? letter.letter : "F";
    };
    const checkBreakpoints = [
      { score: 90, mark: "✔️+" },
      { score: 80, mark: "✔️" },
      { score: 70, mark: "✔️-" },
      { score: 0, mark: "❌" }
    ];
    imports["check"] = (score: number | undefined) => {
      if (score === undefined) return "(Missing)";
      const check = checkBreakpoints.find((b) => score >= b.score);
      return check ? check.mark : "❌";
    };
    for (const functionName of securityFunctions) {
      imports[functionName] = () => {
        throw new Error(`${functionName} is not allowed`);
      };
    }
    math.import(imports, { override: true });
    try {
      const expr = math.parse(column.render_expression ?? "round(score, 2)");
      const compiled = expr.compile();
      const renderer = (cell: RendererParams) => {
        try {
          const context = {
            score: cell.score_override ?? cell.score
          };
          if (context.score === null || context.score === undefined) {
            return <Text>(Missing)</Text>;
          }
          return <Text>{compiled.evaluate(context)}</Text>;
        } catch {
          return <Text>Expression evaluation error</Text>;
        }
      };
      return renderer;
    } catch {
      const renderer = () => {
        return <Text>Expression parse error</Text>;
      };
      return renderer;
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
    if (newColumn.sort_order !== column?.sort_order) {
      const newColumns = this.gradebook.gradebook_columns.map((c) => (c.id === column_id ? newColumn : c));
      newColumns.sort((a, b) => a.sort_order - b.sort_order);
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
          slug: "loading"
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
          new StudentGradebookController(this.gradebook, body.student_id)
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
      this.studentGradebookControllers.set(student_id, new StudentGradebookController(this.gradebook, student_id));
    }
    return this.studentGradebookControllers.get(student_id)!;
  }

  set gradebook(gradebook: GradebookWithAllData) {
    this._gradebook = gradebook;
    this.studentGradebookControllers.clear();
    this.gradebook.gradebook_columns.forEach((col) => {
      this.cellRenderersByColumnId.set(col.id, this.createRendererForColumn(col));
      col.gradebook_column_students.forEach((s) => {
        if (!this.studentGradebookControllers.has(s.student_id)) {
          this.studentGradebookControllers.set(
            s.student_id,
            new StudentGradebookController(this.gradebook, s.student_id)
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
    columns.sort((a, b) => a.sort_order - b.sort_order);
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
  const controller = useRef<GradebookController>(new GradebookController());
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
