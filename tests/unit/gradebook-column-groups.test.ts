import {
  columnUnitKeys,
  databaseLayout,
  displayOrder,
  isHeaderGroup,
  legacySlugLayout,
  moveColumnInLayout,
  moveGroupInLayout,
  collapsedColumnFor,
  topicLayout,
  type LayoutColumn
} from "@/lib/gradebookColumnGroups";

/** The cs4535 seed template's columns (id, sort_order, slug, name), as seeded locally. */
const CS4535: LayoutColumn[] = [
  [1, 0, "assignment-lab-1", "Lab 1 (Group)"],
  [3, 1, "assignment-lab-2", "Lab 2"],
  [5, 2, "assignment-lab-3", "Lab 3"],
  [7, 3, "assignment-lab-4", "Lab 4"],
  [2, 4, "assignment-assignment-1", "Assignment 1 (Group)"],
  [4, 5, "assignment-assignment-2", "Assignment 2"],
  [6, 6, "assignment-assignment-3", "Assignment 3"],
  [8, 7, "assignment-assignment-4", "Assignment 4"],
  [30, 8, "exam-1", "Exam 1"],
  [31, 9, "exam-2", "Exam 2"],
  [32, 10, "exam-3", "Exam 3"],
  [33, 11, "quiz-1", "Quiz 1"],
  [34, 12, "quiz-2", "Quiz 2"],
  [36, 14, "quiz-4", "Quiz 4"],
  [37, 15, "quiz-5", "Quiz 5"],
  ...Array.from({ length: 12 }, (_, i) => [9 + i, 16 + i, `skill-${i + 1}`, `Skill #${i + 1}`] as const),
  [21, 28, "meets-expectations", "Skills Meeting Expectations"],
  [22, 29, "approaching-expectations", "Skills Approaching Expectations"],
  [23, 30, "does-not-meet-expectations", "Skills Not Meeting Expectations"],
  [25, 31, "average.hw", "Average HW"],
  [26, 32, "labs-drop-lowest", "Labs (drop lowest 2)"],
  [24, 33, "total-labs", "Total Labs"],
  [27, 34, "curve-adjustment", "Curve Adjustment (instructor-only)"],
  [28, 35, "midterm-standing", "Midterm Standing (released)"],
  [38, 36, "attendance", "Attendance"],
  [39, 37, "ai-usage-log-1", "AI Usage Log 1"],
  [40, 38, "ai-usage-log-2", "AI Usage Log 2"],
  [41, 39, "assignment-final", "Final Project"],
  [29, 40, "final", "Final Score"]
].map(([id, sort_order, slug, name]) => ({
  id: Number(id),
  sort_order: Number(sort_order),
  slug: String(slug),
  name: String(name)
}));

function headerGroups(grouped: ReturnType<typeof legacySlugLayout>) {
  return Object.values(grouped)
    .filter(isHeaderGroup)
    .map((g) => `${g.groupName}:${g.columns.map((c) => c.slug).join(",")}`);
}

describe("legacySlugLayout", () => {
  it("reproduces the pre-groups heuristic on the cs4535 seed, quirks included", () => {
    expect(headerGroups(legacySlugLayout(CS4535))).toEqual([
      "Lab:assignment-lab-1,assignment-lab-2,assignment-lab-3,assignment-lab-4",
      "Assignment:assignment-assignment-1,assignment-assignment-2,assignment-assignment-3,assignment-assignment-4",
      "Exam:exam-1,exam-2,exam-3",
      // The deleted quiz-3 leaves a sort_order hole that splits Quiz in two.
      "Quiz:quiz-1,quiz-2",
      "Quiz:quiz-4,quiz-5",
      `Skill:${Array.from({ length: 12 }, (_, i) => `skill-${i + 1}`).join(",")}`,
      // First-token label.
      "Ai:ai-usage-log-1,ai-usage-log-2"
    ]);
  });

  it("treats a NULL sort_order as 0, which splits the run it lands in", () => {
    const cols: LayoutColumn[] = [
      { id: 1, sort_order: 0, slug: "hw-1", name: "HW 1" },
      { id: 2, sort_order: 1, slug: "hw-2", name: "HW 2" },
      { id: 3, sort_order: null, slug: "assignment-hw-1-code-walk", name: "Code walk" }
    ];
    const units = Object.values(legacySlugLayout(cols));
    expect(units.map((u) => u.columns.map((c) => c.id))).toEqual([[1], [3], [2]]);
  });
});

describe("databaseLayout", () => {
  const groups = [
    { id: 10, name: "Labs" },
    { id: 11, name: "Quizzes" }
  ];

  it("draws each group at its first member and keeps every column", () => {
    const cols: LayoutColumn[] = [
      { id: 1, sort_order: 0, slug: "a", name: "A", group_id: 10 },
      { id: 2, sort_order: 1, slug: "b", name: "B", group_id: null },
      { id: 3, sort_order: 2, slug: "c", name: "C", group_id: 10 }, // torn: renders with its group
      { id: 4, sort_order: 3, slug: "d", name: "D", group_id: 11 }
    ];
    const grouped = databaseLayout(cols, groups);
    expect(Object.keys(grouped)).toEqual(["group:10", "col:2", "group:11"]);
    expect(grouped["group:10"].columns.map((c) => c.id)).toEqual([1, 3]);
    expect(displayOrder(grouped)).toEqual([1, 3, 2, 4]);
  });

  it("gives a one-member group a header, but not a plain column", () => {
    const grouped = databaseLayout(
      [
        { id: 4, sort_order: 0, slug: "d", name: "D", group_id: 11 },
        { id: 5, sort_order: 1, slug: "e", name: "E", group_id: null }
      ],
      groups
    );
    expect(isHeaderGroup(grouped["group:11"])).toBe(true);
    expect(isHeaderGroup(grouped["col:5"])).toBe(false);
    expect(grouped["group:11"].groupName).toBe("Quizzes");
  });

  it("renders a column whose group is unknown as ungrouped", () => {
    const grouped = databaseLayout([{ id: 1, sort_order: 0, slug: "a", name: "A", group_id: 99 }], groups);
    expect(Object.keys(grouped)).toEqual(["col:1"]);
  });

  it("orders NULL sort_order last, then by id", () => {
    const grouped = databaseLayout(
      [
        { id: 3, sort_order: null, slug: "c", name: "C" },
        { id: 2, sort_order: 0, slug: "b", name: "B" },
        { id: 1, sort_order: 0, slug: "a", name: "A" }
      ],
      []
    );
    expect(displayOrder(grouped)).toEqual([1, 2, 3]);
  });

  it("maps every column to its unit key", () => {
    const grouped = databaseLayout(
      [
        { id: 1, sort_order: 0, slug: "a", name: "A", group_id: 10 },
        { id: 2, sort_order: 1, slug: "b", name: "B" }
      ],
      groups
    );
    expect([...columnUnitKeys(grouped)]).toEqual([
      [1, "group:10"],
      [2, "col:2"]
    ]);
  });
});

describe("moving", () => {
  const grouped = databaseLayout(
    [
      { id: 1, sort_order: 0, slug: "x", name: "X" },
      { id: 2, sort_order: 1, slug: "a", name: "A", group_id: 10 },
      { id: 3, sort_order: 2, slug: "b", name: "B", group_id: 10 },
      { id: 4, sort_order: 3, slug: "y", name: "Y" }
    ],
    [{ id: 10, name: "Labs" }]
  );

  it("moves a grouped column only within its group", () => {
    expect(moveColumnInLayout(grouped, 3, -1)).toEqual([1, 3, 2, 4]);
    expect(moveColumnInLayout(grouped, 2, -1)).toBeNull();
    expect(moveColumnInLayout(grouped, 3, 1)).toBeNull();
  });

  it("steps an ungrouped column over a whole group", () => {
    expect(moveColumnInLayout(grouped, 1, 1)).toEqual([2, 3, 1, 4]);
    expect(moveColumnInLayout(grouped, 4, -1)).toEqual([1, 4, 2, 3]);
    expect(moveColumnInLayout(grouped, 1, -1)).toBeNull();
  });

  it("moves a whole group one unit", () => {
    expect(moveGroupInLayout(grouped, "group:10", 1)).toEqual([1, 4, 2, 3]);
    expect(moveGroupInLayout(grouped, "group:10", -1)).toEqual([2, 3, 1, 4]);
    expect(moveGroupInLayout(grouped, "missing", 1)).toBeNull();
  });
});

describe("topicLayout", () => {
  // Two quiz sessions (groups) covering two topics, CS 2100 style, plus an unrelated homework.
  const cols: LayoutColumn[] = [
    { id: 1, sort_order: 0, slug: "s1-git", name: "Attempt 1: Git", group_id: 100, topic_id: 7, attempt_number: 1 },
    {
      id: 2,
      sort_order: 1,
      slug: "s1-fd",
      name: "Attempt 1: Functions",
      group_id: 100,
      topic_id: 8,
      attempt_number: 1
    },
    {
      id: 3,
      sort_order: 2,
      slug: "s2-fd",
      name: "Attempt 2: Functions",
      group_id: 101,
      topic_id: 8,
      attempt_number: 2
    },
    { id: 4, sort_order: 3, slug: "s2-git", name: "Attempt 2: Git", group_id: 101, topic_id: 7, attempt_number: 2 },
    { id: 5, sort_order: 4, slug: "topic_git", name: "Git standing" },
    { id: 6, sort_order: 5, slug: "hw1", name: "HW1" }
  ];
  const groups = [
    { id: 100, name: "Quiz 9/22" },
    { id: 101, name: "Quiz 10/15" }
  ];
  const topics = [
    { id: 7, name: "Git", standing_column_id: 5, standing_rule: "best" },
    { id: 8, name: "Functions", standing_column_id: null, standing_rule: null },
    { id: 9, name: "Empty", standing_column_id: null, standing_rule: null }
  ];

  it("puts each topic at its standing (or first attempt), standing first, attempts in order", () => {
    const grouped = topicLayout(databaseLayout(cols, groups), topics);
    expect(Object.keys(grouped)).toEqual(["topic:8", "topic:7", "col:6"]);
    expect(grouped["topic:7"].columns.map((c) => c.id)).toEqual([5, 1, 4]);
    expect(grouped["topic:8"].columns.map((c) => c.id)).toEqual([2, 3]);
    expect(isHeaderGroup(grouped["topic:7"])).toBe(true);
  });

  it("keeps the rest of a group when topics take some of its columns", () => {
    const grouped = topicLayout(databaseLayout(cols, groups), [topics[0]]);
    expect(grouped["group:100"].columns.map((c) => c.id)).toEqual([2]);
    expect(grouped["group:101"].columns.map((c) => c.id)).toEqual([3]);
  });

  it("collapses a topic to its standing, and a group to the fallback", () => {
    const grouped = topicLayout(databaseLayout(cols, groups), topics);
    const last = (c: LayoutColumn[]) => c[c.length - 1];
    expect(collapsedColumnFor(grouped["topic:7"], last).id).toBe(5);
    expect(collapsedColumnFor(grouped["topic:8"], last).id).toBe(3);
  });
});
