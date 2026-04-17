"use client";
/**
 * Gradebook expression validation and debugging helpers.
 *
 * Parses a score expression, validates dependencies against the set of loaded
 * gradebook columns / assignments, and evaluates the expression for a concrete
 * student by reusing the same math imports that the server-side recalculator
 * and the client-side what-if evaluator use. Returns:
 *   - parse errors (mathjs `parse(...)` threw)
 *   - dependency errors (unknown slug, cycle, etc.)
 *   - the final score (report_only policy) for the student, or the eval error
 *   - intermediate values for every subexpression in the AST so the Expression
 *     Builder can overlay them on top of the editor.
 */
import type { GradebookColumnWithEntries } from "@/utils/supabase/DatabaseTypes";
import {
  addCommonExpressionFunctions,
  COMMON_CONTEXT_FUNCTIONS
} from "@/supabase/functions/gradebook-column-recalculate/expression/commonMathFunctions";
import {
  dedupeIncompleteValues,
  pushMissingDependenciesToContext,
  type IncompleteValuesAdvice
} from "@/supabase/functions/gradebook-column-recalculate/expression/shared";
import type { FunctionNode, MathNode } from "mathjs";
import { minimatch } from "minimatch";
import type { GradebookController } from "@/hooks/useGradebook";

const CONTEXT_FUNCTIONS = [...COMMON_CONTEXT_FUNCTIONS, "gradebook_columns", "assignments"];

export type IntermediateValue = {
  /** Original substring of the expression (e.g. `mean(gradebook_columns("hw-*"))`) */
  source: string;
  /** 0-indexed start/end position in the original expression string */
  start: number;
  end: number;
  /** The mathjs node type (FunctionNode, OperatorNode, …) */
  nodeType: string;
  /** Short printable form of the evaluated value; trimmed to keep overlays small */
  display: string;
  /** Raw value for debugging / tooltip reveal */
  raw?: unknown;
  /** Error message if evaluating this subtree threw */
  error?: string;
};

export type ValidationResult = {
  /** true when the expression parses and all dependency slugs resolve */
  isValid: boolean;
  /** "" or empty string counts as valid (no score expression) */
  isEmpty: boolean;
  parseError: string | null;
  dependencyError: string | null;
  /** Populated when a student row has been evaluated */
  evaluation: EvaluationResult | null;
};

export type EvaluationResult = {
  studentId: string;
  /** Scalar (or best-effort string) of the full expression */
  result: string;
  /** Raw result for later processing */
  rawResult: unknown;
  /** Any incomplete values encountered during the (report_only) run */
  incompleteValues: IncompleteValuesAdvice | null;
  /** Runtime error, if evaluation threw */
  error: string | null;
  /** Per-subnode evaluation results, in source order */
  intermediates: IntermediateValue[];
};

function maybeUnwrapMatrix(value: unknown): unknown {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // mathjs DenseMatrix exposes a toArray() method
    if (typeof obj.toArray === "function") {
      try {
        return (obj.toArray as () => unknown)();
      } catch {
        /* fall through */
      }
    }
  }
  return value;
}

/** Short, safe stringification for overlays (`mean(...) = 87.5`). */
export function formatValueForOverlay(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return value.toString();
    return Number(value.toFixed(4)).toString();
  }
  if (typeof value === "string") {
    if (value.length > 40) return JSON.stringify(value.slice(0, 37) + "…");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const unwrapped = maybeUnwrapMatrix(value);
  if (Array.isArray(unwrapped)) {
    if (unwrapped.length === 0) return "[]";
    if (unwrapped.length > 4) {
      return `[${unwrapped.slice(0, 4).map(formatValueForOverlay).join(", ")}, … ${unwrapped.length - 4} more]`;
    }
    return `[${unwrapped.map(formatValueForOverlay).join(", ")}]`;
  }
  if (typeof unwrapped === "object" && unwrapped !== null) {
    const obj = unwrapped as Record<string, unknown>;
    // GradebookExpressionValue-like object
    if ("score" in obj && "column_slug" in obj) {
      const score = obj["score"];
      const maxScore = obj["max_score"];
      const slug = obj["column_slug"];
      const scoreStr = formatValueForOverlay(score);
      const maxStr = maxScore !== undefined ? `/${formatValueForOverlay(maxScore)}` : "";
      return `${slug}=${scoreStr}${maxStr}`;
    }
    if ("entries" in obj) {
      const entries = (obj as { entries: unknown[] }).entries;
      if (Array.isArray(entries) && entries.length > 0) {
        return formatValueForOverlay(entries[entries.length - 1]);
      }
    }
    try {
      const json = JSON.stringify(unwrapped);
      if (json.length <= 80) return json;
      return json.slice(0, 77) + "…";
    } catch {
      return "[object]";
    }
  }
  return String(unwrapped);
}

/**
 * We accept the full mathjs namespace (`import * as mathjs from "mathjs"`) so
 * we can call `create(...)` to spin up a fresh instance. The caller is
 * expected to dynamically import mathjs to keep it out of the main bundle.
 */
type MathJSNS = typeof import("mathjs");
type MathJSInstance = ReturnType<MathJSNS["create"]>;

function shouldCaptureNode(node: MathNode): boolean {
  const t = node.type;
  // Skip pure leaves (constants / bare symbol lookups) — the overlay for
  // `score * 2` should not repeat the constant `2` next to itself.
  return (
    t === "FunctionNode" ||
    t === "OperatorNode" ||
    t === "ParenthesisNode" ||
    t === "AccessorNode" ||
    t === "ConditionalNode" ||
    t === "ArrayNode" ||
    t === "RangeNode" ||
    t === "AssignmentNode" ||
    t === "BlockNode"
  );
}

/** Ordered walk of the AST. */
function collectNodes(root: MathNode): MathNode[] {
  const out: MathNode[] = [];
  root.traverse((node) => {
    out.push(node);
  });
  return out;
}

type DepsMap = {
  assignments?: number[];
  gradebook_columns?: number[];
};

/**
 * Returns the set of slugs referenced anywhere in the expression AST that do
 * NOT resolve to a known gradebook column / assignment, plus an "unresolvable"
 * flag for cycles.
 */
export function validateExpressionString(
  math: MathJSNS,
  gradebookController: GradebookController,
  expression: string,
  editingColumnId: number | null
): { parseError: string | null; dependencyError: string | null; deps: DepsMap | null } {
  const trimmed = expression.trim();
  if (!trimmed) {
    return { parseError: null, dependencyError: null, deps: null };
  }
  let node: MathNode;
  try {
    node = math.parse(trimmed);
  } catch (e) {
    return {
      parseError: e instanceof Error ? e.message : String(e),
      dependencyError: null,
      deps: null
    };
  }

  try {
    const deps = gradebookController.extractAndValidateDependencies(trimmed, editingColumnId ?? -1) as DepsMap | null;
    // Check AST-wide for references we should support.
    void node;
    return { parseError: null, dependencyError: null, deps };
  } catch (e) {
    return {
      parseError: null,
      dependencyError: e instanceof Error ? e.message : String(e),
      deps: null
    };
  }
}

type ColumnWithEntries = GradebookColumnWithEntries;

/**
 * Build the import map that mirrors `useGradebookWhatIf.recalculate` but with
 * a much simpler, read-only lookup against the current persisted row for the
 * given student (no what-if overrides are applied).
 *
 * All functions receive a leading `context` argument that the AST transform
 * injects before evaluation.
 */
function buildImports(
  math: MathJSInstance,
  gradebookController: GradebookController,
  studentId: string,
  isPrivateCalculation: boolean
) {
  type ImportFunction = (...args: never[]) => unknown;
  const imports: Record<string, ImportFunction> = {};
  const allColumns = gradebookController.columns as ColumnWithEntries[];

  imports["gradebook_columns"] = ((
    context: {
      incomplete_values: IncompleteValuesAdvice | null;
      incomplete_values_policy: "report_only" | "assume_max" | "assume_zero";
    },
    slugInput: string | string[]
  ) => {
    const findOne = (slug: string) => {
      const matchingColumns = allColumns.filter((c) => c.slug && minimatch(c.slug, slug));
      if (!matchingColumns.length) return null;

      const scoreForColumn = (colId: number) => {
        const thisColumn = allColumns.find((c) => c.id === colId);
        if (!thisColumn) throw new Error(`Column ${colId} not found`);
        const columnStudent = gradebookController.getGradebookColumnStudent(colId, studentId);

        let score: number | null = null;
        let released = columnStudent?.released ?? false;
        let is_missing = columnStudent?.is_missing ?? true;
        if (columnStudent?.score_override !== null && columnStudent?.score_override !== undefined) {
          score = columnStudent.score_override;
          is_missing = false;
          released = true;
        } else if (columnStudent?.score !== null && columnStudent?.score !== undefined) {
          score = columnStudent.score;
        }

        const ret = {
          score: score,
          score_override: columnStudent?.score_override ?? null,
          is_missing,
          is_droppable: columnStudent?.is_droppable ?? true,
          is_excused: columnStudent?.is_excused ?? false,
          max_score: thisColumn.max_score ?? 0,
          column_slug: thisColumn.slug ?? "",
          is_private: columnStudent?.is_private ?? false,
          incomplete_values: columnStudent?.incomplete_values ?? null,
          released
        };
        // Propagate not_released / missing for report_only policy so the
        // caller can see which slugs caused undefined intermediates.
        if (!ret.released && ret.score === null && !ret.is_private) {
          if (!context.incomplete_values) context.incomplete_values = {};
          if (!context.incomplete_values.not_released) context.incomplete_values.not_released = {};
          if (!context.incomplete_values.not_released.gradebook_columns) {
            context.incomplete_values.not_released.gradebook_columns = [];
          }
          context.incomplete_values.not_released.gradebook_columns.push(ret.column_slug);
        }
        pushMissingDependenciesToContext(context as { incomplete_values: IncompleteValuesAdvice | null }, ret);
        return ret;
      };

      if (matchingColumns.length === 1 && !slug.includes("*")) {
        return scoreForColumn(matchingColumns[0].id);
      }
      return matchingColumns.map((c) => scoreForColumn(c.id));
    };

    if (Array.isArray(slugInput)) {
      return slugInput.map(findOne);
    }
    const ret = findOne(slugInput);
    if (ret && !slugInput.includes("*")) return ret;
    if (Array.isArray(ret)) return ret;
    return [ret];
  }) as ImportFunction;

  imports["assignments"] = ((_context: unknown, slugInput: string | string[]) => {
    const assignments = (() => {
      try {
        return gradebookController.assignments ?? [];
      } catch {
        return [];
      }
    })();
    const findOne = (slug: string) => {
      const match = assignments.filter((a) => a.slug && minimatch(a.slug, slug));
      if (!match.length) return null;
      return match[0].total_points ?? null;
    };
    if (Array.isArray(slugInput)) return slugInput.map(findOne);
    return findOne(slugInput);
  }) as ImportFunction;

  addCommonExpressionFunctions(imports, {
    includeSecurityGuards: false,
    enforcePrivateCalculationMatch: false
  });
  math.import(imports, { override: true });
  void isPrivateCalculation;
  return imports;
}

/**
 * Parse, validate, and evaluate an expression against a student. Uses the
 * `report_only` incomplete-values policy so missing dependencies surface
 * rather than being silently coerced.
 */
export function evaluateForStudent(params: {
  math: MathJSNS;
  gradebookController: GradebookController;
  expression: string;
  studentId: string;
  editingColumnId: number | null;
  captureIntermediates?: boolean;
}): ValidationResult {
  const { math, gradebookController, expression, studentId, editingColumnId } = params;
  const trimmed = expression.trim();
  if (!trimmed) {
    return {
      isValid: true,
      isEmpty: true,
      parseError: null,
      dependencyError: null,
      evaluation: null
    };
  }

  const { parseError, dependencyError } = validateExpressionString(math, gradebookController, trimmed, editingColumnId);
  if (parseError) {
    return { isValid: false, isEmpty: false, parseError, dependencyError: null, evaluation: null };
  }
  if (dependencyError) {
    return { isValid: false, isEmpty: false, parseError: null, dependencyError, evaluation: null };
  }

  if (!studentId) {
    return {
      isValid: true,
      isEmpty: false,
      parseError: null,
      dependencyError: null,
      evaluation: null
    };
  }

  // Build a fresh math instance to avoid polluting the shared one used by
  // render expressions.
  const localMath: MathJSInstance = math.create(math.all, {});
  buildImports(localMath, gradebookController, studentId, false);

  const parsed = localMath.parse(trimmed);
  const transformed = parsed.transform((node: MathNode) => {
    if (node.type === "FunctionNode") {
      const fn = node as FunctionNode;
      if (CONTEXT_FUNCTIONS.includes(fn.fn.name)) {
        const SymbolNodeCtor = (localMath as unknown as { SymbolNode: new (name: string) => MathNode }).SymbolNode;
        const contextSymbol = new SymbolNodeCtor("context");
        const newArgs: MathNode[] = [contextSymbol, ...fn.args];
        fn.args = newArgs;
      }
    }
    return node;
  });

  const context = {
    student_id: studentId,
    is_private_calculation: false,
    incomplete_values: {} as IncompleteValuesAdvice,
    incomplete_values_policy: "report_only" as const,
    class_id: gradebookController.class_id,
    scope: {
      setTag: () => {},
      addBreadcrumb: () => {}
    }
  };

  /** mathjs `ResultSet` shape is `{ entries: unknown[] }`, but plain Arrays
   * also own an `entries()` method via `Array.prototype`, so we must guard
   * `Array.isArray(...)` first. Without this guard every array-returning
   * expression (e.g. `gradebook_columns("assignment-*")`) would be rewritten
   * to `undefined`. */
  const unwrapResultSet = (value: unknown): unknown => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "entries" in (value as Record<string, unknown>)
    ) {
      const entries = (value as { entries: unknown }).entries;
      if (Array.isArray(entries)) {
        return entries.length > 0 ? entries[entries.length - 1] : undefined;
      }
    }
    return value;
  };

  let rawResult: unknown;
  let resultStr = "";
  let evalError: string | null = null;
  try {
    rawResult = unwrapResultSet(transformed.evaluate({ context }));
    resultStr = formatValueForOverlay(rawResult);
  } catch (e) {
    evalError = e instanceof Error ? e.message : String(e);
  }

  const intermediates: IntermediateValue[] = [];
  if (params.captureIntermediates !== false) {
    for (const node of collectNodes(transformed)) {
      if (!shouldCaptureNode(node)) continue;
      let source: string;
      try {
        source = node.toString();
      } catch {
        source = node.type;
      }
      // Strip the leading `context, ` the transform injected for known context
      // functions so the displayed source matches what the user typed.
      const pretty = source
        .replace(/^mean\(context, /, "mean(")
        .replace(/^sum\(context, /, "sum(")
        .replace(/^countif\(context, /, "countif(")
        .replace(/^drop_lowest\(context, /, "drop_lowest(")
        .replace(/^gradebook_columns\(context, /, "gradebook_columns(")
        .replace(/^assignments\(context, /, "assignments(");

      const idx = trimmed.indexOf(pretty);
      let value: unknown;
      let nodeError: string | undefined;
      try {
        value = unwrapResultSet(node.evaluate({ context }));
      } catch (e) {
        nodeError = e instanceof Error ? e.message : String(e);
      }
      intermediates.push({
        source: pretty,
        nodeType: node.type,
        start: idx,
        end: idx >= 0 ? idx + pretty.length : -1,
        display: nodeError ? `error: ${nodeError}` : formatValueForOverlay(value),
        raw: value,
        error: nodeError
      });
    }
    // Deduplicate identical (source,start) entries that the tree walk can emit
    // (e.g. BlockNode + its single child both match the whole expression).
    const seen = new Set<string>();
    for (let i = intermediates.length - 1; i >= 0; i--) {
      const key = `${intermediates[i].start}:${intermediates[i].end}:${intermediates[i].source}`;
      if (seen.has(key)) intermediates.splice(i, 1);
      else seen.add(key);
    }
  }

  const deduped = dedupeIncompleteValues(context.incomplete_values);
  const hasMeaningful =
    (deduped?.missing?.gradebook_columns?.length ?? 0) > 0 ||
    (deduped?.not_released?.gradebook_columns?.length ?? 0) > 0;

  return {
    isValid: evalError === null,
    isEmpty: false,
    parseError: null,
    dependencyError: null,
    evaluation: {
      studentId,
      result: evalError ? "" : resultStr,
      rawResult,
      incompleteValues: hasMeaningful ? deduped! : null,
      error: evalError,
      intermediates: intermediates.sort((a, b) => {
        if (a.start === b.start) return b.end - a.end; // longer spans first
        return a.start - b.start;
      })
    }
  };
}
