/**
 * @jest-environment node
 */

import { preorder, type TreeNode } from "@/lib/exam/questionTree";

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
