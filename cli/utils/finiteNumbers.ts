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
export function assertFiniteNumbers(value: unknown, path: string): void {
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
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertFiniteNumbers(item, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertFiniteNumbers(item, path ? `${path}.${key}` : key);
    }
  }
}
