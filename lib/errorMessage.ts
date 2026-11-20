/**
 * Returns a readable message for any thrown value, for use in error toasts.
 *
 * refine's Supabase provider rejects PostgREST errors with a plain object
 * (`{ message, code, details, hint, statusCode }`), not an `Error`. The usual
 * `error instanceof Error ? error.message : String(error)` turns those into
 * "[object Object]", which hides the reason the write failed.
 *
 * - `Error` instances: their `message`.
 * - Other objects with a string `message` (PostgREST errors): that `message`.
 * - Anything else: `String(error)`.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}
