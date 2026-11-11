import * as Sentry from "@sentry/nextjs";

/** Who is reading the message. Changes only where to send them for help. */
export type ErrorAudienceRole = "student" | "grader" | "instructor" | "admin";

export type StudentFacingErrorContext = {
  /**
   * Who will read the message. Without it the wording is the student wording, which is what every
   * existing caller of `getStudentFacingErrorMessage` gets.
   */
  role?: ErrorAudienceRole;
  isStudent?: boolean;
  /** When set with `isStudent`, refines Postgres permission errors during self-review */
  rubricReviewRound?: string | null;
  /**
   * When true with Postgres 42501, maps to copy for TAs blocked because hand-grading feedback
   * was already released on the submission review (RLS issue #446).
   */
  releasedReviewGraderBlocked?: boolean;
};

export const GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE =
  "This grading feedback has already been released to students, so you cannot add or change marks. Ask your instructor to click Unrelease on this submission review if a change is needed; after edits, they can release again.";

const SELF_REVIEW_PAST_DUE_MESSAGE =
  "The self-review due date has passed, so you can no longer add or change checks. If you need more time, ask your instructor.";

/**
 * Maps Supabase/PostgREST errors and other thrown values into plain-language messages for students.
 * Same as `getUserFacingErrorMessage`; kept so existing student-facing callers don't change.
 */
export function getStudentFacingErrorMessage(error: unknown, context?: StudentFacingErrorContext): string {
  return getUserFacingErrorMessage(error, context);
}

/**
 * Maps Supabase/PostgREST errors and other thrown values into plain-language messages for any user.
 * Pass `context.role` so permission errors point the reader at the right person for help.
 * Prefer this over raw `error.message` when the underlying string may be cryptic (e.g. SQL fragments).
 */
export function getUserFacingErrorMessage(error: unknown, context?: StudentFacingErrorContext): string {
  if (error === null || error === undefined) {
    return "Something went wrong. Please try again.";
  }
  if (typeof error === "string") {
    return error.trim() || "Something went wrong. Please try again.";
  }

  // A write RLS refused with 0 rows changed (lib/refineDataProvider.ts) is a permission error, so it
  // gets the same 42501 handling, including the self-review and released-review messages below.
  const code = isRefusedWrite(error) ? "42501" : getErrorCode(error);

  if (code === "42501" && context?.releasedReviewGraderBlocked) {
    return GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE;
  }

  if (code === "42501" && context?.isStudent && context.rubricReviewRound === "self-review") {
    return SELF_REVIEW_PAST_DUE_MESSAGE;
  }

  const message = getErrorProperty(error, "message");
  const details = getErrorProperty(error, "details");
  const hint = getErrorProperty(error, "hint");

  if (code) {
    const mapped = mapPostgrestOrPostgresCode(code, message, details, hint, context?.role);
    if (mapped) {
      return mapped;
    }
  }

  const extra = [details, hint].filter((s) => s && s.trim()).join(" ");
  if (extra.trim()) {
    return extra.trim();
  }

  if (message && message.trim()) {
    return message.trim();
  }

  return "Something went wrong. Please try again.";
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const c = (error as { code?: unknown }).code;
    if (typeof c === "string") return c;
    if (typeof c === "number") return String(c);
  }
  return undefined;
}

function getErrorProperty(error: unknown, key: "message" | "details" | "hint"): string | undefined {
  if (typeof error === "object" && error !== null && key in error) {
    const v = (error as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  if (error instanceof Error && key === "message") {
    return error.message;
  }
  return undefined;
}

function mapPostgrestOrPostgresCode(
  code: string,
  message: string | undefined,
  details: string | undefined,
  hint: string | undefined,
  role: ErrorAudienceRole | undefined
): string | null {
  switch (code) {
    case "PGRST301":
      return "Your session expired or is invalid. Refresh the page and sign in again.";
    case "PGRST116":
      return "Nothing was found for this request. It may have been removed or you may not have access.";
    case "42501":
      return permissionDeniedMessage(role);
    case "23505":
      return "This was already saved or conflicts with existing data. Refresh the page and try again.";
    case "23503":
      return "Something this action depends on is missing or was deleted. Refresh the page and try again.";
    case "23514":
      return !role || role === "student"
        ? "Some entered values are not allowed for this form. Check your answers and try again."
        : "Some entered values are not allowed for this form. Check what you entered and try again.";
    case "57014":
      return "The request took too long and was canceled. Try again in a moment.";
    case "P0001":
      if (message && message.trim()) {
        return message.trim();
      }
      return "This action is not allowed right now.";
    default:
      break;
  }

  if (message && message.trim() && !looksLikeInternalNoise(message)) {
    return message.trim();
  }

  const extra = [details, hint].filter((s) => s && s.trim()).join(" ");
  if (extra.trim() && !looksLikeInternalNoise(extra)) {
    return extra.trim();
  }

  return null;
}

function looksLikeInternalNoise(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("relation ") ||
    t.includes("violates foreign key") ||
    t.includes("duplicate key value violates unique constraint")
  );
}

function permissionDeniedMessage(role: ErrorAudienceRole | undefined): string {
  switch (role) {
    case "grader":
      return "You don't have permission to do that. If you need access, ask an instructor for this course.";
    case "instructor":
    case "admin":
      return "You don't have permission to do that. If you think you should, use Report this so we can look into it.";
    default:
      return "You don't have permission to do that. If you need access, contact your instructor.";
  }
}

/**
 * A write that RLS refused without a PostgREST error (0 rows changed). The refine data provider
 * marks these with `refusedWrite: true` (lib/refineDataProvider.ts).
 */
function isRefusedWrite(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { refusedWrite?: unknown }).refusedWrite === true;
}

/**
 * Error codes that mean the user hit a rule, not that the app broke: permissions, an expired
 * session, a row that is gone, a conflict with existing data, or a check a database function
 * raised on purpose. The message already tells the user what to do, so Sentry doesn't need them.
 */
const EXPECTED_ERROR_CODES = new Set(["42501", "PGRST301", "PGRST116", "23505", "23503", "23514", "P0001"]);

/** True when `error` is one the user caused and the message explains, not an app bug. */
export function isExpectedUserError(error: unknown): boolean {
  if (isRefusedWrite(error)) return true;
  const code = getErrorCode(error);
  return code !== undefined && EXPECTED_ERROR_CODES.has(code);
}

/**
 * Sends `error` to Sentry unless it is an expected user error (see `isExpectedUserError`).
 * Tags the event with the PostgREST/Postgres code (`error_code`, or `none`) so unexpected
 * database errors can be grouped and searched by code. Returns the Sentry event id, or
 * `undefined` when nothing was sent.
 */
export function reportUnexpectedError(error: unknown, extra?: Record<string, unknown>): string | undefined {
  if (isExpectedUserError(error)) return undefined;
  const code = getErrorCode(error);
  return Sentry.withScope((scope) => {
    scope.setTag("error_code", code ?? "none");
    if (extra) scope.setContext("error_context", extra);
    // PostgREST errors are plain objects; give Sentry an Error so it gets a usable title and stack.
    const exception = error instanceof Error ? error : new Error(getErrorProperty(error, "message") ?? String(error));
    return Sentry.captureException(exception, { extra: code ? { postgrest_error: error } : undefined });
  });
}
