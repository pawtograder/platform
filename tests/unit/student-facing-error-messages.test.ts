import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";

describe("getStudentFacingErrorMessage", () => {
  it("maps common PostgREST codes to plain language", () => {
    expect(getStudentFacingErrorMessage({ code: "42501", message: "permission denied" })).toContain("permission");
    expect(getStudentFacingErrorMessage({ code: "PGRST301", message: "JWT expired" })).toContain("session");
  });

  it("falls back to message when no code mapping applies", () => {
    expect(getStudentFacingErrorMessage(new Error("Custom failure"))).toBe("Custom failure");
  });
});
