import type { AssignmentController } from "@/hooks/useAssignment";
import type { HydratedRubric, Rubric, RubricPart, RubricCriteria, RubricCheck } from "@/utils/supabase/DatabaseTypes";
import type TableController from "@/lib/TableController";
import { TablesThatHaveAnIDField } from "@/lib/TableController";

/**
 * Flattens a HydratedRubric into normalized arrays suitable for TableController preview
 *
 * Ensures all foreign keys are correctly set to match the parent rubric's ID,
 * which is critical for hook predicates to work correctly.
 */
export function flattenHydratedRubric(hydrated: HydratedRubric) {
  const rubric: Rubric = {
    id: hydrated.id,
    name: hydrated.name,
    description: hydrated.description,
    assignment_id: hydrated.assignment_id,
    class_id: hydrated.class_id,
    is_private: hydrated.is_private,
    review_round: hydrated.review_round,
    created_at: hydrated.created_at
  };

  const parts: RubricPart[] = [];
  const criteria: RubricCriteria[] = [];
  const checks: RubricCheck[] = [];

  for (const part of hydrated.rubric_parts) {
    parts.push({
      id: part.id,
      name: part.name,
      description: part.description,
      ordinal: part.ordinal,
      data: part.data ?? null,
      rubric_id: hydrated.id, // Use parent rubric's ID
      class_id: hydrated.class_id,
      assignment_id: hydrated.assignment_id,
      created_at: part.created_at
    });

    for (const crit of part.rubric_criteria) {
      criteria.push({
        id: crit.id,
        name: crit.name,
        description: crit.description,
        ordinal: crit.ordinal,
        data: crit.data ?? null,
        is_additive: crit.is_additive,
        total_points: crit.total_points,
        max_checks_per_submission: crit.max_checks_per_submission,
        min_checks_per_submission: crit.min_checks_per_submission,
        rubric_id: hydrated.id, // Use parent rubric's ID
        rubric_part_id: part.id,
        class_id: hydrated.class_id,
        assignment_id: hydrated.assignment_id,
        created_at: crit.created_at
      });

      for (const check of crit.rubric_checks) {
        checks.push({
          id: check.id,
          name: check.name,
          description: check.description,
          ordinal: check.ordinal,
          data: check.data ?? null,
          file: check.file,
          artifact: check.artifact,
          group: check.group,
          is_annotation: check.is_annotation,
          is_comment_required: check.is_comment_required,
          is_required: check.is_required,
          max_annotations: check.max_annotations,
          points: check.points,
          annotation_target: check.annotation_target,
          student_visibility: check.student_visibility ?? "always",
          rubric_id: hydrated.id, // Use parent rubric's ID
          rubric_criteria_id: crit.id,
          class_id: hydrated.class_id,
          assignment_id: hydrated.assignment_id,
          created_at: check.created_at
        });
      }
    }
  }

  return { rubric, parts, criteria, checks };
}

/**
 * Creates a preview-aware TableController wrapper
 */
function createPreviewTableController<TTableName extends TablesThatHaveAnIDField, TData extends { id: number }>(
  originalController: TableController<TTableName>,
  previewData: TData[]
): TableController<TTableName> {
  // Cache overridden methods to maintain stable references
  const overrides = {
    rows: previewData,
    getById: (id: number, callback?: (data: TData | undefined) => void) => {
      const data = previewData.find((item) => item.id === id);
      if (callback) callback(data);
      return { data, unsubscribe: () => {} };
    },
    list: (callback?: (data: TData[], params: { entered: TData[]; left: TData[] }) => void) => {
      // In preview mode, data is static - no items entering or leaving
      if (callback) callback(previewData, { entered: [], left: [] });
      return { data: previewData, unsubscribe: () => {} };
    }
  };

  // Create a proxy that intercepts method calls
  return new Proxy(originalController, {
    get(target, prop) {
      // Return cached override if it exists
      if (prop in overrides) {
        return overrides[prop as keyof typeof overrides];
      }

      // For all other properties, return the original
      return target[prop as keyof typeof target];
    }
  });
}

/**
 * Creates a specialized AssignmentController for preview mode
 *
 * This factory function wraps a base AssignmentController with preview data
 * for rubric-related queries while maintaining access to other assignment data
 * (submissions, review assignments, etc).
 *
 * IMPORTANT: Merges preview rubric with existing rubrics from database so that
 * all rubrics are available (needed for references, multi-rubric displays, etc.)
 */
export function createPreviewAssignmentController(
  baseController: AssignmentController,
  previewRubricData: HydratedRubric
): AssignmentController {
  const flattened = flattenHydratedRubric(previewRubricData);

  // Get existing data from base controller
  const existingRubrics = baseController.rubricsController.rows;
  const existingParts = baseController.rubricPartsController.rows;
  const existingCriteria = baseController.rubricCriteriaController.rows;
  const existingChecks = baseController.rubricChecksController.rows;

  // Merge preview data with existing data
  // Replace existing rubric with same ID, or add new preview rubric
  const mergedRubrics = [...existingRubrics.filter((r) => r.id !== flattened.rubric.id), flattened.rubric];
  console.log(mergedRubrics);

  // Replace parts/criteria/checks that belong to preview rubric
  const mergedParts = [...existingParts.filter((p) => p.rubric_id !== flattened.rubric.id), ...flattened.parts];

  const mergedCriteria = [
    ...existingCriteria.filter((c) => c.rubric_id !== flattened.rubric.id),
    ...flattened.criteria
  ];

  const mergedChecks = [...existingChecks.filter((ch) => ch.rubric_id !== flattened.rubric.id), ...flattened.checks];

  // Cache wrapped controllers to maintain stable references
  // Note: rubricCheckReferencesController uses live data (no preview references)
  const wrappedControllers = {
    rubricsController: createPreviewTableController(baseController.rubricsController, mergedRubrics),
    rubricPartsController: createPreviewTableController(baseController.rubricPartsController, mergedParts),
    rubricCriteriaController: createPreviewTableController(baseController.rubricCriteriaController, mergedCriteria),
    rubricChecksController: createPreviewTableController(baseController.rubricChecksController, mergedChecks),
    // Use live controller for references - they don't have preview data anyway
    rubricCheckReferencesController: baseController.rubricCheckReferencesController
  };

  // Create wrapped controller that returns preview data for rubric queries
  return new Proxy(baseController, {
    get(target, prop) {
      // Return cached wrapped controller if available
      if (prop in wrappedControllers) {
        return wrappedControllers[prop as keyof typeof wrappedControllers];
      }

      // All other properties pass through
      return target[prop as keyof typeof target];
    }
  });
}
