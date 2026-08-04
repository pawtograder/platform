/**
 * Guards the YAML-to-JSON hole in rubric import.
 */

import { CLIError } from "@/cli/utils/logger";

/**
 * Rejects Infinity, -Infinity and NaN anywhere in a parsed document.
 *
 * Has to happen before the request is serialized. YAML has literal forms for these
 * (`.inf`, `.nan`, and any overflowing literal such as `1e999`), JSON has none, so
 * `JSON.stringify` turns them into `null` — and a null points value is indistinguishable
 * from an absent one, which defaults to 0 and cascades that zero into existing grading
 * comments. By the time the server validator runs, the evidence is gone.
 */
export function assertFiniteNumbers(value: unknown, path: string, ancestors: Set<object> = new Set()): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      const what = Number.isNaN(value) ? "not-a-number" : value > 0 ? "infinity" : "-infinity";
      throw new CLIError(
        `Invalid YML: ${path || "value"} is ${what}. ` +
          "JSON cannot carry it, so it would arrive as null and be read as zero."
      );
    }
    return;
  }
  if (value === null || typeof value !== "object") return;

  // YAML aliases can point at an *ancestor* (`parts: &p [{self: *p}]`), and the parser
  // resolves that into a genuinely cyclic object. Without this the walk recursed until
  // the stack blew, reporting "Maximum call stack size exceeded" with no file and no
  // path — and JSON.stringify would have thrown a step later anyway.
  //
  // Ancestors, not every node visited: an anchor reused as a sibling (`a: &x {…}` /
  // `b: *x`) is a legitimate shared reference that JSON serializes fine, so tracking all
  // visited objects would reject valid documents.
  if (ancestors.has(value)) {
    throw new CLIError(
      `Invalid YML: ${path || "the document"} refers back to itself through a YAML anchor. ` +
        "JSON cannot represent a cycle, so the request could not be sent."
    );
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, i) => assertFiniteNumbers(item, `${path}[${i}]`, ancestors));
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertFiniteNumbers(item, path ? `${path}.${key}` : key, ancestors);
    }
  }

  ancestors.delete(value);
}
