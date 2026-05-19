import { HydratedRubric, HydratedRubricCheck, RubricChecksDataType } from "@/utils/supabase/DatabaseTypes";

export type ValidationError = {
  path: string;
  message: string;
};

function hasOptionsData(
  data: HydratedRubricCheck["data"]
): data is HydratedRubricCheck["data"] & { options: RubricChecksDataType["options"] } {
  return (
    typeof data === "object" &&
    data !== null &&
    "options" in data &&
    Array.isArray((data as { options?: unknown }).options)
  );
}

/**
 * Walk an `HydratedRubric` and return a flat list of validation errors.
 *
 * Mirrors the throws in `lib/rubric/parse.ts` and `lib/rubric/validate.ts` so the
 * GUI editor surfaces the same problems the YAML pipeline catches at save time.
 */
export function validateRubric(rubric: HydratedRubric): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!rubric.name || rubric.name.trim() === "") {
    errors.push({ path: "rubric.name", message: "Rubric name is required." });
  }

  const partIdSeen = new Set<number>();
  const criteriaIdSeen = new Set<number>();
  const checkIdSeen = new Set<number>();

  rubric.rubric_parts.forEach((part, pIdx) => {
    const partPath = `parts[${pIdx}]`;
    if (!part.name || part.name.trim() === "") {
      errors.push({ path: `${partPath}.name`, message: "Part name is required." });
    }
    if (part.id && part.id > 0) {
      if (partIdSeen.has(part.id)) {
        errors.push({
          path: `${partPath}.id`,
          message: "Duplicate part id. Remove the id on copies to generate new ones."
        });
      }
      partIdSeen.add(part.id);
    }
    if (part.is_individual_grading && part.is_assign_to_student) {
      errors.push({
        path: `${partPath}.mode`,
        message: `Part "${part.name}" cannot have both is_individual_grading and is_assign_to_student enabled. Choose one mode.`
      });
    }
    if (part.rubric_criteria.length === 0) {
      errors.push({ path: `${partPath}.criteria`, message: "Part must have at least one criterion." });
    }

    part.rubric_criteria.forEach((criteria, cIdx) => {
      const critPath = `${partPath}.criteria[${cIdx}]`;
      if (!criteria.name || criteria.name.trim() === "") {
        errors.push({ path: `${critPath}.name`, message: "Criterion name is required." });
      }
      if (criteria.id && criteria.id > 0) {
        if (criteriaIdSeen.has(criteria.id)) {
          errors.push({
            path: `${critPath}.id`,
            message: "Duplicate criteria id. Remove the id on copies to generate new ones."
          });
        }
        criteriaIdSeen.add(criteria.id);
      }
      if (criteria.rubric_checks.length === 0) {
        errors.push({ path: `${critPath}.checks`, message: "Criteria must have at least one check." });
      }
      if (
        criteria.min_checks_per_submission != null &&
        criteria.max_checks_per_submission != null &&
        criteria.min_checks_per_submission > criteria.max_checks_per_submission
      ) {
        errors.push({
          path: `${critPath}.min_checks_per_submission`,
          message: "min_checks_per_submission cannot exceed max_checks_per_submission."
        });
      }

      criteria.rubric_checks.forEach((check, chIdx) => {
        const checkPath = `${critPath}.checks[${chIdx}]`;
        if (!check.name || check.name.trim() === "") {
          errors.push({ path: `${checkPath}.name`, message: "Check name is required." });
        }
        if (check.id && check.id > 0) {
          if (checkIdSeen.has(check.id)) {
            errors.push({
              path: `${checkPath}.id`,
              message: "Duplicate check id. Remove the id on copies to generate new ones."
            });
          }
          checkIdSeen.add(check.id);
        }
        if (hasOptionsData(check.data)) {
          const options = check.data.options;
          if (options.length === 1) {
            errors.push({
              path: `${checkPath}.data.options`,
              message: "Checks may not have only one option - they must have at least two options, or can have none."
            });
          }
          options.forEach((opt, oIdx) => {
            if (!opt.label) {
              errors.push({ path: `${checkPath}.data.options[${oIdx}].label`, message: "Option label is required." });
            }
            if (opt.points === undefined || opt.points === null) {
              errors.push({
                path: `${checkPath}.data.options[${oIdx}].points`,
                message: "Option points are required."
              });
            }
          });
        }
        if (check.is_annotation && (check.max_annotations == null || check.max_annotations <= 0)) {
          errors.push({
            path: `${checkPath}.max_annotations`,
            message: "Annotation checks should specify a positive max_annotations value."
          });
        }
      });
    });
  });

  return errors;
}
