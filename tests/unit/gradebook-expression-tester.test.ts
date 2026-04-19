import * as mathjs from "mathjs";
import { evaluateRenderExpression, formatValueForOverlay } from "@/lib/gradebookExpressionTester";

describe("gradebook expression tester helpers", () => {
  describe("formatValueForOverlay", () => {
    test("formats primitives", () => {
      expect(formatValueForOverlay(undefined)).toBe("undefined");
      expect(formatValueForOverlay(null)).toBe("null");
      expect(formatValueForOverlay(42)).toBe("42");
      expect(formatValueForOverlay(3.14159)).toBe("3.1416");
      expect(formatValueForOverlay(true)).toBe("true");
    });

    test("formats non-finite numbers (NaN / Infinity)", () => {
      expect(formatValueForOverlay(NaN)).toBe("NaN");
      expect(formatValueForOverlay(Infinity)).toBe("Infinity");
      expect(formatValueForOverlay(-Infinity)).toBe("-Infinity");
    });

    test("formats plain arrays without collapsing to undefined", () => {
      // Regression: `"entries" in arr` is true for plain arrays because
      // Array.prototype.entries exists. We must not mistake plain arrays
      // for mathjs ResultSets.
      expect(formatValueForOverlay([1, 2, 3])).toBe("[1, 2, 3]");
      expect(formatValueForOverlay([])).toBe("[]");
    });

    test("formats long arrays with an ellipsis", () => {
      expect(formatValueForOverlay([1, 2, 3, 4, 5, 6])).toBe("[1, 2, 3, 4, … 2 more]");
    });

    test("formats GradebookExpressionValue-like objects", () => {
      const value = {
        score: 80,
        max_score: 100,
        column_slug: "hw-1",
        score_override: null,
        is_missing: false,
        is_droppable: false,
        is_excused: false,
        is_private: false
      };
      expect(formatValueForOverlay(value)).toBe("hw-1=80/100");
    });

    test("formats arrays of GradebookExpressionValue-like objects", () => {
      const values = [
        {
          score: 80,
          max_score: 100,
          column_slug: "hw-1",
          score_override: null,
          is_missing: false,
          is_droppable: false,
          is_excused: false,
          is_private: false
        },
        {
          score: 90,
          max_score: 100,
          column_slug: "hw-2",
          score_override: null,
          is_missing: false,
          is_droppable: false,
          is_excused: false,
          is_private: false
        }
      ];
      expect(formatValueForOverlay(values)).toBe("[hw-1=80/100, hw-2=90/100]");
    });

    test("unwraps mathjs DenseMatrix-style values via toArray()", () => {
      const fakeMatrix = {
        toArray: () => [1, 2, 3]
      };
      expect(formatValueForOverlay(fakeMatrix)).toBe("[1, 2, 3]");
    });

    test("unwraps ResultSet-style values", () => {
      // ResultSet is `{ entries: unknown[] }` with no other own array behavior.
      const resultSet = { entries: [1, 2, 42] };
      expect(formatValueForOverlay(resultSet)).toBe("42");
    });
  });

  describe("evaluateRenderExpression", () => {
    test("empty render expression is reported as empty, not an error", () => {
      const r = evaluateRenderExpression(mathjs, "", "", 80, 100);
      expect(r.kind).toBe("empty");
      const r2 = evaluateRenderExpression(mathjs, "", null, 80, 100);
      expect(r2.kind).toBe("empty");
    });

    test("default `round(score, 2)` pattern evaluates to a trimmed numeric", () => {
      const r = evaluateRenderExpression(mathjs, "", "round(score, 2)", 81.5, 100);
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.rendered).toBe("81.5");
    });

    test("`letter(score)` maps a raw score to the expected letter grade", () => {
      const r = evaluateRenderExpression(mathjs, "", "letter(score)", 81.5, 100);
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.rendered).toBe("B-");

      const r2 = evaluateRenderExpression(mathjs, "", "letter(score)", 95, 100);
      if (r2.kind === "ok") expect(r2.rendered).toBe("A");

      const r3 = evaluateRenderExpression(mathjs, "", "letter(score)", 55, 100);
      if (r3.kind === "ok") expect(r3.rendered).toBe("F");
    });

    test("`check(score)` maps scores to emoji check marks based on breakpoints", () => {
      const ok = evaluateRenderExpression(mathjs, "", "check(score)", 95, 100);
      expect(ok.kind).toBe("ok");
      if (ok.kind === "ok") expect(ok.rendered).toContain("✔");
      const bad = evaluateRenderExpression(mathjs, "", "check(score)", 10, 100);
      if (bad.kind === "ok") expect(bad.rendered).toBe("❌");
    });

    test("`checkOrX(score)` returns ✔️ for any positive score", () => {
      const ok = evaluateRenderExpression(mathjs, "", "checkOrX(score)", 1, 100);
      expect(ok.kind).toBe("ok");
      if (ok.kind === "ok") expect(ok.rendered).toBe("✔️");
      const zero = evaluateRenderExpression(mathjs, "", "checkOrX(score)", 0, 100);
      if (zero.kind === "ok") expect(zero.rendered).toBe("❌");
    });

    test("`expression_prefix` is prepended so helper defs from the prefix are visible", () => {
      // The expression_prefix is a block of mathjs that runs before the
      // render expression. We simulate a prefix that defines a custom helper.
      const prefix = "halve(x) = x / 2";
      const r = evaluateRenderExpression(mathjs, prefix, "halve(score)", 80, 100);
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.rendered).toBe("40");
    });

    test("undefined score renders without crashing", () => {
      const r = evaluateRenderExpression(mathjs, "", "letter(score)", undefined, 100);
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.rendered).toBe("(N/A)");
    });

    test("syntax error in render expression surfaces as `error`", () => {
      const r = evaluateRenderExpression(mathjs, "", "((letter(score)", 80, 100);
      expect(r.kind).toBe("error");
      if (r.kind === "error") expect(r.message).toBeTruthy();
    });

    test("dangerous MathJS surface (import / createUnit / reviver / resolve) is blocked", () => {
      // Mirrors the live gradebook renderer's security guard in
      // GradebookController._getSharedMath(); the preview must reject the
      // same names so an instructor can't save an expression here that the
      // rendered cell would throw on at runtime.
      for (const name of ["import", "createUnit", "reviver", "resolve"]) {
        const r = evaluateRenderExpression(mathjs, "", `${name}("foo")`, 80, 100);
        expect(r.kind).toBe("error");
        if (r.kind === "error") {
          expect(r.message).toMatch(new RegExp(`${name}\\b.*not allowed`));
        }
      }
    });
  });
});
