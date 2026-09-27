/**
 * @jest-environment node
 */

/**
 * The CLI's rubric row ↔ YAML ↔ RPC-payload mapping.
 *
 * This is the regression net for the bug that motivated the whole change: export and
 * import each kept their own hand-written field list, and both were missing the same
 * seven fields — `hide_unless_assigned`, `part.data`, `is_individual_grading`,
 * `is_assign_to_student`, `criteria.data`, `check.data`, `kpi_category`. An
 * export → import round-trip therefore downgraded per-student grading parts to
 * regular grading, collapsing every group member's grade to the shared total. Nothing
 * errored; the grades were simply wrong afterwards.
 *
 * The completeness guard below is the part that stops it recurring: it fails when a
 * column is added to a row shape and not deliberately mapped or excluded.
 */

import {
  buildUpdateRubricFullPayload,
  planRubricImport,
  rubricPathKey,
  rubricTreeToYaml,
  validateRubricYaml,
  type RubricCheckRowLike,
  type RubricTreeLike,
  type RubricYaml
} from "../../../supabase/functions/_shared/rubricYaml";
import { loadFixtureRaw } from "./fixtures";

const SOURCE = {
  class_id: 1,
  assignment_id: 2,
  rubric_id: 3,
  review_round: "grading-review",
  exported_at: "2026-08-03T00:00:00.000Z"
};

/** Every field set to a distinguishable non-default value. */
function fullCheck(overrides: Partial<RubricCheckRowLike> = {}): RubricCheckRowLike {
  return {
    id: 500,
    name: "check-a",
    description: "check description",
    ordinal: 0,
    points: 7,
    is_annotation: true,
    is_comment_required: true,
    is_required: true,
    annotation_target: "artifact",
    artifact: "build.log",
    file: "src/Main.java",
    group: "group-1",
    max_annotations: 4,
    student_visibility: "if_released",
    kpi_category: "commits",
    data: { options: [{ label: "half", points: 3 }] },
    ...overrides
  };
}

function fullTree(): RubricTreeLike {
  return {
    id: 3,
    name: "Grading rubric",
    description: "rubric description",
    is_private: true,
    review_round: "grading-review",
    cap_score_to_assignment_points: true,
    hide_unless_assigned: true,
    rubric_parts: [
      {
        id: 100,
        name: "part-a",
        description: "part description",
        ordinal: 0,
        data: { partKey: "partValue" },
        is_individual_grading: true,
        is_assign_to_student: false,
        rubric_criteria: [
          {
            id: 300,
            name: "criteria-a",
            description: "criteria description",
            ordinal: 0,
            total_points: 10,
            is_additive: true,
            is_deduction_only: true,
            min_checks_per_submission: 1,
            max_checks_per_submission: 2,
            data: { critKey: "critValue" },
            rubric_checks: [fullCheck()]
          }
        ]
      },
      {
        id: 101,
        name: "part-b",
        description: null,
        ordinal: 1,
        data: null,
        is_individual_grading: false,
        is_assign_to_student: true,
        rubric_criteria: []
      }
    ]
  };
}

describe("rubricTreeToYaml", () => {
  it("carries every field that the old export dropped", () => {
    const yaml = rubricTreeToYaml(fullTree(), new Map(), SOURCE);

    expect(yaml.hide_unless_assigned).toBe(true);
    expect(yaml.parts[0].data).toEqual({ partKey: "partValue" });
    expect(yaml.parts[0].is_individual_grading).toBe(true);
    expect(yaml.parts[1].is_assign_to_student).toBe(true);
    expect(yaml.parts[0].criteria[0].data).toEqual({ critKey: "critValue" });
    expect(yaml.parts[0].criteria[0].checks[0].data).toEqual({ options: [{ label: "half", points: 3 }] });
    expect(yaml.parts[0].criteria[0].checks[0].kpi_category).toBe("commits");
  });

  it("emits ids so a round-trip preserves check identity", () => {
    const yaml = rubricTreeToYaml(fullTree(), new Map(), SOURCE);
    expect(yaml.parts[0].id).toBe(100);
    expect(yaml.parts[0].criteria[0].id).toBe(300);
    expect(yaml.parts[0].criteria[0].checks[0].id).toBe(500);
    expect(yaml._source).toEqual(SOURCE);
  });

  it("sorts children by ordinal rather than trusting embed order", () => {
    const tree = fullTree();
    // PostgREST embed order is unspecified; simulate it arriving reversed.
    tree.rubric_parts = [tree.rubric_parts![1], tree.rubric_parts![0]];
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    expect(yaml.parts.map((p) => p.name)).toEqual(["part-a", "part-b"]);
  });

  it("attaches references only where they exist", () => {
    const refs = new Map([[500, [{ review_round: "self-review", check: "other" }]]]);
    const yaml = rubricTreeToYaml(fullTree(), refs, SOURCE);
    expect(yaml.parts[0].criteria[0].checks[0].references).toEqual([{ review_round: "self-review", check: "other" }]);
  });
});

describe("field mapping completeness", () => {
  // The guard. Bug A happened because nothing forced these lists to be maintained,
  // so adding a column silently meant "not exported, not imported".
  const CHECK_MAPPED = [
    "id",
    "name",
    "description",
    "ordinal",
    "points",
    "is_annotation",
    "is_comment_required",
    "is_required",
    "annotation_target",
    "artifact",
    "file",
    "group",
    "max_annotations",
    "student_visibility",
    "kpi_category",
    "data"
  ];

  it("maps every field on a check row", () => {
    const yaml = rubricTreeToYaml(fullTree(), new Map(), SOURCE);
    const yamlCheck = yaml.parts[0].criteria[0].checks[0] as unknown as Record<string, unknown>;
    for (const field of Object.keys(fullCheck())) {
      expect(CHECK_MAPPED).toContain(field);
      expect(Object.prototype.hasOwnProperty.call(yamlCheck, field)).toBe(true);
    }
  });

  it("carries every mapped check field through to the RPC payload", () => {
    const tree = fullTree();
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    const validated = validateRubricYaml(yaml);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const payload = buildUpdateRubricFullPayload({
      yaml: validated.value,
      rubricId: 3,
      classId: 1,
      assignmentId: 2,
      reviewRound: "grading-review",
      existing: tree,
      resolvedRefsByPath: new Map()
    });

    const check = payload.parts[0].criteria[0].checks[0];
    const original = fullCheck();
    expect(check.id).toBe(original.id);
    expect(check.name).toBe(original.name);
    expect(check.points).toBe(original.points);
    expect(check.kpi_category).toBe(original.kpi_category);
    expect(check.data).toEqual(original.data);
    expect(check.group).toBe(original.group);
    expect(check.student_visibility).toBe(original.student_visibility);
    expect(check.annotation_target).toBe(original.annotation_target);
    expect(check.max_annotations).toBe(original.max_annotations);

    expect(payload.parts[0].is_individual_grading).toBe(true);
    expect(payload.parts[1].is_assign_to_student).toBe(true);
    expect(payload.hide_unless_assigned).toBe(true);
  });
});

describe("buildUpdateRubricFullPayload defaults", () => {
  const base = { rubricId: 3, classId: 1, assignmentId: 2, reviewRound: "grading-review" as string | null };
  const existing = { cap_score_to_assignment_points: true, is_private: true, hide_unless_assigned: true };
  const minimal: RubricYaml = { name: "r", parts: [] };

  it("carries the current value forward for the tri-state rubric flags", () => {
    // The old import defaulted cap to `true` while the web and RPC default it to
    // `false`, and the RPC's own COALESCE would flip a private rubric public if an
    // absent key reached it. Absent must mean "unchanged".
    const payload = buildUpdateRubricFullPayload({
      ...base,
      yaml: minimal,
      existing,
      resolvedRefsByPath: new Map()
    });
    expect(payload.cap_score_to_assignment_points).toBe(true);
    expect(payload.is_private).toBe(true);
    expect(payload.hide_unless_assigned).toBe(true);
  });

  it("honours an explicit false rather than swallowing it", () => {
    const payload = buildUpdateRubricFullPayload({
      ...base,
      yaml: { ...minimal, cap_score_to_assignment_points: false, is_private: false, hide_unless_assigned: false },
      existing,
      resolvedRefsByPath: new Map()
    });
    expect(payload.cap_score_to_assignment_points).toBe(false);
    expect(payload.is_private).toBe(false);
    expect(payload.hide_unless_assigned).toBe(false);
  });

  it("defaults is_additive to false, matching the web and the RPC", () => {
    // The old import defaulted this to true, silently changing criteria behavior.
    const payload = buildUpdateRubricFullPayload({
      ...base,
      yaml: { name: "r", parts: [{ name: "p", criteria: [{ name: "c", checks: [{ name: "k" }] }] }] },
      existing,
      resolvedRefsByPath: new Map()
    });
    const criteria = payload.parts[0].criteria[0];
    expect(criteria.is_additive).toBe(false);
    expect(criteria.is_deduction_only).toBe(false);
    expect(criteria.total_points).toBe(0);
    expect(criteria.checks[0].student_visibility).toBe("always");
    expect(criteria.checks[0].points).toBe(0);
  });

  it("always sends the database's review_round, never the YAML's", () => {
    const payload = buildUpdateRubricFullPayload({
      ...base,
      reviewRound: "grading-review",
      yaml: { ...minimal, review_round: "self-review" },
      existing,
      resolvedRefsByPath: new Map()
    });
    expect(payload.review_round).toBe("grading-review");
  });

  it("omits ids that are not positive integers so the RPC inserts", () => {
    const payload = buildUpdateRubricFullPayload({
      ...base,
      yaml: {
        name: "r",
        parts: [{ id: -1, name: "p", criteria: [{ id: 0, name: "c", checks: [{ name: "k" }] }] }]
      },
      existing,
      resolvedRefsByPath: new Map()
    });
    expect(payload.parts[0].id).toBeUndefined();
    expect(payload.parts[0].criteria[0].id).toBeUndefined();
  });

  it("derives ordinal from array position", () => {
    const payload = buildUpdateRubricFullPayload({
      ...base,
      yaml: {
        name: "r",
        parts: [
          { name: "p1", ordinal: 99, criteria: [] },
          { name: "p2", ordinal: 5, criteria: [] }
        ]
      },
      existing,
      resolvedRefsByPath: new Map()
    });
    expect(payload.parts.map((p) => p.ordinal)).toEqual([0, 1]);
  });

  it("attaches resolved references by tree position", () => {
    const payload = buildUpdateRubricFullPayload({
      ...base,
      yaml: { name: "r", parts: [{ name: "p", criteria: [{ name: "c", checks: [{ name: "k" }] }] }] },
      existing,
      resolvedRefsByPath: new Map([[rubricPathKey(0, 0, 0), [901, 902]]])
    });
    expect(payload.parts[0].criteria[0].checks[0].references).toEqual([
      { referenced_rubric_check_id: 901 },
      { referenced_rubric_check_id: 902 }
    ]);
  });
});

describe("validateRubricYaml", () => {
  const ok = { name: "r", parts: [{ name: "p", criteria: [{ name: "c", checks: [{ name: "k" }] }] }] };

  it("rejects min_checks_per_submission greater than max_checks_per_submission", () => {
    // No number of applied checks satisfies both, so graders cannot complete a review
    // using the criterion and nothing says why. The web editor already refuses this.
    const result = validateRubricYaml({
      name: "r",
      parts: [
        {
          name: "p",
          criteria: [{ name: "c", min_checks_per_submission: 3, max_checks_per_submission: 2, checks: [{ name: "k" }] }]
        }
      ]
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.errors.some((e) => /min_checks_per_submission/.test(e.path))).toBe(true);
    expect(result.errors.some((e) => /cannot exceed/.test(e.message))).toBe(true);
  });

  it("accepts equal bounds, and a bound paired with null or absent", () => {
    const bounds = (min: number | null, max: number | null) => ({
      name: "r",
      parts: [
        {
          name: "p",
          criteria: [
            { name: "c", min_checks_per_submission: min, max_checks_per_submission: max, checks: [{ name: "k" }] }
          ]
        }
      ]
    });
    expect(validateRubricYaml(bounds(2, 2)).ok).toBe(true);
    expect(validateRubricYaml(bounds(5, null)).ok).toBe(true);
    expect(validateRubricYaml(bounds(null, 1)).ok).toBe(true);
  });

  it("accepts a minimal document and an already-exported one", () => {
    expect(validateRubricYaml(ok).ok).toBe(true);
    // Back-compat: the pre-existing field set, with no ids and none of the new fields.
    const legacy = {
      name: "r",
      description: null,
      cap_score_to_assignment_points: true,
      is_private: false,
      review_round: "grading-review",
      parts: [
        {
          name: "p",
          description: null,
          ordinal: 0,
          criteria: [
            {
              name: "c",
              description: null,
              ordinal: 0,
              total_points: 5,
              is_additive: true,
              is_deduction_only: false,
              min_checks_per_submission: null,
              max_checks_per_submission: null,
              checks: [{ name: "k", ordinal: 0, points: 5, is_annotation: false }]
            }
          ]
        }
      ]
    };
    expect(validateRubricYaml(legacy).ok).toBe(true);
  });

  it("rejects an id that is supplied but malformed, rather than treating it as absent", () => {
    // Folding these into "absent" made import create the row as new and delete the row
    // whose id the operator meant to keep.
    for (const badId of ["123", 123.5, 0, -1, null, true] as unknown[]) {
      const doc = {
        name: "r",
        parts: [{ name: "p", id: badId, criteria: [{ name: "c", checks: [{ name: "k" }] }] }]
      };
      const result = validateRubricYaml(doc);
      expect(result.ok).toBe(false);
      expect(result.ok ? [] : result.errors.map((e) => e.path)).toContain("parts[0].id");
    }
  });

  it("rejects malformed ids at criteria and check level too", () => {
    const doc = {
      name: "r",
      parts: [{ name: "p", criteria: [{ name: "c", id: "5", checks: [{ name: "k", id: 1.5 }] }] }]
    };
    const result = validateRubricYaml(doc);
    expect(result.ok).toBe(false);
    const paths = result.ok ? [] : result.errors.map((e) => e.path);
    expect(paths).toContain("parts[0].criteria[0].id");
    expect(paths).toContain("parts[0].criteria[0].checks[0].id");
  });

  it("treats an omitted id as new without complaint", () => {
    expect(validateRubricYaml(ok).ok).toBe(true);
    const explicitUndefined = {
      name: "r",
      parts: [{ name: "p", id: undefined, criteria: [{ name: "c", checks: [{ name: "k" }] }] }]
    };
    expect(validateRubricYaml(explicitUndefined).ok).toBe(true);
  });

  it("rejects an unknown field rather than treating the intended one as absent", () => {
    // `point` for `points` left points absent, which defaults to 0 — and
    // update_rubric_full cascades that zero into existing grading comments.
    const doc = {
      name: "r",
      parts: [{ name: "p", criteria: [{ name: "c", checks: [{ name: "k", point: 5 }] }] }]
    };
    const result = validateRubricYaml(doc);
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    expect(errors.map((e) => e.path)).toContain("parts[0].criteria[0].checks[0].point");
    expect(errors.map((e) => e.message).join(" ")).toMatch(/did you mean "points"/);
  });

  it("suggests the intended field for a misspelled flag", () => {
    const doc = {
      name: "r",
      parts: [{ name: "p", is_indvidual_grading: true, criteria: [{ name: "c", checks: [{ name: "k" }] }] }]
    };
    const result = validateRubricYaml(doc);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors.map((e) => e.message).join(" ")).toMatch(
      /did you mean "is_individual_grading"/
    );
  });

  it("rejects unknown fields at rubric, part and criteria level", () => {
    for (const doc of [
      { name: "r", parts: [], nonsense: 1 },
      { name: "r", parts: [{ name: "p", nonsense: 1, criteria: [] }] },
      { name: "r", parts: [{ name: "p", criteria: [{ name: "c", nonsense: 1, checks: [] }] }] }
    ]) {
      const result = validateRubricYaml(doc);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.errors.map((e) => e.message).join(" ")).toMatch(/unknown field "nonsense"/);
    }
  });

  it("accepts a top-level id, which exported documents carry", () => {
    // Ignored rather than rejected: the rubric written is the one --assignment and
    // --type resolve to, but a legitimate export has this field.
    expect(validateRubricYaml({ id: 42, ...ok }).ok).toBe(true);
  });

  it("rejects non-finite points, which JSON would flatten to null and then zero", () => {
    for (const points of [Infinity, -Infinity, NaN]) {
      const doc = {
        name: "r",
        parts: [{ name: "p", criteria: [{ name: "c", checks: [{ name: "k", points }] }] }]
      };
      const result = validateRubricYaml(doc);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.errors.map((e) => e.message).join(" ")).toMatch(/is not a finite number/);
    }
  });

  it("rejects a duplicate criteria id across different parts", () => {
    // The RPC keys rows by id, so one row would be updated and moved twice, surviving
    // only under whichever part came last.
    const doc = {
      name: "r",
      parts: [
        { name: "p1", criteria: [{ name: "c", id: 7, checks: [{ name: "k" }] }] },
        { name: "p2", criteria: [{ name: "c copy", id: 7, checks: [{ name: "k" }] }] }
      ]
    };
    const result = validateRubricYaml(doc);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors.map((e) => e.message).join(" ")).toMatch(/duplicate criteria id 7/);
  });

  it("rejects a duplicate check id across different criteria", () => {
    const doc = {
      name: "r",
      parts: [
        {
          name: "p",
          criteria: [
            { name: "c1", checks: [{ name: "k", id: 9 }] },
            { name: "c2", checks: [{ name: "k copy", id: 9 }] }
          ]
        }
      ]
    };
    const result = validateRubricYaml(doc);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors.map((e) => e.message).join(" ")).toMatch(/duplicate check id 9/);
  });

  it("rejects each bad enum by field path", () => {
    const bad = validateRubricYaml({
      name: "r",
      review_round: "grading",
      parts: [
        {
          name: "p",
          criteria: [
            {
              name: "c",
              checks: [{ name: "k", student_visibility: "if_release", kpi_category: "nope", annotation_target: "x" }]
            }
          ]
        }
      ]
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const paths = bad.errors.map((e) => e.path);
    expect(paths).toContain("review_round");
    expect(paths).toContain("parts[0].criteria[0].checks[0].student_visibility");
    expect(paths).toContain("parts[0].criteria[0].checks[0].kpi_category");
    expect(paths).toContain("parts[0].criteria[0].checks[0].annotation_target");
  });

  it("collects every error rather than stopping at the first", () => {
    const bad = validateRubricYaml({
      name: "",
      parts: [{ name: "", criteria: [{ name: "", checks: [{ name: "" }] }] }]
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects fractional integers with the reason named", () => {
    const bad = validateRubricYaml({
      name: "r",
      parts: [
        {
          name: "p",
          criteria: [{ name: "c", total_points: 2.5, checks: [{ name: "k", max_annotations: 1.5 }] }]
        }
      ]
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.some((e) => e.path.endsWith("total_points") && /integer/.test(e.message))).toBe(true);
    expect(bad.errors.some((e) => e.path.endsWith("max_annotations"))).toBe(true);
  });

  it("rejects negative points instead of silently making them positive", () => {
    const bad = validateRubricYaml({
      name: "r",
      parts: [{ name: "p", criteria: [{ name: "c", checks: [{ name: "k", points: -3 }] }] }]
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.some((e) => /negative/.test(e.message))).toBe(true);
  });

  it("rejects negative criterion total_points, which no scoring mode makes meaningful", () => {
    // total_points is a magnitude in all three modes: additive caps at it, the default
    // subtracts the applied checks from it, deduction-only floors at -total_points. A
    // negative value turns the deduction into a credit.
    // chk_rubric_criteria_total_points_non_negative rejects it in the DB as well.
    const bad = validateRubricYaml({
      name: "r",
      parts: [{ name: "p", criteria: [{ name: "c", total_points: -20, checks: [{ name: "k", points: 3 }] }] }]
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.some((e) => e.path === "parts[0].criteria[0].total_points" && /negative/.test(e.message))).toBe(
      true
    );
  });

  it("accepts zero total_points and a deduction-only criterion whose deductions are positive", () => {
    expect(
      validateRubricYaml({
        name: "r",
        parts: [
          {
            name: "p",
            criteria: [
              { name: "deductions", total_points: 20, is_deduction_only: true, checks: [{ name: "k", points: 3 }] },
              { name: "zero-weight", total_points: 0, checks: [{ name: "note", points: 0 }] }
            ]
          }
        ]
      }).ok
    ).toBe(true);
  });

  it("rejects the mutually exclusive grading modes the DB also forbids", () => {
    const bad = validateRubricYaml({
      name: "r",
      parts: [{ name: "p", is_individual_grading: true, is_assign_to_student: true, criteria: [] }]
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.some((e) => /mutually exclusive/.test(e.message))).toBe(true);
  });

  it("rejects duplicate ids at each level", () => {
    const bad = validateRubricYaml({
      name: "r",
      parts: [
        { id: 5, name: "p1", criteria: [] },
        { id: 5, name: "p2", criteria: [] }
      ]
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.some((e) => /duplicate part id 5/.test(e.message))).toBe(true);
  });

  it("warns rather than errors on an empty parts list", () => {
    const result = validateRubricYaml({ name: "r", parts: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => /every existing part will be removed/.test(w.message))).toBe(true);
  });
});

describe("planRubricImport", () => {
  const tree = fullTree();
  const payloadFor = (yaml: RubricYaml) =>
    buildUpdateRubricFullPayload({
      yaml,
      rubricId: 3,
      classId: 1,
      assignmentId: 2,
      reviewRound: "grading-review",
      existing: tree,
      resolvedRefsByPath: new Map()
    });

  it("reports an unchanged round-trip as all updates and no removals", () => {
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    const plan = planRubricImport(tree, payloadFor(yaml));
    expect(plan.parts.update.sort()).toEqual([100, 101]);
    expect(plan.parts.remove).toEqual([]);
    expect(plan.checks.remove).toEqual([]);
    expect(plan.checks.insert).toEqual([]);
    expect(plan.broad_change).toBe(false);
  });

  it("flags a part's grading mode change as broad", () => {
    // recompute_scores reads these flags through its criteria -> parts join to decide
    // whether a criterion's points land in the shared total, one student's total, or a
    // per-student assigned total. Flipping either rewrites every affected student's
    // totals, so a dry run that called it "no structural changes" was lying.
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    yaml.parts[0].is_individual_grading = !yaml.parts[0].is_individual_grading;
    const plan = planRubricImport(tree, payloadFor(yaml));
    expect(plan.parts_grading_mode_changed).toEqual([{ id: 100, name: "part-a" }]);
    expect(plan.broad_change).toBe(true);
  });

  it("flags an assign-to-student change as broad too", () => {
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    yaml.parts[0].is_assign_to_student = !yaml.parts[0].is_assign_to_student;
    const plan = planRubricImport(tree, payloadFor(yaml));
    expect(plan.parts_grading_mode_changed.map((p) => p.id)).toEqual([100]);
    expect(plan.broad_change).toBe(true);
  });

  it("flags a criterion kept by id but moved under a different part", () => {
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    // Move part-a's criterion, ids intact, under part-b.
    const moved = yaml.parts[0].criteria[0];
    yaml.parts[0].criteria = [];
    yaml.parts[1].criteria = [...(yaml.parts[1].criteria ?? []), moved];
    const plan = planRubricImport(tree, payloadFor(yaml));
    expect(plan.criteria_reparented.map((c) => c.id)).toEqual([moved.id]);
    // Still an update, not an insert-and-remove: the id is preserved.
    expect(plan.criteria.update).toContain(moved.id);
    expect(plan.criteria.remove).toEqual([]);
    // Nothing else is firing, so broad_change here is attributable to the move alone.
    expect(plan.criteria.insert).toEqual([]);
    expect(plan.parts.insert).toEqual([]);
    expect(plan.parts.remove).toEqual([]);
    expect(plan.checks.insert).toEqual([]);
    expect(plan.checks.remove).toEqual([]);
    expect(plan.checks.points_changed).toEqual([]);
    expect(plan.criteria_scoring_changed).toEqual([]);
    expect(plan.checks_reparented).toEqual([]);
    expect(plan.parts_grading_mode_changed).toEqual([]);
    expect(plan.broad_change).toBe(true);
  });

  it("does not flag a grading mode or parent that stayed the same", () => {
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    const plan = planRubricImport(tree, payloadFor(yaml));
    expect(plan.parts_grading_mode_changed).toEqual([]);
    expect(plan.criteria_reparented).toEqual([]);
    expect(plan.broad_change).toBe(false);
  });

  it("reports a removed check, and that it is a broad change", () => {
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    yaml.parts[0].criteria[0].checks = [];
    const plan = planRubricImport(tree, payloadFor(yaml));
    expect(plan.checks.remove).toEqual([{ id: 500, name: "check-a" }]);
    expect(plan.broad_change).toBe(true);
  });

  it("reports every row as removed for an empty parts list", () => {
    const plan = planRubricImport(tree, payloadFor({ name: "r", parts: [] }));
    expect(plan.parts.remove.map((p) => p.id).sort()).toEqual([100, 101]);
    expect(plan.criteria.remove).toHaveLength(1);
    expect(plan.checks.remove).toHaveLength(1);
  });

  it("flags foreign ids as inserts, which is the cross-rubric copy case", () => {
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    yaml.parts[0].id = 9999;
    yaml.parts[0].criteria[0].id = 8888;
    yaml.parts[0].criteria[0].checks[0].id = 7777;
    const plan = planRubricImport(tree, payloadFor(yaml));
    expect(plan.foreign_ids.map((f) => f.id).sort()).toEqual([7777, 8888, 9999]);
    expect(plan.checks.insert).toContain("check-a");
  });

  it("treats a stripped-id YAML as a full rebuild without flagging foreign ids", () => {
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    delete yaml.parts[0].id;
    delete yaml.parts[0].criteria[0].id;
    delete yaml.parts[0].criteria[0].checks[0].id;
    delete yaml.parts[1].id;
    const plan = planRubricImport(tree, payloadFor(yaml));
    expect(plan.foreign_ids).toEqual([]);
    expect(plan.parts.insert).toEqual(["part-a", "part-b"]);
    expect(plan.checks.remove).toEqual([{ id: 500, name: "check-a" }]);
  });

  it("reports a check moved to another criterion as a broad change", () => {
    // The recompute groups applied comments by the check's *current* criterion and uses
    // that criterion's additive/deduction/cap settings, so a move rescores the check even
    // with its points untouched. Reporting only point changes left total_score stale.
    const twoCriteria = fullTree();
    twoCriteria.rubric_parts![1].rubric_criteria = [
      {
        id: 301,
        name: "criteria-b",
        description: null,
        ordinal: 0,
        total_points: 4,
        is_additive: false,
        is_deduction_only: false,
        min_checks_per_submission: null,
        max_checks_per_submission: null,
        data: null,
        rubric_checks: []
      }
    ];
    const yaml = rubricTreeToYaml(twoCriteria, new Map(), SOURCE);
    // Move check 500 from criteria-a (300) to criteria-b (301), points unchanged.
    const moved = yaml.parts[0].criteria[0].checks.splice(0, 1);
    yaml.parts[1].criteria[0].checks.push(...moved);

    const plan = planRubricImport(
      twoCriteria,
      buildUpdateRubricFullPayload({
        yaml,
        rubricId: 3,
        classId: 1,
        assignmentId: 2,
        reviewRound: "grading-review",
        existing: twoCriteria,
        resolvedRefsByPath: new Map()
      })
    );
    expect(plan.checks_reparented).toEqual([{ id: 500, name: "check-a" }]);
    expect(plan.checks.points_changed).toEqual([]);
    expect(plan.checks.remove).toEqual([]);
    expect(plan.broad_change).toBe(true);
  });

  it("does not report a move when the check stays put", () => {
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    const plan = planRubricImport(tree, payloadFor(yaml));
    expect(plan.checks_reparented).toEqual([]);
    expect(plan.broad_change).toBe(false);
  });

  it("reports a points change with both values", () => {
    const yaml = rubricTreeToYaml(tree, new Map(), SOURCE);
    yaml.parts[0].criteria[0].checks[0].points = 9;
    const plan = planRubricImport(tree, payloadFor(yaml));
    expect(plan.checks.points_changed).toEqual([{ id: 500, name: "check-a", from: 7, to: 9 }]);
    expect(plan.broad_change).toBe(true);
  });
});

describe("the two fixtures whose loss collapses group grades", () => {
  // individual_grading.json and assign_to_student.json exist because these flags are
  // the ones that, when dropped, silently collapse every group member's grade to the
  // shared total. Read un-narrowed: the standard loader whitelists four keys.
  it.each(["individual_grading", "assign_to_student"])("round-trips %s through validation", (name) => {
    const raw = loadFixtureRaw(name);
    const result = validateRubricYaml(raw);
    expect(result.ok).toBe(true);
  });

  it("preserves the per-part grading flag from the fixture", () => {
    const raw = loadFixtureRaw("individual_grading") as { parts: Array<Record<string, unknown>> };
    const flagged = raw.parts.find((p) => p.is_individual_grading === true);
    expect(flagged).toBeDefined();

    const validated = validateRubricYaml(raw);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const payload = buildUpdateRubricFullPayload({
      yaml: validated.value,
      rubricId: 3,
      classId: 1,
      assignmentId: 2,
      reviewRound: "grading-review",
      existing: { cap_score_to_assignment_points: false, is_private: false, hide_unless_assigned: false },
      resolvedRefsByPath: new Map()
    });
    expect(payload.parts.some((p) => p.is_individual_grading)).toBe(true);
  });
});
