/**
 * One-line descriptions of thrown values, for error messages that a human has to act on.
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
