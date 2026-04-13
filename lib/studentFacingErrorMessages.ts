export type StudentFacingErrorContext = {
  isStudent?: boolean;
  /** When set with `isStudent`, refines Postgres permission errors during self-review */
  rubricReviewRound?: string | null;
};

const SELF_REVIEW_PAST_DUE_MESSAGE =
  "The self-review due date has passed, so you can no longer add or change checks. If you need more time, ask your instructor.";

/**
 * Maps Supabase/PostgREST errors and other thrown values into plain-language messages for students.
 * Prefer this over raw `error.message` when the underlying string may be cryptic (e.g. SQL fragments).
 */
export function getStudentFacingErrorMessage(error: unknown, context?: StudentFacingErrorContext): string {
  if (error === null || error === undefined) {
    return "Something went wrong. Please try again.";
  }
  if (typeof error === "string") {
    return error.trim() || "Something went wrong. Please try again.";
  }

  const code = getErrorCode(error);

  if (code === "42501" && context?.isStudent && context.rubricReviewRound === "self-review") {
    return SELF_REVIEW_PAST_DUE_MESSAGE;
  }

  const message = getErrorProperty(error, "message");
  const details = getErrorProperty(error, "details");
  const hint = getErrorProperty(error, "hint");

  if (code) {
    const mapped = mapPostgrestOrPostgresCode(code, message, details, hint);
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
  hint: string | undefined
): string | null {
  switch (code) {
    case "PGRST301":
      return "Your session expired or is invalid. Refresh the page and sign in again.";
    case "PGRST116":
      return "Nothing was found for this request. It may have been removed or you may not have access.";
    case "42501":
      return "You don't have permission to do that. If you need access, contact your instructor.";
    case "23505":
      return "This was already saved or conflicts with existing data. Refresh the page and try again.";
    case "23503":
      return "Something this action depends on is missing or was deleted. Refresh the page and try again.";
    case "23514":
      return "Some entered values are not allowed for this form. Check your answers and try again.";
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
