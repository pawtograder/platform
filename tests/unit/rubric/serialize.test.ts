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
