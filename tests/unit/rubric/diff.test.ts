import { findChanges, findUpdatedPropertyNames } from "@/lib/rubric/diff";

type Item = { id: number | undefined | null; name: string; data?: unknown };

describe("findChanges", () => {
  it("identifies items with id <= 0 (or undefined/null) as creates", () => {
    const result = findChanges<Item>(
      [
        { id: -1, name: "new1" },
        { id: 0, name: "new2" },
        { id: undefined, name: "new3" },
        { id: null, name: "new4" }
      ],
      []
    );
    expect(result.toCreate).toHaveLength(4);
    expect(result.toUpdate).toEqual([]);
    expect(result.toDelete).toEqual([]);
    expect(result.numItemsWithBadIDs).toBe(0);
  });

  it("identifies updates when the JSON shape changed", () => {
    const result = findChanges<Item>([{ id: 1, name: "B" }], [{ id: 1, name: "A" }]);
    expect(result.toUpdate).toEqual([{ id: 1, name: "B" }]);
    expect(result.toCreate).toEqual([]);
    expect(result.toDelete).toEqual([]);
  });

  it("does not mark unchanged items as updates", () => {
    const result = findChanges<Item>([{ id: 1, name: "A" }], [{ id: 1, name: "A" }]);
    expect(result.toUpdate).toEqual([]);
    expect(result.toCreate).toEqual([]);
    expect(result.toDelete).toEqual([]);
  });

  it("identifies items present in existing but missing from new as deletes", () => {
    const result = findChanges<Item>(
      [{ id: 1, name: "A" }],
      [
        { id: 1, name: "A" },
        { id: 2, name: "B" }
      ]
    );
    expect(result.toDelete).toEqual([2]);
  });

  it("counts items with ids not present in existing as bad-id creates", () => {
    const result = findChanges<Item>([{ id: 99, name: "orphan" }], [{ id: 1, name: "A" }]);
    expect(result.numItemsWithBadIDs).toBe(1);
    expect(result.toCreate).toEqual([{ id: 99, name: "orphan" }]);
    expect(result.toDelete).toEqual([1]);
  });

  it("uses JSON.stringify for deep equality", () => {
    const result = findChanges<Item>(
      [{ id: 1, name: "A", data: { x: 1, y: 2 } }],
      [{ id: 1, name: "A", data: { x: 1, y: 3 } }]
    );
    expect(result.toUpdate).toHaveLength(1);
  });
});

describe("findUpdatedPropertyNames", () => {
  type Row = {
    id: number;
    rubric_id: number;
    class_id: number;
    created_at: string;
    assignment_id: number;
    name: string;
    points: number;
    data: { options: { label: string; points: number }[] } | null;
    rubric_checks: unknown[];
  };

  const base: Row = {
    id: 1,
    rubric_id: 100,
    class_id: 1,
    created_at: "2024",
    assignment_id: 5,
    name: "A",
    points: 1,
    data: null,
    rubric_checks: []
  };

  it("excludes rubric_id / class_id / created_at / assignment_id even if changed", () => {
    const changed: Row = { ...base, rubric_id: 999, class_id: 999, created_at: "X", assignment_id: 999 };
    const updated = findUpdatedPropertyNames(changed, base);
    expect(updated).toEqual([]);
  });

  it("excludes arrays from comparison even if changed", () => {
    const changed: Row = { ...base, rubric_checks: [{ id: 1 }] };
    const updated = findUpdatedPropertyNames(changed, base);
    expect(updated).toEqual([]);
  });

  it("flags scalar field changes", () => {
    const changed: Row = { ...base, name: "B", points: 2 };
    const updated = findUpdatedPropertyNames(changed, base);
    expect(updated.sort()).toEqual(["name", "points"]);
  });

  it("deep-compares the data field via JSON.stringify", () => {
    const changed: Row = { ...base, data: { options: [{ label: "x", points: 1 }] } };
    const updated = findUpdatedPropertyNames(changed, base);
    expect(updated).toContain("data");
  });

  it("treats deep-equal data as unchanged even when references differ", () => {
    // The implementation deep-compares the `data` field via JSON.stringify, so two
    // distinct objects with identical contents should not be flagged as changed.
    const a: Row = { ...base, data: { options: [{ label: "x", points: 1 }] } };
    const b: Row = { ...base, data: { options: [{ label: "x", points: 1 }] } };
    const updated = findUpdatedPropertyNames(a, b);
    expect(updated).not.toContain("data");
  });
});
