import { useMemo } from "react";
import { HydratedRubricCheck } from "@/utils/supabase/DatabaseTypes";

/**
 * A hook to determine if a rubric check should be visible to the current user.
 * This encapsulates the visibility logic based on user role (student/grader),
 * submission state, and the check's visibility settings.
 * @param check The rubric check to evaluate.
 * @param rubricCheckComments The comments associated with this check for the current submission.
 * @param reviewForThisRubric The submission review associated with the rubric.
 * @param isGrader Whether the current user is a grader or instructor.
 * @param isPreviewMode Whether the rubric is being viewed in preview mode (no submission).
 * @returns `true` if the check should be shown, `false` otherwise.
 */
export function useShouldShowRubricCheck({
  check,
  rubricCheckComments,
  reviewForThisRubric,
  isGrader,
  isPreviewMode
}: {
  check: HydratedRubricCheck;
  rubricCheckComments: unknown[];
  reviewForThisRubric?: { released: boolean } | null;
  isGrader: boolean;
  isPreviewMode: boolean;
}): boolean {
  const shouldShowCheck = useMemo(() => {
    if (isGrader || isPreviewMode) {
      return true; // Graders and preview mode can see all checks
    }

    // For students, check visibility rules
    const isApplied = rubricCheckComments.length > 0;
    const isReleased = reviewForThisRubric?.released || false;

    switch (check.student_visibility) {
      case "never":
        return false;
      case "if_applied":
        return isApplied && isReleased;
      case "if_released":
        return isReleased;
      case "always":
      default:
        return true;
    }
  }, [isGrader, isPreviewMode, check.student_visibility, rubricCheckComments.length, reviewForThisRubric?.released]);

  return shouldShowCheck;
}
