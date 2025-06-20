import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { all, ConstantNode, create, EvalFunction, FunctionNode, MathNode } from "mathjs";

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  addDependencySourceFunctions,
  DependencySource,
  DependencySourceMap,
  ExprDependencyInstance
} from "./expression/DependencySource.ts";

type GradebookColumn = Database["public"]["Tables"]["gradebook_columns"]["Row"];

type GradebookCellRequest = {
  gradebook_column_id: number;
  student_id: string;
  gradebook_column_student_id?: number; //If set, this means we are doing a very large batch collecting EVERY student for this column
  onComplete: () => void;
};

type DependenciesType = {
  [key: string]: string[];
};

export async function processGradebookCellCalculation(
  cells: GradebookCellRequest[],
  adminSupabase: SupabaseClient<Database>
) {
  const allColumns = await adminSupabase
    .from("gradebook_columns")
    .select("*")
    .in(
      "id",
      cells.map((s) => s.gradebook_column_id)
    );
  const columnMap = new Map<number, GradebookColumn>();
  for (const column of allColumns.data ?? []) {
    columnMap.set(column.id, column);
  }
  function CellRequestToKeyRequests(cell: GradebookCellRequest): ExprDependencyInstance[] {
    const column = columnMap.get(cell.gradebook_column_id);
    if (!column) {
      throw new Error(`Column ${cell.gradebook_column_id} not found`);
    }
    const dependencies = column.dependencies as DependenciesType;
    if (!dependencies) {
      console.error(`Column ${cell.gradebook_column_id} has no dependencies, why is it being recalculated?`);
      return [];
    }
    const ret: ExprDependencyInstance[] = [];
    for (const dependencyProvider of Object.keys(dependencies)) {
      // Validate that we have a dependency source for this provider
      if (!DependencySourceMap[dependencyProvider as keyof typeof DependencySourceMap]) {
        throw new Error(`Dependency source ${dependencyProvider} not found`);
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

  await addDependencySourceFunctions({ math, keys: keysToRetrieve.flat(), class_id: 1, supabase: adminSupabase });

  const gradebookColumnToScoreExpression = new Map<number, EvalFunction>();
  const functionNameToDependencySource = new Map<string, DependencySource>();
  for (const dependencySource of Object.values(DependencySourceMap)) {
    for (const functionName of dependencySource.getFunctionNames()) {
      functionNameToDependencySource.set(functionName, dependencySource);
    }
  }

  for (const column of allColumns.data ?? []) {
    const expr = math.parse(column.score_expression ?? "");
    const instrumented = expr.transform((node: MathNode) => {
      if (node.type === "FunctionNode") {
        const fn = node as FunctionNode;
        if (functionNameToDependencySource.has(fn.fn.name) && fn.args.length > 0) {
          const argType = fn.args[0].type;
          const newArgs: MathNode[] = [];
          newArgs.push(new math.SymbolNode("student_id"));
          if (argType === "ConstantNode") {
            const argVal = (fn.args[0] as ConstantNode).value;
            if (typeof argVal === "string" && (argVal as string).includes("*")) {
              const dependencySource = functionNameToDependencySource.get(fn.fn.name);
              if (dependencySource) {
                const expandedKeys = dependencySource.expandKey({ key: argVal, class_id: column.class_id });
                newArgs.push(new math.ArrayNode(expandedKeys.map((key) => new math.ConstantNode(key))));
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
    console.log(instrumented.toString());
    const compiled = instrumented.compile();
    gradebookColumnToScoreExpression.set(column.id, compiled);
  }

  for (const cell of cells) {
    console.log(`Processing cell ${cell.gradebook_column_id} ${cell.student_id}`);
    const column = allColumns.data?.find((c) => c.id === cell.gradebook_column_id);
    if (column) {
      if (column.score_expression?.startsWith("importCSV")) {
        cell.onComplete();
        continue;
      }
      const context = {
        student_id: cell.student_id
      };
      const compiled = gradebookColumnToScoreExpression.get(column.id);
      if (compiled) {
        const result = compiled.evaluate(context);
        //Update the cell
        console.log(`Updating cell ${cell.gradebook_column_id} ${cell.student_id} with result ${result}`);
        await adminSupabase
          .from("gradebook_column_students")
          .update({
            is_missing: result === undefined,
            score: Number(result)
          })
          .eq("gradebook_column_id", cell.gradebook_column_id)
          .eq("student_id", cell.student_id);
        cell.onComplete();

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
