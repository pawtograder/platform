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

  it("sends graders to an instructor and instructors and admins to the Pawtograder team", () => {
    expect(getUserFacingErrorMessage(denied, { role: "grader" })).toContain("ask an instructor");
    for (const role of ["instructor", "admin"] as const) {
      const message = getUserFacingErrorMessage(denied, { role });
      expect(message).toContain("Pawtograder team");
      expect(message).not.toContain("contact your instructor");
      // The Report this button only exists on error toasts with a Sentry DSN, so don't point at it.
      expect(message).not.toContain("Report this");
    }
  });

  describe("refused writes from the data provider", () => {
    const refusedMessage =
      "You don't have permission to update this assignments record (id 5), or it no longer exists. Nothing was changed.";
    const refused = Object.assign(new Error(refusedMessage), { statusCode: 403, refusedWrite: true });

    it("keep their own message, which allows for a deleted row", () => {
      expect(getUserFacingErrorMessage(refused)).toBe(refusedMessage);
      expect(getUserFacingErrorMessage(refused, { role: "grader" })).toBe(refusedMessage);
      expect(getUserFacingErrorMessage(refused, { role: "instructor" })).toBe(refusedMessage);
    });

    it("still get the released-review and self-review messages", () => {
      expect(getUserFacingErrorMessage(refused, { releasedReviewGraderBlocked: true })).toBe(
        GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE
      );
      expect(getUserFacingErrorMessage(refused, { isStudent: true, rubricReviewRound: "self-review" })).toContain(
        "self-review due date has passed"
      );
    });

    it("fall back to the permission message when they have no message", () => {
      expect(getUserFacingErrorMessage({ refusedWrite: true }, { role: "grader" })).toContain("ask an instructor");
    });
  });

  it("reads the message from a PostgREST plain-object error", () => {
    expect(getUserFacingErrorMessage({ code: "P0001", message: "Groups are locked" }, { role: "grader" })).toBe(
      "Groups are locked"
    );
  });
});

describe("isExpectedUserError", () => {
  it("is true for session, conflict, check and raised errors, and for refused writes", () => {
    for (const code of ["PGRST301", "23505", "23514", "P0001"]) {
      expect(isExpectedUserError({ code, message: "x" })).toBe(true);
    }
    expect(isExpectedUserError({ refusedWrite: true })).toBe(true);
  });

  it("is false by default for permission, no-row and foreign-key errors", () => {
    for (const code of ["42501", "PGRST116", "23503"]) {
      expect(isExpectedUserError({ code, message: "x" })).toBe(false);
    }
  });

  it("is true for codes the caller expects", () => {
    expect(isExpectedUserError({ code: "42501", message: "x" }, { expected: ["42501"] })).toBe(true);
    expect(isExpectedUserError({ code: "23503", message: "x" }, { expected: ["42501"] })).toBe(false);
    expect(isExpectedUserError({ code: "P0001", message: "x" }, { expected: ["42501"] })).toBe(true);
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

  it("does not send expected errors or refused writes to Sentry", () => {
    expect(reportUnexpectedError({ code: "23505", message: "duplicate key" })).toBeUndefined();
    expect(reportUnexpectedError({ refusedWrite: true, message: "refused" })).toBeUndefined();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("sends 42501 by default, such as a missing GRANT on a read", () => {
    const denied = { code: "42501", message: "permission denied for table regrade_requests" };
    expect(reportUnexpectedError(denied, { operation: "regrade_requests_fetch" })).toBe("event-id");
    expect(mockScope.setTag).toHaveBeenCalledWith("error_code", "42501");
  });

  it("does not send 42501 when the caller expects it", () => {
    const denied = { code: "42501", message: "permission denied" };
    expect(reportUnexpectedError(denied, { operation: "save" }, { expected: ["42501"] })).toBeUndefined();
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
