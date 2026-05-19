export { valOrNull, valOrUndefined } from "@/lib/rubric/nullish";
export { rubricCheckDataOrThrow } from "@/lib/rubric/validate";
export {
  HydratedRubricToYamlRubric,
  hydratedRubricChecksToYamlRubric,
  hydratedRubricCriteriaToYamlRubric,
  hydratedRubricPartToYamlRubric
} from "@/lib/rubric/serialize";
export {
  YamlChecksToHydratedChecks,
  YamlCriteriaToHydratedCriteria,
  YamlPartsToHydratedParts,
  YamlRubricToHydratedRubric
} from "@/lib/rubric/parse";
export { findChanges, findUpdatedPropertyNames } from "@/lib/rubric/diff";
export { resolveReferences, serializeReferences } from "@/lib/rubric/references";
export type { ResolvedReference, ResolveContext } from "@/lib/rubric/references";
export {
  computeRubricMaxPoints,
  computeRubricPointsBreakdown,
  hasSplitGradingParts,
  maxPointsForCriterion
} from "@/lib/rubric/points";
export type { AssignToStudentPartSummary, RubricPointsBreakdown } from "@/lib/rubric/points";
