"use client";

import { useCapability, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useCallback } from "react";

/**
 * Who may grade and who may change a released grade, as the database decides it (#1010,
 * 20261123180000_grading_and_release_by_capability.sql).
 *
 * - `canGradeSubmissions` (grade_submissions): apply rubric checks, add and edit your own comments,
 *   and mark reviews complete while the review is unreleased.
 * - `canReleaseGrades` (release_grades): release and unrelease, and change a released grade: add,
 *   edit or delete any comment or rubric check, and edit any review.
 * - `isLockedByRelease(released)`: whether a staff member's marks on this review are locked because
 *   it is released and they don't hold release_grades. Students are never locked by this; their
 *   self-review rules are separate.
 *
 * Both capabilities read `false` while loading and while an instructor is viewing as a student, as
 * {@link useCapability} does.
 */
export function useGradingPermissions() {
  const isStaff = useIsGraderOrInstructor();
  const canGradeSubmissions = useCapability("grade_submissions");
  const canReleaseGrades = useCapability("release_grades");
  const isLockedByRelease = useCallback(
    (released: boolean | null | undefined) => isStaff && !canReleaseGrades && Boolean(released),
    [isStaff, canReleaseGrades]
  );
  return { canGradeSubmissions, canReleaseGrades, isLockedByRelease };
}
