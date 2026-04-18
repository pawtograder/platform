/**
 * Unit tests for `evaluateForStudent` — the core of the Expression Builder.
 *
 * These tests assert that a broad cross-section of real production score
 * expressions (taken verbatim from `tests/e2e/gradebook-calculations.test.tsx`)
 * evaluate to the expected final value AND produce the expected intermediate
 * values, so that:
 *   1. The values shown in the UI overlay are correct.
 *   2. The `context` argument injection (AST transform recursion) works at
 *      every nesting level.
 *   3. The `.score` accessor, glob slug matching, `gradebook_columns()`
 *      single-vs-array return shape, lambdas, and `assume_max` / `report_only`
 *      policies all behave like the server-side recalculator.
 *
 * We stand up an in-memory fake `GradebookController` just rich enough to
 * satisfy the expression machinery — `columns`, `getGradebookColumnStudent`,
 * `assignments`, `class_id`, and `extractAndValidateDependencies` — so the
 * tests don't need a live Supabase / Next.js environment.
 */
import * as mathjs from "mathjs";
import { minimatch } from "minimatch";

import { evaluateForStudent, formatValueForOverlay, type IntermediateValue } from "@/lib/gradebookExpressionTester";
import type { GradebookColumnStudent } from "@/utils/supabase/DatabaseTypes";

type ColumnSpec = {
  id: number;
  slug: string;
  name: string;
  max_score: number;
  score_expression?: string | null;
  dependencies?: { gradebook_columns?: number[]; assignments?: number[] } | null;
};

type StudentEntry = {
  score?: number | null;
  score_override?: number | null;
  is_missing?: boolean;
  is_excused?: boolean;
  is_droppable?: boolean;
  is_private?: boolean;
  released?: boolean;
};

type AssignmentSpec = {
  id: number;
  slug: string;
  total_points: number | null;
};

/**
 * Shape-compatible stand-in for `GradebookController` — we intentionally
 * strip it down to the surface that `evaluateForStudent` touches. The real
 * controller is cast through `as unknown as GradebookController` at the call
 * site.
 */
function createFakeController(params: {
  class_id?: number;
  columns: ColumnSpec[];
  assignments?: AssignmentSpec[];
  /** Per-student, per-slug entries. Missing entries are treated as missing. */
  entries: Record<string, Record<string, StudentEntry>>;
}) {
  const { class_id = 1, columns, assignments = [], entries } = params;
  const columnById = new Map(columns.map((c) => [c.id, c]));
  const columnBySlug = new Map(columns.map((c) => [c.slug, c]));

  return {
    class_id,
    get columns() {
      return columns;
    },
    get assignments() {
      return assignments;
    },
    /** Mirrors GradebookController.getGradebookColumnStudent's `GradebookColumnStudent | undefined` return. */
    getGradebookColumnStudent(column_id: number, student_id: string): GradebookColumnStudent | undefined {
      const col = columnById.get(column_id);
      if (!col) return undefined;
      const e = entries[student_id]?.[col.slug];
      if (!e) return undefined;
      return {
        id: column_id,
        class_id,
        created_at: "",
        updated_at: "",
        gradebook_column_id: column_id,
        gradebook_id: 1,
        is_droppable: e.is_droppable ?? true,
        is_excused: e.is_excused ?? false,
        is_missing: e.is_missing ?? false,
        is_private: e.is_private ?? true,
        is_recalculating: false,
        released: e.released ?? true,
        score: e.score ?? null,
        score_override: e.score_override ?? null,
        score_override_note: null,
        student_id,
        incomplete_values: null
      } as unknown as GradebookColumnStudent;
    },
    /**
     * Minimal port of the real `extractAndValidateDependencies`: parse the
     * expression, walk any `gradebook_columns(...)` / `assignments(...)`
     * calls with string-literal args, and error out if the slug doesn't
     * match anything in the fixture. Keeps the test self-contained (no need
     * to import the full GradebookController).
     */
    extractAndValidateDependencies(expr: string, column_id: number) {
      const errors: string[] = [];
      const deps: { gradebook_columns: Set<number>; assignments: Set<number> } = {
        gradebook_columns: new Set(),
        assignments: new Set()
      };
      const node = mathjs.parse(expr);
      node.traverse((n) => {
        if (n.type !== "FunctionNode") return;
        const fn = n as mathjs.FunctionNode;
        if (fn.fn.name !== "gradebook_columns" && fn.fn.name !== "assignments") return;
        const arg = fn.args[0];
        if (!arg || arg.type !== "ConstantNode") return;
        const val = (arg as mathjs.ConstantNode).value;
        if (typeof val !== "string") return;
        if (fn.fn.name === "gradebook_columns") {
          const matches = columns.filter((c) => minimatch(c.slug, val));
          if (matches.length === 0) errors.push(`Invalid dependency: ${val} for function gradebook_columns`);
          else matches.forEach((c) => deps.gradebook_columns.add(c.id));
        } else {
          const matches = assignments.filter((a) => a.slug && minimatch(a.slug, val));
          if (matches.length === 0) errors.push(`Invalid dependency: ${val} for function assignments`);
          else matches.forEach((a) => deps.assignments.add(a.id));
        }
      });
      if (column_id !== -1 && deps.gradebook_columns.has(column_id)) {
        errors.push("Cycle detected in score expression");
      }
      if (errors.length > 0) throw new Error(errors.join("\n"));
      const out: { gradebook_columns?: number[]; assignments?: number[] } = {};
      if (deps.gradebook_columns.size > 0) out.gradebook_columns = [...deps.gradebook_columns];
      if (deps.assignments.size > 0) out.assignments = [...deps.assignments];
      return Object.keys(out).length > 0 ? out : null;
    },
    // Unused by `evaluateForStudent`, but keep the ref available for future tests.
    _columnBySlug: columnBySlug
  };
}

type FakeController = ReturnType<typeof createFakeController>;

/** Run an expression against the fake controller and return the evaluation. */
function runExpression(controller: FakeController, expression: string, studentId: string) {
  const result = evaluateForStudent({
    math: mathjs,
    // The tester only touches the subset of GradebookController we faked.
    gradebookController: controller as unknown as Parameters<typeof evaluateForStudent>[0]["gradebookController"],
    expression,
    studentId,
    editingColumnId: null,
    captureIntermediates: true
  });
  return result;
}

/**
 * Locate the first intermediate whose post-`context`-strip source equals
 * `source`. Returns the display / numeric score for readable assertions.
 */
function findIntermediate(intermediates: IntermediateValue[], source: string): IntermediateValue | undefined {
  return intermediates.find((iv) => iv.source === source);
}

describe("Expression Builder — evaluateForStudent", () => {
  describe("fixture 1 (weighted average + cascading final grade)", () => {
    // Mirrors gradebook-calculations.test.tsx fixture 1.
    //   HW columns: leaf-hw1=80, leaf-hw2=70, leaf-hw3=90 (all max 100)
    //   Participation: leaf-part=85
    //   calc-hw-avg = mean(gradebook_columns('leaf-hw*'))  → 80.0
    //   calc-final  = gradebook_columns('calc-hw-avg') * 0.7 + gradebook_columns('leaf-part') * 0.3
    //                ≈ 80 * 0.7 + 85 * 0.3 = 81.5
    const controller = createFakeController({
      columns: [
        { id: 1, slug: "leaf-hw1", name: "HW 1", max_score: 100 },
        { id: 2, slug: "leaf-hw2", name: "HW 2", max_score: 100 },
        { id: 3, slug: "leaf-hw3", name: "HW 3", max_score: 100 },
        { id: 4, slug: "leaf-part", name: "Participation", max_score: 100 },
        {
          id: 5,
          slug: "calc-hw-avg",
          name: "HW Avg",
          max_score: 100,
          score_expression: "mean(gradebook_columns('leaf-hw*'))",
          dependencies: { gradebook_columns: [1, 2, 3] }
        }
      ],
      entries: {
        alice: {
          "leaf-hw1": { score: 80 },
          "leaf-hw2": { score: 70 },
          "leaf-hw3": { score: 90 },
          "leaf-part": { score: 85 },
          // calc-hw-avg is stored on the row, but the builder reads it via
          // the expression, not the stored score, so we can leave it 0 here
          // without affecting the test — or set it to the expected 80.
          "calc-hw-avg": { score: 80 }
        }
      }
    });

    test("mean over glob slug evaluates to weighted average and yields a numeric overlay", () => {
      const r = runExpression(controller, "mean(gradebook_columns('leaf-hw*'))", "alice");
      expect(r.isValid).toBe(true);
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBeCloseTo(80, 5);
      expect(r.evaluation?.result).toBe("80");

      // NB: mathjs `node.toString()` canonicalises string literals to
      // double quotes, so intermediate sources use `"..."` even though the
      // user may have typed `'...'`. Every expectation below reflects the
      // canonical double-quoted form.
      const inner = findIntermediate(r.evaluation!.intermediates, `gradebook_columns("leaf-hw*")`);
      expect(inner).toBeDefined();
      expect(inner?.error).toBeUndefined();
      // The inner call resolves to an array of 3 GradebookExpressionValue objects.
      expect(Array.isArray(inner?.raw)).toBe(true);
      expect((inner?.raw as unknown[]).length).toBe(3);
      // The overlay pretty-prints GradebookExpressionValues as `slug=score/max`.
      expect(inner?.display).toMatch(/leaf-hw1=80\/100/);
      expect(inner?.display).toMatch(/leaf-hw2=70\/100/);
      expect(inner?.display).toMatch(/leaf-hw3=90\/100/);
    });

    test("weighted average final grade composes single-column lookups, multiplies, and adds", () => {
      const expr = "gradebook_columns('calc-hw-avg') * 0.7 + gradebook_columns('leaf-part') * 0.3";
      const r = runExpression(controller, expr, "alice");
      expect(r.isValid).toBe(true);
      expect(r.evaluation?.error).toBeNull();
      // 80 * 0.7 + 85 * 0.3 = 81.5
      expect(Number(r.evaluation?.rawResult)).toBeCloseTo(81.5, 5);

      const im = r.evaluation!.intermediates;
      // Both single-slug lookups should appear in intermediates and resolve.
      const hwAvg = findIntermediate(im, `gradebook_columns("calc-hw-avg")`);
      const part = findIntermediate(im, `gradebook_columns("leaf-part")`);
      expect(hwAvg?.display).toMatch(/calc-hw-avg=80\/100/);
      expect(part?.display).toMatch(/leaf-part=85\/100/);

      // The two multiplications should also be captured with numeric results.
      const left = findIntermediate(im, `gradebook_columns("calc-hw-avg") * 0.7`);
      const right = findIntermediate(im, `gradebook_columns("leaf-part") * 0.3`);
      expect(Number(left?.raw)).toBeCloseTo(56, 5);
      expect(Number(right?.raw)).toBeCloseTo(25.5, 5);
    });
  });

  describe("fixture 2 (max of a glob and .score accessor)", () => {
    // Mirrors fixture 2:
    //   classes-a=3, classes-b=4  → max=4
    //   lists-a=2,   lists-b=4    → max=4
    //   topic = (topic-classes.score + topic-lists.score) / 2 → (4+4)/2 = 4
    const controller = createFakeController({
      columns: [
        { id: 1, slug: "classes-a", name: "Classes A", max_score: 4 },
        { id: 2, slug: "classes-b", name: "Classes B", max_score: 4 },
        { id: 3, slug: "lists-a", name: "Lists A", max_score: 4 },
        { id: 4, slug: "lists-b", name: "Lists B", max_score: 4 },
        {
          id: 5,
          slug: "topic-classes",
          name: "Topic Classes",
          max_score: 4,
          score_expression: "max(gradebook_columns('classes*'))",
          dependencies: { gradebook_columns: [1, 2] }
        },
        {
          id: 6,
          slug: "topic-lists",
          name: "Topic Lists",
          max_score: 4,
          score_expression: "max(gradebook_columns('lists*'))",
          dependencies: { gradebook_columns: [3, 4] }
        }
      ],
      entries: {
        alice: {
          "classes-a": { score: 3 },
          "classes-b": { score: 4 },
          "lists-a": { score: 2 },
          "lists-b": { score: 4 },
          "topic-classes": { score: 4 },
          "topic-lists": { score: 4 }
        }
      }
    });

    test("max() over glob returns the highest .score of the matched columns", () => {
      const r = runExpression(controller, "max(gradebook_columns('classes*'))", "alice");
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBe(4);
      const inner = findIntermediate(r.evaluation!.intermediates, `gradebook_columns("classes*")`);
      expect(inner?.display).toMatch(/classes-a=3\/4/);
      expect(inner?.display).toMatch(/classes-b=4\/4/);
    });

    test("`.score` accessor on single-slug call supports manual arithmetic", () => {
      const expr = "(gradebook_columns('topic-classes').score + gradebook_columns('topic-lists').score) / 2";
      const r = runExpression(controller, expr, "alice");
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBeCloseTo(4, 5);

      const im = r.evaluation!.intermediates;
      const leftAccess = findIntermediate(im, `gradebook_columns("topic-classes").score`);
      const rightAccess = findIntermediate(im, `gradebook_columns("topic-lists").score`);
      expect(Number(leftAccess?.raw)).toBe(4);
      expect(Number(rightAccess?.raw)).toBe(4);
    });
  });

  describe("fixture 3 (countif with lambda)", () => {
    // Lab 1/2/4 = 1 (completed), Lab 3 = 0 (not).  countif(lab*, x.score > 0) → 3
    // Skill A=2 (meets), B=1 (approaches), C=0 (does not meet)
    //   countif(skill*, x.score == 2) → 1
    //   countif(skill*, x.score == 1) → 1
    const controller = createFakeController({
      columns: [
        { id: 1, slug: "lab-1", name: "Lab 1", max_score: 1 },
        { id: 2, slug: "lab-2", name: "Lab 2", max_score: 1 },
        { id: 3, slug: "lab-3", name: "Lab 3", max_score: 1 },
        { id: 4, slug: "lab-4", name: "Lab 4", max_score: 1 },
        { id: 5, slug: "skill-a", name: "Skill A", max_score: 2 },
        { id: 6, slug: "skill-b", name: "Skill B", max_score: 2 },
        { id: 7, slug: "skill-c", name: "Skill C", max_score: 2 }
      ],
      entries: {
        alice: {
          "lab-1": { score: 1 },
          "lab-2": { score: 1 },
          "lab-3": { score: 0 },
          "lab-4": { score: 1 },
          "skill-a": { score: 2 },
          "skill-b": { score: 1 },
          "skill-c": { score: 0 }
        }
      }
    });

    test("countif over lab glob with a truthy predicate counts completed labs", () => {
      const r = runExpression(controller, "countif(gradebook_columns('lab*'), f(x) = x.score > 0)", "alice");
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBe(3);
      expect(r.evaluation?.result).toBe("3");
    });

    test("countif over skill glob with an equality predicate counts 'meets' skills", () => {
      const r = runExpression(controller, "countif(gradebook_columns('skill*'), f(x) = x.score == 2)", "alice");
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBe(1);
    });

    test("countif with a different predicate counts 'approaching' skills on the same data", () => {
      const r = runExpression(controller, "countif(gradebook_columns('skill*'), f(x) = x.score == 1)", "alice");
      expect(Number(r.evaluation?.rawResult)).toBe(1);
    });

    test("subexpressions inside a lambda body are never captured as intermediates", () => {
      // The lambda `f(x) = not x.is_missing and x.score > 0` binds `x` inside
      // its body. Evaluating `x.score > 0` at the outer scope throws
      // "Undefined symbol x", so the preview must NOT descend into the
      // lambda. It should still show the top-level call itself and the
      // sibling `gradebook_columns(...)` arg alongside it.
      const r = runExpression(
        controller,
        "countif(gradebook_columns('lab*'), f(x) = not x.is_missing and x.score > 0)",
        "alice"
      );
      expect(r.evaluation?.error).toBeNull();
      const im = r.evaluation!.intermediates;

      // The lambda itself is skipped.
      expect(im.find((iv) => iv.nodeType === "FunctionAssignmentNode")).toBeUndefined();

      // Inner x.is_missing / x.score / x.score > 0 / not x.is_missing / the
      // combining `and` are all inside the lambda body — none should leak in
      // as standalone intermediates.  Check that no intermediate's source
      // EQUALS one of those lambda-body subexpressions (the top-level
      // countif source naturally contains the lambda as a substring — that's
      // fine; what we're guarding against is the individual inner nodes
      // showing up as their own entries).
      const lambdaBodies = new Set([
        "x.is_missing",
        "x.score",
        "x.score > 0",
        "not x.is_missing",
        "not x.is_missing and x.score > 0"
      ]);
      for (const iv of im) {
        expect(lambdaBodies.has(iv.source)).toBe(false);
      }
      // And none of them should be reporting an "Undefined symbol x" error.
      for (const iv of im) {
        expect(iv.display).not.toMatch(/Undefined symbol/i);
      }

      // The top-level `countif(...)` and its `gradebook_columns('lab*')` arg
      // ARE captured (they evaluate cleanly in the outer scope).
      const countifCall = im.find((iv) => iv.source.startsWith("countif("));
      expect(countifCall).toBeDefined();
      expect(Number(countifCall?.raw)).toBe(3);

      const gbcArg = findIntermediate(im, `gradebook_columns("lab*")`);
      expect(gbcArg).toBeDefined();
      expect(Array.isArray(gbcArg?.raw)).toBe(true);
    });
  });

  describe("fixture 4 (additive via .score with score_override)", () => {
    // hw-total (override = 92) + curve-adj (score = 3) → 95
    // Score overrides on a dependency must take precedence over `.score`.
    const controller = createFakeController({
      columns: [
        { id: 1, slug: "hw-total", name: "HW Total", max_score: 100 },
        { id: 2, slug: "curve-adj", name: "Curve", max_score: 20 }
      ],
      entries: {
        alice: {
          "hw-total": { score: 88, score_override: 92 },
          "curve-adj": { score: 3 }
        }
      }
    });

    test("score_override on a dependency wins over the persisted score", () => {
      const r = runExpression(
        controller,
        "gradebook_columns('hw-total').score + gradebook_columns('curve-adj').score",
        "alice"
      );
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBe(95);

      const hw = findIntermediate(r.evaluation!.intermediates, `gradebook_columns("hw-total")`);
      // The GradebookExpressionValue raw carries the overridden score.
      expect((hw?.raw as { score: number }).score).toBe(92);
    });
  });

  describe("fixture 5 (chained calculated → calculated)", () => {
    //   quiz-1=80, quiz-2=70, quiz-3=90 → avg=80
    //   calc-quiz-avg=80
    //   calc-quiz-bonus = calc-quiz-avg * 0.9 + 10 = 82
    const controller = createFakeController({
      columns: [
        { id: 1, slug: "quiz-1", name: "Q1", max_score: 100 },
        { id: 2, slug: "quiz-2", name: "Q2", max_score: 100 },
        { id: 3, slug: "quiz-3", name: "Q3", max_score: 100 },
        {
          id: 4,
          slug: "calc-quiz-avg",
          name: "Quiz Avg",
          max_score: 100,
          score_expression: "mean(gradebook_columns('quiz*'))",
          dependencies: { gradebook_columns: [1, 2, 3] }
        }
      ],
      entries: {
        alice: {
          "quiz-1": { score: 80 },
          "quiz-2": { score: 70 },
          "quiz-3": { score: 90 },
          "calc-quiz-avg": { score: 80 }
        }
      }
    });

    test("chained calculated-column lookup plus constant evaluates correctly", () => {
      const r = runExpression(controller, "gradebook_columns('calc-quiz-avg') * 0.9 + 10", "alice");
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBeCloseTo(82, 5);

      const im = r.evaluation!.intermediates;
      const times = findIntermediate(im, `gradebook_columns("calc-quiz-avg") * 0.9`);
      expect(Number(times?.raw)).toBeCloseTo(72, 5);
    });
  });

  describe("context injection recurses through nested calls", () => {
    const controller = createFakeController({
      columns: [
        { id: 1, slug: "hw-1", name: "HW1", max_score: 100 },
        { id: 2, slug: "hw-2", name: "HW2", max_score: 100 },
        { id: 3, slug: "hw-3", name: "HW3", max_score: 100 }
      ],
      entries: {
        alice: {
          "hw-1": { score: 90 },
          "hw-2": { score: 70 },
          "hw-3": { score: 80 }
        }
      }
    });

    test("nested mean(gradebook_columns(...)) resolves without `invalid pattern`", () => {
      // Regression guard: if the transform stopped recursing after returning
      // a new outer node, the inner `gradebook_columns` would be called
      // without the `context` arg and minimatch would throw "invalid pattern".
      const r = runExpression(controller, "mean(gradebook_columns('hw-*'))", "alice");
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBeCloseTo(80, 5);
      for (const iv of r.evaluation!.intermediates) {
        expect(iv.display).not.toMatch(/invalid pattern/);
      }
    });

    test("overlay source strips the injected `context` arg at every nesting level", () => {
      const r = runExpression(controller, "sum(gradebook_columns('hw-*'))", "alice");
      expect(r.evaluation?.error).toBeNull();
      for (const iv of r.evaluation!.intermediates) {
        // Overlay must show what the user typed — the synthesized `context`
        // symbol must be stripped from every level of the stringified AST.
        expect(iv.source).not.toMatch(/\bcontext\b/);
      }
    });
  });

  describe("parse and dependency errors", () => {
    const controller = createFakeController({
      columns: [{ id: 1, slug: "hw-1", name: "HW1", max_score: 100 }],
      entries: { alice: { "hw-1": { score: 90 } } }
    });

    test("a syntax error surfaces as a parseError (no evaluation attempted)", () => {
      const r = runExpression(controller, "((1 +", "alice");
      expect(r.isValid).toBe(false);
      expect(r.parseError).toBeTruthy();
      expect(r.dependencyError).toBeNull();
      expect(r.evaluation).toBeNull();
    });

    test("an unknown slug surfaces as a dependencyError", () => {
      const r = runExpression(controller, "mean(gradebook_columns('does-not-exist'))", "alice");
      expect(r.isValid).toBe(false);
      expect(r.parseError).toBeNull();
      expect(r.dependencyError).toMatch(/Invalid dependency/);
      expect(r.evaluation).toBeNull();
    });

    test("empty expression is treated as valid-empty", () => {
      const r = runExpression(controller, "", "alice");
      expect(r.isValid).toBe(true);
      expect(r.isEmpty).toBe(true);
      expect(r.evaluation).toBeNull();
    });
  });

  describe("incomplete values and missing data", () => {
    // hw-1 has a score, hw-2 is NOT released and has no score → should surface
    // as `not_released` in the report-only pass.
    const controller = createFakeController({
      columns: [
        { id: 1, slug: "hw-1", name: "HW1", max_score: 100 },
        { id: 2, slug: "hw-2", name: "HW2", max_score: 100 }
      ],
      entries: {
        alice: {
          "hw-1": { score: 80 },
          "hw-2": { released: false, is_private: false }
        }
      }
    });

    test("a not-released dependency shows up in incompleteValues under report_only", () => {
      const r = runExpression(controller, "mean(gradebook_columns('hw-*'))", "alice");
      expect(r.evaluation?.error).toBeNull();
      const slugs = r.evaluation?.incompleteValues?.not_released?.gradebook_columns ?? [];
      expect(slugs).toContain("hw-2");
    });
  });

  describe("drop_lowest preserves dropped semantics", () => {
    // 4 labs, one failed (score 0) — drop_lowest(labs, 1) then mean should
    // ignore the dropped entry.
    //   kept: lab-1=100, lab-2=80, lab-4=90  → weighted mean 100*(100+80+90)/(100*3) = 90
    const controller = createFakeController({
      columns: [
        { id: 1, slug: "lab-1", name: "Lab 1", max_score: 100 },
        { id: 2, slug: "lab-2", name: "Lab 2", max_score: 100 },
        { id: 3, slug: "lab-3", name: "Lab 3", max_score: 100 },
        { id: 4, slug: "lab-4", name: "Lab 4", max_score: 100 }
      ],
      entries: {
        alice: {
          "lab-1": { score: 100 },
          "lab-2": { score: 80 },
          "lab-3": { score: 0 },
          "lab-4": { score: 90 }
        }
      }
    });

    test("mean(drop_lowest(...)) drops the lowest-ratio entry", () => {
      const r = runExpression(controller, "mean(drop_lowest(gradebook_columns('lab-*'), 1))", "alice");
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBeCloseTo(90, 5);

      const dropNode = findIntermediate(r.evaluation!.intermediates, `drop_lowest(gradebook_columns("lab-*"), 1)`);
      expect(dropNode).toBeDefined();
      // After drop_lowest the array has 3 entries, not 4 — lab-3 (ratio 0) is
      // dropped.
      expect(Array.isArray(dropNode?.raw)).toBe(true);
      expect((dropNode?.raw as unknown[]).length).toBe(3);
      expect(dropNode?.display).not.toMatch(/lab-3=/);
      expect(dropNode?.display).toMatch(/lab-1=100\/100/);
    });
  });

  describe("assignments(...) lookup", () => {
    // `assignments("slug")` returns the total_points of the assignment. Used
    // for columns backed by an assignment grade.
    const controller = createFakeController({
      columns: [{ id: 1, slug: "final", name: "Final", max_score: 100 }],
      assignments: [
        { id: 1, slug: "final-exam", total_points: 95 },
        { id: 2, slug: "final-project", total_points: 87 }
      ],
      entries: {}
    });

    test("assignments('slug') returns the total_points and is visible in the overlay", () => {
      const r = runExpression(controller, "assignments('final-exam')", "alice");
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBe(95);
      const inner = findIntermediate(r.evaluation!.intermediates, `assignments("final-exam")`);
      expect(inner?.raw).toBe(95);
    });
  });

  describe("boundary / edge-case expressions", () => {
    const controller = createFakeController({
      columns: [
        { id: 1, slug: "hw-1", name: "HW1", max_score: 100 },
        { id: 2, slug: "hw-2", name: "HW2", max_score: 100 }
      ],
      entries: {
        alice: {
          "hw-1": { score: 50 },
          "hw-2": { score: 100 }
        }
      }
    });

    test("sum over an array of single-slug lookups delegates to .score", () => {
      // sum([a, b]) on GradebookExpressionValue objects. This is the
      // `scoreA + scoreB` pattern written with the shared aggregate.
      const r = runExpression(controller, "sum(gradebook_columns('hw-*'))", "alice");
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBe(150);
    });

    test("pure-arithmetic expression (no dependencies) evaluates without touching the controller", () => {
      const r = runExpression(controller, "1 + 2 * 3", "alice");
      expect(r.evaluation?.error).toBeNull();
      expect(Number(r.evaluation?.rawResult)).toBe(7);
      // The user's typed expression has no context-aware calls, so the
      // intermediates must be free of any `context` references.
      for (const iv of r.evaluation!.intermediates) {
        expect(iv.source).not.toMatch(/context/);
      }
    });

    test("repeated identical subexpressions receive distinct source spans", () => {
      // Regression: `trimmed.indexOf(pretty)` used to always find the first
      // occurrence, so both copies of `gradebook_columns('hw-1')` below would
      // land on `start=0` / `end=24` and the dedup loop would collapse them
      // into one entry — the second instance would disappear from the
      // annotated view entirely.
      const r = runExpression(controller, "gradebook_columns('hw-1') + gradebook_columns('hw-1')", "alice");
      expect(r.evaluation?.error).toBeNull();
      // Both inner calls must appear with strictly-increasing start offsets.
      const hits = r.evaluation!.intermediates.filter((iv) => iv.source === `gradebook_columns("hw-1")`);
      expect(hits.length).toBe(2);
      expect(hits[0].start).toBeGreaterThanOrEqual(0);
      expect(hits[1].start).toBeGreaterThan(hits[0].start);
      expect(hits[1].end).toBeGreaterThan(hits[0].end);
      // Both land on the same `GradebookExpressionValue` shape and score.
      expect((hits[0].raw as { score: number }).score).toBe(50);
      expect((hits[1].raw as { score: number }).score).toBe(50);
    });

    test("intermediate sources preserve positional info within the expression string", () => {
      // Positions should be ascending and within bounds of the typed string.
      const expr = "mean(gradebook_columns('hw-*')) + 5";
      const r = runExpression(controller, expr, "alice");
      expect(r.evaluation?.error).toBeNull();
      for (const iv of r.evaluation!.intermediates) {
        if (iv.start !== -1) {
          expect(iv.start).toBeGreaterThanOrEqual(0);
          expect(iv.end).toBeGreaterThan(iv.start);
          expect(iv.end).toBeLessThanOrEqual(expr.length);
        }
      }
    });

    test("start/end map back to the RAW typed input, not the mathjs-canonical form", () => {
      // Regression: mathjs `node.toString()` normalises `score*2` →
      // `score * 2`, single quotes → double quotes, etc.  The tester should
      // still report positions inside the user's exact textarea text, so the
      // UI can overlay annotations under the right characters (and so
      // `iv.end <= expression.length` holds even for compact input).
      const expr = "gradebook_columns('hw-1').score*2";
      const r = runExpression(controller, expr, "alice");
      expect(r.evaluation?.error).toBeNull();
      for (const iv of r.evaluation!.intermediates) {
        if (iv.start === -1) continue;
        expect(iv.start).toBeGreaterThanOrEqual(0);
        expect(iv.end).toBeGreaterThan(iv.start);
        // Hard constraint from the reviewer: spans must fit inside the
        // user-typed string.
        expect(iv.end).toBeLessThanOrEqual(expr.length);
      }
      // `gradebook_columns('hw-1')` appears at index 0 with single quotes in
      // the typed input — even though mathjs stringifies it with double
      // quotes. The tester must locate it anyway.
      const innerCall = r.evaluation!.intermediates.find((iv) => iv.source === `gradebook_columns("hw-1")`);
      expect(innerCall).toBeDefined();
      expect(innerCall?.start).toBe(0);
      expect(innerCall?.end).toBe("gradebook_columns('hw-1')".length);
    });
  });

  describe("formatValueForOverlay agrees with the evaluator output", () => {
    // Sanity check: the string shown in `result` should equal
    // `formatValueForOverlay(rawResult)` for the same value.
    const controller = createFakeController({
      columns: [
        { id: 1, slug: "hw-1", name: "HW1", max_score: 100 },
        { id: 2, slug: "hw-2", name: "HW2", max_score: 100 }
      ],
      entries: { alice: { "hw-1": { score: 80 }, "hw-2": { score: 60 } } }
    });

    test("result string matches formatValueForOverlay of the raw result", () => {
      const r = runExpression(controller, "mean(gradebook_columns('hw-*'))", "alice");
      expect(r.evaluation?.error).toBeNull();
      expect(r.evaluation?.result).toBe(formatValueForOverlay(r.evaluation?.rawResult));
    });
  });

  describe("per-line annotations for multi-line expressions", () => {
    // Rebuilds the real production workflow: a long block expression that
    // uses top-level `let`-style assignments and ends in a `case_when(...)`
    // that spans multiple lines. The Expression Builder renders the value of
    // each statement inline on the line that ENDS it, and leaves
    // continuation lines (e.g. rows of a multi-line matrix literal) blank.
    const controller = createFakeController({
      columns: [
        { id: 1, slug: "final-course-total", name: "Final Total", max_score: 1000 },
        { id: 2, slug: "final-individual-assignments", name: "Indiv", max_score: 300 },
        { id: 3, slug: "final-group-assignments", name: "Group", max_score: 200 },
        { id: 4, slug: "final-exams", name: "Exams", max_score: 400 },
        { id: 5, slug: "final-labs", name: "Labs", max_score: 12 },
        { id: 6, slug: "final-participation", name: "Part", max_score: 50 }
      ],
      entries: {
        alice: {
          "final-course-total": { score: 930 },
          "final-individual-assignments": { score: 260 },
          "final-group-assignments": { score: 170 },
          "final-exams": { score: 300 },
          "final-labs": { score: 11 },
          "final-participation": { score: 45 }
        }
      }
    });

    test("`T = 930` style single-line statements get their value on the same line", () => {
      const expr = `T = gradebook_columns('final-course-total').score
IND = gradebook_columns('final-individual-assignments').score
T + IND`;
      const r = runExpression(controller, expr, "alice");
      expect(r.evaluation?.error).toBeNull();
      const lines = r.evaluation!.lineResults;
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatchObject({ kind: "value", lineIndex: 0, display: "930" });
      expect(lines[1]).toMatchObject({ kind: "value", lineIndex: 1, display: "260" });
      expect(lines[2]).toMatchObject({ kind: "value", lineIndex: 2, display: "1190" });
    });

    test("case_when spanning multiple lines only annotates the closing `])`", () => {
      const expr = `T = gradebook_columns('final-course-total').score
case_when([
  largerEq(T, 900), 10;
  largerEq(T, 800), 8;
  true, 0
])`;
      const r = runExpression(controller, expr, "alice");
      expect(r.evaluation?.error).toBeNull();
      const lines = r.evaluation!.lineResults;
      expect(lines).toHaveLength(6);
      // Line 0: T = 930
      expect(lines[0]).toMatchObject({ kind: "value", lineIndex: 0, display: "930" });
      // Lines 1-4: inside the case_when literal — continuation, no value
      for (const i of [1, 2, 3, 4]) {
        expect(lines[i].kind).toBe("continuation");
      }
      // Line 5: closing `])` — the case_when evaluates to 10 (largerEq(930, 900))
      expect(lines[5]).toMatchObject({ kind: "value", lineIndex: 5, display: "10" });
    });

    test("blank lines in the editor are flagged as blank (no value, no continuation)", () => {
      const expr = `T = gradebook_columns('final-course-total').score

T * 2`;
      const r = runExpression(controller, expr, "alice");
      expect(r.evaluation?.error).toBeNull();
      const lines = r.evaluation!.lineResults;
      expect(lines[0].kind).toBe("value");
      expect(lines[1].kind).toBe("blank");
      expect(lines[2]).toMatchObject({ kind: "value", display: "1860" });
    });

    test("full production-style grade-boundary block evaluates cleanly end-to-end", () => {
      // Trimmed from the user-supplied expression in the spec. Alice has
      // T=930, IND=260, GRP=170, EXM=300, LABS=11, PART=45 → all A-ok
      // thresholds pass, so A_ok=1 and case_when picks the `T>=930, 11` row.
      const expr = `T = gradebook_columns('final-course-total').score
IND = gradebook_columns('final-individual-assignments').score
GRP = gradebook_columns('final-group-assignments').score
EXM = gradebook_columns('final-exams').score
LABS = gradebook_columns('final-labs').score
PART = gradebook_columns('final-participation').score
A_ok = largerEq(T, 900) * largerEq(IND, 240) * largerEq(GRP, 160) * largerEq(EXM, 280) * largerEq(LABS, 11) * largerEq(PART, 40)
case_when([
  A_ok * largerEq(T, 930), 11;
  A_ok * largerEq(T, 900), 10;
  true, 0
])`;
      const r = runExpression(controller, expr, "alice");
      expect(r.evaluation?.error).toBeNull();
      const lines = r.evaluation!.lineResults;
      // 7 `X = ...` statements (lines 0-6) each annotated, then a 4-line
      // case_when(...) with the last line (line 10) carrying the final value.
      expect(lines[0]).toMatchObject({ kind: "value", display: "930" });
      expect(lines[1]).toMatchObject({ kind: "value", display: "260" });
      expect(lines[2]).toMatchObject({ kind: "value", display: "170" });
      expect(lines[3]).toMatchObject({ kind: "value", display: "300" });
      expect(lines[4]).toMatchObject({ kind: "value", display: "11" });
      expect(lines[5]).toMatchObject({ kind: "value", display: "45" });
      expect(lines[6]).toMatchObject({ kind: "value", display: "1" }); // A_ok
      expect(lines[7].kind).toBe("continuation"); // case_when([
      expect(lines[8].kind).toBe("continuation"); //   A_ok * largerEq(T, 930), 11;
      expect(lines[9].kind).toBe("continuation"); //   A_ok * largerEq(T, 900), 10;
      expect(lines[10].kind).toBe("continuation"); //   true, 0
      expect(lines[11]).toMatchObject({ kind: "value", display: "11" }); // ])
      // And the overall `result` of the expression is the last block's value.
      expect(r.evaluation!.result).toBe("11");
    });
  });
});
