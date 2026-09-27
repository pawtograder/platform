/**
 * @jest-environment node
 */
import { groupBySubmissionId } from "@/lib/groupBySubmissionId";

type Row = { submission_id: number | null; name: string };

describe("groupBySubmissionId", () => {
  it("keeps a submission's only row", () => {
    // The regression: the old idiom created the bucket and never pushed the row that created it,
    // so a submission with exactly one autograder test result exported an EMPTY array.
    const map = groupBySubmissionId<Row>([{ submission_id: 1, name: "solo" }]);
    expect(map.get(1)).toEqual([{ submission_id: 1, name: "solo" }]);
  });

  it("keeps every row for a submission, including the first", () => {
    const map = groupBySubmissionId<Row>([
      { submission_id: 1, name: "a" },
      { submission_id: 1, name: "b" },
      { submission_id: 1, name: "c" }
    ]);
    expect(map.get(1)?.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("keeps submissions separate", () => {
    const map = groupBySubmissionId<Row>([
      { submission_id: 1, name: "a" },
      { submission_id: 2, name: "b" }
    ]);
    expect(map.size).toBe(2);
    expect(map.get(1)?.map((r) => r.name)).toEqual(["a"]);
    expect(map.get(2)?.map((r) => r.name)).toEqual(["b"]);
  });

  it("drops rows with no submission", () => {
    const map = groupBySubmissionId<Row>([
      { submission_id: null, name: "orphan" },
      { submission_id: 3, name: "kept" }
    ]);
    expect(map.size).toBe(1);
    expect(map.get(3)?.map((r) => r.name)).toEqual(["kept"]);
  });

  it("returns an empty map for no rows", () => {
    expect(groupBySubmissionId<Row>([]).size).toBe(0);
  });
});
