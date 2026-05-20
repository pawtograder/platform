import { HydratedRubricToYamlRubric } from "@/lib/rubric/serialize";
import { YamlRubricToHydratedRubric } from "@/lib/rubric/parse";
import { HydratedRubric, YmlRubricType } from "@/utils/supabase/DatabaseTypes";
import { FIXTURE_NAMES, loadFixtureAsYaml } from "./fixtures";

function roundTripYaml(yaml: YmlRubricType): YmlRubricType {
  const hydrated = YamlRubricToHydratedRubric(yaml, {
    assignment_id: 0,
    is_private: false,
    review_round: "grading-review"
  });
  return HydratedRubricToYamlRubric(hydrated);
}

describe("HydratedRubricToYamlRubric — empty rubric", () => {
  it("round-trips a no-parts rubric to a stable YAML shape", () => {
    const initial: YmlRubricType = { name: "Empty", parts: [] };
    const once = roundTripYaml(initial);
    const twice = roundTripYaml(once);
    expect(twice).toEqual(once);
    expect(once.name).toBe("Empty");
    expect(once.parts).toEqual([]);
  });
});

describe("HydratedRubricToYamlRubric — round-trip on CSV fixtures", () => {
  // The first parse normalizes ordinals + default fields; the second pass should be a fixed point.
  it.each(FIXTURE_NAMES)("reaches a fixed point after one normalization pass: %s", (name) => {
    const yaml = loadFixtureAsYaml(name);
    const once = roundTripYaml(yaml);
    const twice = roundTripYaml(once);
    expect(twice).toEqual(once);
  });

  it("preserves data.options on multi-option checks", () => {
    const yaml = loadFixtureAsYaml("multi_option_check");
    const once = roundTripYaml(yaml);
    let foundOptions = false;
    for (const part of once.parts) {
      for (const crit of part.criteria) {
        for (const ch of crit.checks) {
          if (ch.data && Array.isArray(ch.data.options) && ch.data.options.length >= 2) {
            foundOptions = true;
            for (const opt of ch.data.options) {
              expect(typeof opt.label).toBe("string");
              expect(typeof opt.points).toBe("number");
            }
          }
        }
      }
    }
    expect(foundOptions).toBe(true);
  });

  it("preserves is_deduction_only and is_comment_required + max_annotations", () => {
    const yaml = loadFixtureAsYaml("deduction_only");
    const once = roundTripYaml(yaml);
    let deductionSeen = false;
    let commentRequiredSeen = false;
    let maxAnnotationsSeen = false;
    for (const part of once.parts) {
      for (const crit of part.criteria) {
        if (crit.is_deduction_only) deductionSeen = true;
        for (const ch of crit.checks) {
          if (ch.is_comment_required) commentRequiredSeen = true;
          if (ch.max_annotations !== undefined) maxAnnotationsSeen = true;
        }
      }
    }
    expect(deductionSeen).toBe(true);
    expect(commentRequiredSeen).toBe(true);
    expect(maxAnnotationsSeen).toBe(true);
  });

  it("preserves min/max_checks_per_submission for met/partial criteria", () => {
    const yaml = loadFixtureAsYaml("met_partial");
    const once = roundTripYaml(yaml);
    let found11 = false;
    for (const part of once.parts) {
      for (const crit of part.criteria) {
        if (crit.min_checks_per_submission === 1 && crit.max_checks_per_submission === 1) found11 = true;
      }
    }
    expect(found11).toBe(true);
  });

  it("preserves is_individual_grading on the relevant part", () => {
    const yaml = loadFixtureAsYaml("individual_grading");
    const once = roundTripYaml(yaml);
    expect(once.parts.some((p) => p.is_individual_grading)).toBe(true);
    expect(once.parts.every((p) => !(p.is_individual_grading && p.is_assign_to_student))).toBe(true);
  });

  it("preserves is_assign_to_student on the relevant part", () => {
    const yaml = loadFixtureAsYaml("assign_to_student");
    const once = roundTripYaml(yaml);
    expect(once.parts.some((p) => p.is_assign_to_student)).toBe(true);
  });
});

describe("HydratedRubricToYamlRubric — references emission", () => {
  function rubricWithCheck(
    id: number,
    reviewRound: HydratedRubric["review_round"],
    checkId: number,
    checkName: string
  ): HydratedRubric {
    return {
      id,
      class_id: 0,
      created_at: "",
      name: `R${id}`,
      description: null,
      assignment_id: 1,
      is_private: false,
      review_round: reviewRound,
      cap_score_to_assignment_points: false,
      rubric_parts: [
        {
          id: id * 10,
          name: "P",
          description: null,
          ordinal: 0,
          rubric_id: id,
          class_id: 0,
          created_at: "",
          assignment_id: 1,
          is_individual_grading: false,
          is_assign_to_student: false,
          rubric_criteria: [
            {
              id: id * 100,
              name: "C",
              description: null,
              is_deduction_only: false,
              ordinal: 0,
              rubric_id: id,
              assignment_id: 1,
              class_id: 0,
              created_at: "",
              data: null,
              rubric_part_id: id * 10,
              is_additive: false,
              total_points: 0,
              max_checks_per_submission: null,
              min_checks_per_submission: null,
              rubric_checks: [
                {
                  id: checkId,
                  name: checkName,
                  description: null,
                  ordinal: 0,
                  rubric_id: id,
                  assignment_id: 1,
                  class_id: 0,
                  created_at: "",
                  data: null,
                  rubric_criteria_id: id * 100,
                  file: null,
                  artifact: null,
                  group: null,
                  is_annotation: false,
                  is_comment_required: false,
                  is_required: false,
                  max_annotations: null,
                  points: 1,
                  annotation_target: null,
                  student_visibility: "always",
                  kpi_category: null
                }
              ]
            }
          ]
        }
      ]
    };
  }

  it("emits references in name-keyed form when unambiguous", () => {
    const target = rubricWithCheck(1, "self-review", 101, "Foo");
    // Attach a reference from a check in rubric 2 → rubric 1's check 101.
    const owner = rubricWithCheck(2, "grading-review", 201, "Bar");
    owner.rubric_parts[0].rubric_criteria[0].rubric_checks[0].references = [{ referenced_rubric_check_id: 101 }];
    const yaml = HydratedRubricToYamlRubric(owner, { allRubrics: [owner, target] });
    expect(yaml.parts[0].criteria[0].checks[0].references).toEqual([
      { review_round: "self-review", part: "P", criterion: "C", check: "Foo" }
    ]);
  });

  it("emits id form when name is ambiguous", () => {
    const target = rubricWithCheck(1, "self-review", 101, "Foo");
    // Add a duplicate-named check in the same criterion.
    target.rubric_parts[0].rubric_criteria[0].rubric_checks.push({
      ...target.rubric_parts[0].rubric_criteria[0].rubric_checks[0],
      id: 102
    });
    const owner = rubricWithCheck(2, "grading-review", 201, "Bar");
    owner.rubric_parts[0].rubric_criteria[0].rubric_checks[0].references = [{ referenced_rubric_check_id: 102 }];
    const yaml = HydratedRubricToYamlRubric(owner, { allRubrics: [owner, target] });
    expect(yaml.parts[0].criteria[0].checks[0].references).toEqual([{ id: 102 }]);
  });

  it("omits references when none are attached", () => {
    const owner = rubricWithCheck(2, "grading-review", 201, "Bar");
    const yaml = HydratedRubricToYamlRubric(owner, { allRubrics: [owner] });
    expect(yaml.parts[0].criteria[0].checks[0].references).toBeUndefined();
  });
});

describe("HydratedRubricToYamlRubric — sort by ordinal", () => {
  it("emits parts/criteria/checks ordered by ordinal", () => {
    const rubric: HydratedRubric = {
      id: 0,
      class_id: 0,
      created_at: "",
      name: "Ordered",
      description: null,
      assignment_id: 0,
      is_private: false,
      review_round: "grading-review",
      cap_score_to_assignment_points: false,
      rubric_parts: [
        {
          id: 1,
          name: "B",
          description: null,
          ordinal: 1,
          rubric_id: 0,
          class_id: 0,
          created_at: "",
          data: undefined,
          assignment_id: 0,
          is_individual_grading: false,
          is_assign_to_student: false,
          rubric_criteria: []
        },
        {
          id: 2,
          name: "A",
          description: null,
          ordinal: 0,
          rubric_id: 0,
          class_id: 0,
          created_at: "",
          data: undefined,
          assignment_id: 0,
          is_individual_grading: false,
          is_assign_to_student: false,
          rubric_criteria: []
        }
      ]
    };
    const yaml = HydratedRubricToYamlRubric(rubric);
    expect(yaml.parts.map((p) => p.name)).toEqual(["A", "B"]);
  });
});
