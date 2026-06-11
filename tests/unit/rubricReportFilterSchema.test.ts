import {
  filterDepth,
  MAX_FILTER_DEPTH,
  rubricFilterSchema,
  validateRubricFilter,
  type RubricFilter
} from "@/lib/rubricReport/filterSchema";

describe("rubricFilterSchema", () => {
  it("accepts each leaf predicate", () => {
    const leaves: RubricFilter[] = [
      { checkApplied: 42 },
      { optionSelected: { checkId: 3, optionIndex: 0 } },
      { section: "Section A" },
      { lab: "Lab 1" },
      { scoreAtLeast: 80 },
      { scoreAtMost: 100 }
    ];
    for (const leaf of leaves) {
      expect(rubricFilterSchema.safeParse(leaf).success).toBe(true);
    }
  });

  it("accepts nested and/or/not trees", () => {
    const tree: RubricFilter = {
      op: "and",
      args: [
        { checkApplied: 1 },
        { op: "not", args: [{ section: "B" }] },
        { op: "or", args: [{ lab: "L1" }, { lab: "L2" }] }
      ]
    };
    expect(rubricFilterSchema.safeParse(tree).success).toBe(true);
  });

  it("rejects unknown ops and unknown predicate keys", () => {
    expect(rubricFilterSchema.safeParse({ op: "xor", args: [] }).success).toBe(false);
    expect(rubricFilterSchema.safeParse({ bogus: 1 }).success).toBe(false);
    // extra key alongside a valid predicate (strict)
    expect(rubricFilterSchema.safeParse({ checkApplied: 1, extra: 2 }).success).toBe(false);
  });

  it("rejects wrong value types", () => {
    expect(rubricFilterSchema.safeParse({ checkApplied: "1" }).success).toBe(false);
    expect(rubricFilterSchema.safeParse({ section: 5 }).success).toBe(false);
    expect(rubricFilterSchema.safeParse({ optionSelected: { checkId: 1 } }).success).toBe(false);
  });

  it("requires exactly one arg for not (enforced by validateRubricFilter)", () => {
    expect(validateRubricFilter({ op: "not", args: [{ section: "A" }, { section: "B" }] }).ok).toBe(false);
    expect(validateRubricFilter({ op: "not", args: [] }).ok).toBe(false);
    expect(validateRubricFilter({ op: "not", args: [{ section: "A" }] }).ok).toBe(true);
  });

  it("treats injection-style strings as ordinary, valid string values", () => {
    const result = validateRubricFilter({ section: "'); DROP TABLE assignments;--" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ section: "'); DROP TABLE assignments;--" });
  });
});

describe("filterDepth + validateRubricFilter", () => {
  it("computes depth (leaf = 1)", () => {
    expect(filterDepth({ section: "A" })).toBe(1);
    expect(filterDepth({ op: "not", args: [{ section: "A" }] })).toBe(2);
    expect(filterDepth({ op: "and", args: [{ op: "or", args: [{ lab: "L" }] }] })).toBe(3);
  });

  it("rejects trees deeper than MAX_FILTER_DEPTH", () => {
    let node: RubricFilter = { section: "A" };
    for (let i = 0; i < MAX_FILTER_DEPTH + 2; i++) {
      node = { op: "not", args: [node] };
    }
    const result = validateRubricFilter(node);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too deep/i);
  });

  it("returns a structured error for malformed input", () => {
    const result = validateRubricFilter({ op: "and" });
    expect(result.ok).toBe(false);
  });

  it("round-trips a valid filter", () => {
    const filter: RubricFilter = { op: "or", args: [{ checkApplied: 7 }, { scoreAtMost: 50 }] };
    const result = validateRubricFilter(filter);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(filter);
  });
});
