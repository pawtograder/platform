import * as Sentry from "@sentry/nextjs";
import {
  getStudentFacingErrorMessage,
  getUserFacingErrorMessage,
  GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE,
  isExpectedUserError,
  reportUnexpectedError
} from "@/lib/studentFacingErrorMessages";
import { refusedWriteError } from "@/lib/refusedWriteError";

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

  describe("refusals a database function raised (42501 with its own message)", () => {
    // What publish_assignment_group_changes raises for a grader (#996).
    const publishRefused = {
      code: "42501",
      details: null,
      hint: null,
      message: "Only instructors can publish group changes"
    };

    it("keep the function's message and add who to ask", () => {
      expect(getUserFacingErrorMessage(publishRefused, { role: "grader" })).toBe(
        "Only instructors can publish group changes. If you need access, ask an instructor for this course."
      );
      expect(getUserFacingErrorMessage(publishRefused, { role: "instructor" })).toBe(
        "Only instructors can publish group changes. If you think you should, let the Pawtograder team know so we can look into it."
      );
      expect(getUserFacingErrorMessage(publishRefused)).toBe(
        "Only instructors can publish group changes. If you need access, contact your instructor."
      );
    });

    it("capitalize a lowercase message, as most of our functions raise them", () => {
      // What the help request trigger raises when a student resolves a request a TA already closed.
      expect(
        getUserFacingErrorMessage({
          code: "42501",
          message: "students may only resolve an open or in-progress help request"
        })
      ).toBe(
        "Students may only resolve an open or in-progress help request. If you need access, contact your instructor."
      );
    });

    it("don't add a second period", () => {
      expect(
        getUserFacingErrorMessage({ code: "42501", message: "Only admins can do this." }, { role: "grader" })
      ).toBe("Only admins can do this. If you need access, ask an instructor for this course.");
    });

    it("use the generic wording for a bare 'Access denied'", () => {
      expect(getUserFacingErrorMessage({ code: "42501", message: "Access denied" }, { role: "grader" })).toBe(
        "You don't have permission to do that. If you need access, ask an instructor for this course."
      );
    });

    it("use the generic wording for Postgres's own RLS and GRANT messages", () => {
      for (const message of [
        "permission denied for table assignments",
        "permission denied to set role",
        'new row violates row-level security policy for table "assignment_self_review_settings"',
        "must be owner of table objects"
      ]) {
        expect(getUserFacingErrorMessage({ code: "42501", message }, { role: "grader" })).toBe(
          "You don't have permission to do that. If you need access, ask an instructor for this course."
        );
      }
    });
  });

  describe("23505 and 23514", () => {
    it("keep a message a database function raised", () => {
      expect(
        getUserFacingErrorMessage({
          code: "23505",
          message: "you already have a private solo help request in this queue"
        })
      ).toBe("You already have a private solo help request in this queue.");
      expect(
        getUserFacingErrorMessage({ code: "23514", message: "Can only set topic for root posts" }, { role: "grader" })
      ).toBe("Can only set topic for root posts.");
    });

    it("use the generic wording for Postgres's constraint messages", () => {
      expect(
        getUserFacingErrorMessage({
          code: "23505",
          message: 'duplicate key value violates unique constraint "tags_class_id_name_key"',
          details: "Key (class_id, name)=(1, x) already exists."
        })
      ).toBe("This was already saved or conflicts with existing data. Refresh the page and try again.");
      expect(
        getUserFacingErrorMessage({
          code: "23514",
          message: 'new row for relation "assignments" violates check constraint "assignments_points_check"',
          details: "Failing row contains (1, x)."
        })
      ).toBe("Some entered values are not allowed for this form. Check your answers and try again.");
    });
  });

  describe("23503", () => {
    it("says the row is still in use when a delete is blocked", () => {
      expect(
        getUserFacingErrorMessage({
          code: "23503",
          message:
            'update or delete on table "discussion_topics" violates foreign key constraint "discussion_threads_topic_id_fkey" on table "discussion_threads"',
          details: 'Key (id)=(5) is still referenced from table "discussion_threads".'
        })
      ).toBe("Other data still uses this, so it can't be deleted. Remove or move what uses it first, then try again.");
    });

    it("says what it points at is missing on an insert or update", () => {
      expect(
        getUserFacingErrorMessage({
          code: "23503",
          message: 'insert or update on table "discussion_threads" violates foreign key constraint "x_fkey"',
          details: 'Key (topic_id)=(5) is not present in table "discussion_topics".'
        })
      ).toBe("Something this action depends on is missing or was deleted. Refresh the page and try again.");
    });
  });

  it("never shows Postgres's 'Failing row contains' detail, as on a 23502", () => {
    const notNull = {
      code: "23502",
      message: 'null value in column "name" of relation "tags" violates not-null constraint',
      details: "Failing row contains (12, null, 3).",
      hint: null
    };
    expect(getUserFacingErrorMessage(notNull)).toBe("Something went wrong. Please try again.");
    // Without a code too.
    expect(getUserFacingErrorMessage({ message: "x", details: "Failing row contains (12, null, 3)." })).toBe("x");
  });

  describe("refused writes (refine data provider or TableController)", () => {
    const refused = refusedWriteError("update");
    const refusedMessage = refused.message;

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
      const noMessage = Object.assign(refusedWriteError("update"), { message: "" });
      expect(getUserFacingErrorMessage(noMessage, { role: "grader" })).toContain("ask an instructor");
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
    expect(isExpectedUserError(refusedWriteError("delete"))).toBe(true);
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
    expect(reportUnexpectedError(refusedWriteError("update"))).toBeUndefined();
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
