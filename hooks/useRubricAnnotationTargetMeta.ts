import { useRubricPartsQuery } from "@/hooks/assignment-data";
import { useAssignmentGroupWithMembers } from "@/hooks/useCourseController";
import { useProfilesQuery } from "@/hooks/course-data";
import { useSubmission } from "@/hooks/useSubmission";
import { useActiveSubmissionReview } from "@/hooks/useSubmissionReview";
import { useMemo } from "react";
import type {
  RubricCriteria,
  RubricPart,
  SubmissionFileComment,
  SubmissionReview
} from "@/utils/supabase/DatabaseTypes";

export type RubricAnnotationTargetMeta =
  | { mode: "whole_group" }
  | { mode: "individual"; members: { profile_id: string; name?: string }[] }
  | { mode: "assign_fixed"; targetId: string }
  | { mode: "assign_blocked"; reason: string };

/** Pure helper for use in memoized option lists (same rules as the hook). */
export function computeRubricAnnotationTargetMeta(input: {
  criteria: RubricCriteria | null | undefined;
  part: RubricPart | undefined;
  members: { profile_id: string }[];
  review: Pick<SubmissionReview, "rubric_part_student_assignments"> | null | undefined;
}): RubricAnnotationTargetMeta {
  const { criteria, part, members, review } = input;
  if (!criteria || !part) {
    return { mode: "whole_group" };
  }
  if (part.is_individual_grading || part.is_assign_to_student) {
    if (!review || members.length === 0) {
      return { mode: "assign_blocked", reason: "Loading group data…" };
    }
  }
  if (!review || members.length === 0) {
    return { mode: "whole_group" };
  }
  if (part.is_individual_grading) {
    return { mode: "individual", members };
  }
  if (part.is_assign_to_student) {
    const assignments = (review.rubric_part_student_assignments as Record<string, string | null> | null) ?? {};
    const v = assignments[String(part.id)];
    if (v == null || v === "") {
      return {
        mode: "assign_blocked",
        reason:
          "Assign this rubric part to a student in the grading rubric sidebar before adding this annotation, or choose Skip if it does not apply."
      };
    }
    return { mode: "assign_fixed", targetId: v };
  }
  return { mode: "whole_group" };
}

/**
 * How rubric annotations (line / artifact) should set `target_student_profile_id` for group submissions,
 * matching rubric part modes used in the grading sidebar.
 */
export function useRubricAnnotationTargetMeta(criteria: RubricCriteria | null | undefined): RubricAnnotationTargetMeta {
  const submission = useSubmission();
  const review = useActiveSubmissionReview();
  const { data: allParts = [] } = useRubricPartsQuery();
  const rubricId = review?.rubric_id ?? null;
  const parts = useMemo(() => allParts.filter((p) => p.rubric_id === rubricId), [allParts, rubricId]);
  const groupRow = useAssignmentGroupWithMembers({
    assignment_group_id: submission.assignment_group_id ?? undefined
  });
  const rawMembers = groupRow?.assignment_groups_members ?? [];
  const { data: allProfiles = [] } = useProfilesQuery();
  const members = useMemo(
    () =>
      rawMembers.map((m) => ({
        profile_id: m.profile_id,
        name: allProfiles?.find((p) => p.id === m.profile_id)?.name ?? undefined
      })),
    [rawMembers, allProfiles]
  );
  const part = parts?.find((p) => p.id === criteria?.rubric_part_id);
  return computeRubricAnnotationTargetMeta({ criteria, part, members, review });
}

export function computeRubricAnnotationTargetMetaFromParts(input: {
  criteria: RubricCriteria | null | undefined;
  parts: RubricPart[] | null | undefined;
  members: { profile_id: string }[];
  review: Pick<SubmissionReview, "rubric_part_student_assignments"> | null | undefined;
}): RubricAnnotationTargetMeta {
  const part = input.parts?.find((p) => p.id === input.criteria?.rubric_part_id);
  return computeRubricAnnotationTargetMeta({
    criteria: input.criteria,
    part,
    members: input.members,
    review: input.review
  });
}

export function effectiveAnnotationTargetStudentProfileId(
  meta: RubricAnnotationTargetMeta,
  pickedStudentProfileId: string | null
): { targetId: string | null; error: string | null } {
  switch (meta.mode) {
    case "whole_group":
      return { targetId: null, error: null };
    case "individual":
      if (!pickedStudentProfileId) {
        return { targetId: null, error: "Select which group member this annotation is for." };
      }
      return { targetId: pickedStudentProfileId, error: null };
    case "assign_fixed":
      return { targetId: meta.targetId, error: null };
    case "assign_blocked":
      return { targetId: null, error: meta.reason };
  }
}

/** For max_annotations: count existing line comments for this check scoped to the same target as we would submit. */
export function countFileCommentsForCheckScopedToTarget(
  comments: SubmissionFileComment[],
  checkId: number,
  meta: RubricAnnotationTargetMeta,
  pickedStudentProfileId: string | null
): number {
  const eff = effectiveAnnotationTargetStudentProfileId(meta, pickedStudentProfileId);
  if (eff.error) {
    return 0;
  }
  return comments.filter((c) => {
    if (c.rubric_check_id !== checkId) return false;
    const t = c.target_student_profile_id ?? null;
    return t === eff.targetId;
  }).length;
}
