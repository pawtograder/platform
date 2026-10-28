/**
 * #1126: the client's interpretation of the course Gemini key RPC contract, and agreement between
 * the TypeScript feature-flag reader and the database's strict reader (gemini_key_setup_enabled):
 * only a JSON boolean counts, anything else falls back to the default (off).
 */
import {
  classifyGeminiKeyError,
  GEMINI_KEY_FAILURE_TEXT,
  isBlankGeminiKey,
  parseGeminiKeyStatus,
  successText
} from "@/lib/courseGeminiKey";
import { COURSE_FEATURES, courseFeatureEnabled } from "@/lib/courseFeatures";

describe("classifyGeminiKeyError", () => {
  it.each([
    ["42501", "forbidden"],
    ["22023", "invalid"],
    ["55000", "disabled"],
    ["55P03", "busy"],
    ["XX000", "failed"],
    ["PGRST301", "failed"]
  ])("maps %s to %s", (code, expected) => {
    expect(classifyGeminiKeyError({ code, message: "x" }, 400)).toBe(expected);
  });

  it("treats a response that never arrived as an unknown outcome, not a failure", () => {
    expect(classifyGeminiKeyError({ code: "", message: "TypeError: Failed to fetch" }, 0)).toBe("unknown");
    expect(classifyGeminiKeyError({ code: "", message: "Bad gateway" }, 502)).toBe("unknown");
    expect(classifyGeminiKeyError({ code: "42501" }, 0)).toBe("unknown");
  });

  it("never claims success or names a key in failure text", () => {
    const successes = ["saved", "replaced", "removed", "already_absent"].map(successText);
    for (const text of Object.values(GEMINI_KEY_FAILURE_TEXT)) {
      expect(successes).not.toContain(text);
      expect(text).not.toMatch(/^Key (saved|replaced|removed)/);
    }
    expect(GEMINI_KEY_FAILURE_TEXT.unknown).toMatch(/couldn't confirm/i);
  });
});

describe("parseGeminiKeyStatus", () => {
  it("accepts only the documented boolean shape", () => {
    expect(parseGeminiKeyStatus({ setup_enabled: true, configured: false })).toEqual({
      setup_enabled: true,
      configured: false
    });
    expect(parseGeminiKeyStatus({ setup_enabled: "true", configured: false })).toBeNull();
    expect(parseGeminiKeyStatus(null)).toBeNull();
    expect(parseGeminiKeyStatus({ configured: true })).toBeNull();
  });
});

describe("successText", () => {
  it("states that saving does not validate the key", () => {
    expect(successText("saved")).toMatch(/not been checked with Google/);
    expect(successText("already_absent")).toMatch(/nothing to remove/);
  });
});

describe("isBlankGeminiKey", () => {
  it("matches the server's notion of blank", () => {
    for (const v of ["", "   ", "\t\n\r ", "\u00a0\u00a0", "\u200b\ufeff"]) expect(isBlankGeminiKey(v)).toBe(true);
    expect(isBlankGeminiKey("  k ")).toBe(false);
  });
});

describe("gemini-api-key-setup flag agrees with the database reader", () => {
  const name = COURSE_FEATURES.GEMINI_API_KEY_SETUP;
  it.each([
    ["absent", [], false],
    ["null features", null, false],
    ["string true", [{ name, enabled: "true" }], false],
    ["string yes", [{ name, enabled: "yes" }], false],
    ["number 1", [{ name, enabled: 1 }], false],
    ["missing enabled", [{ name }], false],
    ["non-array", { [name]: true }, false],
    ["false", [{ name, enabled: false }], false],
    ["true", [{ name, enabled: true }], true]
  ])("%s → %s", (_label, features, expected) => {
    expect(courseFeatureEnabled(features as never, name)).toBe(expected);
  });
});
