import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { all, ConstantNode, create, EvalFunction, FunctionNode, MathNode } from "mathjs";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  addDependencySourceFunctions,
  ContextFunctions,
  ExprDependencyInstance,
  ExpressionContext
} from "./expression/DependencySource.ts";
import * as Sentry from "npm:@sentry/deno";

type GradebookColumn = GetResult<
  Database["public"],
  Database["public"]["Tables"]["gradebook_columns"]["Row"],
  "gradebook_columns",
  Database["public"]["Tables"]["gradebook_columns"]["Relationships"],
  "*, gradebooks!gradebook_columns_gradebook_id_fkey(expression_prefix)"
>;

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
  columnMap: Map<number, GradebookColumn>,
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
  const columnMap = new Map<number, GradebookColumn>();
  for (const column of allColumns.data ?? []) {
    columnMap.set(column.id, column);
  }

  // Sort cells into dependency-ordered batches
  const cellBatches = sortCellsByDependencies(cells, columnMap, scope);
  scope.setTag("dependency_batches", cellBatches.length);

  // Process each batch sequentially (dependencies must be computed first)
  for (let batchIndex = 0; batchIndex < cellBatches.length; batchIndex++) {
    const batch = cellBatches[batchIndex];
    scope.setTag("current_batch", batchIndex + 1);
    scope.setTag("batch_size", batch.length);

    console.log(`Processing dependency batch ${batchIndex + 1}/${cellBatches.length} with ${batch.length} cells`);

    // Process this batch (cells within a batch can be processed in parallel)
    await processCellBatch(batch, columnMap, allColumns.data ?? [], adminSupabase, scope);
  }
}

/**
 * Process a single batch of cells that have no dependencies on each other.
 * This function contains the original processing logic from processGradebookCellCalculation.
 */
async function processCellBatch(
  cells: GradebookCellRequest[],
  columnMap: Map<number, GradebookColumn>,
  allColumnsData: GradebookColumn[],
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
        Sentry.captureMessage(`Dependency source ${dependencyProvider} not found`, newScope);
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
      ? column.gradebooks.expression_prefix + "\n" + column.score_expression
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
      scope.setTag("score_expression", column.score_expression);
      scope.setTag("column_id", column.id);
      scope.setTag("student_id", cell.student_id);
      scope.setTag("gradebook_column_student_id", cell.gradebook_column_student_id);
      scope.setTag("is_private", cell.is_private);
      if (column.score_expression?.startsWith("importCSV")) {
        await cell.onComplete();
        continue;
      }
      const context: ExpressionContext = {
        student_id: cell.student_id,
        incomplete_values: {},
        is_private_calculation: cell.is_private,
        incomplete_values_policy: "report_only",
        scope: scope
      };
      const compiled = gradebookColumnToScoreExpression.get(column.id);
      if (compiled) {
        try {
          const result = compiled.evaluate({ context });
          let score: number;
          if (typeof result === "object" && result !== null && "entries" in result) {
            const lastEntry = result.entries[result.entries.length - 1];
            score = Number(lastEntry);
          } else {
            score = Number(result);
          }
          const isDependentColumn = column.dependencies && Object.keys(column.dependencies).length > 0;
          const isMissing = !isDependentColumn && (result === undefined || result === null);
          const incompleteValues =
            context.incomplete_values && Object.keys(context.incomplete_values).length === 0
              ? null
              : context.incomplete_values;

          const { error: updateError } = await adminSupabase
            .from("gradebook_column_students")
            .update({
              is_missing: isMissing,
              score,
              incomplete_values: incompleteValues,
              is_recalculating: false
            })
            .eq("id", cell.gradebook_column_student_id);

          if (updateError) {
            const newScope = scope.clone();
            newScope.setContext("cell", cell);
            newScope.setContext("update_data", {
              is_missing: isMissing,
              score,
              incomplete_values: incompleteValues,
              is_recalculating: false
            });
            Sentry.captureException(updateError, newScope);
            console.error("Error updating gradebook cell:", updateError);
          }

          await cell.onComplete();
        } catch (e) {
          const newScope = scope.clone();
          newScope.setTag("score_expression", column.score_expression);
          newScope.setContext("cell", cell);
          Sentry.captureException(e, newScope);
          const { error: errorUpdateError } = await adminSupabase
            .from("gradebook_column_students")
            .update({
              is_missing: true,
              score: null,
              incomplete_values: null,
              is_recalculating: false
            })
            .eq("id", cell.gradebook_column_student_id);
          if (errorUpdateError) {
            newScope.setContext("error_update_data", {
              is_missing: true,
              score: null,
              incomplete_values: null,
              is_recalculating: false
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

// processGradebookCellCalculation([{ gradebook_column_id: 6, student_id: "e0f3531a-b2b5-42c4-b001-d3b0f8ba73c8", onComplete: () => { } }], createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!));
// const parser = new Parser();
// parser.functions.assignmentScore = (assignmentSlug: string) => {
//     return 34;
// }
// const expr = parser.parse("roundTo(assignmentScore('demo-assignment'), 1)");
// const context = {
//     assignments: { "demo-assignment": 95.123 },
// };
// console.log(expr);

// const result = expr.evaluate(context);
// console.log(result);
