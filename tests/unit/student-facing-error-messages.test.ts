import {
  getStudentFacingErrorMessage,
  GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE
} from "@/lib/studentFacingErrorMessages";

describe("getStudentFacingErrorMessage", () => {
  it("maps common PostgREST codes to plain language", () => {
    expect(getStudentFacingErrorMessage({ code: "42501", message: "permission denied" })).toContain("permission");
    expect(getStudentFacingErrorMessage({ code: "PGRST301", message: "JWT expired" })).toContain("session");
  });

  it("maps 42501 for students in self-review to the past-due self-review message", () => {
    expect(
      getStudentFacingErrorMessage(
        { code: "42501", message: "permission denied" },
        { isStudent: true, rubricReviewRound: "self-review" }
      )
    ).toContain("self-review due date has passed");
  });

  it("maps 42501 for graders when released-review context is set", () => {
    expect(
      getStudentFacingErrorMessage(
        { code: "42501", message: "permission denied" },
        { releasedReviewGraderBlocked: true }
      )
    ).toBe(GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE);
  });

  it("falls back to message when no code mapping applies", () => {
    expect(getStudentFacingErrorMessage(new Error("Custom failure"))).toBe("Custom failure");
  });
});
