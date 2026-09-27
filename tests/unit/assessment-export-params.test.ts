/**
 * @jest-environment node
 */

/**
 * Numeric parameter coercion for the assessment export.
 *
 * These matter because the failure mode is silent *success*. The export used
 * `Math.max(0, x ?? 0)`, so a non-numeric batch index became `NaN`,
 * `slice(NaN, NaN)` returned `[]`, and the section reported zero rows with no
 * cursor — which the client's `assertExpectedCount` accepts, because it compares
 * the server's self-reported count against the rows it received and both are zero.
 * An export could therefore report "complete" having written none of the data.
 */

import { parseNonNegativeInt, parseByteCap } from "../../supabase/functions/cli/utils/paramValidation";

describe("parseNonNegativeInt", () => {
  it("defaults an absent value to zero", () => {
    expect(parseNonNegativeInt(undefined)).toBe(0);
    expect(parseNonNegativeInt(null)).toBe(0);
  });

  it("accepts non-negative integers", () => {
    expect(parseNonNegativeInt(0)).toBe(0);
    expect(parseNonNegativeInt(7)).toBe(7);
    expect(parseNonNegativeInt(1e9)).toBe(1e9);
  });

  it("accepts a numeric string, since JSON callers send them", () => {
    expect(parseNonNegativeInt("3")).toBe(3);
    expect(parseNonNegativeInt(" 3 ")).toBe(3);
  });

  it("rejects the value that silently emptied a section", () => {
    // Math.max(0, "abc") is NaN; slice(NaN, NaN) is []; the section then reported
    // zero rows and no cursor, and the client called that a complete export.
    expect(parseNonNegativeInt("abc")).toBeNull();
    expect(parseNonNegativeInt(NaN)).toBeNull();
  });

  it("rejects Infinity, which also produced an empty page with no cursor", () => {
    expect(parseNonNegativeInt(Infinity)).toBeNull();
    expect(parseNonNegativeInt(-Infinity)).toBeNull();
  });

  it("rejects fractions, which shifted the window and skipped rows", () => {
    // 1.5 * 80 = 120, so with a batch size of 80 the window straddled batches 1 and
    // 2: rows 80-119 were never emitted.
    expect(parseNonNegativeInt(1.5)).toBeNull();
    expect(parseNonNegativeInt("2.5")).toBeNull();
  });

  it("rejects negatives rather than clamping them to zero", () => {
    // Math.max clamped these, which quietly restarted the export at batch 0 while
    // the caller believed it was resuming.
    expect(parseNonNegativeInt(-1)).toBeNull();
    expect(parseNonNegativeInt("-1")).toBeNull();
  });

  it("rejects non-numeric types", () => {
    expect(parseNonNegativeInt(true)).toBeNull();
    expect(parseNonNegativeInt(false)).toBeNull();
    expect(parseNonNegativeInt({})).toBeNull();
    expect(parseNonNegativeInt([])).toBeNull();
    expect(parseNonNegativeInt("")).toBeNull();
    expect(parseNonNegativeInt("   ")).toBeNull();
  });
});

describe("parseByteCap", () => {
  const DEFAULT = 4096;
  const MAX = 1024 * 1024;

  it("defaults when absent", () => {
    expect(parseByteCap(undefined, DEFAULT, MAX)).toBe(DEFAULT);
    expect(parseByteCap(null, DEFAULT, MAX)).toBe(DEFAULT);
  });

  it("passes through a value inside the range", () => {
    expect(parseByteCap(8192, DEFAULT, MAX)).toBe(8192);
    expect(parseByteCap("8192", DEFAULT, MAX)).toBe(8192);
  });

  it("clamps to the maximum", () => {
    expect(parseByteCap(10_000_000, DEFAULT, MAX)).toBe(MAX);
  });

  it("rejects garbage instead of becoming NaN", () => {
    // A NaN cap made `output.length <= NaN` false and `slice(0, NaN)` empty, so every
    // row exported as "" with output_truncated: true — data loss reported as
    // truncation.
    expect(parseByteCap("abc", DEFAULT, MAX)).toBeNull();
    expect(parseByteCap(NaN, DEFAULT, MAX)).toBeNull();
    expect(parseByteCap(Infinity, DEFAULT, MAX)).toBeNull();
  });

  it("rejects zero and negatives, which emptied every output", () => {
    expect(parseByteCap(0, DEFAULT, MAX)).toBeNull();
    expect(parseByteCap(-1, DEFAULT, MAX)).toBeNull();
  });

  it("rejects fractions and non-numeric types", () => {
    expect(parseByteCap(1.5, DEFAULT, MAX)).toBeNull();
    expect(parseByteCap(true, DEFAULT, MAX)).toBeNull();
    expect(parseByteCap({}, DEFAULT, MAX)).toBeNull();
    expect(parseByteCap("", DEFAULT, MAX)).toBeNull();
  });
});
