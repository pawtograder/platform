/**
 * Deno-side reference resolver/serializer for the CLI rubric import/export
 * commands. Mirrors `lib/rubric/references.ts` from the Next.js app — kept in
 * sync logically (same disambiguation rules), but duplicated because the CLI
 * runs in Deno and cannot share Node-targeted modules.
 *
 * Resolution rules (must match `lib/rubric/references.ts`):
 *  - Prefer `id` when it resolves to a real check.
 *  - Otherwise match on (review_round, part, criterion, check) names.
 *  - Reject same-round targets (cross-round references only).
 *  - Each reference must resolve to exactly one target check.
 */

import type { RubricWithHierarchy } from "../types.ts";
import type { IndexedCheck, ResolveOutcome, YamlReference } from "../../_shared/FunctionTypes.d.ts";

export type { IndexedCheck, ResolveOutcome, YamlReference };

export function indexAssignmentRubrics(rubrics: RubricWithHierarchy[]): IndexedCheck[] {
  const out: IndexedCheck[] = [];
  for (const rubric of rubrics) {
    for (const part of rubric.rubric_parts ?? []) {
      for (const crit of part.rubric_criteria ?? []) {
        for (const check of crit.rubric_checks ?? []) {
          out.push({
            checkId: check.id,
            checkName: check.name,
            partName: part.name,
            criterionName: crit.name,
            reviewRound: rubric.review_round,
            rubricId: rubric.id,
            assignmentId: rubric.assignment_id,
            classId: rubric.class_id
          });
        }
      }
    }
  }
  return out;
}

function describeReference(ref: YamlReference): string {
  if (ref.id !== undefined) return `id ${ref.id}`;
  const parts: string[] = [];
  if (ref.review_round) parts.push(ref.review_round);
  if (ref.part) parts.push(`part "${ref.part}"`);
  if (ref.criterion) parts.push(`criterion "${ref.criterion}"`);
  if (ref.check) parts.push(`check "${ref.check}"`);
  return parts.length > 0 ? parts.join(" > ") : "(empty reference)";
}

/**
 * Serialize a list of `rubric_check_references` rows for one check into the
 * YAML-friendly `references` array. Prefers the name-keyed form; falls back to
 * `{ id }` when the target check name path is ambiguous across the indexed
 * rubrics, or the target check is not present in the index at all.
 */
export function serializeReferencesForExport(
  refs: Array<{ referenced_rubric_check_id: number }>,
  indexed: IndexedCheck[]
): YamlReference[] {
  if (!refs || refs.length === 0) return [];
  const out: YamlReference[] = [];
  for (const ref of refs) {
    const targetId = ref.referenced_rubric_check_id;
    const target = indexed.find((ic) => ic.checkId === targetId);
    if (!target) {
      out.push({ id: targetId });
      continue;
    }
    const sameName = indexed.filter(
      (ic) =>
        ic.reviewRound === target.reviewRound &&
        ic.partName === target.partName &&
        ic.criterionName === target.criterionName &&
        ic.checkName === target.checkName
    );
    if (sameName.length > 1) {
      out.push({ id: targetId });
      continue;
    }
    const entry: YamlReference = {
      part: target.partName,
      criterion: target.criterionName,
      check: target.checkName
    };
    if (target.reviewRound) entry.review_round = target.reviewRound;
    out.push(entry);
  }
  return out;
}

/**
 * Resolve a single YAML reference against the indexed checks of an assignment.
 * `currentReviewRound` is the review_round of the rubric that owns the
 * referencing check — same-round targets are rejected.
 */
export function resolveYamlReference(
  ref: YamlReference,
  indexed: IndexedCheck[],
  currentReviewRound: string | null
): ResolveOutcome {
  let target: IndexedCheck | undefined;

  if (ref.id !== undefined) {
    target = indexed.find((ic) => ic.checkId === ref.id);
    if (!target) {
      return { ok: false, reason: `Reference ${describeReference(ref)} did not resolve to a known check.` };
    }
  } else {
    const matches = indexed.filter((ic) => {
      if (ref.review_round && ic.reviewRound !== ref.review_round) return false;
      if (ref.part && ic.partName !== ref.part) return false;
      if (ref.criterion && ic.criterionName !== ref.criterion) return false;
      if (ref.check && ic.checkName !== ref.check) return false;
      return ref.review_round || ref.part || ref.criterion || ref.check ? true : false;
    });
    if (matches.length === 1) {
      target = matches[0];
    } else if (matches.length > 1) {
      return {
        ok: false,
        reason: `Reference ${describeReference(ref)} is ambiguous — matches ${matches.length} checks.`
      };
    } else {
      return { ok: false, reason: `Reference ${describeReference(ref)} did not resolve to a known check.` };
    }
  }

  if (target.reviewRound === currentReviewRound) {
    return {
      ok: false,
      reason: `Reference ${describeReference(ref)} targets the same review round (${target.reviewRound ?? "null"}) — references must be cross-round.`
    };
  }

  return { ok: true, target };
}
