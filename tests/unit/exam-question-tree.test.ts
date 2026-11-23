/**
 * @jest-environment node
 */

import {
  parentPointsMismatches,
  preorder,
  spreadParentPoints,
  type PointsMismatch,
  type PointsNode,
  type TreeNode
} from "@/lib/exam/questionTree";

const node = (client_id: string, parent_client_id: string | null, ordinal: number): TreeNode => ({
  client_id,
  parent_client_id,
  ordinal
});
const ids = (questions: TreeNode[]) => preorder(questions).map((q) => q.client_id);

describe("preorder", () => {
  it.each<[string, TreeNode[], string[]]>([
    // The bug in #1264: the database returns rows by level, then ordinal, and ordinals are per parent,
    // so questions 1 and 3 (both ordinal 0) come first. Catches rendering that order as-is.
    [
      "puts each part's questions under it, not grouped by level",
      [
        node("A", null, 0),
        node("B", null, 1),
        node("q1", "A", 0),
        node("q3", "B", 0),
        node("q2", "A", 1),
        node("q4", "B", 1)
      ],
      ["A", "q1", "q2", "B", "q3", "q4"]
    ],
    // Catches trusting the input order within one parent instead of sorting by ordinal.
    ["sorts siblings by ordinal", [node("A", null, 0), node("q2", "A", 1), node("q1", "A", 0)], ["A", "q1", "q2"]],
    // Catches only going one level deep: items belong under their question, under its part.
    [
      "nests items under their question, under their part",
      [node("A", null, 0), node("B", null, 1), node("q1", "A", 0), node("q2", "B", 0), node("1a", "q1", 0)],
      ["A", "q1", "1a", "B", "q2"]
    ],
    // Catches silently hiding a question whose parent isn't in the list (a bad id from Auto-extract).
    // It comes last, with its own child still under it.
    [
      "keeps a question whose parent is missing, at the end",
      [node("A", null, 0), node("lost", "nope", 0), node("q1", "A", 0), node("lost-a", "lost", 0)],
      ["A", "q1", "lost", "lost-a"]
    ]
  ])("%s", (_name, questions, expected) => {
    expect(ids(questions)).toEqual(expected);
  });
});

const q = (client_id: string, parent_client_id: string | null, points: number | null): PointsNode => ({
  client_id,
  parent_client_id,
  points
});

describe("parentPointsMismatches", () => {
  it.each<[string, PointsNode[], [string, PointsMismatch][]]>([
    // The bug in #1370: Gemini put 3(b)'s 7 points on 3(b) and none on its four parts. Only parts
    // count toward the total, so the 7 vanished without a word.
    [
      "flags a question whose points its parts don't add up to",
      [q("3b", null, 7), q("c1", "3b", 0), q("c2", "3b", 0), q("c3", "3b", 0), q("c4", "3b", 0)],
      [["3b", { points: 7, partsTotal: 0 }]]
    ],
    // Catches warning on an exam that's already right.
    ["passes a question whose parts add up to its points", [q("3b", null, 7), q("c1", "3b", 3), q("c2", "3b", 4)], []],
    // Catches warning on every question with parts: they default to 0, and Gemini often sends null.
    ["passes a question at 0 points", [q("A", null, 0), q("a1", "A", 2)], []],
    ["passes a question with no points", [q("A", null, null), q("a1", "A", 2)], []],
    // Catches adding up only direct parts. The level-2 parts here have parts of their own, so their
    // 0 doesn't count; the answerable parts under them do.
    [
      "adds up the answerable parts, not the direct ones",
      [q("P1", null, 20), q("q1", "P1", 0), q("q2", "P1", 0), q("1a", "q1", 8), q("1b", "q1", 4), q("2a", "q2", 8)],
      []
    ],
    // Catches treating a question with no parts as one with parts.
    ["passes a question with no parts", [q("Q", null, 5)], []],
    // Catches recursing forever on a bad id from Auto-extract, which crashed the editor on render.
    ["skips a question that is its own parent", [q("A", null, 4), q("a1", "A", 4), q("x", "x", 3)], []]
  ])("%s", (_name, questions, expected) => {
    expect(parentPointsMismatches(questions)).toEqual(new Map(expected));
  });
});

describe("spreadParentPoints", () => {
  const pointsOf = (questions: PointsNode[]) =>
    Object.fromEntries(spreadParentPoints(questions).map((n) => [n.client_id, n.points]));

  it.each<[string, PointsNode[], Record<string, number | null>]>([
    // The bug in #1370: 3(b)'s 7 points sat on 3(b) and its four calls came in at 0.
    [
      "spreads a question's points over parts that have none",
      [q("3b", null, 7), q("c1", "3b", 0), q("c2", "3b", null), q("c3", "3b", 0), q("c4", "3b", 0)],
      { "3b": 7, c1: 2, c2: 2, c3: 2, c4: 1 }
    ],
    // Catches a split that loses points (3 + 3 + 3) or gives decimals, which a leaf's integer rubric
    // criterion total would round.
    [
      "splits into whole points that keep the total",
      [q("A", null, 10), q("a1", "A", 0), q("a2", "A", 0), q("a3", "A", 0)],
      { A: 10, a1: 4, a2: 3, a3: 3 }
    ],
    // Catches spreading points that can't be split into whole points.
    [
      "leaves a question with fractional points alone",
      [q("A", null, 2.5), q("a1", "A", 0), q("a2", "A", 0)],
      { A: 2.5, a1: 0, a2: 0 }
    ],
    // Catches spreading top-down: Problem 3's 13 would go over (a) and the calls, overwriting (a)'s 6.
    // Only 3(b), whose parts have nothing, is spread.
    [
      "leaves a part that already has points alone",
      [q("P3", null, 13), q("a", "P3", 6), q("b", "P3", 7), q("c1", "b", 0), q("c2", "b", 0)],
      { P3: 13, a: 6, b: 7, c1: 4, c2: 3 }
    ],
    // Catches spreading a level-1 question's points over all its level-3 parts when its level-2 parts
    // say how they're divided.
    [
      "spreads the deepest points first",
      [q("P", null, 20), q("q1", "P", 8), q("q2", "P", 12), q("1a", "q1", 0), q("1b", "q1", 0), q("2a", "q2", 0)],
      { P: 20, q1: 8, q2: 12, "1a": 4, "1b": 4, "2a": 12 }
    ],
    // Catches overwriting points Gemini did give some parts. A partial split is left for the note.
    [
      "leaves parts alone when some have points",
      [q("A", null, 7), q("a1", "A", 3), q("a2", "A", 0)],
      { A: 7, a1: 3, a2: 0 }
    ]
  ])("%s", (_name, questions, expected) => {
    expect(pointsOf(questions)).toEqual(expected);
  });
});
