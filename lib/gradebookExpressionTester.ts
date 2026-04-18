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

/**
 * Per-input-line annotation used by the inline preview. For each line of the
 * user's typed expression we report either:
 *   - `kind: "value"` — this line ENDS a top-level statement (e.g. `T = 930`
 *     or the final `])` of a multi-line `case_when([...])`), and `display` is
 *     the short-form evaluated value of that statement.
 *   - `kind: "continuation"` — this line is mid-statement (e.g. a line in the
 *     middle of a multi-line matrix literal). No value to show yet.
 *   - `kind: "blank"` — empty or whitespace-only line.
 *   - `kind: "error"` — the statement ending on this line threw during eval;
 *     `display` is the error message.
 */
export type LineResult =
  | { kind: "value"; lineIndex: number; blockIndex: number; display: string; raw?: unknown }
  | { kind: "continuation"; lineIndex: number; blockIndex: number }
  | { kind: "blank"; lineIndex: number }
  | { kind: "error"; lineIndex: number; blockIndex: number; display: string };

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
  /**
   * Per-input-line annotations, one per `\n`-separated line of the raw
   * expression text. Used by the Expression Builder to render an inline
   * `= value` overlay on the line that ends each statement.
   */
  lineResults: LineResult[];
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
  // `score * 2` should not repeat the constant `2` next to itself. We also
  // skip `FunctionAssignmentNode` (e.g. `f(x) = ...`) because its value is a
  // function reference, not a scalar worth displaying, and we never recurse
  // into its body either (see `collectNodes`).
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

/**
 * Walk the user's raw expression character-by-character, tracking bracket
 * depth and string state, and assign each `\n`-separated input line to a
 * top-level statement (block) index. Returns, per input line:
 *   `{ kind: "end", blockIndex }` — the line ENDS a top-level statement.
 *   `{ kind: "mid", blockIndex }` — the line is mid-statement.
 *   `{ kind: "blank" }` — whitespace/comment only.
 *
 * Matches mathjs's parse behaviour: newline at bracket-depth 0 terminates a
 * statement, so does `;` at depth 0. Tracks `"` / `'` string literals and
 * backslash-escapes so braces inside strings don't affect depth. `#`
 * starts a line comment.
 */
export function mapLinesToBlocks(
  expression: string
): Array<{ kind: "end"; blockIndex: number } | { kind: "mid"; blockIndex: number } | { kind: "blank" }> {
  const lines = expression.split("\n");
  const result: Array<{ kind: "end"; blockIndex: number } | { kind: "mid"; blockIndex: number } | { kind: "blank" }> =
    [];
  let depth = 0;
  let blockIndex = 0;
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let hasContent = false;
    let endedStatement = false;
    let assignedBlock = blockIndex;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (inString) {
        if (ch === "\\") {
          j++;
          continue;
        }
        if (ch === stringChar) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
        hasContent = true;
        continue;
      }
      if (ch === "#") break; // mathjs line comment
      if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
        hasContent = true;
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        hasContent = true;
        continue;
      }
      if (/\s/.test(ch)) continue;
      if (ch === ";" && depth === 0) {
        assignedBlock = blockIndex;
        blockIndex++;
        endedStatement = true;
        hasContent = true;
        continue;
      }
      hasContent = true;
    }
    if (!hasContent) {
      result.push({ kind: "blank" });
      continue;
    }
    if (depth === 0 && !inString) {
      // Newline at top level → end of a statement.
      assignedBlock = blockIndex;
      blockIndex++;
      endedStatement = true;
    }
    result.push(
      endedStatement ? { kind: "end", blockIndex: assignedBlock } : { kind: "mid", blockIndex: assignedBlock }
    );
  }
  return result;
}

/** Ordered walk of the AST. Descendants of a `FunctionAssignmentNode` (the
 *  body of a lambda like `f(x) = x.score > 0`) are intentionally skipped:
 *  their free variables (`x` here) are bound inside the lambda and have no
 *  meaningful value in the outer evaluation scope, so trying to evaluate them
 *  produces misleading "Undefined symbol x" errors. The lambda itself — and
 *  the top-level call that receives it, e.g. `countif(gradebook_columns(...),
 *  f(x) = ...)` — is still captured. */
function collectNodes(root: MathNode): MathNode[] {
  const out: MathNode[] = [];
  const walk = (node: MathNode) => {
    out.push(node);
    if (node.type === "FunctionAssignmentNode") return;
    (node as unknown as { forEach?: (cb: (child: MathNode) => void) => void }).forEach?.(walk);
  };
  walk(root);
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
  // Attempt a parse first so we can distinguish a syntax error from a
  // dependency error. `extractAndValidateDependencies` also parses internally
  // but throws a single merged error, which the UI presents under the wrong
  // category.
  try {
    math.parse(trimmed);
  } catch (e) {
    return {
      parseError: e instanceof Error ? e.message : String(e),
      dependencyError: null,
      deps: null
    };
  }

  try {
    const deps = gradebookController.extractAndValidateDependencies(trimmed, editingColumnId ?? -1) as DepsMap | null;
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
function buildImports(math: MathJSInstance, gradebookController: GradebookController, studentId: string) {
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
  return imports;
}

/**
 * Breakpoints used by the default gradebook render helpers (`letter`,
 * `check`, `checkOrX`). Mirrors the tables in `useGradebook._getSharedMath`.
 * Keeping them here keeps the tester self-contained — the expression builder
 * can evaluate a column's render expression without touching the shared math
 * instance that powers the live gradebook cells (and without waiting for the
 * controller to have wired one up yet, which matters on Add Column).
 */
const LETTER_BREAKPOINTS: Array<{ score: number; letter: string }> = [
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
const CHECK_BREAKPOINTS: Array<{ score: number; mark: string }> = [
  { score: 90, mark: "✔️+" },
  { score: 80, mark: "✔️" },
  { score: 70, mark: "✔️-" },
  { score: 0, mark: "❌" }
];

export type RenderExpressionResult =
  | { kind: "empty" }
  | { kind: "ok"; rendered: string }
  | { kind: "error"; message: string };

/**
 * Evaluate a column's render expression against a final score. Reuses the
 * `letter`, `check`, `checkOrX`, and `customLabel` helpers exposed in the
 * live gradebook so the builder's preview matches the rendered cell.
 *
 * @param prefix The gradebook's `expression_prefix` (may be empty).
 * @param renderExpression The user's render expression. Empty/null → `empty`.
 * @param score Final numeric score of the column (undefined → "(N/A)"-like).
 * @param maxScore Max score of the column.
 */
export function evaluateRenderExpression(
  math: MathJSNS,
  prefix: string,
  renderExpression: string | null | undefined,
  score: number | undefined,
  maxScore: number | undefined
): RenderExpressionResult {
  const raw = (renderExpression ?? "").trim();
  if (!raw) return { kind: "empty" };
  try {
    const localMath: MathJSInstance = math.create(math.all, {});
    type ImportFunction = (...args: never[]) => unknown;
    const imports: Record<string, ImportFunction> = {};
    imports["letter"] = ((s: number | undefined, m: number | undefined) => {
      if (s === undefined) return "(N/A)";
      const normalized = 100 * (s / (m ?? 100));
      const hit = LETTER_BREAKPOINTS.find((b) => normalized >= b.score);
      return hit ? hit.letter : "F";
    }) as ImportFunction;
    imports["check"] = ((s: number | undefined, m: number | undefined) => {
      if (s === undefined) return "(N/A)";
      const normalized = 100 * (s / (m ?? 100));
      const hit = CHECK_BREAKPOINTS.find((b) => normalized >= b.score);
      return hit ? hit.mark : "❌";
    }) as ImportFunction;
    imports["checkOrX"] = ((s: number | undefined, m: number | undefined) => {
      if (s === undefined) return "(N/A)";
      const normalized = 100 * (s / (m ?? 1));
      return normalized > 0 ? "✔️" : "❌";
    }) as ImportFunction;
    imports["customLabel"] = ((value: number | undefined, breakpoints: { toArray?: () => unknown[] } | unknown) => {
      if (value === undefined) return "(N/A)";
      const arr = Array.isArray(breakpoints)
        ? breakpoints
        : breakpoints && typeof (breakpoints as { toArray?: () => unknown[] }).toArray === "function"
          ? (breakpoints as { toArray: () => unknown[] }).toArray()
          : [];
      for (const pair of arr as [number, string][]) {
        const [s, label] = pair;
        if (value >= s) return label;
      }
      return "Error";
    }) as ImportFunction;
    // Mirror the security guards used by the live gradebook cell renderer in
    // `GradebookController._getSharedMath()`: block MathJS surface that could
    // let a render expression redefine operators, pull arbitrary modules, or
    // reshape the parser. This keeps the preview behaviour aligned with what
    // the rendered cell will actually do, so instructors can't save an
    // expression here that the real renderer would reject at runtime.
    for (const name of ["import", "createUnit", "reviver", "resolve"]) {
      imports[name] = (() => {
        throw new Error(`${name} is not allowed`);
      }) as ImportFunction;
    }
    localMath.import(imports, { override: true });

    const full = (prefix ? prefix + "\n" : "") + raw;
    const expr = localMath.parse(full);
    const compiled = expr.compile();
    const ret = compiled.evaluate({ score, max_score: maxScore });
    const unwrapped =
      ret && typeof ret === "object" && !Array.isArray(ret) && "entries" in (ret as Record<string, unknown>)
        ? (() => {
            const entries = (ret as { entries: unknown }).entries;
            return Array.isArray(entries) && entries.length > 0 ? entries[entries.length - 1] : undefined;
          })()
        : ret;
    if (unwrapped === undefined || unwrapped === null) return { kind: "ok", rendered: "-" };
    if (typeof unwrapped === "number") {
      if (!Number.isFinite(unwrapped)) return { kind: "ok", rendered: String(unwrapped) };
      return { kind: "ok", rendered: Number(unwrapped.toFixed(4)).toString() };
    }
    return { kind: "ok", rendered: String(unwrapped) };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
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
  buildImports(localMath, gradebookController, studentId);

  const parsed = localMath.parse(trimmed);
  // For every context-aware function call, prepend the `context` symbol to
  // the argument list.
  //
  // mathjs's `Node.transform(cb)` stops recursing once the callback returns a
  // DIFFERENT node (see node_modules/mathjs/lib/esm/expression/node/Node.js),
  // so if we naively `return new FunctionNode(...)` for the outer `sum(...)`
  // the inner `gradebook_columns(...)` never gets its context prepended and
  // fails at runtime with a bogus "invalid pattern" error. We recurse
  // manually so both levels get rewritten, and we build fresh `FunctionNode`s
  // rather than mutating `.args` in place to avoid corrupting any AST that
  // mathjs may have cached.
  const SymbolNodeCtor = (localMath as unknown as { SymbolNode: new (name: string) => MathNode }).SymbolNode;
  const FunctionNodeCtor = (localMath as unknown as { FunctionNode: new (fn: unknown, args: MathNode[]) => MathNode })
    .FunctionNode;
  const injectContextArg = (node: MathNode): MathNode => {
    // Recurse into children first so inner calls also get transformed.
    const mapped = (node as unknown as { map: (cb: (child: MathNode) => MathNode) => MathNode }).map(injectContextArg);
    if (mapped.type === "FunctionNode") {
      const fn = mapped as FunctionNode;
      if (CONTEXT_FUNCTIONS.includes(fn.fn.name)) {
        const contextSymbol = new SymbolNodeCtor("context");
        return new FunctionNodeCtor(fn.fn, [contextSymbol, ...fn.args]);
      }
    }
    return mapped;
  };
  const transformed = injectContextArg(parsed);

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
  /** Raw per-block values from the top-level `ResultSet.entries`, if the
   *  expression parsed as a `BlockNode`. Used to annotate each line of the
   *  editor with the value of the statement that ends there. */
  let blockEntries: unknown[] = [];
  try {
    const topLevel = transformed.evaluate({ context });
    if (
      topLevel &&
      typeof topLevel === "object" &&
      !Array.isArray(topLevel) &&
      "entries" in (topLevel as Record<string, unknown>)
    ) {
      const entries = (topLevel as { entries: unknown }).entries;
      if (Array.isArray(entries)) {
        blockEntries = entries;
        rawResult = entries.length > 0 ? entries[entries.length - 1] : undefined;
      } else {
        rawResult = unwrapResultSet(topLevel);
      }
    } else {
      rawResult = unwrapResultSet(topLevel);
      blockEntries = [rawResult];
    }
    resultStr = formatValueForOverlay(rawResult);
  } catch (e) {
    evalError = e instanceof Error ? e.message : String(e);
  }

  const intermediates: IntermediateValue[] = [];
  if (params.captureIntermediates !== false) {
    // Hoisted so it's compiled once per evaluateForStudent call instead of
    // once per captured node. The CONTEXT_FUNCTIONS list is a hard-coded
    // constant, so the regex is fully static — no ReDoS surface.
    const contextArgStrip = new RegExp(
      `\\b(${CONTEXT_FUNCTIONS.map((fn) => fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\(context,\\s*`,
      "g"
    );
    // `start`/`end` on each intermediate need to be positions in the USER'S
    // raw input (`trimmed`) so the UI can overlay annotations on the exact
    // substring the user typed. MathJS's `node.toString()` normalises
    // formatting (single → double quotes, canonical operator spacing, etc.),
    // so the `pretty` we derive from `node.toString()` may not be a literal
    // substring of `trimmed`. We try a few variants to locate it, and fall
    // back to `-1` when no mapping exists — that's the documented contract
    // and the UI falls back cleanly (the per-line annotation path doesn't
    // depend on positions at all).
    //
    // Walk source positions greedily so repeated subexpressions (e.g.
    // `gradebook_columns("hw-1") + gradebook_columns("hw-1")`) get DISTINCT
    // spans: `indexOf(pretty)` alone would always return the first
    // occurrence, collapsing both instances into one dedup entry.
    const nextSearchFromBySource = new Map<string, number>();
    /**
     * Locate `pretty` inside the user's raw input (`trimmed`) starting at
     * `searchFrom`. Returns `{ start, end }` indices into `trimmed`, or
     * `{ start: -1, end: -1 }` when no mapping exists. Tries three
     * progressively more forgiving matches so mathjs's formatting
     * normalisation (e.g. `'hw-1'` → `"hw-1"`, `score*2` → `score * 2`)
     * doesn't drop otherwise-valid spans.
     */
    const findRawSpan = (pretty: string, searchFrom: number): { start: number; end: number } => {
      // 1. Literal match against the user's typed text.
      let idx = trimmed.indexOf(pretty, searchFrom);
      if (idx >= 0) return { start: idx, end: idx + pretty.length };
      // 2. Swap mathjs-canonical double quotes for single quotes — common
      //    when the user typed `'hw-1'` but mathjs stringified as `"hw-1"`.
      if (pretty.includes('"')) {
        const singleQuoted = pretty.replace(/"/g, "'");
        idx = trimmed.indexOf(singleQuoted, searchFrom);
        if (idx >= 0) return { start: idx, end: idx + singleQuoted.length };
      }
      // 3. Strip all whitespace and compare, character-by-character,
      //    tolerating different whitespace in `trimmed`. This catches
      //    `score*2` ↔ `score * 2`-style operator-spacing normalisation
      //    without needing a second parser. Returns the exact raw span
      //    (including any whitespace inside the matching run).
      const squished = pretty.replace(/\s+/g, "");
      if (squished !== pretty && squished.length > 0) {
        for (let start = searchFrom; start + squished.length <= trimmed.length; start++) {
          let i = start;
          let j = 0;
          while (i < trimmed.length && j < squished.length) {
            if (/\s/.test(trimmed[i])) {
              i++;
              continue;
            }
            if (trimmed[i] !== squished[j]) break;
            i++;
            j++;
          }
          if (j === squished.length) return { start, end: i };
        }
      }
      return { start: -1, end: -1 };
    };
    for (const node of collectNodes(transformed)) {
      if (!shouldCaptureNode(node)) continue;
      let source: string;
      try {
        source = node.toString();
      } catch {
        source = node.type;
      }
      // Strip every `context, ` the transform injected for context-aware
      // functions so the displayed source matches what the user typed. This
      // must be global (not anchored) because nested calls like
      // `sum(gradebook_columns("hw-*"))` stringify to
      // `sum(context, gradebook_columns(context, "hw-*"))` and we need to
      // clean both levels.
      const pretty = source.replace(contextArgStrip, "$1(");

      const searchFrom = nextSearchFromBySource.get(pretty) ?? 0;
      const span = findRawSpan(pretty, searchFrom);
      if (span.start >= 0) {
        nextSearchFromBySource.set(pretty, span.end);
      }
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
        start: span.start,
        end: span.end,
        display: nodeError ? `error: ${nodeError}` : formatValueForOverlay(value),
        raw: value,
        error: nodeError
      });
    }
    // Deduplicate identical (source,start) entries that the tree walk can emit
    // (e.g. BlockNode + its single child both match the whole expression).
    // Repeated subexpressions with DIFFERENT start offsets (thanks to the
    // greedy search above) stay distinct.
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

  // Walk the raw expression text and decide, for each input line, whether it
  // ends a statement — if so we pair it with the corresponding entry from
  // `blockEntries` so the UI can render an inline `= value` annotation.
  const lineMap = mapLinesToBlocks(expression);
  const lineResults: LineResult[] = lineMap.map((entry, lineIndex) => {
    if (entry.kind === "blank") return { kind: "blank", lineIndex } as const;
    if (entry.kind === "mid") {
      return { kind: "continuation", lineIndex, blockIndex: entry.blockIndex } as const;
    }
    // kind === "end"
    if (evalError) {
      // If evaluation threw, only the statement that threw should report the
      // error. We don't know which one, but annotating the last-evaluated
      // line with the error is a reasonable approximation.
      const isLastBlock = entry.blockIndex === lineMap.filter((l) => l.kind === "end").length - 1;
      if (isLastBlock) {
        return { kind: "error", lineIndex, blockIndex: entry.blockIndex, display: evalError } as const;
      }
      return { kind: "continuation", lineIndex, blockIndex: entry.blockIndex } as const;
    }
    const rawValue = entry.blockIndex < blockEntries.length ? blockEntries[entry.blockIndex] : undefined;
    return {
      kind: "value",
      lineIndex,
      blockIndex: entry.blockIndex,
      display: formatValueForOverlay(rawValue),
      raw: rawValue
    } as const;
  });

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
      }),
      lineResults
    }
  };
}
