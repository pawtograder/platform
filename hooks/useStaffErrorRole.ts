import { useIsInstructor, useOptionalCourseRole } from "@/hooks/useClassProfiles";
import type { ErrorAudienceRole } from "@/lib/studentFacingErrorMessages";

/**
 * The `role` to pass to `getUserFacingErrorMessage` on staff screens: `"instructor"` for
 * instructors, otherwise `"grader"`. Uses the effective role from `useIsInstructor`, so an
 * instructor viewing as a student gets the grader wording.
 */
export function useStaffErrorRole(): Extract<ErrorAudienceRole, "instructor" | "grader"> {
  return useIsInstructor() ? "instructor" : "grader";
}

/**
 * The `role` to pass to `getUserFacingErrorMessage` on screens any course member can see: the
 * viewer's effective course role. A course admin gets `"admin"`, which has the instructor wording.
 * Outside a course (no `ClassProfileProvider`) it is `undefined`, which gives the student wording.
 * Staff-only screens can use `useStaffErrorRole` instead.
 */
export function useViewerErrorRole(): ErrorAudienceRole | undefined {
  const role = useOptionalCourseRole();
  return role === "admin" || role === "instructor" || role === "grader" || role === "student" ? role : undefined;
}
