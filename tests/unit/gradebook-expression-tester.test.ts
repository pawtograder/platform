import { formatValueForOverlay } from "@/lib/gradebookExpressionTester";

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
});
