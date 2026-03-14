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

function isGradebookExpressionValue(value: unknown): value is GradebookExpressionValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "score" in value &&
    "score_override" in value &&
    "is_droppable" in value &&
    "is_excused" in value &&
    "is_missing" in value &&
    "max_score" in value &&
    "column_slug" in value
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

  imports["min"] = ((...values: unknown[]) => {
    const validValues = extractScalarValues(values);
    if (validValues.length === 0) return undefined;
    return Math.min(...validValues);
  }) as (...args: never[]) => unknown;

  imports["max"] = ((...values: unknown[]) => {
    const validValues = extractScalarValues(values);
    if (validValues.length === 0) return undefined;
    return Math.max(...validValues);
  }) as (...args: never[]) => unknown;

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
