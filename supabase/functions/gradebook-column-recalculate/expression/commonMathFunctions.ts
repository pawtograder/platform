import { isArray, isDenseMatrix, Matrix } from "mathjs";

export const COMMON_CONTEXT_FUNCTIONS = ["mean", "countif", "sum", "drop_lowest"] as const;

export type GradebookExpressionValue = {
  score: number | null;
  score_override: number | null;
  is_missing?: boolean | null;
  is_droppable: boolean;
  is_excused: boolean;
  max_score: number;
  column_slug: string;
  is_private: boolean;
};

export type ExpressionContextForCommonFunctions = {
  student_id: string;
  class_id: number;
  is_private_calculation: boolean;
  scope?: {
    setTag?: (key: string, value: unknown) => void;
    addBreadcrumb?: (payload: { message: string; level: string }) => void;
  };
};

type ImportMap = Record<string, (...args: never[]) => unknown>;

/** True when `value` has the required shape for expression operands; optional fields (e.g. is_missing) may be absent. */
function isGradebookExpressionValue(value: unknown): value is GradebookExpressionValue {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    "score" in v &&
    (typeof v.score === "number" || v.score === null) &&
    "score_override" in v &&
    (typeof v.score_override === "number" || v.score_override === null) &&
    "is_droppable" in v &&
    typeof v.is_droppable === "boolean" &&
    "is_excused" in v &&
    typeof v.is_excused === "boolean" &&
    "max_score" in v &&
    typeof v.max_score === "number" &&
    "column_slug" in v &&
    typeof v.column_slug === "string" &&
    "is_private" in v &&
    typeof v.is_private === "boolean"
  );
}

function toBinaryOperand(value: number | GradebookExpressionValue): number {
  if (isGradebookExpressionValue(value)) {
    return value.score ?? 0;
  }
  return value;
}

function extractScalarValues(values: unknown[]): number[] {
  const result: number[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number") {
      result.push(v);
    } else if (isGradebookExpressionValue(v)) {
      if (v.score !== undefined && v.score !== null) {
        result.push(v.score);
      }
    } else if (isDenseMatrix(v)) {
      result.push(...extractScalarValues(v.toArray()));
    } else if (Array.isArray(v)) {
      result.push(...extractScalarValues(v));
    }
  }
  return result;
}

/** The part of an evaluation context that records which dependencies were missing. */
type MissingCarrier = { incomplete_values?: { missing?: { gradebook_columns?: string[] } } | null };

type RawArgNode = { isNode: true; compile: () => { evaluate: (scope: unknown) => unknown } };

function isRawArgNode(value: unknown): value is RawArgNode {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { isNode?: unknown }).isNode === true &&
    typeof (value as { compile?: unknown }).compile === "function"
  );
}

/** The evaluation context ("context" in the mathjs scope), when the caller provides one. */
function contextFromScope(scope: unknown): MissingCarrier | undefined {
  const get = (scope as { get?: (key: string) => unknown } | null)?.get;
  if (typeof get !== "function") return undefined;
  const context = get.call(scope, "context");
  return typeof context === "object" && context !== null ? (context as MissingCarrier) : undefined;
}

/** Drop the missing-column entries recorded after `keep`, and the empty containers that leaves. */
function forgetMissingSince(context: MissingCarrier | undefined, keep: number) {
  const incomplete = context?.incomplete_values;
  const list = incomplete?.missing?.gradebook_columns;
  if (!incomplete || !list || list.length <= keep) return;
  list.length = keep;
  if (list.length === 0) {
    delete incomplete.missing!.gradebook_columns;
    if (Object.keys(incomplete.missing!).length === 0) delete incomplete.missing;
  }
}

const compiledRawArgs = new WeakMap<RawArgNode, { evaluate: (scope: unknown) => unknown }>();

function evaluateRawArg(node: RawArgNode, scope: unknown): unknown {
  let compiled = compiledRawArgs.get(node);
  if (!compiled) {
    compiled = node.compile();
    compiledRawArgs.set(node, compiled);
  }
  return compiled.evaluate(scope);
}

/**
 * `max` / `min` are sinks for missing values: they only need one score to have a result, so as
 * long as at least one non-missing value reaches them, the dependencies that were missing among
 * their arguments are not reported as incomplete (a best-of standing with an unattempted try is
 * complete). With no value at all they return undefined and the missing entries stay.
 *
 * Under mathjs this is a `rawArgs` function: it receives its argument nodes and the scope,
 * evaluates them itself, and so can tell which missing entries its own arguments recorded,
 * whether they reach it as gradebook values, as globs, or through map/filter. Called directly
 * with values (no scope), it simply reduces them.
 */
function missingSinkFunction(reduce: (...values: number[]) => number) {
  const fn = (...params: unknown[]) => {
    const [args, , scope] = params;
    const isRawCall = params.length === 3 && Array.isArray(args) && args.every(isRawArgNode);
    if (!isRawCall) {
      const validValues = extractScalarValues(params);
      return validValues.length === 0 ? undefined : reduce(...validValues);
    }
    const context = contextFromScope(scope);
    const keep = context?.incomplete_values?.missing?.gradebook_columns?.length ?? 0;
    const values = (args as RawArgNode[]).map((node) => evaluateRawArg(node, scope));
    const validValues = extractScalarValues(values);
    if (validValues.length === 0) return undefined;
    forgetMissingSince(context, keep);
    return reduce(...validValues);
  };
  (fn as unknown as { rawArgs: boolean }).rawArgs = true;
  return fn;
}

export function addCommonExpressionFunctions(
  imports: ImportMap,
  {
    enforcePrivateCalculationMatch = false,
    includeSecurityGuards = true
  }: { enforcePrivateCalculationMatch?: boolean; includeSecurityGuards?: boolean } = {}
): void {
  imports["divide"] = ((a: number | GradebookExpressionValue, b: number | GradebookExpressionValue) => {
    if (a === undefined || b === undefined) return undefined;
    return toBinaryOperand(a) / toBinaryOperand(b);
  }) as (...args: never[]) => unknown;

  imports["subtract"] = ((a: number | GradebookExpressionValue, b: number | GradebookExpressionValue) => {
    if (a === undefined || b === undefined) return undefined;
    return toBinaryOperand(a) - toBinaryOperand(b);
  }) as (...args: never[]) => unknown;

  imports["multiply"] = ((a: number | GradebookExpressionValue, b: number | GradebookExpressionValue) => {
    if (a === undefined || b === undefined) return undefined;
    return toBinaryOperand(a) * toBinaryOperand(b);
  }) as (...args: never[]) => unknown;

  imports["add"] = ((a: number | GradebookExpressionValue, b: number | GradebookExpressionValue) => {
    if (a === undefined || b === undefined) return undefined;
    return toBinaryOperand(a) + toBinaryOperand(b);
  }) as (...args: never[]) => unknown;

  imports["sum"] = ((context: ExpressionContextForCommonFunctions, value: (GradebookExpressionValue | number)[]) => {
    context.scope?.setTag?.("student_id", context.student_id);
    context.scope?.setTag?.("class_id", context.class_id);
    context.scope?.setTag?.("is_private", context.is_private_calculation);
    context.scope?.addBreadcrumb?.({
      message: `Sum called with value: ${JSON.stringify(value, null, 2)}`,
      level: "debug"
    });

    const values = isDenseMatrix(value) ? value.toArray() : value;
    if (Array.isArray(values)) {
      const numbers = values
        .map((v) => {
          if (isGradebookExpressionValue(v)) return v.score ?? 0;
          if (typeof v === "number") return v;
          if (v === undefined || v === null) return undefined;
          throw new Error(
            `Unsupported value type for sum. Sum can only be applied to gradebook columns or numbers. Got: ${JSON.stringify(v, null, 2)}`
          );
        })
        .filter((v) => v !== undefined);

      if (numbers.length === 0) return undefined;
      return numbers.reduce((a, b) => a + b, 0);
    }

    throw new Error(`Sum called with non-array value: ${JSON.stringify(value, null, 2)}`);
  }) as (...args: never[]) => unknown;

  imports["equal"] = ((value: number | GradebookExpressionValue, threshold: number) => {
    if (isGradebookExpressionValue(value)) {
      return (value.score ?? 0) === threshold ? 1 : 0;
    }
    return value === threshold ? 1 : 0;
  }) as (...args: never[]) => unknown;

  imports["unequal"] = ((value: number | GradebookExpressionValue, threshold: number) => {
    if (isGradebookExpressionValue(value)) {
      return (value.score ?? 0) !== threshold ? 1 : 0;
    }
    return value !== threshold ? 1 : 0;
  }) as (...args: never[]) => unknown;

  imports["largerEq"] = ((value: number | GradebookExpressionValue, threshold: number) => {
    if (isGradebookExpressionValue(value)) {
      return (value.score ?? 0) >= threshold ? 1 : 0;
    }
    return value >= threshold ? 1 : 0;
  }) as (...args: never[]) => unknown;

  imports["smallerEq"] = ((value: number | GradebookExpressionValue, threshold: number) => {
    if (isGradebookExpressionValue(value)) {
      return (value.score ?? 0) <= threshold ? 1 : 0;
    }
    return value <= threshold ? 1 : 0;
  }) as (...args: never[]) => unknown;

  imports["min"] = missingSinkFunction(Math.min) as (...args: never[]) => unknown;
  imports["max"] = missingSinkFunction(Math.max) as (...args: never[]) => unknown;

  imports["larger"] = ((value: number | GradebookExpressionValue, threshold: number) => {
    if (isGradebookExpressionValue(value)) {
      return (value.score ?? 0) > threshold ? 1 : 0;
    }
    return value > threshold ? 1 : 0;
  }) as (...args: never[]) => unknown;

  imports["smaller"] = ((value: number | GradebookExpressionValue, threshold: number) => {
    if (isGradebookExpressionValue(value)) {
      return (value.score ?? 0) < threshold ? 1 : 0;
    }
    return value < threshold ? 1 : 0;
  }) as (...args: never[]) => unknown;

  imports["countif"] = ((
    _context: ExpressionContextForCommonFunctions,
    value: GradebookExpressionValue[],
    condition: (value: GradebookExpressionValue) => boolean
  ) => {
    if (isDenseMatrix(value)) {
      value = value.toArray() as unknown as GradebookExpressionValue[];
    }
    if (Array.isArray(value)) {
      const values = value.map((v) => (condition(v) ? 1 : 0));
      if (values.length === 0) return undefined;
      return values.filter((v) => v === 1).length;
    }
    throw new Error("Countif called with non-array value");
  }) as (...args: never[]) => unknown;

  imports["mean"] = ((
    context: ExpressionContextForCommonFunctions,
    value: GradebookExpressionValue[],
    weighted: boolean = true
  ) => {
    if (isDenseMatrix(value)) {
      value = value.toArray() as unknown as GradebookExpressionValue[];
    }
    if (!Array.isArray(value)) {
      throw new Error("Mean called with non-matrix value");
    }

    const valuesToAverage = value.map((v) => {
      if (isGradebookExpressionValue(v)) {
        if (enforcePrivateCalculationMatch && v.is_private !== context.is_private_calculation) {
          throw new Error(
            `Mean called with gradebook value that is_private mismatch: ${v.is_private} !== ${context.is_private_calculation}`
          );
        }
        if (v.is_missing) {
          if (v.is_excused) {
            return { score: undefined, max_score: v.max_score };
          }
          return { score: 0, max_score: v.max_score };
        }
        return { score: v.score, max_score: v.max_score };
      }
      if (isArray(v)) {
        throw new Error("Unsupported nesting of arrays");
      }
      if (v === undefined || v === null) {
        return { score: undefined, max_score: undefined };
      }
      throw new Error(
        "Unsupported value type for mean. Mean can only be applied to gradebook columns because it expects a max_score for each value."
      );
    });

    const validValues = valuesToAverage.filter(
      (v) =>
        v !== undefined &&
        v.score !== undefined &&
        v.max_score !== undefined &&
        v.max_score !== null &&
        v.max_score > 0 &&
        v.score !== null
    );
    if (validValues.length === 0) return undefined;

    if (weighted) {
      const totalPoints = validValues.reduce((a, b) => a + (b?.max_score ?? 0), 0);
      const totalScore = validValues.reduce((a, b) => a + (b?.score ?? 0), 0);
      if (totalPoints === 0) return undefined;
      return (100 * totalScore) / totalPoints;
    }

    return (100 * validValues.reduce((a, b) => a + (b && b.score ? b.score / b.max_score : 0), 0)) / validValues.length;
  }) as (...args: never[]) => unknown;

  imports["drop_lowest"] = ((
    _context: ExpressionContextForCommonFunctions,
    value: GradebookExpressionValue[],
    count: number
  ) => {
    if (isDenseMatrix(value)) {
      value = value.toArray() as unknown as GradebookExpressionValue[];
    }
    if (!Array.isArray(value)) {
      throw new Error("Drop_lowest called with non-matrix value");
    }

    const validEntries = value.filter((v) => (v.max_score ?? 0) > 0 && v.score !== null);
    const sorted = [...validEntries].sort((a, b) => {
      const aScore = a.score ?? 0;
      const bScore = b.score ?? 0;
      const aMaxScore = a.max_score ?? 1;
      const bMaxScore = b.max_score ?? 1;
      const aRatio = aMaxScore > 0 ? aScore / aMaxScore : 0;
      const bRatio = bMaxScore > 0 ? bScore / bMaxScore : 0;
      return aRatio - bRatio;
    });

    const toDrop = new Set<GradebookExpressionValue>();
    let numDropped = 0;
    for (const v of sorted) {
      if (numDropped < count && v.is_droppable) {
        toDrop.add(v);
        numDropped++;
      }
    }

    const ret: GradebookExpressionValue[] = [];
    for (const v of value) {
      if (!toDrop.has(v) && (v.max_score ?? 0) > 0 && v.score !== null) {
        ret.push(v);
      }
    }
    return ret;
  }) as (...args: never[]) => unknown;

  imports["case_when"] = ((conditions: Matrix<unknown>) => {
    const conditionValues = conditions.toArray();
    for (const condition of conditionValues) {
      const [value, result] = condition as [boolean, number];
      if (value) return result;
    }
    return undefined;
  }) as (...args: never[]) => unknown;

  if (includeSecurityGuards) {
    for (const functionName of ["import", "createUnit", "reviver", "resolve"]) {
      imports[functionName] = (() => {
        throw new Error(`${functionName} is not allowed`);
      }) as (...args: never[]) => unknown;
    }
  }
}
