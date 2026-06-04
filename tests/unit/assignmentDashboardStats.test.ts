import {
  ALL_SECTIONS_FILTER,
  buildScoreHistogram,
  collectSectionOptions,
  computeGradingCounts,
  filterRowsBySection
} from "@/lib/assignmentDashboardStats";

describe("computeGradingCounts", () => {
  it("returns all-zero counts for no rows", () => {
    expect(computeGradingCounts([])).toEqual({ total: 0, graded: 0, released: 0, notReleased: 0 });
  });

  it("counts graded as rows with a non-null completed_at", () => {
    const rows = [
      { completed_at: "2026-01-01T00:00:00Z", released: true },
      { completed_at: null, released: false },
      { completed_at: "2026-01-02T00:00:00Z", released: false },
      {} // missing completed_at => not graded
    ];
    expect(computeGradingCounts(rows)).toEqual({ total: 4, graded: 2, released: 1, notReleased: 3 });
  });

  it("treats only released === true as released (null/undefined are not released)", () => {
    const rows = [{ released: true }, { released: false }, { released: null }, {}];
    const counts = computeGradingCounts(rows);
    expect(counts.released).toBe(1);
    expect(counts.notReleased).toBe(3);
  });
});

describe("buildScoreHistogram", () => {
  it("returns an empty array when there are no numeric values", () => {
    expect(buildScoreHistogram([null, undefined, NaN, Infinity])).toEqual([]);
  });

  it("buckets by rounded integer and sorts ascending", () => {
    expect(buildScoreHistogram([90.4, 90.6, 80, 80, 100])).toEqual([
      { name: "80", value: 2 },
      { name: "90", value: 1 },
      { name: "91", value: 1 },
      { name: "100", value: 1 }
    ]);
  });

  it("ignores missing values but keeps zero", () => {
    expect(buildScoreHistogram([0, null, 0, undefined])).toEqual([{ name: "0", value: 2 }]);
  });
});

describe("collectSectionOptions", () => {
  it("returns distinct, sorted class and lab names, ignoring nullish", () => {
    const rows = [
      { class_section_name: "B", lab_section_name: "Lab 2" },
      { class_section_name: "A", lab_section_name: null },
      { class_section_name: "B", lab_section_name: "Lab 1" },
      { class_section_name: null, lab_section_name: "Lab 1" }
    ];
    expect(collectSectionOptions(rows)).toEqual({
      classSections: ["A", "B"],
      labSections: ["Lab 1", "Lab 2"]
    });
  });

  it("returns empty arrays when no sections are present", () => {
    expect(collectSectionOptions([{}, {}])).toEqual({ classSections: [], labSections: [] });
  });
});

describe("filterRowsBySection", () => {
  const rows = [
    { class_section_name: "A", lab_section_name: "Lab 1" },
    { class_section_name: "B", lab_section_name: "Lab 1" },
    { class_section_name: "A", lab_section_name: "Lab 2" }
  ];

  it("returns all rows for the ALL filter", () => {
    expect(filterRowsBySection(rows, ALL_SECTIONS_FILTER)).toBe(rows);
  });

  it("filters by class section", () => {
    expect(filterRowsBySection(rows, "class:A")).toEqual([
      { class_section_name: "A", lab_section_name: "Lab 1" },
      { class_section_name: "A", lab_section_name: "Lab 2" }
    ]);
  });

  it("filters by lab section", () => {
    expect(filterRowsBySection(rows, "lab:Lab 1")).toEqual([
      { class_section_name: "A", lab_section_name: "Lab 1" },
      { class_section_name: "B", lab_section_name: "Lab 1" }
    ]);
  });

  it("handles section names that contain a colon (only the first colon delimits)", () => {
    const colonRows = [{ class_section_name: "Section: Honors" }, { class_section_name: "Regular" }];
    expect(filterRowsBySection(colonRows, "class:Section: Honors")).toEqual([
      { class_section_name: "Section: Honors" }
    ]);
  });

  it("returns all rows for an unrecognized filter kind", () => {
    expect(filterRowsBySection(rows, "bogus:value")).toEqual(rows);
    expect(filterRowsBySection(rows, "no-delimiter")).toEqual(rows);
  });
});
