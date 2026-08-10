/**
 * Reading structured Postgres/PostgREST errors: describing them, and classifying the benign ones.
 *
 * PostgREST and GoTrue hand back plain structured objects rather than `Error` instances, so the
 * reflexive `cause instanceof Error ? cause.message : String(cause)` yields `[object Object]` — which
 * loses the message, code, details and hint from both the HTTP response body and the Sentry event, and
 * leaves an outage with nothing to diagnose it by. Read `message` off anything that carries one.
 *
 * Pure and dependency-free so it can be imported from any edge function without dragging in a
 * `Sentry.init` side effect, and unit-tested without a Deno.serve host.
 */

/** A readable one-line description of `cause`, preferring a real message over its JSON shape. */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === "object") {
    const { message, code } = cause as { message?: unknown; code?: unknown };
    if (typeof message === "string" && message) {
      // The PostgREST code is what distinguishes a 502 from a missing relation or an RLS denial.
      return typeof code === "string" && code ? `${message} (${code})` : message;
    }
    try {
      return JSON.stringify(cause);
    } catch {
      // Circular or otherwise unserializable: fall back rather than throwing from an error path.
      return String(cause);
    }
  }
  return String(cause);
}

/** Postgres `unique_violation`. */
export const UNIQUE_VIOLATION = "23505";

/**
 * True when `error` is a Postgres unique-constraint violation.
 *
 * Useful where an insert is really an assertion that a row exists: for an idempotent write, 23505 is
 * the success case arriving late, not a fault. Callers should still scope this narrowly — swallow it
 * for the specific insert whose duplicate is harmless, never as a blanket ignore, since the same code
 * on a different table can mean genuinely conflicting data.
 */
export function isDuplicateKey(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}
