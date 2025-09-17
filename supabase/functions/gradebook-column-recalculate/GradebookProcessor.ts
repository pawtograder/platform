import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { all, ConstantNode, create, EvalFunction, FunctionNode, MathNode } from "mathjs";

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  addDependencySourceFunctions,
  ContextFunctions,
  ExprDependencyInstance,
  ExpressionContext,
  setRowOverrideValues,
  clearRowOverrideValues
} from "./expression/DependencySource.ts";
import * as Sentry from "npm:@sentry/deno";

type ColumnWithPrefix = Database["public"]["Tables"]["gradebook_columns"]["Row"] & {
  gradebooks: { expression_prefix: string | null };
};

function deepEqualJson(a: unknown, b: unknown): boolean {
  try {
    const norm = (v: unknown) => (v === undefined ? null : v);
    const sa = JSON.stringify(norm(a));
    const sb = JSON.stringify(norm(b));
    return sa === sb;
  } catch {
    return false;
  }
}

function nearlyEqual(a: number | null, b: number | null, eps = 1e-9): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= eps;
}

type GradebookCellRequest = {
  gradebook_column_id: number;
  gradebook_column_student_id: number;
  is_private: boolean;
  student_id: string;
  onComplete: () => void;
};

type DependenciesType = {
  [key: string]: string[];
};

type CellBatch = GradebookCellRequest[];

/**
 * Performs topological sorting on gradebook cells based on their dependencies.
 * Returns an array of batches where each batch can be processed in parallel,
 * and batches must be processed in order (earlier batches before later ones).
 */
function sortCellsByDependencies(
  cells: GradebookCellRequest[],
  columnMap: Map<number, ColumnWithPrefix>,
  scope: Sentry.Scope
): CellBatch[] {
  // Build dependency graph: columnId -> Set of columnIds that depend on it
  const dependencyGraph = new Map<number, Set<number>>();
  const inDegree = new Map<number, number>();

  // Get all unique column IDs from cells
  const columnIds = new Set(cells.map((cell) => cell.gradebook_column_id));

  // Initialize in-degree counter for all columns
  for (const columnId of columnIds) {
    inDegree.set(columnId, 0);
    dependencyGraph.set(columnId, new Set());
  }

  // Build the dependency graph
  for (const columnId of columnIds) {
    const column = columnMap.get(columnId);
    if (column?.dependencies) {
      const deps = column.dependencies as { gradebook_columns?: number[] };
      if (deps.gradebook_columns) {
        for (const depColumnId of deps.gradebook_columns) {
          // Only consider dependencies that are also in our batch
          if (columnIds.has(depColumnId)) {
            // depColumnId -> columnId dependency
            if (!dependencyGraph.has(depColumnId)) {
              dependencyGraph.set(depColumnId, new Set());
            }
            dependencyGraph.get(depColumnId)!.add(columnId);

            // Increase in-degree of the dependent column
            inDegree.set(columnId, (inDegree.get(columnId) || 0) + 1);
          }
        }
      }
    }
  }

  // Group cells by column ID for easier processing
  const cellsByColumn = new Map<number, GradebookCellRequest[]>();
  for (const cell of cells) {
    if (!cellsByColumn.has(cell.gradebook_column_id)) {
      cellsByColumn.set(cell.gradebook_column_id, []);
    }
    cellsByColumn.get(cell.gradebook_column_id)!.push(cell);
  }

  // Topological sort using Kahn's algorithm
  const batches: CellBatch[] = [];
  const queue: number[] = [];

  // Find all columns with no dependencies (in-degree 0)
  for (const [columnId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(columnId);
    }
  }

  while (queue.length > 0) {
    // Process all columns with no remaining dependencies as one batch
    const currentBatch: GradebookCellRequest[] = [];
    const currentBatchColumns = [...queue];
    queue.length = 0; // Clear the queue

    for (const columnId of currentBatchColumns) {
      // Add all cells for this column to the current batch
      const cellsForColumn = cellsByColumn.get(columnId) || [];
      currentBatch.push(...cellsForColumn);

      // Remove this column from dependency graph and update in-degrees
      const dependents = dependencyGraph.get(columnId) || new Set();
      for (const dependentColumnId of dependents) {
        const newInDegree = (inDegree.get(dependentColumnId) || 0) - 1;
        inDegree.set(dependentColumnId, newInDegree);

        // If this dependent column now has no dependencies, add it to queue
        if (newInDegree === 0) {
          queue.push(dependentColumnId);
        }
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }
  }

  // Check for cycles - if any columns still have positive in-degree, there's a cycle
  const remainingColumns = Array.from(inDegree.entries())
    .filter(([, degree]) => degree > 0)
    .map(([columnId]) => columnId);

  if (remainingColumns.length > 0) {
    const innerScope = scope.clone();
    innerScope.setContext("remaining_columns", { remaining_columns: remainingColumns.join(",") });
    //This will not be correct, but is a way to terminate the process, if this ever actually happens we should debug further to prevent cycles in the first place
    const remainingCells: GradebookCellRequest[] = [];
    for (const columnId of remainingColumns) {
      const cellsForColumn = cellsByColumn.get(columnId) || [];
      remainingCells.push(...cellsForColumn);
    }
    if (remainingCells.length > 0) {
      batches.push(remainingCells);
    }
  }

  return batches;
}

/**
 * Process gradebook cell calculations with proper dependency ordering.
 *
 * This function implements topological sorting to ensure that dependencies
 * are calculated before dependent cells. It:
 * 1. Groups cells by their gradebook column dependencies
 * 2. Uses Kahn's algorithm to create batches where each batch contains only
 *    cells that have no dependencies on cells in later batches
 * 3. Processes batches sequentially, ensuring dependencies are computed first
 * 4. Within each batch, cells can be processed in parallel
 * 5. Creates fresh dependency source instances for each batch to ensure
 *    updated values from previous batches are properly read
 */
export async function processGradebookCellCalculation(
  cells: GradebookCellRequest[],
  adminSupabase: SupabaseClient<Database>,
  scope: Sentry.Scope
) {
  if (cells.length === 0) {
    return;
  }
  scope.setTag("cells", cells.length);
  const allColumns = await adminSupabase
    .from("gradebook_columns")
    .select("*, gradebooks!gradebook_columns_gradebook_id_fkey(expression_prefix)")
    .in("id", Array.from(new Set(cells.map((s) => s.gradebook_column_id))));
  if (allColumns.error) {
    const newScope = scope.clone();
    newScope.setContext("column_ids", { ids: Array.from(new Set(cells.map((s) => s.gradebook_column_id))) });
    newScope.setContext("cells_count", { count: cells.length });
    Sentry.captureException(allColumns.error, newScope);
    console.error("Error fetching gradebook columns:", allColumns.error);
    return;
  }
  const columnMap = new Map<number, ColumnWithPrefix>();
  for (const column of allColumns.data ?? []) {
    columnMap.set(column.id, column as unknown as ColumnWithPrefix);
  }

  // Sort cells into dependency-ordered batches
  const cellBatches = sortCellsByDependencies(cells, columnMap, scope);
  scope.setTag("dependency_batches", cellBatches.length);

  // Process each batch sequentially (dependencies must be computed first)
  for (let batchIndex = 0; batchIndex < cellBatches.length; batchIndex++) {
    const batch = cellBatches[batchIndex];
    scope.setTag("current_batch", batchIndex + 1);
    scope.setTag("batch_size", batch.length);

    const uniqueColumns = new Set(batch.map((b) => b.gradebook_column_id));

    // Process this batch (cells within a batch can be processed in parallel)
    await processCellBatch(
      batch,
      columnMap,
      (allColumns.data ?? []) as unknown as ColumnWithPrefix[],
      adminSupabase,
      scope
    );
  }
}

type GradebookColumnRow = Database["public"]["Tables"]["gradebook_column_students"]["Row"];

export type RowUpdate = {
  gradebook_column_id: number;
  score?: number | null;
  is_missing?: boolean;
  is_excused?: boolean;
  is_droppable?: boolean;
  released?: boolean;
  score_override_note?: string | null;
  incomplete_values?: unknown | null;
};

function topoSortColumns(columns: ColumnWithPrefix[]): number[] {
  const idSet = new Set(columns.map((c) => c.id));
  const inDegree = new Map<number, number>();
  const graph = new Map<number, Set<number>>();
  for (const id of idSet) {
    inDegree.set(id, 0);
    graph.set(id, new Set());
  }
  for (const c of columns) {
    const cid = c.id;
    const deps = (c.dependencies as { gradebook_columns?: number[] } | null)?.gradebook_columns ?? [];
    for (const dep of deps) {
      if (!idSet.has(dep)) continue;
      graph.get(dep)!.add(cid);
      inDegree.set(cid, (inDegree.get(cid) ?? 0) + 1);
    }
  }
  const queue: number[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  const order: number[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const d of graph.get(id) ?? []) {
      const nd = (inDegree.get(d) ?? 0) - 1;
      inDegree.set(d, nd);
      if (nd === 0) queue.push(d);
    }
  }
  // If cycle, append remaining
  if (order.length < idSet.size) {
    for (const id of idSet) if (!order.includes(id)) order.push(id);
  }
  return order;
}

export async function processGradebookRowCalculation(
  adminSupabase: SupabaseClient<Database>,
  scope: Sentry.Scope,
  {
    class_id,
    gradebook_id,
    student_id,
    is_private,
    gcsRows
  }: {
    class_id: number;
    gradebook_id: number;
    student_id: string;
    is_private: boolean;
    gcsRows: Pick<
      Database["public"]["Tables"]["gradebook_column_students"]["Row"],
      | "id"
      | "gradebook_column_id"
      | "is_missing"
      | "is_excused"
      | "is_droppable"
      | "score_override"
      | "score"
      | "released"
      | "score_override_note"
      | "incomplete_values"
    >[];
  }
): Promise<RowUpdate[]> {
  // Fetch all columns for this gradebook
  const { data: columns, error: colsError } = await adminSupabase
    .from("gradebook_columns")
    .select("*, gradebooks!gradebook_columns_gradebook_id_fkey(expression_prefix)")
    .eq("gradebook_id", gradebook_id)
    .order("sort_order", { ascending: true });
  if (colsError || !columns) {
    Sentry.captureException(colsError || new Error("Missing columns"), scope);
    return [];
  }

  const columnById = new Map<number, ColumnWithPrefix>();
  const columnBySlug = new Map<string, ColumnWithPrefix>();
  for (const c of columns) {
    columnById.set(c.id, c);
    columnBySlug.set(c.slug, c);
  }

  // Prepare math and dependency sources
  const math = create(all, {});

  // Collect dependency keys for this row
  const keys: ExprDependencyInstance[] = [];
  for (const c of columns) {
    const deps = (c.dependencies as { gradebook_columns?: number[]; assignments?: number[] } | null) || {};
    if (deps.gradebook_columns) {
      for (const dep of deps.gradebook_columns) {
        keys.push({ class_id, student_id, key: String(dep) });
      }
    }
    if (deps.assignments) {
      for (const dep of deps.assignments) {
        keys.push({ class_id, student_id, key: String(dep) });
      }
    }
  }

  await addDependencySourceFunctions({ math, keys, supabase: adminSupabase });

  // Compile expressions
  const compiledById = new Map<number, EvalFunction>();
  for (const c of columns as unknown as ColumnWithPrefix[]) {
    if (!c.score_expression) continue;
    const theScoreExpression = (c.gradebooks.expression_prefix ?? "") + "\n" + c.score_expression;
    const expr = math.parse(theScoreExpression);
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
        if ((fn.fn.name === "assignments" || fn.fn.name === "gradebook_columns") && fn.args.length > 0) {
          const argType = fn.args[0].type;
          const newArgs: MathNode[] = [];
          newArgs.push(new math.SymbolNode("context"));
          if (argType === "ConstantNode") {
            const argVal = (fn.args[0] as ConstantNode).value;
            if (typeof argVal === "string" && (argVal as string).includes("*")) {
              const batchDependencySourceMap = (math as unknown as Record<string, unknown>)
                ._batchDependencySourceMap as Record<
                  string,
                  { expandKey: (params: { key: string; class_id: number }) => string[] }
                >;
              if (batchDependencySourceMap && batchDependencySourceMap[fn.fn.name]) {
                const dependencySource = batchDependencySourceMap[fn.fn.name];
                const expandedKeys = dependencySource.expandKey({ key: argVal, class_id });
                newArgs.push(new math.ArrayNode(expandedKeys.map((key: string) => new math.ConstantNode(key))));
              } else {
                newArgs.push(...fn.args);
              }
            } else {
              newArgs.push(...fn.args);
            }
          } else {
            newArgs.push(...fn.args);
          }
          fn.args = newArgs;
        }
      }
      return node;
    });
    compiledById.set(c.id, instrumented.compile());
  }

  const gcsByColumnId = new Map<number, GradebookColumnRow>();
  for (const r of gcsRows as GradebookColumnRow[]) gcsByColumnId.set(r.gradebook_column_id, r);

  // Override map to expose computed results to subsequent columns
  const rowOverrideMap = new Map<
    string,
    {
      class_id: number;
      created_at: string;
      gradebook_column_id: number;
      gradebook_id: number;
      id: number;
      incomplete_values: Database["public"]["Tables"]["gradebook_column_students"]["Row"]["incomplete_values"];
      is_droppable: boolean;
      is_excused: boolean;
      is_missing: boolean;
      is_private: boolean;
      released: boolean;
      score: number | null;
      score_override: number | null;
      score_override_note: string | null;
      student_id: string;
      column_slug: string;
      max_score: number;
    }
  >();
  setRowOverrideValues(
    class_id,
    student_id,
    is_private,
    rowOverrideMap as unknown as Map<string, import("./expression/types.d.ts").GradebookColumnStudentWithMaxScore>
  );

  const order = topoSortColumns(columns as unknown as ColumnWithPrefix[]);
  const updates: RowUpdate[] = [];

  for (const columnId of order) {
    const column = columnById.get(columnId)!;
    const current = gcsByColumnId.get(columnId);
    const slug = (column as unknown as ColumnWithPrefix).slug!;
    const context: ExpressionContext = {
      student_id,
      incomplete_values: {},
      is_private_calculation: is_private,
      incomplete_values_policy: "report_only",
      scope,
      class_id
    };

    let nextScore: number | null = null;
    let isMissing = false;
    let nextIncomplete: unknown | null = null;
    let nextReleased = false;

    if (column.score_expression) {
      try {
        const compiled = compiledById.get(columnId)!;
        const result = compiled.evaluate({ context });
        if (typeof result === "object" && result !== null && "entries" in (result as Record<string, unknown>)) {
          const lastEntry = (result as { entries: unknown[] }).entries[
            (result as { entries: unknown[] }).entries.length - 1
          ];
          if (lastEntry === undefined || lastEntry === null) {
            nextScore = null;
          } else {
            nextScore = Number(lastEntry);
          }
        } else {
          nextScore = result === undefined || result === null ? null : Number(result);
        }
        const depObj = (column.dependencies as Record<string, unknown>) || {};
        const hasDeps = Object.keys(depObj).length > 0;
        isMissing = !hasDeps && nextScore === null;
        nextIncomplete =
          context.incomplete_values && Object.keys(context.incomplete_values).length === 0
            ? null
            : context.incomplete_values;
        const assigns = (column.dependencies as { assignments?: number[] } | null)?.assignments ?? null;
        if (assigns && Array.isArray(assigns)) {
          const hasUnreleased =
            (context.incomplete_values as { not_released?: { gradebook_columns?: string[] } } | undefined)?.not_released
              ?.gradebook_columns?.length ?? 0;
          nextReleased = hasUnreleased === 0 && !isMissing;
        } else {
          nextReleased = ((column as unknown as { released: boolean | null }).released ?? false) as boolean;
        }
      } catch (e) {
        console.log(e);
        Sentry.captureException(e, scope);
        nextScore = null;
        isMissing = true;
        nextIncomplete = null;
        nextReleased = false;
      }
    } else {
      // Skip manual columns
      continue;
    }

    const overrideScore = (current?.score_override as number | null) ?? null;
    if (overrideScore !== null) {
      isMissing = false;
    }

    // Queue update only if changed
    const curScore = (current?.score as number | null) ?? null;
    const curMissing = (current?.is_missing as boolean) ?? false;
    const curReleased = (current?.released as boolean) ?? false;
    const curIncomplete = current?.incomplete_values ?? null;
    const changed =
      !nearlyEqual(nextScore, curScore) ||
      isMissing !== curMissing ||
      nextReleased !== curReleased ||
      !deepEqualJson(nextIncomplete, curIncomplete);
    if (changed) {
      updates.push({
        gradebook_column_id: columnId,
        score: nextScore,
        is_missing: isMissing,
        released: nextReleased,
        incomplete_values: nextIncomplete
      });
    }

    // Expose computed value for dependency reads by slug (lightweight payload)
    const maxScore = (column as unknown as { max_score: number | null }).max_score ?? 0;
    const valueForSlug = {
      class_id,
      created_at: new Date().toISOString(),
      gradebook_column_id: columnId,
      gradebook_id,
      id: (gcsByColumnId.get(columnId)?.id as number) ?? 0,
      incomplete_values:
        nextIncomplete as unknown as Database["public"]["Tables"]["gradebook_column_students"]["Row"]["incomplete_values"],
      is_droppable: (current?.is_droppable as boolean) ?? false,
      is_excused: (current?.is_excused as boolean) ?? false,
      is_missing: isMissing,
      is_private,
      released: nextReleased,
      score:
        current?.score_override !== null && current?.score_override !== undefined ? current?.score_override : nextScore,
      score_override: (current?.score_override as number | null) ?? null,
      score_override_note: (current?.score_override_note as string | null) ?? null,
      student_id,
      column_slug: slug,
      max_score: maxScore
    };
    rowOverrideMap.set(slug, valueForSlug);
  }

  clearRowOverrideValues(class_id, student_id, is_private);
  return updates;
}

export async function processGradebookRowsCalculation(
  adminSupabase: SupabaseClient<Database>,
  scope: Sentry.Scope,
  {
    class_id,
    gradebook_id,
    is_private,
    rows
  }: {
    class_id: number;
    gradebook_id: number;
    is_private: boolean;
    rows: {
      student_id: string;
      gcsRows: Pick<
        Database["public"]["Tables"]["gradebook_column_students"]["Row"],
        | "id"
        | "gradebook_column_id"
        | "is_missing"
        | "is_excused"
        | "is_droppable"
        | "score_override"
        | "score"
        | "released"
        | "score_override_note"
        | "incomplete_values"
      >[];
    }[];
  }
): Promise<Map<string, RowUpdate[]>> {
  const { data: columns, error: colsError } = await adminSupabase
    .from("gradebook_columns")
    .select("*, gradebooks!gradebook_columns_gradebook_id_fkey(expression_prefix)")
    .eq("gradebook_id", gradebook_id)
    .order("sort_order", { ascending: true });
  if (colsError || !columns) {
    Sentry.captureException(colsError || new Error("Missing columns"), scope);
    return new Map();
  }

  const math = create(all, {});
  // Build keys for all students in this batch
  const keys: ExprDependencyInstance[] = [];
  for (const c of columns) {
    const deps = (c.dependencies as { gradebook_columns?: number[]; assignments?: number[] } | null) || {};
    for (const r of rows) {
      if (deps.gradebook_columns) {
        for (const dep of deps.gradebook_columns) keys.push({ class_id, student_id: r.student_id, key: String(dep) });
      }
      if (deps.assignments) {
        for (const dep of deps.assignments) keys.push({ class_id, student_id: r.student_id, key: String(dep) });
      }
    }
  }

  console.log(`Working on ${keys.length} keys for gradebook ${gradebook_id}`);
  await addDependencySourceFunctions({ math, keys, supabase: adminSupabase });

  const compiledById = new Map<number, EvalFunction>();
  for (const c of columns as unknown as ColumnWithPrefix[]) {
    if (!c.score_expression) continue;
    const theScoreExpression = (c.gradebooks.expression_prefix ?? "") + "\n" + c.score_expression;
    const expr = math.parse(theScoreExpression);
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
        if ((fn.fn.name === "assignments" || fn.fn.name === "gradebook_columns") && fn.args.length > 0) {
          const argType = fn.args[0].type;
          const newArgs: MathNode[] = [];
          newArgs.push(new math.SymbolNode("context"));
          if (argType === "ConstantNode") {
            const argVal = (fn.args[0] as ConstantNode).value;
            if (typeof argVal === "string" && (argVal as string).includes("*")) {
              const batchDependencySourceMap = (math as unknown as Record<string, unknown>)
                ._batchDependencySourceMap as Record<
                  string,
                  { expandKey: (params: { key: string; class_id: number }) => string[] }
                >;
              if (batchDependencySourceMap && batchDependencySourceMap[fn.fn.name]) {
                const dependencySource = batchDependencySourceMap[fn.fn.name];
                const expandedKeys = dependencySource.expandKey({ key: argVal, class_id });
                newArgs.push(new math.ArrayNode(expandedKeys.map((key: string) => new math.ConstantNode(key))));
              } else {
                newArgs.push(...fn.args);
              }
            } else {
              newArgs.push(...fn.args);
            }
          } else {
            newArgs.push(...fn.args);
          }
          fn.args = newArgs;
        }
      }
      return node;
    });
    compiledById.set(c.id, instrumented.compile());
  }

  const order = topoSortColumns(columns as unknown as ColumnWithPrefix[]);
  const result = new Map<string, RowUpdate[]>();

  for (const { student_id, gcsRows } of rows) {
    const gcsByColumnId = new Map<number, GradebookColumnRow>();
    for (const r of gcsRows) {
      gcsByColumnId.set(r.gradebook_column_id, r);
    }
    const studentOverrideMap = new Map<
      string,
      {
        class_id: number;
        created_at: string;
        gradebook_column_id: number;
        gradebook_id: number;
        id: number;
        incomplete_values: Database["public"]["Tables"]["gradebook_column_students"]["Row"]["incomplete_values"];
        is_droppable: boolean;
        is_excused: boolean;
        is_missing: boolean;
        is_private: boolean;
        released: boolean;
        score: number | null;
        score_override: number | null;
        score_override_note: string | null;
        student_id: string;
        column_slug: string;
        max_score: number;
      }
    >();
    setRowOverrideValues(
      class_id,
      student_id,
      is_private,
      studentOverrideMap as unknown as Map<string, import("./expression/types.d.ts").GradebookColumnStudentWithMaxScore>
    );

    const updates: RowUpdate[] = [];
    for (const columnId of order) {
      const column = columns.find((c) => c.id === columnId)!;
      const current = gcsByColumnId.get(columnId);
      const slug = column.slug;
      const context: ExpressionContext = {
        student_id,
        incomplete_values: {},
        is_private_calculation: is_private,
        incomplete_values_policy: "report_only",
        scope,
        class_id
      };

      let nextScore: number | null = null;
      let isMissing = false;
      let nextIncomplete: unknown | null = null;
      let nextReleased = false;

      if (column.score_expression) {
        try {
          const compiled = compiledById.get(columnId)!;
          const resultVal = compiled.evaluate({ context });
          if (
            typeof resultVal === "object" &&
            resultVal !== null &&
            "entries" in (resultVal as Record<string, unknown>)
          ) {
            const lastEntry = (resultVal as { entries: unknown[] }).entries[
              (resultVal as { entries: unknown[] }).entries.length - 1
            ];
            nextScore = Number(lastEntry);
          } else {
            nextScore = resultVal === undefined || resultVal === null ? null : Number(resultVal);
          }
          const depObj = (column.dependencies as Record<string, unknown>) || {};
          const hasDeps = Object.keys(depObj).length > 0;
          isMissing = !hasDeps && nextScore === null;
          nextIncomplete =
            context.incomplete_values && Object.keys(context.incomplete_values).length === 0
              ? null
              : context.incomplete_values;
          const assigns = (column.dependencies as { assignments?: number[] } | null)?.assignments ?? null;
          if (assigns && Array.isArray(assigns)) {
            const hasUnreleased =
              (context.incomplete_values as { not_released?: { gradebook_columns?: string[] } } | undefined)
                ?.not_released?.gradebook_columns?.length ?? 0;
            nextReleased = hasUnreleased === 0 && !isMissing;
          } else {
            nextReleased = (column.released ?? false) as boolean;
          }
        } catch (e) {
          Sentry.captureException(e, scope);
          nextScore = null;
          isMissing = true;
          nextIncomplete = null;
          nextReleased = false;
        }
      } else {
        // Skip manual columns
        continue;
      }

      const overrideScore = (current?.score_override as number | null) ?? null;
      if (overrideScore !== null) {
        isMissing = false;
      }
      const curScore = (current?.score as number | null) ?? null;

      const curMissing = (current?.is_missing as boolean) ?? false;
      const curReleased = (current?.released as boolean) ?? false;
      const curIncomplete = current?.incomplete_values ?? null;
      const changed =
        !nearlyEqual(nextScore, curScore) ||
        isMissing !== curMissing ||
        nextReleased !== curReleased ||
        !deepEqualJson(nextIncomplete, curIncomplete);
      if (changed) {
        updates.push({
          gradebook_column_id: columnId,
          score: nextScore,
          is_missing: isMissing,
          released: nextReleased,
          incomplete_values: nextIncomplete
        });
      }

      const maxScore = (column as { max_score: number | null }).max_score ?? 0;
      const valueForSlug = {
        class_id,
        created_at: new Date().toISOString(),
        gradebook_column_id: columnId,
        gradebook_id,
        id: (gcsByColumnId.get(columnId)?.id as number) ?? 0,
        incomplete_values:
          nextIncomplete as unknown as Database["public"]["Tables"]["gradebook_column_students"]["Row"]["incomplete_values"],
        is_droppable: (current?.is_droppable as boolean) ?? false,
        is_excused: (current?.is_excused as boolean) ?? false,
        is_missing: isMissing,
        is_private,
        released: nextReleased,
        score:
          current?.score_override !== null && current?.score_override !== undefined
            ? current?.score_override
            : nextScore,
        score_override: (current?.score_override as number | null) ?? null,
        score_override_note: (current?.score_override_note as string | null) ?? null,
        student_id,
        column_slug: slug,
        max_score: maxScore
      };
      studentOverrideMap.set(slug, valueForSlug);
    }

    clearRowOverrideValues(class_id, student_id, is_private);
    result.set(student_id, updates);
  }
  console.log(`Finished working on ${rows.length} students for gradebook ${gradebook_id}, results: ${result.size}`);

  return result;
}

/**
 * Process a single batch of cells that have no dependencies on each other.
 * This function contains the original processing logic from processGradebookCellCalculation.
 */
async function processCellBatch(
  cells: GradebookCellRequest[],
  columnMap: Map<number, ColumnWithPrefix>,
  allColumnsData: ColumnWithPrefix[],
  adminSupabase: SupabaseClient<Database>,
  scope: Sentry.Scope
) {
  function CellRequestToKeyRequests(cell: GradebookCellRequest): ExprDependencyInstance[] {
    const column = columnMap.get(cell.gradebook_column_id);
    if (!column) {
      throw new Error(`Column ${cell.gradebook_column_id} not found`);
    }
    const dependencies = column.dependencies as DependenciesType;
    if (!dependencies) {
      const newScope = scope.clone();
      newScope.setContext("cell", cell);
      newScope.setTag("column_id", cell.gradebook_column_id);
      newScope.setTag("score_expression", column.score_expression);
      Sentry.captureMessage(`Column has no dependencies, why is it being recalculated?`, newScope);
      return [];
    }
    const ret: ExprDependencyInstance[] = [];
    for (const dependencyProvider of Object.keys(dependencies)) {
      // Validate that we have a dependency source for this provider
      if (dependencyProvider !== "assignments" && dependencyProvider !== "gradebook_columns") {
        const newScope = scope.clone();
        newScope.setContext("cell", cell);
        newScope.setTag("dependency_provider", dependencyProvider);
        Sentry.captureMessage(`Dependency source not found`, newScope);
        continue;
      }
      ret.push(
        ...dependencies[dependencyProvider].map((key) => ({
          key: key,
          student_id: cell.student_id,
          class_id: column.class_id
        }))
      );
    }
    return ret;
  }

  const keysToRetrieve = cells.map((s) => CellRequestToKeyRequests(s));

  // Create a custom mathjs instance
  const math = create(all, {});

  // Create fresh dependency source instances for this batch to ensure
  // they pick up the latest values from previous batches
  await addDependencySourceFunctions({ math, keys: keysToRetrieve.flat(), supabase: adminSupabase });

  const gradebookColumnToScoreExpression = new Map<number, EvalFunction>();

  // Note: We're no longer using the global DependencySourceMap since we create
  // fresh instances in addDependencySourceFunctions for each batch
  // This ensures each batch sees the updated values from previous batches

  for (const column of allColumnsData) {
    if (!column.score_expression) {
      continue;
    }
    // console.log(`Parsing expression for column ${column.slug} ${column.id}, ${column.score_expression}`);
    const theScoreExpression = column.score_expression
      ? (column.gradebooks.expression_prefix ?? "") + "\n" + column.score_expression
      : "";
    const expr = math.parse(theScoreExpression);
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
        // Check if this is a dependency function (assignments or gradebook_columns)
        if ((fn.fn.name === "assignments" || fn.fn.name === "gradebook_columns") && fn.args.length > 0) {
          const argType = fn.args[0].type;
          const newArgs: MathNode[] = [];
          newArgs.push(new math.SymbolNode("context"));
          if (argType === "ConstantNode") {
            const argVal = (fn.args[0] as ConstantNode).value;
            if (typeof argVal === "string" && (argVal as string).includes("*")) {
              // For wildcard patterns, expand them using the batch dependency sources
              const batchDependencySourceMap = (math as unknown as Record<string, unknown>)
                ._batchDependencySourceMap as Record<
                  string,
                  { expandKey: (params: { key: string; class_id: number }) => string[] }
                >;
              if (batchDependencySourceMap && batchDependencySourceMap[fn.fn.name]) {
                const dependencySource = batchDependencySourceMap[fn.fn.name];
                const expandedKeys = dependencySource.expandKey({ key: argVal, class_id: column.class_id });
                newArgs.push(new math.ArrayNode(expandedKeys.map((key: string) => new math.ConstantNode(key))));
              } else {
                newArgs.push(...fn.args);
              }
            } else {
              newArgs.push(...fn.args);
            }
          } else {
            newArgs.push(...fn.args);
          }
          fn.args = newArgs;
        }
      }
      return node;
    });
    // console.log(`Instrumented expression for column ${column.slug} ${column.id}, ${instrumented.toString()}`);
    const compiled = instrumented.compile();
    gradebookColumnToScoreExpression.set(column.id, compiled);
  }

  for (const cell of cells) {
    const column = allColumnsData.find((c) => c.id === cell.gradebook_column_id);
    if (column) {
      scope.setContext("cell", cell);
      scope.setTag("score_expression", column.score_expression ?? "");
      scope.setTag("column_id", column.id);
      scope.setTag("student_id", cell.student_id);
      scope.setTag("gradebook_column_student_id", cell.gradebook_column_student_id);
      scope.setTag("is_private", cell.is_private);
      if ((column.score_expression ?? "").startsWith("importCSV")) {
        await cell.onComplete();
        continue;
      }
      const context: ExpressionContext = {
        student_id: cell.student_id,
        incomplete_values: {},
        is_private_calculation: cell.is_private,
        incomplete_values_policy: "report_only",
        scope: scope,
        class_id: column.class_id
      };
      const compiled = gradebookColumnToScoreExpression.get(column.id);
      if (compiled) {
        try {
          const result = compiled.evaluate({ context });
          let score: number;
          if (typeof result === "object" && result !== null && "entries" in (result as Record<string, unknown>)) {
            const lastEntry = (result as { entries: unknown[] }).entries[
              (result as { entries: unknown[] }).entries.length - 1
            ];
            score = Number(lastEntry);
          } else {
            score = Number(result);
          }
          const isDependentColumn = !!column.dependencies && Object.keys(column.dependencies as object).length > 0;
          const isMissing = !isDependentColumn && (result === undefined || result === null);
          const incompleteValues =
            context.incomplete_values && Object.keys(context.incomplete_values).length === 0
              ? null
              : context.incomplete_values;

          // Calculate released status for assignment-dependent columns
          let isReleased = false;
          if (
            column.dependencies &&
            (column.dependencies as { assignments?: number[] }).assignments &&
            Array.isArray((column.dependencies as { assignments?: number[] }).assignments)
          ) {
            // For assignment-dependent columns, check if all underlying assignment reviews are released
            // This is determined by checking if there are any not_released items in incomplete_values
            const hasUnreleasedDependencies =
              (context.incomplete_values as { not_released?: { gradebook_columns?: string[] } } | undefined)
                ?.not_released?.gradebook_columns?.length ?? 0;
            isReleased = !hasUnreleasedDependencies && !isMissing;
          } else {
            // For non-assignment columns, use the column's released status
            isReleased = (column as unknown as { released: boolean | null }).released ?? false;
          }

          const { error: updateError } = await adminSupabase
            .from("gradebook_column_students")
            .update({
              is_missing: isMissing,
              score,
              incomplete_values: incompleteValues,
              is_recalculating: false,
              released: isReleased
            })
            .eq("id", cell.gradebook_column_student_id);

          if (updateError) {
            const newScope = scope.clone();
            newScope.setContext("cell", cell);
            newScope.setContext("update_data", {
              is_missing: isMissing,
              score,
              incomplete_values: incompleteValues,
              is_recalculating: false,
              released: isReleased
            });
            Sentry.captureException(updateError, newScope);
            console.error("Error updating gradebook cell:", updateError);
          }

          await cell.onComplete();
        } catch (e) {
          const newScope = scope.clone();
          newScope.setTag("score_expression", column.score_expression ?? "");
          newScope.setContext("cell", cell);
          Sentry.captureException(e, newScope);
          const { error: errorUpdateError } = await adminSupabase
            .from("gradebook_column_students")
            .update({
              is_missing: true,
              score: null,
              incomplete_values: null,
              is_recalculating: false,
              released: false
            })
            .eq("id", cell.gradebook_column_student_id);
          if (errorUpdateError) {
            newScope.setContext("error_update_data", {
              is_missing: true,
              score: null,
              incomplete_values: null,
              is_recalculating: false,
              released: false
            });
            Sentry.captureException(errorUpdateError, newScope);
            console.error("Error updating gradebook cell in error state:", errorUpdateError);
          }
          await cell.onComplete();
        }
        // updatePromises.push(updatePromise);
        // console.log(`Result for cell ${cell.gradebook_column_id} ${cell.student_id}: ${result}`);
      }
    }
  }
  // console.log("Waiting for updates to complete");
  // await Promise.all(updatePromises);

  // cell.onComplete();
}
