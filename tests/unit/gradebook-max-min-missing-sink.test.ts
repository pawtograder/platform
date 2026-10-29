import * as mathjs from "mathjs";
import type { FunctionNode, MathNode } from "mathjs";
import {
  addCommonExpressionFunctions,
  COMMON_CONTEXT_FUNCTIONS,
  type GradebookExpressionValue
} from "@/supabase/functions/gradebook-column-recalculate/expression/commonMathFunctions";
import {
  pushMissingDependenciesToContext,
  type IncompleteValuesAdvice
} from "@/supabase/functions/gradebook-column-recalculate/expression/shared";

/**
 * max/min as sinks for missing values, evaluated the way the recalc edge function does it:
 * `gradebook_columns(context, slug)` records a missing dependency as it resolves a value, and
 * the expression runs with `{ context }` as its scope.
 */
function value(slug: string, score: number | null, extra: Partial<GradebookExpressionValue> = {}) {
  return {
    score,
    score_override: null,
    is_missing: score === null,
    is_droppable: false,
    is_excused: false,
    max_score: 4,
    column_slug: slug,
    is_private: true,
    ...extra
  };
}

function evaluate(expression: string, scores: Record<string, number | null>) {
  const math = mathjs.create(mathjs.all, {});
  const imports: Record<string, unknown> = {};
  addCommonExpressionFunctions(imports as never);
  const values = Object.fromEntries(Object.entries(scores).map(([slug, score]) => [slug, value(slug, score)]));
  imports["gradebook_columns"] = (
    context: { incomplete_values: IncompleteValuesAdvice | null },
    key: string | string[] | mathjs.Matrix
  ) => {
    const keys = Array.isArray(key) ? key : typeof key === "string" ? [key] : (key.toArray() as unknown as string[]);
    const resolved = keys.map((k) => values[k]);
    pushMissingDependenciesToContext(context, resolved);
    return Array.isArray(key) || typeof key !== "string" ? resolved : resolved[0];
  };
  math.import(imports as never, { override: true });

  // Same AST rewrite as GradebookProcessor: context first for context functions and lookups,
  // globs expanded to an explicit list of slugs.
  const transformed = math.parse(expression).transform((node: MathNode) => {
    if (node.type !== "FunctionNode") return node;
    const fn = node as FunctionNode;
    const name = fn.fn.name;
    if ((COMMON_CONTEXT_FUNCTIONS as readonly string[]).includes(name) || name === "gradebook_columns") {
      const args = [...fn.args];
      if (name === "gradebook_columns" && args[0]?.type === "ConstantNode") {
        const pattern = (args[0] as mathjs.ConstantNode).value as unknown as string;
        if (pattern.includes("*")) {
          const prefix = pattern.replace("*", "");
          args[0] = new math.ArrayNode(
            Object.keys(values)
              .filter((k) => k.startsWith(prefix))
              .map((k) => new math.ConstantNode(k))
          );
        }
      }
      fn.args = [new math.SymbolNode("context"), ...args];
    }
    return node;
  });

  const context = {
    incomplete_values: {} as IncompleteValuesAdvice,
    is_private_calculation: true,
    student_id: "s",
    class_id: 1,
    incomplete_values_policy: "report_only"
  };
  const result = transformed.compile().evaluate({ context });
  return { result, missing: context.incomplete_values.missing?.gradebook_columns ?? [] };
}

describe("max and min are sinks for missing values", () => {
  it("max of attempts with one missing reports nothing missing", () => {
    const { result, missing } = evaluate('max(gradebook_columns("cce_1"), gradebook_columns("cce_2"))', {
      cce_1: 3,
      cce_2: null
    });
    expect(result).toBe(3);
    expect(missing).toEqual([]);
  });

  it("works through a slug glob", () => {
    const { result, missing } = evaluate('max(gradebook_columns("cce*"))', { cce_1: null, cce_2: 2, cce_3: null });
    expect(result).toBe(2);
    expect(missing).toEqual([]);
  });

  it("works through map, as in a generated best-of standing", () => {
    const { result, missing } = evaluate(
      'max(map([gradebook_columns("a"), gradebook_columns("b")], f(x) = x.is_excused ? null : x.score))',
      { a: null, b: 4 }
    );
    expect(result).toBe(4);
    expect(missing).toEqual([]);
  });

  it("min behaves the same way", () => {
    const { result, missing } = evaluate('min(gradebook_columns("a"), gradebook_columns("b"))', { a: 3, b: null });
    expect(result).toBe(3);
    expect(missing).toEqual([]);
  });

  it("keeps the missing entries when nothing reaches max", () => {
    const { result, missing } = evaluate('max(gradebook_columns("a"), gradebook_columns("b"))', { a: null, b: null });
    expect(result).toBeUndefined();
    expect(missing).toEqual(["a", "b"]);
  });

  it("still reports a missing value used outside max", () => {
    const { result, missing } = evaluate(
      'max(gradebook_columns("a"), gradebook_columns("b")) + gradebook_columns("c")',
      {
        a: 2,
        b: null,
        c: null
      }
    );
    expect(result).toBe(2);
    expect(missing).toEqual(["c"]);
  });

  it("still reports missing values through mean, which is not a sink", () => {
    const { missing } = evaluate('mean(gradebook_columns("a*"))', { a1: 4, a2: null });
    expect(missing).toEqual(["a2"]);
  });

  it("keeps the plain-values call working", () => {
    const imports: Record<string, (...args: unknown[]) => unknown> = {};
    addCommonExpressionFunctions(imports as never);
    expect(imports["max"](value("a", 80), value("b", 95), value("c", 60))).toBe(95);
    expect(imports["min"](value("a", 80), value("b", null))).toBe(80);
    expect(imports["max"](value("a", null))).toBeUndefined();
  });
});
