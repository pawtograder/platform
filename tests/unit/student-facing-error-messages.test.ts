import * as Sentry from "@sentry/nextjs";
import {
  getStudentFacingErrorMessage,
  getUserFacingErrorMessage,
  GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE,
  isExpectedUserError,
  reportUnexpectedError
} from "@/lib/studentFacingErrorMessages";

const mockScope = { setTag: jest.fn(), setContext: jest.fn() };
jest.mock("@sentry/nextjs", () => ({
  withScope: (callback: (scope: unknown) => unknown) => callback(mockScope),
  captureException: jest.fn(() => "event-id")
}));

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

describe("getUserFacingErrorMessage", () => {
  const denied = { code: "42501", message: "permission denied for table assignments" };

  it("keeps the student wording when no role is given", () => {
    expect(getUserFacingErrorMessage(denied)).toBe(getStudentFacingErrorMessage(denied));
    expect(getUserFacingErrorMessage(denied)).toContain("contact your instructor");
  });

  it("sends graders to an instructor and instructors to Report this", () => {
    expect(getUserFacingErrorMessage(denied, { role: "grader" })).toContain("ask an instructor");
    expect(getUserFacingErrorMessage(denied, { role: "instructor" })).toContain("Report this");
    expect(getUserFacingErrorMessage(denied, { role: "instructor" })).not.toContain("contact your instructor");
  });

  it("treats a refused write from the data provider as a permission error", () => {
    const refused = Object.assign(new Error("You don't have permission to update this assignments record"), {
      statusCode: 403,
      refusedWrite: true
    });
    expect(getUserFacingErrorMessage(refused, { role: "grader" })).toContain("ask an instructor");
    expect(getUserFacingErrorMessage(refused, { releasedReviewGraderBlocked: true })).toBe(
      GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE
    );
  });

  it("reads the message from a PostgREST plain-object error", () => {
    expect(getUserFacingErrorMessage({ code: "P0001", message: "Groups are locked" }, { role: "grader" })).toBe(
      "Groups are locked"
    );
  });
});

describe("isExpectedUserError", () => {
  it("is true for permission, session, conflict and raised errors", () => {
    for (const code of ["42501", "PGRST301", "PGRST116", "23505", "23503", "23514", "P0001"]) {
      expect(isExpectedUserError({ code, message: "x" })).toBe(true);
    }
    expect(isExpectedUserError({ refusedWrite: true })).toBe(true);
  });

  it("is false for anything else", () => {
    expect(isExpectedUserError({ code: "57014", message: "canceling statement due to statement timeout" })).toBe(false);
    expect(isExpectedUserError({ code: "XX000", message: "internal error" })).toBe(false);
    expect(isExpectedUserError(new Error("network down"))).toBe(false);
    expect(isExpectedUserError(undefined)).toBe(false);
  });
});

describe("reportUnexpectedError", () => {
  beforeEach(() => {
    jest.mocked(Sentry.captureException).mockClear();
    mockScope.setTag.mockClear();
    mockScope.setContext.mockClear();
  });

  it("does not send permission errors to Sentry", () => {
    expect(reportUnexpectedError({ code: "42501", message: "permission denied" })).toBeUndefined();
    expect(reportUnexpectedError({ refusedWrite: true, message: "refused" })).toBeUndefined();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("sends unexpected PostgREST errors as an Error, tagged with the code", () => {
    const timeout = { code: "57014", message: "canceling statement due to statement timeout" };

    expect(reportUnexpectedError(timeout, { operation: "load" })).toBe("event-id");

    expect(mockScope.setTag).toHaveBeenCalledWith("error_code", "57014");
    expect(mockScope.setContext).toHaveBeenCalledWith("error_context", { operation: "load" });
    const [sent, hint] = jest.mocked(Sentry.captureException).mock.calls[0];
    expect(sent).toBeInstanceOf(Error);
    expect((sent as Error).message).toBe(timeout.message);
    expect(hint).toEqual({ extra: { postgrest_error: timeout } });
  });

  it("tags errors without a code as none", () => {
    reportUnexpectedError(new Error("network down"));
    expect(mockScope.setTag).toHaveBeenCalledWith("error_code", "none");
  });
});
