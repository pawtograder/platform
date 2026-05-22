import {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCheckReference,
  YamlReference
} from "@/utils/supabase/DatabaseTypes";

/**
 * A reference that has been resolved against a known set of rubrics. `id` is the
 * DB row id if this reference already exists; absent means the save flow should
 * create the row.
 */
export type ResolvedReference = {
  referenced_rubric_check_id: number;
  id?: number;
};

export type ResolveContext = {
  /** All other rubrics on the same assignment, hydrated with parts/criteria/checks. */
  otherRubrics: HydratedRubric[];
  /** Existing reference rows for the rubric currently being edited; used to round-trip the `id` field. */
  existingReferences?: HydratedRubricCheckReference[];
  /**
   * The review_round of the rubric whose check owns these references. Used to
   * reject same-round targets (cross-round references only).
   */
  currentReviewRound: HydratedRubric["review_round"];
};

type IndexedCheck = {
  check: HydratedRubricCheck;
  partName: string;
  criterionName: string;
  reviewRound: HydratedRubric["review_round"];
  rubricId: number;
};

function indexChecks(rubrics: HydratedRubric[]): IndexedCheck[] {
  const indexed: IndexedCheck[] = [];
  for (const rubric of rubrics) {
    for (const part of rubric.rubric_parts) {
      for (const crit of part.rubric_criteria) {
        for (const check of crit.rubric_checks) {
          indexed.push({
            check,
            partName: part.name,
            criterionName: crit.name,
            reviewRound: rubric.review_round,
            rubricId: rubric.id
          });
        }
      }
    }
  }
  return indexed;
}

function describeReference(ref: YamlReference): string {
  if (ref.id !== undefined) return `id ${ref.id}`;
  const parts: string[] = [];
  if (ref.review_round) parts.push(ref.review_round);
  if (ref.part) parts.push(`part "${ref.part}"`);
  if (ref.criterion) parts.push(`criterion "${ref.criterion}"`);
  if (ref.check) parts.push(`check "${ref.check}"`);
  return parts.length > 0 ? parts.join(" › ") : "(empty reference)";
}

/**
 * Resolve `references` parsed from YAML against the hydrated trees of the other
 * rubrics on the same assignment. Returns numeric `referenced_rubric_check_id`s
 * plus a list of human-readable error messages for unresolvable references.
 *
 * Resolution rules:
 *  - Prefer `id` when it resolves to a real check.
 *  - Otherwise match on (review_round, part, criterion, check) names.
 *  - Reject targets in the same review_round as the referencing check.
 *  - Each reference must resolve to exactly one target check.
 */
export function resolveReferences(
  refs: YamlReference[] | undefined,
  context: ResolveContext
): { resolved: ResolvedReference[]; errors: string[] } {
  if (!refs || refs.length === 0) return { resolved: [], errors: [] };

  const errors: string[] = [];
  const resolved: ResolvedReference[] = [];
  const indexed = indexChecks(context.otherRubrics);
  const existingByTarget = new Map<number, number>();
  for (const ex of context.existingReferences ?? []) {
    if (ex.id !== undefined) existingByTarget.set(ex.referenced_rubric_check_id, ex.id);
  }

  for (const ref of refs) {
    let target: IndexedCheck | undefined;

    if (ref.id !== undefined) {
      target = indexed.find((ic) => ic.check.id === ref.id);
    }
    if (!target) {
      const matches = indexed.filter((ic) => {
        if (ref.review_round && ic.reviewRound !== ref.review_round) return false;
        if (ref.part && ic.partName !== ref.part) return false;
        if (ref.criterion && ic.criterionName !== ref.criterion) return false;
        if (ref.check && ic.check.name !== ref.check) return false;
        return ref.review_round || ref.part || ref.criterion || ref.check ? true : false;
      });
      if (matches.length === 1) {
        target = matches[0];
      } else if (matches.length > 1) {
        errors.push(`Reference ${describeReference(ref)} is ambiguous — matches ${matches.length} checks.`);
        continue;
      }
    }

    if (!target) {
      errors.push(`Reference ${describeReference(ref)} did not resolve to a known check.`);
      continue;
    }

    if (target.reviewRound === context.currentReviewRound) {
      errors.push(
        `Reference ${describeReference(ref)} targets the same review round (${target.reviewRound}) — references must be cross-round.`
      );
      continue;
    }

    const resolvedRef: ResolvedReference = { referenced_rubric_check_id: target.check.id };
    const existingRowId = existingByTarget.get(target.check.id);
    if (existingRowId !== undefined) resolvedRef.id = existingRowId;
    resolved.push(resolvedRef);
  }

  return { resolved, errors };
}

/**
 * Emit YAML `YamlReference[]` for a set of resolved references, preferring the
 * name-keyed form. Falls back to `{ id }` only when the target name is ambiguous
 * across the hydrated rubrics, or the target check id can't be located at all.
 */
export function serializeReferences(
  refs: HydratedRubricCheckReference[] | ResolvedReference[] | undefined,
  allRubrics: HydratedRubric[]
): YamlReference[] {
  if (!refs || refs.length === 0) return [];
  const indexed = indexChecks(allRubrics);
  const out: YamlReference[] = [];
  for (const ref of refs) {
    const targetId = ref.referenced_rubric_check_id;
    const target = indexed.find((ic) => ic.check.id === targetId);
    if (!target) {
      out.push({ id: targetId });
      continue;
    }
    // Check whether the name path is unambiguous across rubrics.
    const sameName = indexed.filter(
      (ic) =>
        ic.reviewRound === target.reviewRound &&
        ic.partName === target.partName &&
        ic.criterionName === target.criterionName &&
        ic.check.name === target.check.name
    );
    if (sameName.length > 1) {
      out.push({ id: targetId });
      continue;
    }
    out.push({
      review_round: target.reviewRound ?? undefined,
      part: target.partName,
      criterion: target.criterionName,
      check: target.check.name
    });
  }
  return out;
}
