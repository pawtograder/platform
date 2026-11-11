import { useIsInstructor } from "@/hooks/useClassProfiles";
import type { ErrorAudienceRole } from "@/lib/studentFacingErrorMessages";

/**
 * The `role` to pass to `getUserFacingErrorMessage` on staff screens: `"instructor"` for
 * instructors, otherwise `"grader"`. Uses the effective role from `useIsInstructor`, so an
 * instructor viewing as a student gets the grader wording.
 */
export function useStaffErrorRole(): Extract<ErrorAudienceRole, "instructor" | "grader"> {
  return useIsInstructor() ? "instructor" : "grader";
}
