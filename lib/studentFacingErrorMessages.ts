import * as Sentry from "@sentry/nextjs";

import { isRefusedWriteError } from "./refusedWriteError";

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

  const code = getErrorCode(error);
  // A write that changed 0 rows. The refine data provider and TableController both throw this
  // (lib/refusedWriteError.ts). TableController turns the PGRST116 from an update's `.single()` into
  // it, which is how editing a comment on a released review or after the self-review deadline fails:
  // the UPDATE policy's USING clause matches 0 rows. So these contexts check it as well as 42501.
  const refusedWrite = isRefusedWriteError(error);
  const permissionDenied = refusedWrite || code === "42501";

  if (permissionDenied && context?.releasedReviewGraderBlocked) {
    return GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE;
  }

  if (permissionDenied && context?.isStudent && context.rubricReviewRound === "self-review") {
    return SELF_REVIEW_PAST_DUE_MESSAGE;
  }

  const message = getErrorProperty(error, "message");
  const details = getErrorProperty(error, "details");
  const hint = getErrorProperty(error, "hint");

  // Otherwise keep the refusal's own message. A 0-row update can also mean the row was deleted,
  // and that message says so. The plain 42501 wording only mentions permissions.
  if (refusedWrite) {
    return message?.trim() || permissionDeniedMessage(context?.role);
  }

  if (code) {
    const mapped = mapPostgrestOrPostgresCode(code, message, details, hint, context?.role);
    if (mapped) {
      return mapped;
    }
  }

  // The same filter as mapPostgrestOrPostgresCode: Postgres's own text ("Failing row contains (…)"
  // on a 23502, a constraint or table name) means nothing to the reader.
  const extra = [details, hint].filter((s) => s && s.trim()).join(" ");
  if (extra.trim() && !looksLikeInternalNoise(extra)) {
    return extra.trim();
  }

  if (message && message.trim() && !looksLikeInternalNoise(message)) {
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
    case "42501": {
      // A function's own refusal ("students may only resolve an open or in-progress help request")
      // says what was refused, so keep it. Postgres's RLS and GRANT messages name tables and
      // policies instead, and a bare "Access denied" says less than the generic wording.
      const raised = raisedMessage(message);
      if (raised && !UNINFORMATIVE_REFUSAL.test(raised)) {
        return `${raised} ${permissionHelp(role)}`;
      }
      return permissionDeniedMessage(role);
    }
    case "23505":
      return (
        raisedMessage(message) ??
        "This was already saved or conflicts with existing data. Refresh the page and try again."
      );
    case "23503":
      // On a delete, the row is still referenced; on an insert or update, the row it points at is gone.
      return isStillReferenced(message, details)
        ? "Other data still uses this, so it can't be deleted. Remove or move what uses it first, then try again."
        : "Something this action depends on is missing or was deleted. Refresh the page and try again.";
    case "23514":
      return (
        raisedMessage(message) ??
        (!role || role === "student"
          ? "Some entered values are not allowed for this form. Check your answers and try again."
          : "Some entered values are not allowed for this form. Check what you entered and try again.")
      );
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

/**
 * True for text Postgres wrote rather than one of our database functions: constraint and table
 * names, a "Failing row contains (…)" detail, and the RLS and GRANT refusals ("permission denied
 * for table …", "new row violates row-level security policy …", "must be owner of …").
 */
function looksLikeInternalNoise(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t.includes("relation ") ||
    t.includes("violates foreign key") ||
    t.includes("duplicate key value violates unique constraint") ||
    t.includes("violates check constraint") ||
    t.includes("violates not-null constraint") ||
    t.includes("failing row contains") ||
    t.includes("row-level security policy") ||
    t.startsWith("permission denied for ") ||
    t.startsWith("permission denied to ") ||
    t.startsWith("must be owner of ")
  );
}

/**
 * A message one of our database functions raised on purpose (`raise exception '...' using errcode
 * = ...`), as a sentence: first letter capitalized and a final period. `undefined` when there is no
 * message or Postgres wrote it.
 */
function raisedMessage(message: string | undefined): string | undefined {
  const t = message?.trim();
  if (!t || looksLikeInternalNoise(t)) return undefined;
  const capitalized = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

/** Refusals that say nothing beyond "no". The generic wording is clearer than these. */
const UNINFORMATIVE_REFUSAL = /^(access|permission) denied\.?$/i;

/**
 * True when a 23503 came from a DELETE (or a key UPDATE) of a row other rows still point at.
 * Postgres says so in both fields: the message starts "update or delete on table" and the details
 * say "Key (id)=(…) is still referenced from table …". An insert or update that points at a
 * missing row says "insert or update on table" and "is not present in table" instead.
 */
function isStillReferenced(message: string | undefined, details: string | undefined): boolean {
  return (
    /^update or delete on table /i.test(message?.trim() ?? "") || /is still referenced from table/i.test(details ?? "")
  );
}

function permissionDeniedMessage(role: ErrorAudienceRole | undefined): string {
  return `You don't have permission to do that. ${permissionHelp(role)}`;
}

/** Who to ask when a permission error blocks you. */
function permissionHelp(role: ErrorAudienceRole | undefined): string {
  switch (role) {
    case "grader":
      return "If you need access, ask an instructor for this course.";
    case "instructor":
    case "admin":
      return "If you think you should, let the Pawtograder team know so we can look into it.";
    default:
      return "If you need access, contact your instructor.";
  }
}

/**
 * Error codes that are expected on any request: an expired session, a conflict with existing data,
 * a check constraint, or a check a database function raised on purpose. The message already tells
 * the user what to do, so Sentry doesn't need them.
 *
 * 42501, PGRST116 and 23503 are not here. On a read they usually mean our bug (a missing GRANT,
 * `.single()` matching several rows, an ID for a row that is gone), so a caller that expects them,
 * such as a save handler blocked by RLS, passes them in `expected`.
 */
const DEFAULT_EXPECTED_ERROR_CODES: readonly string[] = ["PGRST301", "23505", "23514", "P0001"];

export type ExpectedErrorOptions = {
  /** Extra error codes this caller expects, added to the default list. */
  expected?: readonly string[];
};

/**
 * True when `error` is one the user caused and the message explains, not an app bug. A refused
 * write (0 rows changed, see lib/refusedWriteError.ts) always counts.
 */
export function isExpectedUserError(error: unknown, options?: ExpectedErrorOptions): boolean {
  if (isRefusedWriteError(error)) return true;
  const code = getErrorCode(error);
  if (code === undefined) return false;
  return DEFAULT_EXPECTED_ERROR_CODES.includes(code) || (options?.expected?.includes(code) ?? false);
}

/**
 * Sends `error` to Sentry unless it is an expected user error (see `isExpectedUserError`; pass
 * `options.expected` to expect more codes). Tags the event with the PostgREST/Postgres code
 * (`error_code`, or `none`) so unexpected database errors can be grouped and searched by code.
 * Returns the Sentry event id, or `undefined` when nothing was sent.
 */
export function reportUnexpectedError(
  error: unknown,
  extra?: Record<string, unknown>,
  options?: ExpectedErrorOptions
): string | undefined {
  if (isExpectedUserError(error, options)) return undefined;
  const code = getErrorCode(error);
  return Sentry.withScope((scope) => {
    scope.setTag("error_code", code ?? "none");
    if (extra) scope.setContext("error_context", extra);
    // PostgREST errors are plain objects; give Sentry an Error so it gets a usable title and stack.
    const exception = error instanceof Error ? error : new Error(getErrorProperty(error, "message") ?? String(error));
    return Sentry.captureException(exception, { extra: code ? { postgrest_error: error } : undefined });
  });
}
