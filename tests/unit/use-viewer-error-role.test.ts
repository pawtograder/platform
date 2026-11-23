/**
 * useViewerErrorRole passes the viewer's course role to getUserFacingErrorMessage (#983). A course
 * admin used to fall through to `undefined`, which gave them the student wording ("contact your
 * instructor") on a refused write.
 */
import { renderHook } from "@testing-library/react";

import { useViewerErrorRole } from "@/hooks/useStaffErrorRole";
import { getUserFacingErrorMessage } from "@/lib/studentFacingErrorMessages";

let courseRole: string | undefined;

jest.mock("@/hooks/useClassProfiles", () => ({
  useIsInstructor: () => courseRole === "instructor",
  useOptionalCourseRole: () => courseRole
}));

const permissionDenied = { code: "42501", message: "permission denied for table submissions" };

describe("useViewerErrorRole", () => {
  it.each(["admin", "instructor", "grader", "student"])("returns the %s course role", (role) => {
    courseRole = role;
    expect(renderHook(() => useViewerErrorRole()).result.current).toBe(role);
  });

  it("returns undefined outside a course", () => {
    courseRole = undefined;
    expect(renderHook(() => useViewerErrorRole()).result.current).toBeUndefined();
  });

  it("gives a course admin the instructor wording, not the student wording", () => {
    courseRole = "admin";
    const role = renderHook(() => useViewerErrorRole()).result.current;
    expect(getUserFacingErrorMessage(permissionDenied, { role })).toBe(
      getUserFacingErrorMessage(permissionDenied, { role: "instructor" })
    );
    expect(getUserFacingErrorMessage(permissionDenied, { role })).not.toContain("contact your instructor");
  });
});
