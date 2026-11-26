import { getUserFacingErrorMessage, type StudentFacingErrorContext } from "@/lib/studentFacingErrorMessages";

/**
 * Returns a readable message for any thrown value, for use in error toasts.
 *
 * Delegates to `getUserFacingErrorMessage`, so a screen that uses both shows one kind of error
 * message. Pass `context.role` (from `useStaffErrorRole` or `useViewerErrorRole`) so permission
 * errors point the reader at the right person; without it the wording is the student wording.
 *
 * refine's Supabase provider rejects PostgREST errors with a plain object
 * (`{ message, code, details, hint, statusCode }`), not an `Error`. The usual
 * `error instanceof Error ? error.message : String(error)` turns those into
 * "[object Object]"; the mapper reads them instead.
 */
export function getErrorMessage(error: unknown, context?: StudentFacingErrorContext): string {
  return getUserFacingErrorMessage(error, context);
}
