/**
 * useViewerErrorRole and useStaffErrorRole pick the role passed to getUserFacingErrorMessage (#983).
 * A course admin used to get the student wording ("contact your instructor") from
 * useViewerErrorRole, and the grader wording ("ask an instructor") from useStaffErrorRole. Both now
 * give an admin the instructor wording.
 */
import { renderHook } from "@testing-library/react";

import { useStaffErrorRole, useViewerErrorRole } from "@/hooks/useStaffErrorRole";
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

describe("useStaffErrorRole", () => {
  it.each([
    ["admin", "instructor"],
    ["instructor", "instructor"],
    ["grader", "grader"]
  ])("gives a course %s the %s wording", (role, expected) => {
    courseRole = role;
    expect(renderHook(() => useStaffErrorRole()).result.current).toBe(expected);
  });

  it("gives a course admin the same permission message as an instructor", () => {
    courseRole = "admin";
    const role = renderHook(() => useStaffErrorRole()).result.current;
    expect(getUserFacingErrorMessage(permissionDenied, { role })).toBe(
      getUserFacingErrorMessage(permissionDenied, { role: "instructor" })
    );
  });
});
