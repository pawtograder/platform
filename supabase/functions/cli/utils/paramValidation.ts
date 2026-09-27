/**
 * Coercion for caller-supplied numeric parameters.
 *
 * The router hands `request.params` straight from the JSON body to each handler,
 * so any HTTP caller can send strings, floats, or `NaN`-producing values. The
 * assessment export used `Math.max(0, x ?? 0)`, which turns `"abc"` into `NaN`;
 * `slice(NaN, NaN)` is `[]`, so the section emitted zero rows, omitted its cursor,
 * and the client accepted that as a *complete* empty section. A fractional index
 * shifted the window and skipped rows outright.
 *
 * These return `null` rather than throwing so the module stays free of value
 * imports and can be asserted from the Jest suite; callers raise
 * `CLICommandError(…, 400)` themselves, and must do so *before* opening an NDJSON
 * stream — once the response headers are flushed, a throw can only become an
 * in-band error record inside an HTTP 200.
 */

/**
 * A non-negative integer, or null. Rejects `NaN`, `Infinity`, fractions, negatives,
 * booleans, and anything non-numeric. Accepts a numeric string, since JSON callers
 * commonly send one.
 */
export function parseNonNegativeInt(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === "boolean") return null;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * A byte cap clamped to `[0, max]`, defaulting when absent — but rejecting garbage
 * rather than silently becoming `NaN`.
 *
 * A `NaN` cap made `output.length <= NaN` false and `slice(0, NaN)` empty, so every
 * row was exported as `""` flagged `output_truncated: true`: data loss dressed up as
 * truncation. Zero and negative values did the same thing, so a floor of 1 is
 * enforced — a cap of zero has no legitimate meaning here.
 */
export function parseByteCap(raw: unknown, defaultValue: number, max: number): number | null {
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw === "boolean") return null;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(max, value);
}
