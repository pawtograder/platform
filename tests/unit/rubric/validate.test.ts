import { rubricCheckDataOrThrow } from "@/lib/rubric/validate";
import { YamlChecksToHydratedChecks } from "@/lib/rubric/parse";
import { YmlRubricChecksType } from "@/utils/supabase/DatabaseTypes";

function makeCheck(data: YmlRubricChecksType["data"] | undefined): YmlRubricChecksType {
  return {
    name: "Check",
    points: 1,
    is_annotation: false,
    is_required: false,
    is_comment_required: false,
    data
  };
}

describe("rubricCheckDataOrThrow", () => {
  it("returns undefined when data is missing", () => {
    expect(rubricCheckDataOrThrow(makeCheck(undefined))).toBeUndefined();
  });

  it("returns undefined when data is an object without options", () => {
    // Cast through unknown because the YmlRubricChecksType narrows .data, but the
    // runtime function tolerates objects without an `options` field.
    const check = { ...makeCheck(undefined), data: { foo: "bar" } as unknown as YmlRubricChecksType["data"] };
    expect(rubricCheckDataOrThrow(check)).toBeUndefined();
  });

  it("rejects a single-option check", () => {
    const check = makeCheck({ options: [{ label: "only", points: 1 }] });
    expect(() => rubricCheckDataOrThrow(check)).toThrow(/must have at least two options/);
  });

  it("rejects an option missing label", () => {
    const check = makeCheck({
      options: [
        { label: "", points: 0 },
        { label: "ok", points: 5 }
      ]
    });
    expect(() => rubricCheckDataOrThrow(check)).toThrow(/Option label is required/);
  });

  it("rejects an option missing points", () => {
    const check = makeCheck({
      options: [{ label: "a", points: 1 }, { label: "b" } as unknown as { label: string; points: number }]
    });
    expect(() => rubricCheckDataOrThrow(check)).toThrow(/Option points are required/);
  });

  it("accepts a valid multi-option check", () => {
    const check = makeCheck({
      options: [
        { label: "yes", points: 2 },
        { label: "no", points: 0 }
      ]
    });
    const result = rubricCheckDataOrThrow(check);
    expect(result?.options).toHaveLength(2);
  });

  it("accepts an empty options array (the contract allows zero options)", () => {
    const check = makeCheck({ options: [] });
    const result = rubricCheckDataOrThrow(check);
    expect(result?.options).toEqual([]);
  });
});

describe("YamlChecksToHydratedChecks — empty check list", () => {
  it("rejects a criterion with zero checks", () => {
    expect(() => YamlChecksToHydratedChecks([])).toThrow("Criteria must have at least one check");
  });
});
